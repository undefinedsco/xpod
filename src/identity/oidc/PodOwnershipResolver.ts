import { getLoggerFor } from 'global-logger-factory';
import type { PodStore, WebIdStore } from '@solid/community-server';

export interface PodOwnershipTarget {
  storageUrl: string;
  lookupUrl?: string;
  serviceAccessToken?: string;
}

export interface OwnedWebIdEntry {
  webId: string;
  storageUrl: string;
  storageMode: 'cloud' | 'local' | 'custom';
}

export interface PodOwnershipResolver {
  listAccountWebIds(accountId: string): Promise<string[]>;
  resolveOwnedWebIds(input: {
    accountId: string;
    candidateWebIds: string[];
    target: PodOwnershipTarget;
  }): Promise<OwnedWebIdEntry[]>;
}

interface ResolverLogger {
  warn(message: string): void;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CssPodOwnershipResolverOptions {
  webIdStore: WebIdStore;
  podStore: PodStore;
  /** Optional fetch implementation for remote resolution; local resolution never uses it. */
  fetch?: FetchLike;
  logger?: ResolverLogger;
}

/**
 * Resolves account WebID ownership from the CSS identity stores in this process.
 *
 * This resolver deliberately does not inspect Pod data directories or open a
 * second database connection. A target carrying remote lookup credentials is
 * verified through the target SP's provision lookup endpoint.
 */
export class CssPodOwnershipResolver implements PodOwnershipResolver {
  private readonly logger: ResolverLogger;
  private readonly webIdStore: WebIdStore;
  private readonly podStore: PodStore;
  private readonly fetch: FetchLike;

  public constructor(options: CssPodOwnershipResolverOptions) {
    this.webIdStore = options.webIdStore;
    this.podStore = options.podStore;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger ?? getLoggerFor(this);
  }

  public async listAccountWebIds(accountId: string): Promise<string[]> {
    try {
      const links = await this.webIdStore.findLinks(accountId);
      if (!Array.isArray(links)) {
        return [];
      }

      return dedupeStrings(links
        .map((link) => link?.webId)
        .filter((webId): webId is string => typeof webId === 'string' && webId.length > 0));
    } catch {
      this.warnStoreFailure('WebID links');
      return [];
    }
  }

  public async resolveOwnedWebIds({ accountId, candidateWebIds, target }: {
    accountId: string;
    candidateWebIds: string[];
    target: PodOwnershipTarget;
  }): Promise<OwnedWebIdEntry[]> {
    if (target.lookupUrl || target.serviceAccessToken) {
      if (!target.lookupUrl || !target.serviceAccessToken) {
        this.logger.warn('Pod ownership remote target is missing verification credentials; refusing unverified WebIDs');
        return [];
      }
      return this.resolveRemoteOwnedWebIds(candidateWebIds, target);
    }

    const accountWebIds = new Set(await this.listAccountWebIds(accountId));
    const candidates = new Set(dedupeStrings(candidateWebIds.filter(isNonEmptyString))
      .filter((webId) => accountWebIds.has(webId)));
    if (candidates.size === 0) {
      return [];
    }

    let pods: Array<{ id: string; baseUrl: string }>;
    try {
      pods = await this.podStore.findPods(accountId);
    } catch {
      this.warnStoreFailure('Pod list');
      return [];
    }

    const entries: OwnedWebIdEntry[] = [];
    const resolvedWebIds = new Set<string>();

    for (const pod of pods ?? []) {
      if (!pod || typeof pod.id !== 'string' || typeof pod.baseUrl !== 'string' || pod.baseUrl.length === 0) {
        continue;
      }
      if (!matchesTargetStorage(pod.baseUrl, target.storageUrl)) {
        continue;
      }

      let owners: Array<{ webId: string; visible: boolean }> | undefined;
      try {
        owners = await this.podStore.getOwners(pod.id);
      } catch {
        this.warnStoreFailure('Pod owners');
        continue;
      }

      for (const owner of owners ?? []) {
        const webId = owner?.webId;
        if (!isNonEmptyString(webId) || !candidates.has(webId) || resolvedWebIds.has(webId)) {
          continue;
        }

        const storageUrl = ensureTrailingSlash(pod.baseUrl);
        entries.push({
          webId,
          storageUrl,
          storageMode: deriveStorageMode(webId, storageUrl),
        });
        resolvedWebIds.add(webId);
      }
    }

    return entries;
  }

