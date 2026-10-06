import {
  BadRequestHttpError, BasicConditions, BasicETagHandler, BasicRepresentation, ConflictHttpError,
  ForbiddenHttpError, NotFoundHttpError, SparqlUpdateBodyParser,
  guardedStreamFrom, readableToString,
  type AccountLoginStorage, type IdentifierGenerator, type ReadWriteLocker, type ResourcesGenerator,
  type HttpRequest, type ResourceIdentifier, type ResourceStore, type WebIdStore,
} from '@solid/community-server';
import { ACCOUNT_TYPE } from '@solid/community-server/dist/identity/interaction/account/util/LoginStorage';
import { WEBID_STORAGE_TYPE } from '@solid/community-server/dist/identity/interaction/webid/util/BaseWebIdStore';
import { getLoggerFor } from 'global-logger-factory';
import { DataFactory, Parser, Writer } from 'n3';
import type { Quad } from '@rdfjs/types';

export interface CloudProfileCreatorOptions {
  baseUrl: string;
  /** Existing runtime issuer: an externally managed Local must prepare at Cloud. */
  oidcIssuer?: string;
  identifierGenerator: IdentifierGenerator;
  resourcesGenerator: ResourcesGenerator;
  resourceStore: ResourceStore;
  webIdStore: WebIdStore;
  accountStorage: AccountLoginStorage<Record<string, never>>;
  resourceLocker: ReadWriteLocker;
}

export interface PreparedCloudProfile {
  webId: string;
  webIdLink: string;
}

export class CloudProfileCreator {
  private readonly logger = getLoggerFor(this);
  private readonly root: URL;
  private readonly ownsIssuer: boolean;
  private readonly eTags = new BasicETagHandler();
  private readonly patchParser = new SparqlUpdateBodyParser();

  public constructor(private readonly options: CloudProfileCreatorOptions) {
    this.root = canonicalRoot(options.baseUrl);
    this.ownsIssuer = !options.oidcIssuer || canonicalRoot(options.oidcIssuer).href === this.root.href;
  }

  public async prepare(accountId: string, podName: string): Promise<PreparedCloudProfile> {
    this.assertIssuer();
    if (!podName || podName.trim() !== podName) {
      throw new BadRequestHttpError('A profile name is required.');
    }
    const base = this.options.identifierGenerator.generate(podName);
    if (canonicalRoot(base.path).href !== base.path) throw new BadRequestHttpError('Invalid Cloud profile identifier.');
    const webId = new URL('profile/card#me', base.path).href;
    const card = this.cardIdentifier(webId);
    return this.withNamespaceLock(base, async () => {
      await this.assertAccount(accountId);
      const link = await this.findUniqueLink(accountId, webId);
      if (await this.options.resourceStore.hasResource(card)) {
        if (!link) throw new ConflictHttpError('The Cloud profile name is already occupied.');
        // Existing Cloud storage profiles keep all their original resources and permissions.
        return { webId, webIdLink: link.id };
      }
      if (link || await this.options.resourceStore.hasResource(base)) {
        throw new ConflictHttpError('The Cloud profile namespace is already occupied.');
      }

      const generated = await this.generateCard(base, webId, podName);
      const created: ResourceIdentifier[] = [];
      try {
        // These are ordinary LDP containers, never pim:Storage or Account Pod entries.
        await this.writeNew(base, new BasicRepresentation([], base), created);
        const parentAuthorization = { path: `${base.path}.${generated.mode}` };
        const deny = generated.mode === 'acl' ? [] : [
          DataFactory.quad(DataFactory.namedNode(parentAuthorization.path), DataFactory.namedNode(RDF_TYPE), DataFactory.namedNode(`${ACP}AccessControlResource`)),
          DataFactory.quad(DataFactory.namedNode(parentAuthorization.path), DataFactory.namedNode(`${ACP}resource`), DataFactory.namedNode(base.path)),
        ];
        await this.writeNew(parentAuthorization, new BasicRepresentation(serialize(deny), parentAuthorization, 'text/turtle'), created);
        const profileContainer = { path: new URL('profile/', base.path).href };
        await this.writeNew(profileContainer, new BasicRepresentation([], profileContainer), created);
        await this.writeNew(card, new BasicRepresentation(serialize(generated.card), card, 'text/turtle'), created);
        const authorization = { path: `${card.path}.${generated.mode}` };
        await this.writeNew(authorization, new BasicRepresentation(serialize(generated.authorization), authorization, 'text/turtle'), created);
        const webIdLink = await this.options.webIdStore.create(webId, accountId);
        return { webId, webIdLink };
      } catch (error: unknown) {
        // Only resources in this new, locked namespace can be removed. Never touch an existing Pod.
        for (const identifier of created.reverse()) {
          try {
            await this.options.resourceStore.deleteResource(identifier);
          } catch (cleanupError: unknown) {
            if (!NotFoundHttpError.isInstance(cleanupError)) {
              this.logger.warn('Cloud profile preparation cleanup failed.');
            }
          }
        }
        throw error;
      }
    });
  }

