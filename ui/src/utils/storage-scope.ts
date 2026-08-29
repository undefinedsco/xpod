import { decodeProvisionScopePayload } from './provision-scope';

export type StorageMode = 'cloud' | 'local' | 'custom';

export interface StorageScope {
  root: string;
  lookupUrl?: string;
  serviceToken?: string;
  mode: StorageMode;
}

export interface ScopedWebIdEntry {
  webId: string;
  storageUrl: string;
  storageMode?: StorageMode;
}

export function ensureTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '') + '/';
}

export function safeUrl(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function storageRootFromUrl(value: string | undefined): string | undefined {
  const url = safeUrl(value);
  if (!url) {
    return undefined;
  }

  return ensureTrailingSlash(url.toString());
}

export function storageRootFromOrigin(origin: string): string | undefined {
  return storageRootFromUrl(origin);
}

export function storageUrlBelongsToRoot(storageUrl: string | undefined, root: string | undefined): boolean {
  const storage = safeUrl(storageUrl);
  const scope = safeUrl(root);
  if (!storage || !scope) {
    return false;
  }

  if (storage.origin !== scope.origin) {
    return false;
  }

  const scopePath = ensurePathScope(scope.pathname);
  return storage.pathname === scopePath || storage.pathname.startsWith(scopePath);
}

export function storageModeFor(webId: string | undefined, storageUrl: string | undefined): StorageMode {
  const webIdUrl = safeUrl(webId);
  const storage = safeUrl(storageUrl);
  if (!webIdUrl || !storage) {
    return 'custom';
  }

  return webIdUrl.origin === storage.origin ? 'cloud' : 'local';
}

export function formatStorageHost(storageUrl: string | undefined): string {
  return safeUrl(storageUrl)?.host ?? 'unavailable';
}

export function parseProvisionScope(provisionCode: string | undefined): StorageScope | undefined {
  const payload = decodeProvisionScopePayload(provisionCode);
  if (!payload) {
    return undefined;
  }
  const canonical = payload.spDomain ? `https://${payload.spDomain}` : payload.spUrl;
  const root = storageRootFromUrl(canonical);
  if (!root) {
    return undefined;
  }

  return {
    root,
    lookupUrl: ensureTrailingSlash(payload.spUrl),
    serviceToken: payload.serviceToken,
    mode: 'local',
  };
}

export function currentStorageScope(_origin: string, provisionCode?: string): StorageScope | undefined {
  const provisionScope = parseProvisionScope(provisionCode);
  if (provisionScope) {
    return provisionScope;
  }

  // The account UI can be served through Vite, the desktop shell, or the
  // Gateway while the actual Pod lives at its Cloud-assigned canonical URL.
  // A browser origin is therefore not a storage authority. Only a signed
  // provision code may narrow the account view to one hosted storage root.
  return undefined;
}

export async function lookupProvisionScopedWebIds(
  fetchImpl: typeof fetch,
  webIds: string[],
  scope: StorageScope,
): Promise<ScopedWebIdEntry[]> {
  if (!scope.lookupUrl || !scope.serviceToken || webIds.length === 0) {
    return [];
  }

  const lookupUrl = currentLoopbackLookupUrl() ?? scope.lookupUrl;
  const response = await fetchImpl(new URL('/provision/webids', lookupUrl).toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${scope.serviceToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ webIds }),
  });
  if (!response.ok) {
    return [];
  }

  const body = await response.json().catch(() => null) as { entries?: Array<{ webId?: string; storageUrl?: string; storageMode?: StorageMode }> } | null;
  if (!Array.isArray(body?.entries)) {
    return [];
  }

  const allowed = new Set(webIds);
  return body.entries
    .filter((entry): entry is { webId: string; storageUrl: string; storageMode?: StorageMode } =>
      typeof entry.webId === 'string' &&
      typeof entry.storageUrl === 'string' &&
      allowed.has(entry.webId) &&
      storageUrlBelongsToRoot(entry.storageUrl, scope.root))
    .map((entry) => ({
      webId: entry.webId,
      storageUrl: ensureTrailingSlash(entry.storageUrl),
      storageMode: entry.storageMode ?? storageModeFor(entry.webId, entry.storageUrl),
    }));
}

function currentLoopbackLookupUrl(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  try {
    const url = new URL(window.location.href);
    return isLoopbackHostname(url.hostname) ? ensureTrailingSlash(url.origin) : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

export function scopedEntriesFromPods(webIds: string[], podUrls: string[], scope: StorageScope): ScopedWebIdEntry[] {
  const scopedPods = podUrls.filter((podUrl) => storageUrlBelongsToRoot(podUrl, scope.root));
  if (scopedPods.length === 0) {
    return [];
  }

  const entries: ScopedWebIdEntry[] = [];
  for (const webId of webIds) {
    const mode = storageModeFor(webId, scope.root);
    if (scope.mode !== 'local' && mode !== scope.mode) {
      continue;
    }

    const candidatePods = mode === 'cloud'
      ? scopedPods.filter((podUrl) => storageUrlMatchesWebIdSlug(podUrl, webId))
      : scopedPods.filter((podUrl) => storageSlugMatchesWebIdSlug(podUrl, webId));
    for (const storageUrl of candidatePods) {
      entries.push({
        webId,
        storageUrl: ensureTrailingSlash(storageUrl),
        storageMode: storageModeFor(webId, storageUrl),
      });
    }
  }

  return dedupeScopedEntries(entries);
}

export function dedupeScopedEntries(entries: ScopedWebIdEntry[]): ScopedWebIdEntry[] {
  const seen = new Set<string>();
  const out: ScopedWebIdEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.webId}\n${entry.storageUrl}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function ensurePathScope(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function storageUrlMatchesWebIdSlug(storageUrl: string, webId: string): boolean {
  const storage = safeUrl(storageUrl);
  const identity = safeUrl(webId);
  if (!storage || !identity || storage.origin !== identity.origin) {
    return false;
  }

  const [storageSlug] = storage.pathname.split('/').filter(Boolean);
  const [webIdSlug] = identity.pathname.split('/').filter(Boolean);
  return Boolean(storageSlug && webIdSlug && storageSlug === webIdSlug);
}

function storageSlugMatchesWebIdSlug(storageUrl: string, webId: string): boolean {
  const storage = safeUrl(storageUrl);
  const identity = safeUrl(webId);
  if (!storage || !identity) {
    return false;
  }

  const [storageSlug] = storage.pathname.split('/').filter(Boolean);
  const [webIdSlug] = identity.pathname.split('/').filter(Boolean);
  return Boolean(storageSlug && webIdSlug && storageSlug === webIdSlug);
}
