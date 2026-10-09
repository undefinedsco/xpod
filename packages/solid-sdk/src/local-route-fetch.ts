export interface SolidLocalRoute {
  /** Canonical Pod/container URL used for RDF identity and public access. */
  canonicalBaseUrl: string
  /** Same resource tree exposed by the local Xpod Gateway. */
  localBaseUrl: string
}

export interface CreateSolidLocalRouteFetchOptions {
  fetch: typeof globalThis.fetch
  routes: () => readonly SolidLocalRoute[]
}

export const SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER = 'x-xpod-canonical-url'
export const SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER = 'x-xpod-canonical-origin'
export const SOLID_LOCAL_ROUTE_CANONICAL_HOST_HEADER = 'x-xpod-canonical-host'
export const SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER = 'x-xpod-local-route-url'

export interface DiscoverSolidLocalRouteOptions {
  fetch: typeof globalThis.fetch
  localBaseUrl: string
  statusUrl?: string
  /** The owner of the probe; aborting it settles the whole exchange. */
  signal?: AbortSignal
}

/**
 * The reachability budget of one optional route probe. The provisioning status
 * endpoint only exists to locate a route, so a host that never answers it must
 * not hold identity open any longer than a route probe does
 * (`chooseAccessRoute`'s default `probeTimeoutMs`).
 */
const SOLID_ROUTE_PROBE_TIMEOUT_MS = 1_000

export interface SolidRouteProbeOptions<T> {
  fetch: typeof globalThis.fetch
  url: string
  /** The owner of the probe; aborting it settles the whole exchange. */
  signal?: AbortSignal
  /**
   * Reads and normalizes the response under the same deadline as the request,
   * so a body that stalls after its headers cannot hold the caller open.
   */
  read: (response: Response) => Promise<T>
}

/**
 * Probe one optional runtime endpoint with a bounded, cancellable exchange.
 *
 * The budget covers the whole operation, including the caller's body decode.
 * The probe settles at the deadline or when its owner aborts, even if the fetch
 * adapter ignores the signal, and always clears its timer and listeners. Any
 * failure reports `undefined`, so a missing optional endpoint can never
 * fabricate a route.
 */
