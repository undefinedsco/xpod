import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseAccessRoute,
  createSolidAccessRouteFetch,
  NoUsableAccessRouteError,
  type AccessRoute,
  type AccessRouteSet,
} from '../src/access-route'

const CANONICAL = 'https://node-0000.undefineds.co/'

function route(overrides: Partial<AccessRoute> & Pick<AccessRoute, 'id' | 'kind' | 'targetUrl' | 'priority'>): AccessRoute {
  return {
    canonicalUrl: CANONICAL,
    requiresManagedClient: true,
    visibility: overrides.kind === 'loopback' ? 'local-only' : 'authorized-client',
    health: 'healthy',
    ...overrides,
  }
}

function routeSet(routes: AccessRoute[]): AccessRouteSet {
  return { nodeId: 'node-0000', canonicalUrl: CANONICAL, routes }
}

describe('chooseAccessRoute', () => {
  it('takes the best route that answers, and never offers a same-machine route to a remote client', async () => {
    const set = routeSet([
      route({ id: 'loopback', kind: 'loopback', targetUrl: 'http://127.0.0.1:3000/', priority: 10, visibility: 'local-only' }),
      route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20 }),
      route({ id: 'tunnel', kind: 'user-tunnel', targetUrl: 'https://tunnel.example/', priority: 50, requiresManagedClient: false, visibility: 'public' }),
    ])

    const remoteClient = await chooseAccessRoute(set, { managedClient: true, probe: () => true })
    expect(remoteClient?.kind).toBe('lan')

    const sameMachine = await chooseAccessRoute(set, {
      managedClient: true,
      allowLocalOnlyRoutes: true,
      probe: () => true,
    })
    expect(sameMachine?.kind).toBe('loopback')
  })

  it('does not probe a route this client can already vouch for', async () => {
    const probe = vi.fn(() => false)
    const set = routeSet([
      route({ id: 'loopback', kind: 'loopback', targetUrl: 'http://127.0.0.1:3000/', priority: 10, visibility: 'local-only', health: 'healthy' }),
      route({
        id: 'public-direct',
        kind: 'public-direct',
        targetUrl: CANONICAL,
        priority: 30,
        requiresManagedClient: false,
        visibility: 'public',
        health: 'unknown',
      }),
    ])

    const chosen = await chooseAccessRoute(set, {
      managedClient: true,
      allowLocalOnlyRoutes: true,
      probe,
    })

    // The current origin served this very document, and the node's own runtime
    // reports this route healthy: neither a probe nor a dead public route may
    // take away the one path the client is standing on.
    expect(chosen?.kind).toBe('loopback')
    expect(probe).not.toHaveBeenCalled()
  })

  it('falls through to the next route when the best one does not answer', async () => {
    const set = routeSet([
      route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20, health: 'unknown' }),
      route({ id: 'tunnel', kind: 'user-tunnel', targetUrl: 'https://tunnel.example/', priority: 50, health: 'unknown' }),
    ])

    const chosen = await chooseAccessRoute(set, {
      managedClient: true,
      probe: (candidate) => candidate.kind !== 'lan',
    })
    expect(chosen?.kind).toBe('user-tunnel')
  })

  it('skips routes the node itself marked unreachable and routes a plain client may not use', async () => {
    const set = routeSet([
      route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20, health: 'unreachable' }),
      route({
        id: 'tunnel',
        kind: 'user-tunnel',
        targetUrl: 'https://tunnel.example/',
        priority: 50,
        requiresManagedClient: false,
        visibility: 'public',
      }),
    ])

    const plainClient = await chooseAccessRoute(set, { managedClient: false, probe: () => true })
    expect(plainClient?.kind).toBe('user-tunnel')
  })
})

