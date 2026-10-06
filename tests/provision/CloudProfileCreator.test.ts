import { describe, expect, it, vi } from 'vitest';
import {
  BaseResourcesGenerator, BasicRepresentation, ComposedAuxiliaryStrategy, EqualReadWriteLocker,
  ExtensionBasedMapperFactory, HandlebarsTemplateEngine, MemoryResourceLocker, NotFoundHttpError,
  RepresentationMetadata, StaticFolderGenerator, SubfolderResourcesGenerator, SuffixAuxiliaryIdentifierStrategy,
  DataAccessorBasedStore, InMemoryDataAccessor, RoutingAuxiliaryStrategy, PreconditionFailedHttpError,
  ChainedConverter, RdfToQuadConverter, QuadToRdfConverter, ConvertingPatcher, RdfPatcher,
  SparqlUpdatePatcher, PatchingStore, RepresentationPatchHandler, LockingResourceStore,
  WrappedExpiringReadWriteLocker,
  readableToString, type Representation, type Conditions, type ResourceStore, type Patch,
} from '@solid/community-server';
import { DataFactory, Parser, Store, Writer } from 'n3';
import { CloudProfileCreator, type CloudProfileCreatorOptions } from '../../src/provision/CloudProfileCreator';
import { ReservedSuffixIdentifierGenerator } from '../../src/pods/ReservedSuffixIdentifierGenerator';
import { ClusterIdentifierStrategy } from '../../src/util/identifiers/ClusterIdentifierStrategy';

const baseUrl = 'https://id.example/';
const root = `${baseUrl}alice/`;
const card = `${root}profile/card`;
const webId = `${card}#me`;
const solidStorage = 'http://www.w3.org/ns/solid/terms#storage';
const pimStorage = 'http://www.w3.org/ns/pim/space#storage';
const acl = 'http://www.w3.org/ns/auth/acl#';
const acp = 'http://www.w3.org/ns/solid/acp#';
const patcher = new SparqlUpdatePatcher();

