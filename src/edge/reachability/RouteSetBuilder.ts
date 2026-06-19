import type {
  AccessRoute,
  AccessRouteHealth,
  AccessRouteKind,
  AccessRouteVisibility,
  BuildRouteSetOptions,
  BuildRouteSetSource,
  RouteAudience,
  RouteSet,
} from './types';

const DEFAULT_PRIORITY: Record<AccessRouteKind, number> = {
  loopback: 10,
  lan: 20,
  'public-direct': 30,
  p2p: 40,
  'user-tunnel': 50,
  'xpod-relay': 90,
};

const PUBLIC_KINDS = new Set<AccessRouteKind>(['public-direct', 'user-tunnel', 'xpod-relay']);

export function buildRouteSet(source: BuildRouteSetSource, options: BuildRouteSetOptions = {}): RouteSet {
  const audience = options.audience ?? 'managed';
  const now = options.now ?? new Date();
  const metadata = source.metadata ?? {};
  const canonicalUrl = normalizeCanonicalUrl(
    source.canonicalUrl
      ?? getString(metadata.canonicalUrl)
      ?? getString(metadata.baseUrl)
      ?? source.publicUrl
      ?? deriveManagedDomainUrl(source.subdomain, options.baseStorageDomain ?? source.baseStorageDomain),
  );

  const routes = uniqueRoutes([
    ...routesFromMetadata(source, canonicalUrl, metadata),
    ...routesFromDirectCandidates(source, canonicalUrl, metadata),
    ...routesFromTunnel(source, canonicalUrl, metadata),
    ...routesFromConnectivity(source, canonicalUrl),
  ])
    .filter((route) => isVisibleToAudience(route, audience))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  return {
    nodeId: source.nodeId,
    canonicalUrl,
    generatedAt: now.toISOString(),
    routes,
  };
}

function routesFromMetadata(source: BuildRouteSetSource, canonicalUrl: string, metadata: Record<string, unknown>): AccessRoute[] {
  const rawRoutes = Array.isArray(metadata.routes) ? metadata.routes : [];
  return rawRoutes
    .map((value, index) => normalizeAccessRoute(source.nodeId, canonicalUrl, value, `metadata-${index}`))
    .filter((route): route is AccessRoute => Boolean(route));
}

function routesFromDirectCandidates(source: BuildRouteSetSource, canonicalUrl: string, metadata: Record<string, unknown>): AccessRoute[] {
  const candidates = [
    ...normalizeStringArray(source.metadata?.directCandidates),
    ...normalizeStringArray(metadata.directCandidates),
  ];
  return candidates
    .map((targetUrl, index) => normalizeAccessRoute(source.nodeId, canonicalUrl, {
      id: `public-direct-${index}`,
      kind: 'public-direct',
      targetUrl,
      priority: DEFAULT_PRIORITY['public-direct'],
      requiresManagedClient: false,
      visibility: 'public',
      health: source.connectivityStatus === 'unreachable' ? 'unreachable' : 'healthy',
    }, `public-direct-${index}`))
    .filter((route): route is AccessRoute => Boolean(route));
}

function routesFromTunnel(source: BuildRouteSetSource, canonicalUrl: string, metadata: Record<string, unknown>): AccessRoute[] {
  const tunnel = isRecord(metadata.tunnel) ? metadata.tunnel : undefined;
  const entrypoint = getString(tunnel?.entrypoint) ?? getString(tunnel?.endpoint) ?? getString(tunnel?.url);
  const status = getString(tunnel?.status);
  if (!entrypoint || status === 'inactive' || status === 'standby') {
    return [];
  }
  const route = normalizeAccessRoute(source.nodeId, canonicalUrl, {
    id: 'user-tunnel',
    kind: 'user-tunnel',
    targetUrl: entrypoint,
    priority: DEFAULT_PRIORITY['user-tunnel'],
    requiresManagedClient: false,
    visibility: 'public',
    health: status === 'error' ? 'degraded' : 'healthy',
    metadata: { tunnel },
  }, 'user-tunnel');
  return route ? [route] : [];
}

