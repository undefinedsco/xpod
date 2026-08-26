/**
 * ProvisionPodCreator
 *
 * 等位替换 CSS 的 BasePodCreator。
 *
 * 检查 settings 里有没有 provisionCode：
 * - 有 → 解码 JWT，回调远端 SP 的 /provision/pods 创建 Pod
 * - 没有 → 委托给原始 BasePodCreator（标准本地创建）
 */

import { randomUUID } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import { Readable } from 'node:stream';
import { DataFactory, Parser, Writer } from 'n3';
import {
  BasePodCreator,
  BasicRepresentation,
  guardStream,
  readableToString,
  type PodCreatorInput,
  type PodCreatorOutput,
  type BasePodCreatorArgs,
  type ResourceIdentifier,
  type ResourceStore,
  type PodSettings,
  ConflictHttpError,
  InternalServerError,
} from '@solid/community-server';
import { ProvisionCodeCodec, type ProvisionCodePayload } from './ProvisionCodeCodec';
import {
  createSignaledManagedClientFetch,
  type ManagedClientFetch,
  type SignaledManagedClientFetchOptions,
} from '../edge/reachability/ManagedClientFetch';
import { XPOD_REMOTE_PROVISIONED } from './ProvisionPodStore';

function joinUrlPath(baseUrl: string, relativePath: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
  const normalizedRelativePath = relativePath.replace(/^\/+/u, '');
  return `${normalizedBaseUrl}/${normalizedRelativePath}`;
}

function normalizeOptionalUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUrlRoot(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isSameUrlRoot(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeUrlRoot(left);
  const normalizedRight = normalizeUrlRoot(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function isSameNodeId(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim() === right.trim());
}

function isSameUrlOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function buildDefaultWebId(issuer: string, podName: string, relativeWebIdPath: string): string {
  const normalizedRelativePath = relativeWebIdPath.replace(/^\/+/u, '');
  return joinUrlPath(issuer, `${encodeURIComponent(podName)}/${normalizedRelativePath}`);
}

function buildStorageRoot(payload: { spDomain?: string; spUrl: string }): string {
  return payload.spDomain ? `https://${payload.spDomain}` : payload.spUrl;
}

function buildPodUrl(storageRoot: string, podName: string): string {
  return joinUrlPath(storageRoot, `${encodeURIComponent(podName)}/`);
}

function stripProvisionCode(settings: PodCreatorInput['settings']): Record<string, unknown> | undefined {
  if (!settings) {
    return undefined;
  }

  const { provisionCode: _provisionCode, ...rest } = settings as Record<string, unknown>;
  return rest;
}

async function readProvisionResponseMessage(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return undefined;
  }

  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    return typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : text;
  } catch {
    return text;
  }
}

export interface ProvisionPodCreatorArgs extends BasePodCreatorArgs {
  /** 与 ProvisionHandler 使用相同的 baseUrl 派生签名密钥 */
  provisionBaseUrl?: string;
  /** Current SP node id; used to recognize this SP even when URLs differ by localhost/managed domain. */
  nodeId?: string;
  /** Kept in the component signature for config compatibility; Pod storage facts live in CSS account data. */
  identityDbUrl?: string;
  /**
   * Server-internal resource store. Used to reconcile the solid:storage binding in an existing
   * WebID profile card after the Pod moves to another storage provider.
   */
  resourceStore?: ResourceStore;
}

interface StandardPodCreateOptions {
  baseIdentifier?: ResourceIdentifier;
  linkWebId?: boolean;
  oidcIssuer?: string;
  storageUrl?: string;
  webId?: string;
}

interface PreparedWebIdLink {
  /** Link id to expose in the create-pod response. May be an existing link. */
  outputWebIdLink?: string;
  /** Link id CSS may delete if Pod creation fails. Only newly-created links are safe here. */
  cleanupWebIdLink?: string;
}