describe('probing a route without an injected probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * The reported 0.4.17 Local login failure. Xpod's own Pod server (CSS 8)
   * answers `HEAD /.well-known/solid` with 405 and `GET` with 501, and the
   * desktop app's other route — the node's canonical domain — is unreachable
   * while its tunnel is down. Rejecting the 405 left the app with no route at
   * all, so the WebID profile read fell back to the canonical URL and login
   * failed with `profile-read-failed` instead of using loopback.
   */
  it('keeps a route whose host answers the probe without implementing the document', async () => {
    const probed: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      probed.push(String(input))
      return new Response(null, { status: 405 })
    }))

    const chosen = await chooseAccessRoute(
      routeSet([route({ id: 'loopback', kind: 'loopback', targetUrl: 'http://127.0.0.1:3000/', priority: 10, visibility: 'local-only', health: 'unknown' })]),
      { managedClient: true, allowLocalOnlyRoutes: true },
    )

    expect(chosen?.kind).toBe('loopback')
    expect(probed).toEqual(['http://127.0.0.1:3000/.well-known/solid'])
  })

  it('drops a route whose host fails or cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('http://127.0.0.1:3000/')) {
        return new Response(null, { status: 503 })
      }
      throw new TypeError('socket closed')
    }))

    const chosen = await chooseAccessRoute(routeSet([
      route({ id: 'loopback', kind: 'loopback', targetUrl: 'http://127.0.0.1:3000/', priority: 10, visibility: 'local-only', health: 'unknown' }),
      route({
        id: 'public-direct',
        kind: 'public-direct',
        targetUrl: CANONICAL,
        priority: 30,
        requiresManagedClient: false,
        visibility: 'public',
        health: 'unknown',
      }),
    ]), { managedClient: true, allowLocalOnlyRoutes: true })

    expect(chosen).toBeNull()
  })
})

