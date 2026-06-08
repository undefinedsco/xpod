export interface ProvisionScopePayload {
  spUrl: string;
  serviceToken: string;
  spDomain?: string;
  exp?: number;
}

export interface ProvisionScopedWebIdEntry {
  webId: string;
  podUrl?: string;
  storageUrl: string;
}

export interface ProvisionScope {
  lookupUrl: string;
  storageRoot: string;
  serviceToken: string;
}

export interface StorageScopedWebIdEntry {
  webId: string;
  storageUrl: string;
}

export function decodeProvisionScopePayload(provisionCode: string | undefined | null): ProvisionScopePayload | undefined {
  if (!provisionCode) {
    return undefined;
  }

  const data = provisionCode.split('.')[0];
  if (!data) {
    return undefined;
  }

  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof globalThis.atob !== 'function') {
      return undefined;
    }
    const bytes = Uint8Array.from(globalThis.atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProvisionScopePayload>;

    if (typeof payload.spUrl !== 'string' || typeof payload.serviceToken !== 'string') {
      return undefined;
    }
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }

    return {
      spUrl: ensureTrailingSlash(payload.spUrl),
      serviceToken: payload.serviceToken,
      spDomain: typeof payload.spDomain === 'string' ? payload.spDomain : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    };
  } catch {
    return undefined;
  }
}

export function resolveProvisionScope(provisionCode: string | undefined | null): ProvisionScope | undefined {
  const payload = decodeProvisionScopePayload(provisionCode);
  if (!payload) {
    return undefined;
  }

  return {
    lookupUrl: payload.spUrl,
    storageRoot: payload.spDomain
      ? ensureTrailingSlash(`https://${payload.spDomain}`)
      : ensureTrailingSlash(payload.spUrl),
    serviceToken: payload.serviceToken,
  };
}

export async function lookupProvisionScopedWebIds(
  fetchImpl: typeof fetch,
  webIds: string[],
  provisionCode: string | undefined | null,
): Promise<ProvisionScopedWebIdEntry[] | undefined> {
  const scope = resolveProvisionScope(provisionCode);
  if (!scope) {
    return undefined;
  }

  const candidates = Array.from(new Set(webIds.filter((webId) => typeof webId === 'string' && webId.length > 0)));
  if (candidates.length === 0) {
    return [];
  }

  const response = await fetchImpl(new URL('/provision/webids', scope.lookupUrl).toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${scope.serviceToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ webIds: candidates }),
  });
  if (!response.ok) {
    return [];
  }

  const body = await response.json().catch(() => undefined) as { entries?: ProvisionScopedWebIdEntry[] } | undefined;
  if (!Array.isArray(body?.entries)) {
    return [];
  }

  const allowed = new Set(candidates);
  return body.entries
    .filter((entry) => entry && typeof entry.webId === 'string' && allowed.has(entry.webId))
    .filter((entry) => typeof entry.storageUrl === 'string' && entry.storageUrl.length > 0)
    .filter((entry) => storageUrlBelongsToRoot(entry.storageUrl, scope.storageRoot))
    .map((entry) => ({
      webId: entry.webId,
      podUrl: typeof entry.podUrl === 'string' ? ensureTrailingSlash(entry.podUrl) : undefined,
      storageUrl: ensureTrailingSlash(entry.storageUrl),
    }));
}

export async function filterWebIdsByStorageRoot(
  fetchImpl: typeof fetch,
  webIds: string[],
  storageRoot: string | undefined,
): Promise<StorageScopedWebIdEntry[]> {
  const root = normalizeStorageRoot(storageRoot);
  if (!root) {
    return [];
  }

  const uniqueWebIds = Array.from(new Set(webIds.filter((webId) => typeof webId === 'string' && webId.length > 0)));
  const entries = await Promise.all(uniqueWebIds.map(async (webId) => {
    const storageUrls = await fetchProfileStorageUrls(fetchImpl, webId);
    const storageUrl = storageUrls.find((candidate) => storageUrlBelongsToRoot(candidate, root));
    return storageUrl ? { webId, storageUrl: ensureTrailingSlash(storageUrl) } : undefined;
  }));

  return entries.filter((entry): entry is StorageScopedWebIdEntry => Boolean(entry));
}

export function storageUrlBelongsToRoot(storageUrl: string, storageRoot: string | undefined): boolean {
  const normalizedStorageUrl = normalizeStorageUrl(storageUrl);
  const normalizedRoot = normalizeStorageRoot(storageRoot);
  return Boolean(normalizedStorageUrl && normalizedRoot && normalizedStorageUrl.startsWith(normalizedRoot));
}

export function storageRootFromOrigin(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  try {
    return ensureTrailingSlash(new URL(origin).origin);
  } catch {
    return undefined;
  }
}

export function normalizeStorageRoot(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return ensureTrailingSlash(new URL(url).toString());
  } catch {
    return undefined;
  }
}

async function fetchProfileStorageUrls(fetchImpl: typeof fetch, webId: string): Promise<string[]> {
  const response = await fetchImpl(webId, {
    headers: {
      Accept: 'text/turtle, application/ld+json, application/json',
    },
    credentials: 'include',
  } as RequestInit).catch(() => undefined);
  if (!response?.ok) {
    return [];
  }

  const contentType = response.headers?.get?.('content-type') ?? '';
  const body = await response.text().catch(() => '');
  if (!body) {
    return [];
  }

  if (contentType.includes('json')) {
    try {
      return extractStorageUrlsFromJson(JSON.parse(body));
    } catch {
      return [];
    }
  }

  return extractStorageUrlsFromTurtle(body);
}

function extractStorageUrlsFromTurtle(body: string): string[] {
  return Array.from(body.matchAll(/(?:solid:storage|<http:\/\/www\.w3\.org\/ns\/solid\/terms#storage>)\s+<([^>]+)>/giu))
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function extractStorageUrlsFromJson(value: unknown): string[] {
  const urls = new Set<string>();
  const seen = new WeakSet<object>();

  const visit = (node: unknown, underStorage = false): void => {
    if (typeof node === 'string') {
      if (underStorage) {
        urls.add(node);
      }
      return;
    }

    if (!node || typeof node !== 'object') {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, underStorage);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(node)) {
      const childIsStorage = childKey === 'solid:storage' || childKey === 'http://www.w3.org/ns/solid/terms#storage';
      if (underStorage && childKey === '@id') {
        visit(childValue, true);
        continue;
      }
      visit(childValue, underStorage || childIsStorage);
    }
  };

  visit(value);
  return Array.from(urls);
}

function normalizeStorageUrl(url: string): string | undefined {
  try {
    return ensureTrailingSlash(new URL(url).toString());
  } catch {
    return undefined;
  }
}

export function ensureTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '') + '/';
}
