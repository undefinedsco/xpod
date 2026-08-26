import { decodeProvisionScopePayload } from './provision-scope';

export type StorageMode = 'cloud' | 'local' | 'custom';

export interface StorageScope {
  root: string;
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
    mode: 'local',
  };
}

export function currentStorageScope(_origin: string, provisionCode?: string): StorageScope | undefined {
  const provisionScope = parseProvisionScope(provisionCode);
  if (provisionScope) {
    return provisionScope;
  }

  // The account UI may be served by Vite, the desktop shell, the Gateway, or
  // the Cloud IdP. Its browser origin is not evidence of Pod storage
  // authority. Only a signed provision code may scope this view to one Local
  // storage provider.
  return undefined;
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
