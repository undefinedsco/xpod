import { describe, expect, it, vi } from 'vitest'
import {
  chooseAccessRoute,
  createSolidAccessRouteFetch,
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

  it('falls through to the next route when the best one does not answer', async () => {
    const set = routeSet([
      route({ id: 'lan', kind: 'lan', targetUrl: 'http://192.168.1.20:3000/', priority: 20 }),
      route({ id: 'tunnel', kind: 'user-tunnel', targetUrl: 'https://tunnel.example/', priority: 50 }),
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