function routesFromConnectivity(source: BuildRouteSetSource, canonicalUrl: string): AccessRoute[] {
  if (!source.publicUrl || source.connectivityStatus === 'unreachable') {
    return [];
  }
  const route = normalizeAccessRoute(source.nodeId, canonicalUrl, {
    id: 'public-direct',
    kind: 'public-direct',
    targetUrl: source.publicUrl,
    priority: DEFAULT_PRIORITY['public-direct'],
    requiresManagedClient: false,
    visibility: 'public',
    health: source.connectivityStatus === 'reachable' ? 'healthy' : 'unknown',
  }, 'public-direct');
  return route ? [route] : [];
}

function normalizeAccessRoute(
  nodeId: string,
  canonicalUrl: string,
  value: unknown,
  fallbackId: string,
): AccessRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = normalizeKind(value.kind);
  const targetUrl = normalizeUrlString(getString(value.targetUrl));
  if (!kind || !targetUrl) {
    return undefined;
  }
  const visibility = normalizeVisibility(value.visibility) ?? defaultVisibility(kind);
  const requiresManagedClient = typeof value.requiresManagedClient === 'boolean'
    ? value.requiresManagedClient
    : visibility !== 'public';
  return {
    id: getString(value.id) ?? fallbackId,
    nodeId: getString(value.nodeId) ?? nodeId,
    canonicalUrl: normalizeCanonicalUrl(getString(value.canonicalUrl) ?? canonicalUrl),
    kind,
    targetUrl,
    priority: normalizePriority(value.priority) ?? DEFAULT_PRIORITY[kind],
    requiresManagedClient,
    visibility,
    health: normalizeHealth(value.health) ?? 'unknown',
    lastCheckedAt: getString(value.lastCheckedAt),
    expiresAt: getString(value.expiresAt),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function normalizeCanonicalUrl(value?: string): string {
  const normalized = normalizeUrlString(value);
  if (normalized) {
    return normalized;
  }
  return 'about:blank';
}

function normalizeUrlString(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function normalizeKind(value: unknown): AccessRouteKind | undefined {
  const kind = getString(value) as AccessRouteKind | undefined;
  return kind && kind in DEFAULT_PRIORITY ? kind : undefined;
}

function normalizeVisibility(value: unknown): AccessRouteVisibility | undefined {
  const visibility = getString(value) as AccessRouteVisibility | undefined;
  if (visibility === 'local-only' || visibility === 'same-account' || visibility === 'authorized-client' || visibility === 'public') {
    return visibility;
  }
  return undefined;
}

function normalizeHealth(value: unknown): AccessRouteHealth | undefined {
  const health = getString(value) as AccessRouteHealth | undefined;
  if (health === 'unknown' || health === 'healthy' || health === 'degraded' || health === 'unreachable') {
    return health;
  }
  return undefined;
}

function normalizePriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function defaultVisibility(kind: AccessRouteKind): AccessRouteVisibility {
  return PUBLIC_KINDS.has(kind) ? 'public' : 'authorized-client';
}

function isVisibleToAudience(route: AccessRoute, audience: RouteAudience): boolean {
  if (audience === 'managed') {
    return true;
  }
  return route.visibility === 'public' && !route.requiresManagedClient && PUBLIC_KINDS.has(route.kind);
}

function uniqueRoutes(routes: AccessRoute[]): AccessRoute[] {
  const byKey = new Map<string, AccessRoute>();
  for (const route of routes) {
    const key = `${route.kind}\n${route.targetUrl}`;
    const previous = byKey.get(key);
    if (!previous || route.priority < previous.priority) {
      byKey.set(key, route);
    }
  }
  return [...byKey.values()];
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function deriveManagedDomainUrl(subdomain?: string, baseStorageDomain?: string): string | undefined {
  if (!subdomain || !baseStorageDomain) {
    return undefined;
  }
  return `https://${subdomain}.${baseStorageDomain}/`;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