function remapPodConflict(error: unknown, podName: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/There already is a resource at/i.test(message)) {
    throw new ConflictHttpError(`Pod name "${podName}" is already taken for this storage target.`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  throw error;
}

const STORAGE_PROVIDER_UNAVAILABLE_MESSAGE =
  'Local Xpod is temporarily unreachable. Wait for it to reconnect, then try again.';

export class ProvisionPodCreator extends BasePodCreator {
  private readonly provisionLogger = getLoggerFor(this);
  private readonly codec: ProvisionCodeCodec;
  private readonly oidcIssuer?: string;
  private readonly currentNodeId?: string;
  private readonly resourceStore?: ResourceStore;

  public constructor(args: ProvisionPodCreatorArgs) {
    super(args);
    this.oidcIssuer = normalizeOptionalUrl(args.provisionBaseUrl);
    this.currentNodeId = normalizeOptionalString(args.nodeId);
    this.resourceStore = args.resourceStore;
    this.codec = new ProvisionCodeCodec(this.oidcIssuer ?? args.baseUrl);
  }

  public override async handle(input: PodCreatorInput): Promise<PodCreatorOutput> {
    const provisionCode = input.settings?.provisionCode as string | undefined;

    if (!provisionCode) {
      return this.handleStandardPodCreate(input);
    }

    // SP 模式：解码 provisionCode，回调远端 SP
    const payload = this.codec.decode(provisionCode);
    if (!payload) {
      throw new Error('Invalid or expired provisionCode');
    }

    // 1. 确定 podName
    const podName = input.name;
    if (!podName) {
      throw new Error('Pod name is required for remote provisioning');
    }
    const webId = input.webId ?? buildDefaultWebId(this.oidcIssuer ?? this.baseUrl, podName, this.relativeWebIdPath);
    const targetStorageRoot = buildStorageRoot(payload);
    const canonicalStorageUrl = buildPodUrl(targetStorageRoot, podName);
    const tokenOidcIssuer = normalizeUrlRoot(this.oidcIssuer ?? this.baseUrl) ?? this.oidcIssuer ?? this.baseUrl;

    if (this.targetsCurrentStorageProvider(payload, targetStorageRoot)) {
      this.provisionLogger.info(
        `Provision code targets current SP ${this.baseUrl}${this.currentNodeId ? ` (${this.currentNodeId})` : ''}; creating Pod directly through CSS`,
      );
      return this.handleStandardPodCreate(input, {
        baseIdentifier: { path: canonicalStorageUrl },
        linkWebId: !input.webId,
        oidcIssuer: tokenOidcIssuer,
        storageUrl: canonicalStorageUrl,
        webId,
      });
    }

    this.provisionLogger.info(`Provisioning pod on remote SP: ${payload.spUrl}`);

    // 2. 回调 SP 创建 Pod
    const callbackToken = payload.serviceAccessToken ?? payload.serviceToken;
    const callbackUrl = `${payload.spUrl.replace(/\/$/, '')}/provision/pods`;
    let callback: { response: Response; close: () => void };
    try {
      callback = await this.openProvisionCallback(payload, callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${callbackToken}`,
        },
        body: JSON.stringify({ podName, webId }),
      });
    } catch (error) {
      this.provisionLogger.error(`SP callback could not be opened for ${payload.spUrl}: ${error}`);
      throw new InternalServerError(STORAGE_PROVIDER_UNAVAILABLE_MESSAGE, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    let spResult: { podUrl?: string };
    try {
      const spResponse = callback.response;
      if (!spResponse.ok) {
        const message = await readProvisionResponseMessage(spResponse);
        this.provisionLogger.error(`SP callback failed: ${spResponse.status} ${message ?? ''}`);
        if (spResponse.status === 409 || /already exists|already taken|conflict/iu.test(message ?? '')) {
          throw new ConflictHttpError(message || `Pod name "${podName}" is already taken for this storage target.`);
        }
        throw new Error(message
          ? `Failed to create pod on SP: ${spResponse.status}: ${message}`
          : `Failed to create pod on SP: ${spResponse.status}`);
      }
      spResult = await spResponse.json() as { podUrl?: string };
    } finally {
      callback.close();
    }

    // Return the callback URL when the Local SP reports it, while recording
    // the canonical managed storage URL in the Cloud account Pod list.
    const podUrl = spResult.podUrl || canonicalStorageUrl;

    // 3. Link the WebID and record the remote Pod in account storage.
    // ProvisionPodStore uses the marker below to persist settings.storage
    // instead of creating a phantom Cloud Pod at settings.base.path.
    const localBase = this.identifierGenerator.generate(podName);
    const inputSettings = stripProvisionCode(input.settings);
    const podSettings = {
      ...inputSettings,
      base: localBase,
      webId,
      oidcIssuer: tokenOidcIssuer,
      storage: canonicalStorageUrl,
      [XPOD_REMOTE_PROVISIONED]: true,
    };

    const webIdLink = await this.prepareWebIdLink(!input.webId, webId, input.accountId, podSettings);
    podSettings.oidcIssuer = tokenOidcIssuer;
    const podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink.cleanupWebIdLink);

    await this.trySyncProfileStorageBinding(webId, canonicalStorageUrl);

    this.provisionLogger.info(`Provisioned pod ${podName} on SP ${payload.spUrl}, podUrl: ${podUrl}`);

    return {
      podUrl,
      webId,
      podId,
      webIdLink: webIdLink.outputWebIdLink,
    };
  }

  /**
   * A managed node's canonical domain is an identity, not proof that the node
   * is directly reachable. New provision codes therefore open the existing
   * managed/P2P route before sending the Local-only callback credential.
   */
  private async openProvisionCallback(
    payload: ProvisionCodePayload,
    callbackUrl: string,
    init: RequestInit,
  ): Promise<{ response: Response; close: () => void }> {
    if (
      payload.nodeId
      && payload.signalApiUrl
      && payload.routeAccessToken
      && payload.routeAccessTokenExp
    ) {
      const managed = await this.createManagedFetch({
        apiBaseUrl: payload.signalApiUrl,
        nodeId: payload.nodeId,
        token: payload.routeAccessToken,
        clientId: `provision-${randomUUID()}`,
      });
      try {
        const response = await managed.fetch(callbackUrl, init);
        return { response, close: () => managed.close() };
      } catch (error) {
        managed.close();
        throw error;
      }
    }

    return {
      response: await fetch(callbackUrl, init),
      close: () => undefined,
    };
  }

  protected async createManagedFetch(
    options: SignaledManagedClientFetchOptions,
  ): Promise<ManagedClientFetch> {
    return createSignaledManagedClientFetch(options);
  }

  private targetsCurrentStorageProvider(payload: { nodeId?: string; spUrl: string }, targetStorageRoot: string): boolean {
    return isSameNodeId(payload.nodeId, this.currentNodeId) ||
      isSameUrlRoot(payload.spUrl, this.baseUrl) ||
      isSameUrlRoot(targetStorageRoot, this.baseUrl);
  }

  private async handleStandardPodCreate(
    input: PodCreatorInput,
    options: StandardPodCreateOptions = {},
  ): Promise<PodCreatorOutput> {
    const totalStarted = Date.now();
    const baseIdentifier = options.baseIdentifier ?? this.generateBaseIdentifier(input.name);
    const inputSettings = stripProvisionCode(input.settings);
    const oidcIssuer = options.oidcIssuer ?? (typeof inputSettings?.oidcIssuer === 'string'
      ? inputSettings.oidcIssuer
      : this.oidcIssuer ?? this.baseUrl);
    const webId = options.webId ?? input.webId ?? (input.name
      ? buildDefaultWebId(oidcIssuer, input.name, this.relativeWebIdPath)
      : joinUrlPath(baseIdentifier.path, this.relativeWebIdPath));
    const storageUrl = options.storageUrl ?? baseIdentifier.path;
    const podSettings = {
      ...inputSettings,
      base: baseIdentifier,
      webId,
      oidcIssuer,
      storage: storageUrl,
    };
    const linkWebId = options.linkWebId ?? !input.webId;

    const webIdStarted = Date.now();
    const webIdLink = await this.prepareWebIdLink(linkWebId, webId, input.accountId, podSettings);
    podSettings.oidcIssuer = oidcIssuer;
    const webIdElapsed = Date.now() - webIdStarted;

    const podStarted = Date.now();
    let podId: string;
    try {
      podId = await this.createPod(input.accountId, podSettings, !input.name, webIdLink.cleanupWebIdLink);
    } catch (error) {
      if (input.name) {
        remapPodConflict(error, input.name);
      }
      throw error;
    }
    const podElapsed = Date.now() - podStarted;
    const totalElapsed = Date.now() - totalStarted;

    await this.trySyncProfileStorageBinding(webId, storageUrl);

    this.provisionLogger.info(
      `[timing] ProvisionPodCreator.standard account=${input.accountId} pod=${baseIdentifier.path} handleWebId=${webIdElapsed}ms createPod=${podElapsed}ms total=${totalElapsed}ms`,
    );

    return {
      podUrl: baseIdentifier.path,
      webId,
      podId,
      webIdLink: webIdLink.outputWebIdLink,
    };
  }

  private async prepareWebIdLink(
    linkWebId: boolean,
    webId: string,
    accountId: string,
    settings: PodSettings,
  ): Promise<PreparedWebIdLink> {
    if (!linkWebId) {
      return {};
    }

    const existingLink = await this.findExistingWebIdLink(webId, accountId);
    if (existingLink) {
      this.provisionLogger.info(`Reusing existing WebID link ${existingLink.id} for ${webId}`);
      return { outputWebIdLink: existingLink.id };
    }

    const createdLink = await this.handleWebId(true, webId, accountId, settings);
    return {
      outputWebIdLink: createdLink,
      cleanupWebIdLink: createdLink,
    };
  }

  private async findExistingWebIdLink(
    webId: string,
    accountId: string,
  ): Promise<{ id: string; webId: string } | undefined> {
    const normalizedTarget = normalizeUrlRoot(webId) ?? webId;
    const links = await this.webIdStore.findLinks(accountId);
    return links.find((link) => (normalizeUrlRoot(link.webId) ?? link.webId) === normalizedTarget);
  }

  /**
   * Best-effort reconcile of the solid:storage binding in a WebID profile card hosted on this server.
   * Fresh pods get the correct binding from the pod resource templates, so this only rewrites
   * the card when an existing WebID's Pod moved to a different storage URL.
   * Never throws: the Pod itself is already created and a stale card is recoverable on retry.
   */
  private async trySyncProfileStorageBinding(webId: string, storageUrl: string): Promise<void> {
    try {
      await this.syncProfileStorageBinding(webId, storageUrl);
    } catch (error: unknown) {
      this.provisionLogger.error(
        `Failed to sync solid:storage in profile card for ${webId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async syncProfileStorageBinding(webId: string, storageUrl: string): Promise<void> {
    if (!this.resourceStore) {
      return;
    }

    const cardUrl = webId.split('#')[0];
    if (!cardUrl || !isSameUrlOrigin(cardUrl, this.baseUrl)) {
      return;
    }

    const identifier = { path: cardUrl };
    const representation = await this.resourceStore.getRepresentation(identifier, {
      type: { 'text/turtle': 1 },
    });
    const turtle = await readableToString(representation.data);

    const webIdNode = DataFactory.namedNode(webId);
    const storagePredicate = DataFactory.namedNode('http://www.w3.org/ns/solid/terms#storage');
    const quads = new Parser().parse(turtle);
    const storageQuads = quads.filter((quad) =>
      quad.subject.equals(webIdNode) && quad.predicate.equals(storagePredicate));

    if (storageQuads.length === 1 && storageQuads[0].object.value === storageUrl) {
      return;
    }

    const keptQuads = quads.filter((quad) =>
      !(quad.subject.equals(webIdNode) && quad.predicate.equals(storagePredicate)));
    keptQuads.push(DataFactory.quad(webIdNode, storagePredicate, DataFactory.namedNode(storageUrl)));

    const writer = new Writer({
      prefixes: {
        foaf: 'http://xmlns.com/foaf/0.1/',
        solid: 'http://www.w3.org/ns/solid/terms#',
        rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      },
    });
    writer.addQuads(keptQuads);
    const updatedTurtle = await new Promise<string>((resolve, reject) => {
      writer.end((error, result) => error ? reject(error) : resolve(result));
    });

    await this.resourceStore.setRepresentation(
      identifier,
      new BasicRepresentation(guardStream(Readable.from(updatedTurtle)), identifier, 'text/turtle'),
    );
    this.provisionLogger.info(`Updated solid:storage in profile card ${cardUrl} to ${storageUrl}`);
  }
}
