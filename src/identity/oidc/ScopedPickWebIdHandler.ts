import { boolean, object, string } from 'yup';
import { getLoggerFor } from 'global-logger-factory';
import {
  BadRequestHttpError,
  FoundHttpError,
  JsonInteractionHandler,
  assertAccountId,
  assertOidcInteraction,
  finishInteraction,
  forgetWebId,
  parseSchema,
  validateWithError,
} from '@solid/community-server';
import type {
  Json,
  JsonInteractionHandlerInput,
  JsonRepresentation,
  JsonView,
  ProviderFactory,
  WebIdStore,
} from '@solid/community-server';
import { getIdentityDatabase } from '../drizzle/db';
import { PodLookupRepository, type PodLookupResult } from '../drizzle/PodLookupRepository';
import { ProvisionCodeCodec } from '../../provision/ProvisionCodeCodec';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const inSchema = object({
  webId: string().trim().required(),
  remember: boolean().default(false),
});

export interface ScopedPickWebIdHandlerOptions {
  webIdStore: WebIdStore;
  providerFactory: ProviderFactory;
  identityDbUrl?: string;
  provisionBaseUrl?: string;
  podLookupRepository?: PodWebIdLookupRepository;
  fetch?: FetchLike;
}

export interface PodWebIdLookupRepository {
  findByWebId: (webId: string) => Promise<PodLookupResult | undefined>;
  findAllByWebId?: (webId: string) => Promise<PodLookupResult[]>;
  findByWebIds?: (webIds: string[]) => Promise<PodLookupResult[]>;
  listByAccountId?: (accountId: string) => Promise<PodLookupResult[]>;
}

interface WebIdEntry extends Record<string, Json | undefined> {
  webId: string;
  storageUrl?: string;
  storageMode?: 'cloud' | 'local' | 'custom';
}

/**
 * CSS-compatible WebID picker scoped to the current storage provider.
 *
 * The upstream handler lists every WebID linked to the IdP account. In an
 * IDP/SP split flow that lets a Local SP login pick a Cloud Pod again, so this
 * replacement keeps consent choices constrained by the selected SP's Pod facts.
 */
export class ScopedPickWebIdHandler extends JsonInteractionHandler implements JsonView {
  private readonly logger = getLoggerFor(this);
  private readonly webIdStore: WebIdStore;
  private readonly providerFactory: ProviderFactory;
  private readonly provisionBaseUrl?: string;
  private readonly podLookupRepository?: PodWebIdLookupRepository;
  private readonly fetch: FetchLike;

