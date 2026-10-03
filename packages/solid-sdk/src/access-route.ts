import { createSolidLocalRouteFetch, resolveSolidLocalRouteUrl, type SolidLocalRoute } from './local-route-fetch'

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
 * Pick the best route that is known to work: candidates are ordered by priority,
 * and only the ones this client cannot vouch for are probed.
 *
 * A route the client already knows is up is never probed. The current origin
 * served this very document, and the node's own runtime reports the health of
 * the routes beside it, so a probe could only replace a known fact with a guess.
 * That guess is what made local login fail: the local gateway answers the probe
 * path with 405 (CSS does not implement the optional `/.well-known/solid`), the
 * probe called the one reachable route dead, and the client fell back to a
 * canonical URL it could not reach.
 *
 * Probes remain for candidates whose health is unknown, and are run in parallel
 * so a same-machine client still lands on loopback without waiting for a remote
 * one to time out.
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

  const best = candidates[0]!
  if (isSelfProvenRoute(best)) {
    return best
  }

  const probe = options.probe ?? defaultProbe
  const timeoutMs = options.probeTimeoutMs ?? 1_000
  const results = await Promise.all(candidates.map(async (route) => ({
    route,
    ok: isSelfProvenRoute(route) || await probeWithTimeout(route, probe, timeoutMs),
  })))

  return results.find((result) => result.ok)?.route ?? null
}

/**
 * A route this client can vouch for without asking: `healthy` is the runtime's
 * own report about its own node, and the current-origin route is the document
 * this client is already running in. `unknown` and `degraded` still get probed.
 */
