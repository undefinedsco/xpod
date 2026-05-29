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

interface ProvisionCodePayload {
  spUrl?: string;
  serviceToken?: string;
  spDomain?: string;
  exp?: number;
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
  if (!provisionCode) {
    return undefined;
  }

  const dotIndex = provisionCode.indexOf('.');
  if (dotIndex <= 0) {
    return undefined;
  }

  try {
    const data = provisionCode.slice(0, dotIndex);
    const payload = JSON.parse(base64UrlDecode(data)) as ProvisionCodePayload;
    const canonical = payload.spDomain ? `https://${payload.spDomain}` : payload.spUrl;
    const root = storageRootFromUrl(canonical);
    if (!root) {
      return undefined;
    }

    return {
      root,
      lookupUrl: payload.spUrl ? ensureTrailingSlash(payload.spUrl) : undefined,
      serviceToken: payload.serviceToken,
      mode: 'local',
    };
  } catch {
    return undefined;
  }
}

export function currentStorageScope(origin: string, provisionCode?: string): StorageScope | undefined {
  const provisionScope = parseProvisionScope(provisionCode);
  if (provisionScope) {
    return provisionScope;
  }

  const root = storageRootFromOrigin(origin);
  if (!root) {
    return undefined;
  }

  return {
    root,
    mode: 'cloud',
  };
}

export async function lookupProvisionScopedWebIds(
  fetchImpl: typeof fetch,
  webIds: string[],
  scope: StorageScope,
): Promise<ScopedWebIdEntry[]> {
  if (!scope.lookupUrl || !scope.serviceToken || webIds.length === 0) {
    return [];
  }

  const response = await fetchImpl(new URL('/provision/webids', scope.lookupUrl).toString(), {
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

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
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