  public constructor(options: ScopedPickWebIdHandlerOptions) {
    super();
    this.webIdStore = options.webIdStore;
    this.providerFactory = options.providerFactory;
    this.provisionBaseUrl = normalizeOptionalUrl(options.provisionBaseUrl);
    this.podLookupRepository = options.podLookupRepository ??
      (options.identityDbUrl ? new PodLookupRepository(getIdentityDatabase(options.identityDbUrl)) : undefined);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  public async getView({ accountId, oidcInteraction }: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    assertAccountId(accountId);
    const provider = await this.providerFactory.getProvider();
    const description = parseSchema(inSchema);
    const target = await this.resolveTargetStorage(provider, oidcInteraction);
    const entries = await this.resolveScopedEntries(accountId, target);

    return {
      json: {
        ...description,
        webIds: entries.map((entry) => entry.webId),
        entries,
      },
    };
  }

  public async handle({ oidcInteraction, accountId, json }: JsonInteractionHandlerInput): Promise<never> {
    assertOidcInteraction(oidcInteraction);
    assertAccountId(accountId);
    const { webId, remember } = await validateWithError(inSchema, json);
    const provider = await this.providerFactory.getProvider();
    const target = await this.resolveTargetStorage(provider, oidcInteraction);

    if (!await this.isLinkedToAccount(webId, accountId)) {
      this.logger.warn(`Trying to pick WebID ${webId} which does not belong to account ${accountId}`);
      throw new BadRequestHttpError('WebID does not belong to this account.');
    }

    if (!await this.isResolvableByCurrentSp(webId, target)) {
      this.logger.warn(`Trying to pick WebID ${webId} which does not belong to this storage provider`);
      throw new BadRequestHttpError('WebID does not belong to this storage provider.');
    }

    await forgetWebId(provider, oidcInteraction);
    const location = await finishInteraction(oidcInteraction, {
      login: {
        accountId: webId,
        remember,
      },
    }, true);
    throw new FoundHttpError(location);
  }

  private async resolveScopedEntries(accountId: string, target: TargetStorage): Promise<WebIdEntry[]> {
    const webIds = await this.resolveCandidateWebIds(accountId);
    if (target.serviceToken) {
      return this.resolveRemoteSpEntries(webIds, target);
    }

    const entries: WebIdEntry[] = [];
    for (const webId of webIds) {
      const pod = await this.findSpPod(webId, target.storageUrl);
      if (!pod) {
        continue;
      }
      const storageUrl = ensureTrailingSlash(pod.storageUrl ?? pod.baseUrl);
      entries.push({
        webId,
        storageUrl,
        storageMode: deriveStorageMode(webId, storageUrl),
      });
    }
    return entries;
  }

  private async resolveCandidateWebIds(accountId: string): Promise<string[]> {
    const linkedWebIds = (await this.webIdStore.findLinks(accountId)).map((link) => link.webId);
    if (linkedWebIds.length > 0) {
      return dedupeStrings(linkedWebIds);
    }

    if (!this.podLookupRepository?.listByAccountId) {
      return [];
    }

    try {
      const pods = await this.podLookupRepository.listByAccountId(accountId);
      return dedupeStrings(pods.flatMap(getPodCandidateWebIds));
    } catch (error) {
      this.logger.warn(`Pod lookup unavailable for account ${accountId}: ${error}`);
      return [];
    }
  }

  private async isLinkedToAccount(webId: string, accountId: string): Promise<boolean> {
    if (await this.webIdStore.isLinked(webId, accountId)) {
      return true;
    }

    if (!this.podLookupRepository?.listByAccountId) {
      return false;
    }

    try {
      const pods = await this.podLookupRepository.listByAccountId(accountId);
      return pods.some((pod) => getPodCandidateWebIds(pod).includes(webId));
    } catch (error) {
      this.logger.warn(`Pod lookup unavailable for account ${accountId}: ${error}`);
      return false;
    }
  }

  private async isResolvableByCurrentSp(webId: string, target: TargetStorage): Promise<boolean> {
    if (target.serviceToken) {
      return (await this.resolveRemoteSpEntries([webId], target)).some((entry) => entry.webId === webId);
    }
    return Boolean(await this.findSpPod(webId, target.storageUrl));
  }

  private async findSpPod(webId: string, targetStorageUrl: string): Promise<PodLookupResult | undefined> {
    if (!this.podLookupRepository) {
      this.logger.warn('No PodLookupRepository configured; refusing to expose unscoped WebID choices');
      return undefined;
    }

    try {
      if (this.podLookupRepository.findAllByWebId) {
        const pods = await this.podLookupRepository.findAllByWebId(webId);
        return pods.find((pod) => matchesTargetStorage(pod, targetStorageUrl));
      }

      if (this.podLookupRepository.findByWebIds) {
        const pods = await this.podLookupRepository.findByWebIds([webId]);
        return pods.find((pod) => matchesTargetStorage(pod, targetStorageUrl));
      }

      const pod = await this.podLookupRepository.findByWebId(webId);
      return pod && matchesTargetStorage(pod, targetStorageUrl) ? pod : undefined;
    } catch (error) {
      this.logger.warn(`Pod lookup unavailable for WebID ${webId}: ${error}`);
      return undefined;
    }
  }

  private async resolveTargetStorage(
    provider: { issuer: string },
    oidcInteraction?: JsonInteractionHandlerInput['oidcInteraction'],
  ): Promise<TargetStorage> {
    const provisionCode = extractProvisionCode(oidcInteraction);
    if (!provisionCode) {
      return { storageUrl: ensureTrailingSlash(provider.issuer) };
    }

    const payload = new ProvisionCodeCodec(this.provisionBaseUrl ?? provider.issuer).decode(provisionCode);
    if (!payload) {
      throw new BadRequestHttpError('Invalid or expired provisionCode.');
    }

    const targetUrl = payload.spDomain
      ? `https://${payload.spDomain}`
      : payload.spUrl;
    return {
      storageUrl: ensureTrailingSlash(targetUrl),
      lookupUrl: ensureTrailingSlash(payload.spUrl),
      serviceToken: payload.serviceToken,
    };
  }

  private async resolveRemoteSpEntries(webIds: string[], target: TargetStorage): Promise<WebIdEntry[]> {
    if (!target.lookupUrl || !target.serviceToken || webIds.length === 0) {
      return [];
    }

    const response = await this.fetch(new URL('/provision/webids', target.lookupUrl).toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${target.serviceToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ webIds }),
    });

    if (!response.ok) {
      this.logger.warn(`Remote SP WebID lookup failed: HTTP ${response.status}`);
      return [];
    }