describe('createSolidAccessRouteFetch', () => {
  it('sends a canonical request over the chosen route and keeps canonical identity', async () => {
    const requests: { url: string; canonicalHost: string | null }[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      requests.push({
        url: request.url,
        canonicalHost: request.headers.get('x-xpod-canonical-host'),
      })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20 })],
      probe: () => true,
    })

    const response = await routed(`${CANONICAL}alice/notes.ttl`)

    expect(response.status).toBe(200)
    expect(requests).toEqual([{ url: 'http://192.168.1.20:3000/alice/notes.ttl', canonicalHost: 'node-0000.undefineds.co' }])
  })

  it('reports the canonical URL on the response even though the request went over a route', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof globalThis.fetch
    // A real route answers with its own origin in `Response.url`.
    const withLocalUrl = vi.fn(async () => {
      const response = new Response('ok', { status: 200 })
      Object.defineProperty(response, 'url', {
        value: 'http://192.168.1.20:3000/alice/notes.ttl',
        configurable: true,
      })
      return response
    }) as unknown as typeof globalThis.fetch

    const routed = createSolidAccessRouteFetch({
      fetch: withLocalUrl,
      routes: () => [route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20 })],
      probe: () => true,
    })

    const response = await routed(`${CANONICAL}alice/notes.ttl`)
    expect(response.url).toBe(`${CANONICAL}alice/notes.ttl`)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes the routes and retries once when the chosen route stops answering', async () => {
    let generation = 1
    const attempts: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      attempts.push(request.url)
      if (generation === 1) {
        throw new TypeError('socket closed')
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [route({
        id: generation === 1 ? 'tunnel' : 'lan',
        kind: generation === 1 ? 'user-tunnel' : 'lan',
        targetUrl: generation === 1 ? 'https://tunnel.example/' : 'http://192.168.1.20:3000/',
        priority: generation === 1 ? 50 : 20,
      })],
      refreshRoutes: () => {
        generation = 2
      },
      probe: () => true,
    })

    const response = await routed(`${CANONICAL}alice/notes.ttl`)

    expect(response.status).toBe(200)
    expect(attempts).toEqual([
      'https://tunnel.example/alice/notes.ttl',
      'http://192.168.1.20:3000/alice/notes.ttl',
    ])
  })

  it('fails over to the next route when a trusted route stops answering', async () => {
    const attempts: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      attempts.push(request.url)
      if (request.url.startsWith('http://127.0.0.1:3000/')) {
        throw new TypeError('socket closed')
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [
        // Trusted, and therefore never probed: the request itself is what
        // discovers that this path is gone, and the retry has to be able to
        // land somewhere else.
        route({ id: 'loopback', kind: 'loopback', targetUrl: 'http://127.0.0.1:3000/', priority: 10, visibility: 'local-only', health: 'healthy' }),
        route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20, health: 'unknown' }),
      ],
      allowLocalOnlyRoutes: true,
      probe: () => true,
    })

    const response = await routed(`${CANONICAL}alice/notes.ttl`)

    expect(response.status).toBe(200)
    expect(attempts).toEqual([
      'http://127.0.0.1:3000/alice/notes.ttl',
      'http://192.168.1.20:3000/alice/notes.ttl',
    ])
  })

  it('reports a URL it can only reach through a route when none is usable', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof globalThis.fetch
    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      // The node's own gateway is the only path this client knows, and it is
      // down: sending the request to the canonical URL would leave through a
      // path this client cannot reach, so the caller must hear about it.
      routes: () => [route({
        id: 'loopback',
        kind: 'loopback',
        targetUrl: 'http://127.0.0.1:3000/',
        priority: 10,
        visibility: 'local-only',
        health: 'unknown',
      })],
      allowLocalOnlyRoutes: true,
      probe: () => false,
    })

    await expect(routed(`${CANONICAL}alice/notes.ttl`)).rejects.toBeInstanceOf(NoUsableAccessRouteError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends a canonical URL unchanged when that is where the best route would have gone', async () => {
    const attempts: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      attempts.push(String(input))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      // A client whose only path *is* the canonical URL: passing the request
      // through unchanged is exactly what this route would have done, so a
      // failed probe must not turn it into an error.
      routes: () => [route({
        id: 'public-direct',
        kind: 'public-direct',
        targetUrl: CANONICAL,
        priority: 30,
        requiresManagedClient: false,
        visibility: 'public',
        health: 'unknown',
      })],
      probe: () => false,
    })

    const response = await routed(`${CANONICAL}alice/notes.ttl`)
    expect(response.status).toBe(200)
    expect(attempts).toEqual([`${CANONICAL}alice/notes.ttl`])
  })

  it('leaves a URL no route covers to the caller', async () => {
    const attempts: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      attempts.push(String(input))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [route({
        id: 'loopback',
        kind: 'loopback',
        targetUrl: 'http://127.0.0.1:3000/',
        priority: 10,
        visibility: 'local-only',
        health: 'unknown',
      })],
      allowLocalOnlyRoutes: true,
      probe: () => false,
    })

    const response = await routed('https://id.undefineds.co/.well-known/openid-configuration')
    expect(response.status).toBe(200)
    expect(attempts).toEqual(['https://id.undefineds.co/.well-known/openid-configuration'])
  })

  it('keeps the transport failure as the reason when the only route for a URL dies', async () => {
    const networkError = new TypeError('socket closed')
    const fetchImpl = vi.fn(async () => {
      throw networkError
    }) as unknown as typeof globalThis.fetch
    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [route({
        id: 'loopback',
        kind: 'loopback',
        targetUrl: 'http://127.0.0.1:3000/',
        priority: 10,
        visibility: 'local-only',
        health: 'healthy',
      })],
      allowLocalOnlyRoutes: true,
    })

    // The first attempt discovers that the path is gone; with nothing to fail
    // over to, the caller has to be told the path is unusable — not handed a
    // bare network error it cannot tell apart from an unreadable profile.
    await expect(routed(`${CANONICAL}alice/notes.ttl`)).rejects.toMatchObject({
      name: 'NoUsableAccessRouteError',
      url: `${CANONICAL}alice/notes.ttl`,
      reason: networkError,
    })
  })

  it('leaves the error of a URL no route covers untouched', async () => {
    const networkError = new TypeError('socket closed')
    const fetchImpl = vi.fn(async () => {
      throw networkError
    }) as unknown as typeof globalThis.fetch
    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [route({
        id: 'loopback',
        kind: 'loopback',
        targetUrl: 'http://127.0.0.1:3000/',
        priority: 10,
        visibility: 'local-only',
        health: 'healthy',
      })],
      allowLocalOnlyRoutes: true,
    })

    await expect(routed('https://id.undefineds.co/.well-known/openid-configuration'))
      .rejects.toBe(networkError)
  })

  it('passes a request through untouched when no route can be used', async () => {
    const attempts: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      attempts.push(input instanceof Request ? input.url : String(input))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const routed = createSolidAccessRouteFetch({
      fetch: fetchImpl,
      routes: () => [],
      probe: () => false,
    })

    await routed(`${CANONICAL}alice/notes.ttl`)
    expect(attempts).toEqual([`${CANONICAL}alice/notes.ttl`])
  })
})