  public async finalizeStorageBinding(accountId: string, webId: string, storageUrl: string): Promise<void> {
    this.assertIssuer();
    const card = this.cardIdentifier(webId);
    const storage = canonicalRoot(storageUrl).href;
    if (storage !== storageUrl) throw new BadRequestHttpError('The storage URL must be canonical.');
    await this.withNamespaceLock({ path: new URL('../', card.path).href }, async () => {
      await this.assertAccount(accountId);
      if (!await this.findUniqueLink(accountId, webId)) {
        throw new ForbiddenHttpError('The Cloud profile does not belong to this Account.');
      }
      const representation = await this.options.resourceStore.getRepresentation(card, { type: { 'text/turtle': 1 } });
      const quads = new Parser({ baseIRI: card.path }).parse(await readableToString(representation.data));
      const storageValues = new Set([storage]);
      for (const quad of quads) {
        if (quad.subject.value === webId && STORAGE_PREDICATES.includes(quad.predicate.value) && quad.object.termType === 'NamedNode') {
          storageValues.add(quad.object.value);
        }
      }
      const additions = STORAGE_PREDICATES.flatMap((predicate) => [...storageValues].map((value) =>
        DataFactory.quad(DataFactory.namedNode(webId), DataFactory.namedNode(predicate), DataFactory.namedNode(value))));
      // CSS ETags are second-granular. A whole-document PUT can overwrite an owner edit in
      // that same second even with If-Match. Add only discovery triples under the native
      // ResourceStore patch lock; neither owner RDF nor another Pod is ever replaced.
      const update = `INSERT DATA {\n${serialize(additions)}\n}`;
      const metadata = new BasicRepresentation('', card, 'application/sparql-update').metadata;
      const patch = await this.patchParser.handleSafe({
        // The installed parser consumes only the body stream. This is an internal patch;
        // no HTTP request or network transport is created.
        request: guardedStreamFrom(update) as HttpRequest,
        metadata,
      });
      await this.options.resourceStore.modifyResource(card, patch, new BasicConditions(this.eTags, { matchesETag: ['*'] }));
    });
  }

  /** Native Cloud Pod creation must hold this same lock for its whole check/generate sequence. */
  public async withNamespaceLock<T>(base: ResourceIdentifier, action: () => Promise<T>): Promise<T> {
    if (!this.ownsIssuer) return action();
    const namespace = canonicalRoot(base.path);
    if (namespace.href !== base.path) throw new BadRequestHttpError('Invalid Cloud profile namespace.');
    // Existing native storage may use another accepted host. It cannot collide with this
    // issuer's identity namespace and keeps its original creation behavior.
    if (namespace.origin !== this.root.origin || !namespace.pathname.startsWith(this.root.pathname)) return action();
    // A separate key avoids reacquiring the ResourceStore's canonical lock inside an operation.
    return this.options.resourceLocker.withWriteLock({ path: `${base.path}#xpod-cloud-profile` }, action);
  }

  private assertIssuer(): void {
    if (!this.ownsIssuer) throw new ForbiddenHttpError('Prepare the identity profile at the Account issuer.');
  }