    const body = await response.json().catch(() => null) as { entries?: RemoteSpWebIdEntry[] } | null;
    if (!Array.isArray(body?.entries)) {
      return [];
    }

    const allowedWebIds = new Set(webIds);
    return body.entries
      .filter((entry) => typeof entry.webId === 'string' && allowedWebIds.has(entry.webId))
      .filter((entry) => typeof entry.storageUrl === 'string' && matchesTargetStorage(
        {
          podId: '',
          accountId: '',
          baseUrl: entry.podUrl ?? entry.storageUrl,
          storageUrl: entry.storageUrl,
        },
        target.storageUrl,
      ))
      .map((entry) => ({
        webId: entry.webId,
        storageUrl: ensureTrailingSlash(entry.storageUrl),
        storageMode: deriveStorageMode(entry.webId, entry.storageUrl),
      }));
  }
}

interface TargetStorage {
  storageUrl: string;
  lookupUrl?: string;
  serviceToken?: string;
}

interface RemoteSpWebIdEntry {
  webId: string;
  podUrl?: string;
  storageUrl: string;
}

function deriveStorageMode(webId: string, storageUrl: string): 'cloud' | 'local' | 'custom' {
  const webIdRoot = deriveStorageRoot(webId);
  const storageRoot = deriveStorageRoot(storageUrl);
  if (!webIdRoot || !storageRoot) {
    return 'custom';
  }
  return sameStorageRoot(webIdRoot, storageRoot) ? 'cloud' : 'local';
}

function deriveStorageRoot(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return ensureTrailingSlash(parsed.origin);
    }

    return ensureTrailingSlash(new URL(`/${segments[0]}/`, parsed.origin).toString());
  } catch {
    return undefined;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '') + '/';
}

function normalizeOptionalUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function getPodCandidateWebIds(pod: PodLookupResult): string[] {
  return dedupeStrings([
    pod.webId,
    ...(pod.webIds ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
}

function matchesTargetStorage(pod: PodLookupResult, targetStorageUrl: string): boolean {
  const candidateUrls = (pod.storageUrl ? [pod.storageUrl] : [pod.baseUrl])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const targetRoot = deriveStorageRoot(targetStorageUrl);
  if (!targetRoot) {
    return false;
  }

  for (const candidate of candidateUrls) {
    const candidateRoot = deriveStorageRoot(candidate);
    if (candidateRoot && sameStorageRoot(candidateRoot, targetRoot)) {
      return true;
    }

    if (sameStorageScope(candidate, targetRoot)) {
      return true;
    }
  }

  return false;
}

function sameStorageRoot(left: string, right: string): boolean {
  if (ensureTrailingSlash(left) === ensureTrailingSlash(right)) {
    return true;
  }

  const leftUrl = parseUrl(left);
  const rightUrl = parseUrl(right);
  if (!leftUrl || !rightUrl) {
    return false;
  }

  return sameUrlAuthority(leftUrl, rightUrl)
    && normalizeUrlPath(leftUrl.pathname) === normalizeUrlPath(rightUrl.pathname);
}

function sameStorageScope(candidate: string, targetRoot: string): boolean {
  const candidateUrl = parseUrl(candidate);
  const targetUrl = parseUrl(targetRoot);
  if (!candidateUrl || !targetUrl || !sameUrlAuthority(candidateUrl, targetUrl)) {
    return false;
  }

  const candidatePath = normalizeUrlPath(candidateUrl.pathname);
  const targetPath = normalizeUrlPath(targetUrl.pathname);
  return candidatePath.startsWith(targetPath) || targetPath.startsWith(candidatePath);
}

function sameUrlAuthority(left: URL, right: URL): boolean {
  if (left.protocol !== right.protocol) {
    return false;
  }

  if (normalizePort(left) !== normalizePort(right)) {
    return false;
  }

  if (left.hostname === right.hostname) {
    return true;
  }

  return isLoopbackHostname(left.hostname) && isLoopbackHostname(right.hostname);
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function normalizePort(url: URL): string {
  if (url.port) {
    return url.port;
  }

  if (url.protocol === 'http:') {
    return '80';
  }

  if (url.protocol === 'https:') {
    return '443';
  }

  return '';
}

function normalizeUrlPath(pathname: string): string {
  return ensureTrailingSlash(pathname || '/');
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function extractProvisionCode(oidcInteraction: JsonInteractionHandlerInput['oidcInteraction']): string | undefined {
  const params = oidcInteraction?.params as Record<string, unknown> | undefined;
  const value = params?.provisionCode;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
