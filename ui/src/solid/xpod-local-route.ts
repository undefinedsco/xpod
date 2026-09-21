import type {
  AccessRoute,
  AccessRouteHealth,
  AccessRouteKind,
  AccessRouteVisibility,
} from '@undefineds.co/solid-sdk/access-route';

/**
 * Ranked access routes for a Pod this browser talks to.
 *
 * A canonical URL is one identity reachable over several physical paths, and only
 * the client knows which path it is standing on (`docs/multi-channel-access.md`),
 * so a route set combines what this page can prove about itself (its own origin,
 * classified by where it is) with every access point the runtime reports. The SDK
 * orders and probes them, so the best route that answers wins and a path that
 * stops working is not a dead end.
 *
 * A route maps a canonical origin onto a reachable one and keeps the path, which
 * is what makes one route enough for the Pod, the service APIs beside it and the
 * notification channels below it.
 */
export type XpodLocalPodRoute = AccessRoute;

/** An access point the runtime reports; loopback and LAN are the client's own facts. */
export interface XpodAdvertisedAccessRoute {
  id: string;
  kind: AccessRouteKind;
  targetUrl: string;
  priority: number;
  requiresManagedClient?: boolean;
  visibility?: AccessRouteVisibility;
  health?: AccessRouteHealth;
}

export interface XpodProvisionRouteStatus {
  managed?: boolean;
  /** The node's canonical public URL, as reported by its own runtime. */
  storageRoot?: string;
  routes?: XpodAdvertisedAccessRoute[];
}

const ORIGIN_PRIORITY: Record<'loopback' | 'lan' | 'public-direct', number> = {
  loopback: 10,
  lan: 20,
  'public-direct': 30,
};

export async function currentHostLocalPodRoutes(
  storageUrl: string,
  fetchImpl: typeof fetch,
): Promise<XpodLocalPodRoute[]> {
  if (typeof window === 'undefined') return [];
  const status = await fetchCurrentProvisionRouteStatus(fetchImpl);
  return provisionLocalPodRoutes(storageUrl, status);
}

/**
 * Routes for a canonical storage URL, best first:
 *
 * 1. this page's own origin, which is the loopback or LAN path when the page is
 *    served from one, and the public path when it is served from the node's
 *    canonical domain;
 * 2. every access point the runtime reports (canonical public URL, tunnel).
 *
 * Passing the node's canonical origin instead of a Pod URL yields the routes that
 * are known before a Pod has been discovered.
 */