  private cardIdentifier(webId: string): ResourceIdentifier {
    let url: URL;
    try { url = new URL(webId); } catch { throw new BadRequestHttpError('Invalid Cloud WebID.'); }
    const relative = url.pathname.slice(this.root.pathname.length);
    if (url.href !== webId || url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname) ||
      url.username || url.password || url.search || url.hash !== '#me' || !/^[^/]+\/profile\/card$/u.test(relative)) {
      throw new BadRequestHttpError('Invalid Cloud WebID.');
    }
    url.hash = '';
    return { path: url.href };
  }

  private async assertAccount(accountId: string): Promise<void> {
    if (!accountId || !await this.options.accountStorage.has(ACCOUNT_TYPE, accountId)) {
      throw new ForbiddenHttpError('The Account does not exist.');
    }
  }

  private async findUniqueLink(accountId: string, webId: string): Promise<{ id: string } | undefined> {
    // BaseWebIdStore prevents duplicates only within one Account, so inspect the real global index.
    const storage = this.options.accountStorage as unknown as {
      find: (type: typeof WEBID_STORAGE_TYPE, query: { webId: string }) => Promise<{ id: string; accountId: string }[]>;
    };
    const links = await storage.find(WEBID_STORAGE_TYPE, { webId });
    if (!links.length) return undefined;
    if (links.length !== 1 || links[0].accountId !== accountId || !await this.options.webIdStore.isLinked(webId, accountId)) {
      throw new ForbiddenHttpError('The Cloud profile has a conflicting Account binding.');
    }
    return links[0];
  }

  private async generateCard(base: ResourceIdentifier, webId: string, name: string): Promise<{ card: Quad[]; authorization: Quad[]; mode: 'acl' | 'acr' }> {
    const cardUrl = webId.split('#')[0];
    let card: Quad[] | undefined;
    let authorization: Quad[] | undefined;
    let mode: 'acl' | 'acr' | undefined;
    // The configured CSS generator selects the installed native templates and ACP/WAC mode.
    // Consume only the identity document and its authorization, dropping every storage resource.
    for await (const resource of this.options.resourcesGenerator.generate(base, { base, name, webId, oidcIssuer: this.root.href })) {
      const path = resource.identifier.path;
      if (path === cardUrl || path === `${cardUrl}.acl` || path === `${cardUrl}.acr`) {
        const quads = new Parser({ baseIRI: path }).parse(await readableToString(resource.representation.data));
        if (path === cardUrl) {
          card = quads.filter((q) => !(q.subject.value === webId && STORAGE_PREDICATES.includes(q.predicate.value)));
        } else {
          if (mode) throw new Error('The native profile has multiple authorization modes.');
          mode = path.endsWith('.acl') ? 'acl' : 'acr';
          authorization = quads;
        }
      } else {
        resource.representation.data.destroy();
      }
    }
    if (!card || !authorization || !mode) throw new Error('The native Cloud profile templates are incomplete.');
    if (mode === 'acr') {
      // Native ACP card public-read depends on root inheritance for the owner. This independent
      // document instead grants owner modes on the card alone, never memberAccessControl.
      const node = DataFactory.namedNode;
      const q = DataFactory.quad;
      const resource = node(`${cardUrl}.acr#card`);
      const control = node(`${cardUrl}.acr#profileOwnerAccess`);
      const policy = node(`${cardUrl}.acr#profileOwnerPolicy`);
      const matcher = node(`${cardUrl}.acr#profileOwnerMatcher`);
      authorization.push(q(resource, node(`${ACP}accessControl`), control),
        q(control, node(RDF_TYPE), node(`${ACP}AccessControl`)), q(control, node(`${ACP}apply`), policy),
        q(policy, node(RDF_TYPE), node(`${ACP}Policy`)), q(policy, node(`${ACP}anyOf`), matcher),
        q(matcher, node(RDF_TYPE), node(`${ACP}Matcher`)), q(matcher, node(`${ACP}agent`), node(webId)),
        ...['Read', 'Write', 'Control'].map((value) => q(policy, node(`${ACP}allow`), node(`${ACL}${value}`))));
    }
    return { card, authorization, mode };
  }

  private async writeNew(identifier: ResourceIdentifier, representation: BasicRepresentation, created: ResourceIdentifier[]): Promise<void> {
    await this.options.resourceStore.setRepresentation(identifier, representation,
      new BasicConditions(this.eTags, { notMatchesETag: ['*'] }));
    // A failed precondition belongs to another creator and must never enter cleanup.
    // A backend reporting an unknown partial write is left intact, rather than guessed away.
    created.push(identifier);
  }
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const STORAGE_PREDICATES = ['http://www.w3.org/ns/solid/terms#storage', 'http://www.w3.org/ns/pim/space#storage'];

function canonicalRoot(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestHttpError('Invalid canonical URL.'); }
  if (value.trim() !== value || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new BadRequestHttpError('Invalid canonical URL.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function serialize(quads: Quad[]): string {
  return new Writer({ format: 'text/turtle' }).quadsToString(quads);
}