function fixture(authMode: 'wac' | 'acp' = 'acp') {
  const resources = new Map<string, { text: string; metadata: RepresentationMetadata }>();
  let version = 0;
  const links: { id: string; webId: string; accountId: string }[] = [];
  const resourceStore = {
    hasResource: vi.fn(async ({ path }: { path: string }) => resources.has(path)),
    getRepresentation: vi.fn(async ({ path }: { path: string }) => {
      const resource = resources.get(path);
      if (!resource) throw new NotFoundHttpError();
      return new BasicRepresentation(resource.text, new RepresentationMetadata(resource.metadata));
    }),
    setRepresentation: vi.fn(async ({ path }: { path: string }, representation: Representation, conditions?: Conditions) => {
      if (conditions && !conditions.matchesMetadata(resources.get(path)?.metadata, false)) throw new PreconditionFailedHttpError();
      const metadata = new RepresentationMetadata(representation.metadata);
      metadata.set(DataFactory.namedNode('http://purl.org/dc/terms/modified'),
        DataFactory.literal(new Date(++version).toISOString(), DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#dateTime')));
      resources.set(path, { text: await readableToString(representation.data), metadata });
    }),
    deleteResource: vi.fn(async ({ path }: { path: string }) => { resources.delete(path); }),
    modifyResource: vi.fn(async (id: { path: string }, patch: Patch, conditions?: Conditions) => {
      const current = resources.get(id.path);
      if (!current) throw new NotFoundHttpError();
      if (conditions && !conditions.matchesMetadata(current.metadata, false)) throw new PreconditionFailedHttpError();
      const updated = await patcher.handleSafe({ identifier: id, patch, representation: {
        dataset: new Store(new Parser().parse(current.text)), data: undefined as never,
        binary: false, isEmpty: false, metadata: new RepresentationMetadata(current.metadata),
      } });
      resources.set(id.path, { text: new Writer().quadsToString(updated.dataset.getQuads(null, null, null, null)), metadata: updated.metadata });
    }),
  };
  const webIdStore = {
    findLinks: vi.fn(async (accountId: string) => links.filter((link) => link.accountId === accountId)),
    isLinked: vi.fn(async (value: string, accountId: string) => links.some((link) => link.accountId === accountId && link.webId === value)),
    create: vi.fn(async (value: string, accountId: string) => {
      const id = `link-${links.length + 1}`;
      links.push({ id, webId: value, accountId });
      return id;
    }),
    delete: vi.fn(async (id: string) => { const index = links.findIndex((link) => link.id === id); if (index >= 0) links.splice(index, 1); }),
  };
  const accountStorage = {
    has: vi.fn(async (_type: string, accountId: string) => ['account-a', 'account-b'].includes(accountId)),
    find: vi.fn(async (_type: string, query: { webId: string }) => links.filter((link) => link.webId === query.webId)),
  };
  const generator = new StaticFolderGenerator(new SubfolderResourcesGenerator(new BaseResourcesGenerator({
    factory: new ExtensionBasedMapperFactory(),
    templateEngine: new HandlebarsTemplateEngine(baseUrl),
    metadataStrategy: new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.meta')),
    store: resourceStore,
  }), ['base', authMode]), '@css:templates/pod');
  const options = {
    baseUrl, identifierGenerator: new ReservedSuffixIdentifierGenerator({ baseUrl }), resourcesGenerator: generator,
    resourceStore, webIdStore, accountStorage, resourceLocker: new EqualReadWriteLocker(new MemoryResourceLocker()),
  } as unknown as CloudProfileCreatorOptions;
  return { creator: new CloudProfileCreator(options), resources, links, resourceStore, webIdStore, accountStorage, options };
}

function objects(text: string, subject: string, predicate: string): string[] {
  return new Parser({ baseIRI: subject.split('#')[0] }).parse(text)
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object.value);
}

function nativeStore(): ResourceStore {
  const identifiers = new ClusterIdentifierStrategy({ baseUrl });
  const metadata = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.meta'));
  const authorization = new ComposedAuxiliaryStrategy(new SuffixAuxiliaryIdentifierStrategy('.acr'));
  const auxiliary = new RoutingAuxiliaryStrategy([authorization, metadata]);
  const backend = new DataAccessorBasedStore(new InMemoryDataAccessor(identifiers), identifiers, auxiliary, metadata);
  const converter = new ChainedConverter([new RdfToQuadConverter(), new QuadToRdfConverter()]);
  const patching = new PatchingStore(backend, new RepresentationPatchHandler(new ConvertingPatcher(
    new RdfPatcher(new SparqlUpdatePatcher()), converter, 'internal/quads', 'text/turtle')));
  return new LockingResourceStore(patching,
    new WrappedExpiringReadWriteLocker(new EqualReadWriteLocker(new MemoryResourceLocker()), 5_000), auxiliary);
}

describe('CloudProfileCreator', () => {
  it.each(['wac', 'acp'] as const)('creates an independent native Cloud card with card-only %s permissions', async (mode) => {
    const f = fixture(mode);
    expect(await f.creator.prepare('account-a', 'alice')).toEqual({ webId, webIdLink: 'link-1' });
    expect([...f.resources.keys()].sort()).toEqual([root, `${root}.${mode === 'wac' ? 'acl' : 'acr'}`, `${root}profile/`, card,
      `${card}.${mode === 'wac' ? 'acl' : 'acr'}`].sort());
    const profile = f.resources.get(card)!.text;
    expect(objects(profile, webId, 'http://www.w3.org/ns/solid/terms#oidcIssuer')).toEqual([baseUrl]);
    expect(objects(profile, webId, solidStorage)).toEqual([]);
    expect(objects(profile, webId, pimStorage)).toEqual([]);
    for (const resource of f.resources.values()) {
      expect(resource.metadata.quads().some((q) => q.object.value === 'http://www.w3.org/ns/pim/space#Storage')).toBe(false);
      expect(resource.text).not.toContain(`${acp}memberAccessControl`);
      expect(resource.text).not.toContain(`${acl}default`);
    }
    const permissions = new Parser().parse(f.resources.get(`${card}.${mode === 'wac' ? 'acl' : 'acr'}`)!.text);
    expect(permissions.some((q) => q.predicate.value === `${mode === 'wac' ? acl : acp}agent` && q.object.value === webId)).toBe(true);
    expect(permissions.some((q) => q.object.value === `${acl}Write`)).toBe(true);
    expect(permissions.some((q) => q.object.value === `${acl}Control`)).toBe(true);
    expect(permissions.some((q) => q.object.value === (mode === 'wac' ? 'http://xmlns.com/foaf/0.1/Agent' : `${acp}PublicAgent`))).toBe(true);
    const rootPermissions = new Parser().parse(f.resources.get(`${root}.${mode === 'wac' ? 'acl' : 'acr'}`)!.text);
    expect(rootPermissions.some((q) => [acl + 'mode', acp + 'allow', acp + 'memberAccessControl'].includes(q.predicate.value))).toBe(false);
  });

  it('serializes two accounts claiming the same name without overwriting the winner', async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([f.creator.prepare('account-a', 'alice'), f.creator.prepare('account-b', 'alice')]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.links).toHaveLength(1);
    expect(f.resourceStore.setRepresentation).toHaveBeenCalledTimes(5);
  });

  it('same-account retries preserve the native card and ACL', async () => {
    const f = fixture();
    const prepared = await f.creator.prepare('account-a', 'alice');
    await f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/alice/');
    f.resourceStore.setRepresentation.mockClear();
    expect(await f.creator.prepare('account-a', 'alice')).toEqual(prepared);
    expect(f.resourceStore.setRepresentation).not.toHaveBeenCalled();
  });

  it('reuses an account-owned existing Cloud identity without tightening its Cloud Pod ACL', async () => {
    const f = fixture();
    f.resources.set(root, { text: '', metadata: new RepresentationMetadata({ path: root }) });
    f.resources.set(card, { text: `<${webId}> <${solidStorage}> <${root}>.`, metadata: new RepresentationMetadata({ path: card }, 'text/turtle') });
    f.links.push({ id: 'existing', webId, accountId: 'account-a' });
    expect(await f.creator.prepare('account-a', 'alice')).toEqual({ webId, webIdLink: 'existing' });
    expect(f.resourceStore.setRepresentation).not.toHaveBeenCalled();
  });

  it('rejects occupied namespaces and never adopts an unlinked existing Cloud card', async () => {
    const f = fixture();
    f.resources.set(root, { text: '', metadata: new RepresentationMetadata({ path: root }) });
    await expect(f.creator.prepare('account-a', 'alice')).rejects.toThrow();
    expect(f.webIdStore.create).not.toHaveBeenCalled();
    expect(f.resourceStore.setRepresentation).not.toHaveBeenCalled();
  });

  it('rejects preexisting other-account and ambiguous WebID links', async () => {
    const f = fixture();
    f.links.push({ id: 'other', webId, accountId: 'account-b' });
    await expect(f.creator.prepare('account-a', 'alice')).rejects.toThrow();
    f.links.push({ id: 'own', webId, accountId: 'account-a' });
    await expect(f.creator.prepare('account-a', 'alice')).rejects.toThrow();
    expect(f.resourceStore.setRepresentation).not.toHaveBeenCalled();
  });

  it('requires a current Account and a valid non-reserved name', async () => {
    const f = fixture();
    await expect(f.creator.prepare('gone', 'alice')).rejects.toThrow();
    await expect(f.creator.prepare('account-a', '')).rejects.toThrow();
    await expect(f.creator.prepare('account-a', 'admin')).rejects.toThrow();
    expect(f.resources.size).toBe(0);
  });

  it('rejects an identifier generator escaping the Cloud authority', async () => {
    const f = fixture();
    f.options.identifierGenerator = { generate: () => ({ path: 'https://node.example/alice/' }), extractPod: (id) => id };
    await expect(new CloudProfileCreator(f.options).prepare('account-a', 'alice')).rejects.toThrow();
    expect(f.resources.size).toBe(0);
  });

  it('never creates a profile at an externally managed Local, while self issuers keep working', async () => {
    const f = fixture();
    const local = new CloudProfileCreator({ ...f.options, oidcIssuer: 'https://cloud.example/' });
    await expect(local.prepare('account-a', 'alice')).rejects.toThrow();
    await expect(local.finalizeStorageBinding('account-a', webId, 'https://node.example/')).rejects.toThrow();
    expect(f.resources.size).toBe(0);
    const own = new CloudProfileCreator({ ...f.options, oidcIssuer: baseUrl });
    expect((await own.prepare('account-a', 'alice')).webId).toBe(webId);
  });

  it('normalizes existing issuer configuration and supports a Cloud URL path prefix', async () => {
    const f = fixture();
    const cloud = 'https://id.example/solid/';
    const creator = new CloudProfileCreator({ ...f.options, baseUrl: cloud, oidcIssuer: 'https://id.example/solid',
      identifierGenerator: new ReservedSuffixIdentifierGenerator({ baseUrl: cloud }) });
    const prepared = await creator.prepare('account-a', 'alice');
    expect(prepared.webId).toBe(`${cloud}alice/profile/card#me`);
    await creator.finalizeStorageBinding('account-a', prepared.webId, 'https://node.example/alice/');
    expect(objects(f.resources.get(`${cloud}alice/profile/card`)!.text, prepared.webId, solidStorage)).toEqual(['https://node.example/alice/']);
  });

  it('accepts equivalent self issuer configuration without a trailing slash', async () => {
    const f = fixture();
    const creator = new CloudProfileCreator({ ...f.options, oidcIssuer: baseUrl.slice(0, -1) });
    expect((await creator.prepare('account-a', 'alice')).webId).toBe(webId);
  });

  it('cleans only newly created resources when account linking fails, allowing retry', async () => {
    const f = fixture();
    f.webIdStore.create.mockRejectedValueOnce(new Error('link failed'));
    await expect(f.creator.prepare('account-a', 'alice')).rejects.toThrow('link failed');
    expect(f.resources.size).toBe(0);
    expect(await f.creator.prepare('account-a', 'alice')).toEqual({ webId, webIdLink: 'link-1' });
  });

  it('writes both ecosystem storage predicates while preserving existing Pods and unrelated RDF', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    await f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/alice/');
    await f.creator.finalizeStorageBinding('account-a', webId, 'https://other.example/data/');
    await f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/alice/');
    const profile = f.resources.get(card)!.text;
    expect(objects(profile, webId, solidStorage).sort()).toEqual(['https://node.example/alice/', 'https://other.example/data/']);
    expect(objects(profile, webId, pimStorage).sort()).toEqual(['https://node.example/alice/', 'https://other.example/data/']);
    expect(objects(profile, webId, 'http://www.w3.org/ns/solid/terms#oidcIssuer')).toEqual([baseUrl]);
  });

  it('serializes concurrent finalizations so no storage binding is lost', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    await Promise.all([f.creator.finalizeStorageBinding('account-a', webId, 'https://a.example/'),
      f.creator.finalizeStorageBinding('account-a', webId, 'https://b.example/')]);
    expect(objects(f.resources.get(card)!.text, webId, solidStorage).sort()).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it('does not change an existing Cloud Pod pointer while adding Local storage', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    f.resources.get(card)!.text += `<${webId}> <${pimStorage}> <${root}>.\n`;
    await f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/alice/');
    expect(objects(f.resources.get(card)!.text, webId, pimStorage).sort()).toEqual([root, 'https://node.example/alice/'].sort());
  });

  it.each(['https://other.example/card#me', `${card}?x=1#me`, `${card}#other`, ` ${webId}`])('rejects noncanonical identity %s', async (value) => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    await expect(f.creator.finalizeStorageBinding('account-a', value, 'https://node.example/alice/')).rejects.toThrow();
  });

  it.each(['https://node.example/alice/?token=x', 'https://user:secret@node.example/alice/', 'file:///data/', 'https://node.example/alice/#me'])('rejects invalid storage URL %s', async (value) => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    await expect(f.creator.finalizeStorageBinding('account-a', webId, value)).rejects.toThrow();
  });

  it('rejects other Accounts, revoked links and missing accounts at finalize time', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    await expect(f.creator.finalizeStorageBinding('account-b', webId, 'https://node.example/')).rejects.toThrow();
    f.links.splice(0);
    await expect(f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/')).rejects.toThrow();
    await expect(f.creator.finalizeStorageBinding('gone', webId, 'https://node.example/')).rejects.toThrow();
  });

  it('propagates binding write failure instead of reporting successful provisioning', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    f.resourceStore.modifyResource.mockRejectedValueOnce(new Error('RDF store unavailable'));
    await expect(f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/')).rejects.toThrow('RDF store unavailable');
  });

  it('uses native If-None-Match and never cleans up another creator winning the namespace', async () => {
    const f = fixture();
    const store = nativeStore();
    const set = store.setRepresentation.bind(store);
    const winner = new BasicRepresentation('<> <http://example.org/owner> "other creator".', { path: root }, 'text/turtle');
    const deletion = vi.spyOn(store, 'deleteResource');
    vi.spyOn(store, 'setRepresentation').mockImplementationOnce(async (id, representation, conditions) => {
      await set(id, winner);
      return set(id, representation, conditions);
    });
    const creator = new CloudProfileCreator({ ...f.options, resourceStore: store });
    // Native CSS rejects existing containers before evaluating request conditions.
    await expect(creator.prepare('account-a', 'alice')).rejects.toThrow();
    expect(store.setRepresentation).toHaveBeenCalledWith({ path: root }, expect.anything(),
      expect.objectContaining({ notMatchesETag: ['*'] }));
    expect(deletion).not.toHaveBeenCalled();
    expect(await store.hasResource({ path: root })).toBe(true);
    expect(f.webIdStore.create).not.toHaveBeenCalled();
  });

  it('preserves owner edits using real native ResourceStore conditional writes', async () => {
    const f = fixture();
    const store = nativeStore();
    const creator = new CloudProfileCreator({ ...f.options, resourceStore: store });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
    try {
      await creator.prepare('account-a', 'alice');
      const get = store.getRepresentation.bind(store);
      vi.spyOn(store, 'getRepresentation').mockImplementationOnce(async (id, preferences, conditions) => {
        const old = await get(id, preferences, conditions);
        const text = await readableToString(old.data); // Release the native read lock.
        await store.setRepresentation(id, new BasicRepresentation(`${text}\n<${webId}> <http://xmlns.com/foaf/0.1/name> "Owner edit".`, new RepresentationMetadata(old.metadata)));
        const changed = await get(id, preferences);
        expect(changed.metadata.get(DataFactory.namedNode('http://purl.org/dc/terms/modified'))?.value)
          .toBe(old.metadata.get(DataFactory.namedNode('http://purl.org/dc/terms/modified'))?.value);
        await readableToString(changed.data);
        return new BasicRepresentation(text, old.metadata);
      });
      await creator.finalizeStorageBinding('account-a', webId, 'https://node.example/alice/');
      const profile = await store.getRepresentation({ path: card }, { type: { 'text/turtle': 1 } });
      const text = await readableToString(profile.data);
      expect(text).toContain('Owner edit');
      expect(objects(text, webId, 'http://xmlns.com/foaf/0.1/name')).toContain('Owner edit');
      expect(objects(text, webId, solidStorage)).toEqual(['https://node.example/alice/']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the whole native Cloud Pod generation lock with profile preparation', async () => {
    const f = fixture();
    const standardCreation = f.creator.withNamespaceLock({ path: root }, async () => {
      if (await f.resourceStore.hasResource({ path: root })) throw new Error('name occupied');
      for await (const resource of f.options.resourcesGenerator.generate({ path: root }, { webId, oidcIssuer: baseUrl })) {
        await f.resourceStore.setRepresentation(resource.identifier, resource.representation);
      }
      return 'native-pod';
    });
    const results = await Promise.allSettled([standardCreation, f.creator.prepare('account-a', 'alice')]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'native-pod' });
    expect(results[1].status).toBe('rejected');
    expect(f.resources.get(root)!.metadata.quads().some((q) => q.object.value === 'http://www.w3.org/ns/pim/space#Storage')).toBe(true);
    expect(f.webIdStore.create).not.toHaveBeenCalled();
  });

  it('preserves externally managed and native server-root namespace callers', async () => {
    const f = fixture();
    expect(await f.creator.withNamespaceLock({ path: baseUrl }, async () => 'root-pod')).toBe('root-pod');
    const local = new CloudProfileCreator({ ...f.options, oidcIssuer: 'https://cloud.example/' });
    expect(await local.withNamespaceLock({ path: root }, async () => 'local-pod')).toBe('local-pod');
    expect(await f.creator.withNamespaceLock({ path: 'https://other.example/' }, async () => 'native-alias')).toBe('native-alias');
  });

  it('propagates native patch condition failures without rewriting the card', async () => {
    const f = fixture();
    await f.creator.prepare('account-a', 'alice');
    f.resourceStore.modifyResource.mockRejectedValue(new PreconditionFailedHttpError());
    await expect(f.creator.finalizeStorageBinding('account-a', webId, 'https://node.example/')).rejects.toBeInstanceOf(PreconditionFailedHttpError);
  });
});