export async function probeSolidLocalRouteStatus<T>(
  options: SolidRouteProbeOptions<T>,
): Promise<T | undefined> {
  if (options.signal?.aborted) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SOLID_ROUTE_PROBE_TIMEOUT_MS)
  const relayAbort = () => controller.abort()
  options.signal?.addEventListener('abort', relayAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  try {
    return await settleOnAbort(controller.signal, async () => {
      const response = await options.fetch.call(globalThis, options.url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      return options.read(response)
    })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

/**
 * Settle `operation` as soon as `signal` aborts, whether or not the operation
 * itself observes the signal, and stop listening once it has settled.
 */
async function settleOnAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  let remove: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([operation(), aborted])
  } finally {
    remove()
  }
}

/** Discover the canonical origin currently hosted by this local Xpod. */
export async function discoverSolidLocalRoute(
  options: DiscoverSolidLocalRouteOptions,
): Promise<SolidLocalRoute | undefined> {
  const publicUrl = await probeSolidLocalRouteStatus({
    fetch: options.fetch,
    url: options.statusUrl ?? '/provision/status',
    signal: options.signal,
    read: async (response) => {
      if (!response.ok) return undefined
      const body = await response.json().catch(() => undefined) as { publicUrl?: unknown } | undefined
      return typeof body?.publicUrl === 'string' ? body.publicUrl : undefined
    },
  })
  if (typeof publicUrl !== 'string') return undefined
  try {
    return normalizeRoute({
      canonicalBaseUrl: publicUrl,
      localBaseUrl: options.localBaseUrl,
    })
  } catch {
    return undefined
  }
}

export async function resolveSolidLocalRouteFromStatus(
  input: string | URL,
  options: DiscoverSolidLocalRouteOptions,
): Promise<URL | undefined> {
  const route = await discoverSolidLocalRoute(options)
  return route ? resolveSolidLocalRouteUrl(input, [route]) : undefined
}

/**
 * Resolve a canonical Solid endpoint to an equivalent route exposed by the
 * current host. The caller owns route discovery; this function only performs
 * strict, path-preserving URL translation.
 */
export function resolveSolidLocalRouteUrl(
  input: string | URL,
  routes: readonly SolidLocalRoute[],
): URL | undefined {
  let sourceUrl: URL
  try {
    sourceUrl = input instanceof URL ? new URL(input.href) : new URL(input)
  } catch {
    return undefined
  }

  const route = routes
    .map(normalizeRoute)
    .filter((candidate) => isInsideBase(sourceUrl, candidate.canonicalBaseUrl))
    .sort((left, right) => right.canonicalBaseUrl.length - left.canonicalBaseUrl.length)[0]

  return route ? replaceBase(sourceUrl, route) : undefined
}

/**
 * Optimizes access to Pods hosted by the current Xpod without changing their
 * canonical RDF identity. drizzle-solid still receives the canonical podUrl;
 * only the final HTTP request target is replaced with the equivalent local
 * Gateway URL.
 * For DPoP sessions, inject this as the signer's network transport, not as an
 * outer wrapper around authenticated fetch. The proof remains canonical.
 */
export function createSolidLocalRouteFetch(
  options: CreateSolidLocalRouteFetchOptions,
): typeof globalThis.fetch {
  return async (input, init) => {
    const sourceUrl = requestUrl(input)
    if (!sourceUrl) {
      return init === undefined
        ? options.fetch.call(globalThis, input)
        : options.fetch.call(globalThis, input, init)
    }
    const routes = options.routes()
    const targetUrl = resolveSolidLocalRouteUrl(sourceUrl, routes)
    if (!targetUrl) {
      return init === undefined
        ? options.fetch.call(globalThis, input)
        : options.fetch.call(globalThis, input, init)
    }
    const headers = routedHeaders(input, init, sourceUrl, targetUrl)
    let response: Response
    if (input instanceof Request) {
      const request = new Request(new Request(targetUrl, input), { headers })
      response = init === undefined
        ? await options.fetch.call(globalThis, request)
        : await options.fetch.call(globalThis, request, { ...init, headers })
    } else {
      response = await options.fetch.call(globalThis, targetUrl, { ...init, headers })
    }
    // An alias transport is not an HTTP redirect. In particular, Inrupt must
    // not retry a local 401 by signing the local Response.url as a new target.
    const canonicalResponseUrl = resolveSolidLocalRouteUrl(response.url, routes.map((route) => ({
      canonicalBaseUrl: route.localBaseUrl,
      localBaseUrl: route.canonicalBaseUrl,
    })))
    return canonicalResponseUrl ? withResponseUrl(response, canonicalResponseUrl.href) : response
  }
}

function withResponseUrl(response: Response, url: string): Response {
  const clone = response.clone.bind(response)
  Object.defineProperties(response, {
    url: { value: url, configurable: true },
    clone: { value: () => withResponseUrl(clone(), url), configurable: true },
  })
  return response
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
  if (input instanceof Request) return new URL(input.url)
  try {
    return new URL(String(input))
  } catch {
    return undefined
  }
}

function normalizeRoute(route: SolidLocalRoute): SolidLocalRoute {
  return {
    canonicalBaseUrl: normalizeBaseUrl(route.canonicalBaseUrl),
    localBaseUrl: normalizeBaseUrl(route.localBaseUrl),
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Solid local routes must use http or https')
  }
  url.search = ''
  url.hash = ''
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

function isInsideBase(url: URL, base: string): boolean {
  const canonical = new URL(base)
  return url.origin === canonical.origin && url.pathname.startsWith(canonical.pathname)
}

function replaceBase(url: URL, route: SolidLocalRoute): URL {
  const canonical = new URL(route.canonicalBaseUrl)
  const local = new URL(route.localBaseUrl)
  const relativePath = url.pathname.slice(canonical.pathname.length)
  const target = new URL(relativePath, local)
  target.search = url.search
  target.hash = url.hash
  return target
}

function routedHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  canonicalUrl: URL,
  localUrl: URL,
): Headers {
  const request = input instanceof Request ? input : undefined
  const headers = new Headers(request?.headers ?? undefined)
  new Headers(init?.headers ?? undefined).forEach((value, key) => headers.set(key, value))
  headers.set(SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER, canonicalUrl.toString())
  headers.set(SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER, canonicalUrl.origin)
  headers.set(SOLID_LOCAL_ROUTE_CANONICAL_HOST_HEADER, canonicalUrl.host)
  headers.set(SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER, localUrl.toString())
  return headers
}