export function provisionLocalPodRoutes(
  storageUrl: string | undefined,
  status: XpodProvisionRouteStatus,
  currentHref: string = typeof window === 'undefined' ? '' : window.location.href,
): XpodLocalPodRoute[] {
  const page = safeUrl(currentHref);
  if (!page || !storageUrl) return [];

  const ownRoute = currentOriginRoute(storageUrl, status, page);
  return [...(ownRoute ? [ownRoute] : []), ...advertisedRoutes(storageUrl, status)]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

/**
 * The current page reaches a Pod hosted by its own Xpod on its own origin: the
 * desktop shell is the runtime's loopback origin, a phone on the LAN is its LAN
 * address, and a page served from the canonical domain is already public.
 */
function currentOriginRoute(
  storageUrl: string,
  status: XpodProvisionRouteStatus,
  page: URL,
): XpodLocalPodRoute | undefined {
  const storage = safeUrl(storageUrl);
  if (!storage || !['http:', 'https:'].includes(storage.protocol) || storage.username || storage.password) {
    return undefined;
  }
  if (!podBelongsToCurrentHost(storageUrl, status)) return undefined;

  const canonical = safeUrl(status.storageRoot ?? '') ?? storage;
  if (canonical.origin === page.origin) return undefined;

  const kind = currentOriginKind(page);
  return {
    id: `${kind}-current-origin`,
    kind,
    canonicalUrl: `${canonical.origin}/`,
    targetUrl: `${page.origin}/`,
    priority: ORIGIN_PRIORITY[kind],
    // A loopback target exists on this machine only; a LAN one on this network.
    requiresManagedClient: kind !== 'public-direct',
    visibility: kind === 'loopback' ? 'local-only' : 'same-account',
    health: 'healthy',
  };
}

/**
 * A route is only this page's own when the Pod is served by the Xpod this page
 * came from: the desktop shell runs on the node's host, and a browser has to be
 * told by that node's own runtime that it hosts the Pod. Another node's Pod keeps
 * its public route.
 */
function podBelongsToCurrentHost(storageUrl: string, status: XpodProvisionRouteStatus): boolean {
  if (typeof window !== 'undefined' && window.xpodDesktop) return true;
  if (status.managed !== true || typeof status.storageRoot !== 'string') return false;
  return coveredByStorageRoot(storageUrl, status.storageRoot);
}

function coveredByStorageRoot(storageUrl: string, storageRoot: string): boolean {
  const canonical = safeUrl(storageRoot);
  const storage = safeUrl(storageUrl);
  if (!canonical || !storage) return false;
  // An account binding records the canonical URL; anything below the node's
  // canonical origin is hosted by it.
  return storage.origin === canonical.origin
    || storage.href.startsWith(ensureTrailingSlash(canonical.href));
}

/**
 * Every access point the runtime reports describes the node's canonical origin,
 * so each one is already an origin-level route the caller only has to rank.
 */
function advertisedRoutes(
  storageUrl: string,
  status: XpodProvisionRouteStatus,
): XpodLocalPodRoute[] {
  const storage = safeUrl(storageUrl);
  if (!storage) return [];
  const canonicalBase = `${(safeUrl(status.storageRoot ?? '') ?? storage).origin}/`;
  return (status.routes ?? []).flatMap((route) => {
    const target = safeUrl(route.targetUrl);
    if (!target || !['http:', 'https:'].includes(target.protocol)) return [];
    return [{
      id: route.id,
      kind: route.kind,
      canonicalUrl: canonicalBase,
      targetUrl: `${target.origin}/`,
      priority: route.priority,
      requiresManagedClient: route.requiresManagedClient ?? true,
      visibility: route.visibility ?? 'public',
      health: route.health ?? 'unknown',
    }];
  });
}

function currentOriginKind(page: URL): 'loopback' | 'lan' | 'public-direct' {
  if (isLoopbackHostname(page.hostname)) return 'loopback';
  if (isPrivateNetworkHostname(page.hostname)) return 'lan';
  return 'public-direct';
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!octets) return hostname.endsWith('.local');
  const first = Number(octets[1]);
  const second = Number(octets[2]);
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

export async function fetchCurrentProvisionRouteStatus(
  fetchImpl: typeof fetch,
): Promise<XpodProvisionRouteStatus> {
  let response: Response | undefined;
  try {
    response = await fetchImpl(new URL('/provision/status', window.location.origin).href, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    return {};
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer().catch(() => undefined);
    return {};
  }
  const status = await response.json().catch(() => undefined) as {
    managed?: unknown;
    publicUrl?: unknown;
    routes?: unknown;
  } | undefined;
  return {
    managed: status?.managed === true,
    storageRoot: typeof status?.publicUrl === 'string' ? status.publicUrl : undefined,
    routes: normalizeAdvertisedAccessRoutes(status?.routes),
  };
}

export function normalizeAdvertisedAccessRoutes(value: unknown): XpodAdvertisedAccessRoute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const route = entry as Record<string, unknown>;
    if (typeof route.targetUrl !== 'string' || typeof route.kind !== 'string') return [];
    if (typeof route.priority !== 'number' || !Number.isFinite(route.priority)) return [];
    return [{
      id: typeof route.id === 'string' && route.id ? route.id : `${route.kind}-${route.targetUrl}`,
      kind: route.kind as AccessRouteKind,
      targetUrl: route.targetUrl,
      priority: route.priority,
      ...(typeof route.requiresManagedClient === 'boolean'
        ? { requiresManagedClient: route.requiresManagedClient }
        : {}),
      ...(typeof route.visibility === 'string' ? { visibility: route.visibility as AccessRouteVisibility } : {}),
      ...(typeof route.health === 'string' ? { health: route.health as AccessRouteHealth } : {}),
    }];
  });
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