  private async resolveRemoteOwnedWebIds(
    candidateWebIds: string[],
    target: PodOwnershipTarget,
  ): Promise<OwnedWebIdEntry[]> {
    const candidates = candidateWebIds.filter(isNonEmptyString);
    if (candidates.length === 0 || !target.lookupUrl || !target.serviceAccessToken) {
      return [];
    }

    let lookupUrl: string;
    try {
      lookupUrl = new URL('/provision/webids', target.lookupUrl).toString();
    } catch {
      this.warnRemoteFailure();
      return [];
    }

    let response: Response;
    try {
      response = await this.fetch(lookupUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${target.serviceAccessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ webIds: candidates }),
      });
    } catch {
      this.warnRemoteFailure();
      return [];
    }

    if (!response?.ok) {
      this.warnRemoteFailure();
      return [];
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      this.warnRemoteFailure();
      return [];
    }

    if (!isRecord(body) || !Array.isArray(body.entries)) {
      this.warnRemoteFailure();
      return [];
    }

    const allowedWebIds = new Set(candidates);
    const resolvedWebIds = new Set<string>();
    const entries: OwnedWebIdEntry[] = [];
    for (const entry of body.entries) {
      if (!isRecord(entry)
        || typeof entry.webId !== 'string'
        || !allowedWebIds.has(entry.webId)
        || resolvedWebIds.has(entry.webId)
        || typeof entry.storageUrl !== 'string'
        || ('podUrl' in entry && entry.podUrl !== undefined && typeof entry.podUrl !== 'string')) {
        continue;
      }

      const podUrl = entry.podUrl as string | undefined;
      if (!matchesTargetStorage(entry.storageUrl, target.storageUrl)
        || (podUrl !== undefined && !matchesTargetStorage(podUrl, target.storageUrl))) {
        continue;
      }

      const storageUrl = ensureTrailingSlash(entry.storageUrl);
      entries.push({
        webId: entry.webId,
        storageUrl,
        storageMode: deriveStorageMode(entry.webId, storageUrl),
      });
      resolvedWebIds.add(entry.webId);
    }

    return entries;
  }

  private warnRemoteFailure(): void {
    // Never include the caught error, response body, or credentials: upstream
    // services can echo sensitive values in either.
    this.logger.warn('Remote Pod ownership lookup failed; refusing unverified WebIDs');
  }

  private warnStoreFailure(operation: string): void {
    // Never include the caught error: database drivers can echo connection
    // strings or credentials in their messages.
    this.logger.warn(`Pod ownership ${operation} lookup failed; refusing unverified WebIDs`);
  }
}

/**
 * Derives the same cloud/local/custom classification used by scoped consent.
 */
export function deriveStorageMode(webId: string, storageUrl: string): 'cloud' | 'local' | 'custom' {
  const webIdRoot = deriveStorageRoot(webId);
  const storageRoot = deriveStorageRoot(storageUrl);
  if (!webIdRoot || !storageRoot) {
    return 'custom';
  }
  return sameStorageRoot(webIdRoot, storageRoot) ? 'cloud' : 'local';
}

/**
 * Matches a Pod base URL against the selected storage root. Hostname aliases
 * for loopback (localhost, 127.0.0.1, and ::1) are intentionally equivalent.
 */
export function matchesTargetStorage(candidate: string, targetStorageUrl: string): boolean {
  const targetRoot = deriveStorageRoot(targetStorageUrl);
  if (!targetRoot) {
    return false;
  }

  const candidateRoot = deriveStorageRoot(candidate);
  if (candidateRoot && sameStorageRoot(candidateRoot, targetRoot)) {
    return true;
  }

  return sameStorageScope(candidate, targetRoot);
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

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