function isSelfProvenRoute(route: AccessRoute): boolean {
  return route.health === 'healthy'
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
 * routes are refreshed and a read is retried once against the new best one.
 * Writes report the failure because the original request may have been accepted.
 */
export function createSolidAccessRouteFetch(
  options: CreateSolidAccessRouteFetchOptions,
): typeof globalThis.fetch {
  const managedClient = options.managedClient ?? true
  let selected: AccessRoute | undefined
  const selectRoute = async (excluded?: string): Promise<AccessRoute | null> => {
    const all = options.routes()
    // Exclude the failed path only for this request's retry. A later explicit
    // request can try it again after a transient failure.
    const routes = excluded === undefined ? all : all.filter((route) => routeKey(route) !== excluded)
    const routeSet: AccessRouteSet = {
      canonicalUrl: routes[0]?.canonicalUrl ?? '',
      routes,
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

  /**
   * Whether this client knows a route for the URL: the URLs it may rewrite and
   * therefore the only ones it is entitled to judge. Everything else — the IdP,
   * another Pod — is sent unchanged, whatever the routes are doing.
   */
  const routeCovers = (url: URL): boolean =>
    Boolean(resolveSolidLocalRouteUrl(url, options.routes().map(toLocalRoute)))

  /**
   * The URL a request would have to reach if it is sent unchanged, when sending
   * it unchanged is *not* the path this client meant to take.
   *
   * A URL no route covers is none of our business — the IdP, another Pod — and is
   * passed through as before. A URL whose origin is where the best route would
   * have sent it is already its own physical address, so passing it through is
   * exactly what that route would have done. Anything else means the client
   * knows a shorter path and has none usable: sending the request to the
   * canonical URL anyway would leave over a path this client cannot reach, and
   * that has to be reported (with the candidates) instead of quietly attempted.
   */
  const unreachablePassThrough = (input: RequestInfo | URL): URL | undefined => {
    const url = requestUrl(input)
    if (!url || !routeCovers(url)) {
      return undefined
    }
    const routes = options.routes()
    const preferred = usableRoutes(
      { canonicalUrl: routes[0]?.canonicalUrl ?? '', routes },
      managedClient,
      options.allowLocalOnlyRoutes ?? false,
    )[0]
    if (!preferred || sameOrigin(preferred.targetUrl, url)) {
      return undefined
    }
    return url
  }

  return async (input, init) => {
    // IdP and other origins are not node-route candidates. A failure there
    // must not mark a node route dead or replay an unrelated token exchange.
    const sourceUrl = requestUrl(input)
    if (!sourceUrl || !routeCovers(sourceUrl)) {
      return init === undefined
        ? options.fetch.call(globalThis, input)
        : options.fetch.call(globalThis, input, init)
    }
    const route = await routeFor()
    if (!route) {
      const unreachable = unreachablePassThrough(input)
      if (unreachable) {
        throw new NoUsableAccessRouteError(unreachable.href, options.routes())
      }
      return init === undefined
        ? options.fetch.call(globalThis, input)
        : options.fetch.call(globalThis, input, init)
    }

    try {
      const response = await routedFetchFor(route)(input, init)
      return response
    } catch (error) {
      // The route went away (laptop moved networks, tunnel restarted, or the
      // runtime reported a health it cannot back up). Ask for the current set
      // once and retry against whatever is best now, without this one.
      selected = undefined
      // A lost response cannot prove a mutation was refused. Select a new
      // path for future calls, but never repeat a possibly accepted write.
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) throw error
      await options.refreshRoutes?.()
      const retryRoute = await selectRoute(routeKey(route))
      if (retryRoute && routeKey(retryRoute) !== routeKey(route)) {
        return routedFetchFor(retryRoute)(input, init)
      }
      // Nothing else can serve this request. When the URL was one this client
      // only reaches through a route, the failure *is* "no usable route" — say
      // so, with the transport failure kept as the reason, instead of letting
      // the caller report whatever the canonical URL would have answered. A URL
      // no route covers (the IdP, another Pod) keeps its own error.
      const url = requestUrl(input)
      if (url && routeCovers(url)) {
        throw new NoUsableAccessRouteError(url.href, options.routes(), error)
      }
      throw error
    }
  }
}

/** Identity of one physical path: the same route id can point at a new target. */
function routeKey(route: Pick<AccessRoute, 'id' | 'targetUrl'>): string {
  return `${route.id}|${route.targetUrl}`
}

/**
 * A URL this client can only reach through a route, with no route usable.
 *
 * Thrown instead of sending the request to its canonical address, because that
 * address is not the path this client meant to take: something is wrong with the
 * routes themselves (the node's own gateway is down, a tunnel is gone), and the
 * caller has to say so rather than report whatever the canonical URL answers.
 */
export class NoUsableAccessRouteError extends Error {
  constructor(
    readonly url: string,
    readonly routes: readonly AccessRoute[],
    /** The transport failure that left no route usable, when there was one. */
    readonly reason?: unknown,
  ) {
    super(`No usable access route can reach ${url}`)
    this.name = 'NoUsableAccessRouteError'
  }
}

function toLocalRoute(route: AccessRoute): SolidLocalRoute {
  return { canonicalBaseUrl: route.canonicalUrl, localBaseUrl: route.targetUrl }
}

function sameOrigin(value: string, url: URL): boolean {
  try {
    return new URL(value).origin === url.origin
  } catch {
    return false
  }
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  if (input instanceof Request) {
    try {
      return new URL(input.url)
    } catch {
      return undefined
    }
  }
  try {
    return new URL(String(input))
  } catch {
    return undefined
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

/**
 * Whether a route's host answered at all.
 *
 * The probe asks the target host for one small document; what it measures is
 * reachability, not whether that host implements this optional discovery path.
 * A Pod server that answers `HEAD /.well-known/solid` with 404/405/501 (CSS does:
 * 405 for `HEAD`, 501 for `GET`) is up and serving this route, and the request
 * that follows carries the canonical URL plus its own authorization. Rejecting
 * those answers leaves a same-machine client with no route whenever the public
 * one is down — the one case local login has to survive
 * (`docs/multi-channel-access.md`). A failing host (5xx, or a closed socket,
 * which throws) still reports no route.
 */
function answersAccessRoute(response: Response): boolean {
  return response.status < 500
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
  return answersAccessRoute(response)
}
