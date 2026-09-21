import { createSolidLocalRouteFetch, type SolidLocalRoute } from './local-route-fetch'

/**
 * Access routes for a node whose canonical URL never changes.
 *
 * A Pod's canonical URL is its RDF identity (`docs/multi-channel-access.md`), and
 * the same identity can be reached over several physical paths: the node's own
 * loopback listener, a LAN address, a public address, a hole-punched p2p socket
 * or the user's tunnel. Callers pick by *where they are*, so the routes carry the
 * priority that encodes it and the health that says whether it currently works.
 */
export type AccessRouteKind =
  | 'loopback'
  | 'lan'
  | 'public-direct'
  | 'p2p'
  | 'user-tunnel'
  | 'xpod-relay'

export type AccessRouteVisibility = 'local-only' | 'same-account' | 'authorized-client' | 'public'

export type AccessRouteHealth = 'unknown' | 'healthy' | 'degraded' | 'unreachable'

export interface AccessRoute {
  id: string
  nodeId?: string
  /** The canonical origin this route serves. Requests keep this identity. */
  canonicalUrl: string
  kind: AccessRouteKind
  /** Where the request is actually sent. */
  targetUrl: string
  /** Lower wins. Loopback is 10, lan 20, public-direct 30, p2p 40, tunnel 50. */
  priority: number
  requiresManagedClient?: boolean
  visibility?: AccessRouteVisibility
  health?: AccessRouteHealth
  metadata?: Record<string, unknown>
}

export interface AccessRouteSet {
  nodeId?: string
  canonicalUrl: string
  generatedAt?: string
  routes: readonly AccessRoute[]
}

export interface ChooseAccessRouteOptions {
  /** A client that may use private routes (LAN, p2p, tunnel). */
  managedClient?: boolean
  /**
   * A client running on the node's own host may use `local-only` routes. It has
   * to say so: a loopback target is meaningless anywhere else.
   */
  allowLocalOnlyRoutes?: boolean
  probeTimeoutMs?: number
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean
}

/**
 * Pick the best route that actually answers: candidates are ordered by priority
 * and probed in parallel, so a same-machine client lands on loopback while a
 * remote one skips it without waiting for it to time out.
 */
export async function chooseAccessRoute(
  routeSet: AccessRouteSet,
  options: ChooseAccessRouteOptions = {},
): Promise<AccessRoute | null> {
  const candidates = usableRoutes(
    routeSet,
    options.managedClient ?? true,
    options.allowLocalOnlyRoutes ?? false,
  )
  if (candidates.length === 0) {
    return null
  }

  const probe = options.probe ?? defaultProbe
  const timeoutMs = options.probeTimeoutMs ?? 1_000
  const results = await Promise.all(candidates.map(async (route) => ({
    route,
    ok: await probeWithTimeout(route, probe, timeoutMs),
  })))

  return results.find((result) => result.ok)?.route ?? null
}

export function usableRoutes(
  routeSet: AccessRouteSet,
  managedClient: boolean,
  allowLocalOnlyRoutes: boolean,
): AccessRoute[] {
  return routeSet.routes
    .filter((route) => route.health !== 'unreachable')
    .filter((route) => managedClient || !route.requiresManagedClient)
    .filter((route) => allowLocalOnlyRoutes || route.visibility !== 'local-only')
    .slice()
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
}

export interface CreateSolidAccessRouteFetchOptions {
  fetch: typeof globalThis.fetch
  /** Current route set. Re-read on every request so a caller can refresh it. */
  routes: () => readonly AccessRoute[]
  /**
   * Re-discover the routes after the selected one stops working, which is how a
   * client keeps using the newest path it knows about.
   */
  refreshRoutes?: () => Promise<readonly AccessRoute[] | void> | readonly AccessRoute[] | void
  managedClient?: boolean
  /** Set by clients that run on the node's own host (`local-only` routes). */
  allowLocalOnlyRoutes?: boolean
  probeTimeoutMs?: number
  probe?: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean
}

/**
 * A fetch that keeps canonical URLs canonical while sending the request over the
 * best route this client can use.
 *
 * Canonical identity is preserved end to end: the target URL is rewritten, the
 * canonical host travels in the `x-xpod-canonical-*` headers, and the response
 * reports its canonical URL again. When the chosen route stops answering, the
 * routes are refreshed and the request is retried once against the new best one.
 */
export function createSolidAccessRouteFetch(
  options: CreateSolidAccessRouteFetchOptions,
): typeof globalThis.fetch {
  const managedClient = options.managedClient ?? true
  let selected: AccessRoute | undefined

  const selectRoute = async (): Promise<AccessRoute | null> => {
    const routeSet: AccessRouteSet = {
      canonicalUrl: options.routes()[0]?.canonicalUrl ?? '',
      routes: options.routes(),
    }
    const candidate = await chooseAccessRoute(routeSet, {
      managedClient,
      ...(options.allowLocalOnlyRoutes === undefined
        ? {}
        : { allowLocalOnlyRoutes: options.allowLocalOnlyRoutes }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
    })
    selected = candidate ?? undefined
    return candidate
  }

  const routeFor = async (): Promise<AccessRoute | undefined> => {
    if (selected && options.routes().some((route) => route.id === selected?.id && route.targetUrl === selected?.targetUrl)) {
      return selected
    }
    return (await selectRoute()) ?? undefined
  }

  const routedFetchFor = (route: AccessRoute): typeof globalThis.fetch =>
    createSolidLocalRouteFetch({
      fetch: options.fetch,
      routes: (): readonly SolidLocalRoute[] => [{
        canonicalBaseUrl: route.canonicalUrl,
        localBaseUrl: route.targetUrl,
      }],
    })

  return async (input, init) => {
    const route = await routeFor()
    if (!route) {
      return init === undefined
        ? options.fetch.call(globalThis, input)
        : options.fetch.call(globalThis, input, init)
    }

    try {
      return await routedFetchFor(route)(input, init)
    } catch (error) {
      // The route went away (laptop moved networks, tunnel restarted). Ask for
      // the current set once and retry against whatever is best now.
      selected = undefined
      await options.refreshRoutes?.()
      const retryRoute = await selectRoute()
      if (!retryRoute || retryRoute.id === route.id) {
        throw error
      }
      return routedFetchFor(retryRoute)(input, init)
    }
  }
}

async function probeWithTimeout(
  route: AccessRoute,
  probe: (route: AccessRoute, signal: AbortSignal) => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await Promise.resolve(probe(route, controller.signal))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function defaultProbe(route: AccessRoute, signal: AbortSignal): Promise<boolean> {
  if (!route.targetUrl.startsWith('http://') && !route.targetUrl.startsWith('https://')) {
    // Non-HTTP routes (p2p sockets) report their own readiness.
    return route.health === 'healthy'
  }
  const response = await fetch(new URL('/.well-known/solid', route.targetUrl), {
    method: 'HEAD',
    signal,
  })
  return response.ok || response.status === 401 || response.status === 403
}
