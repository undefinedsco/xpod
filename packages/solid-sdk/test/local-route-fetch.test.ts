import { describe, expect, it, vi } from 'vitest'
import {
  buildAuthenticatedFetch,
  createDpopHeader,
  generateDpopKeyPair,
} from '@inrupt/solid-client-authn-core'
import {
  createSolidLocalRouteFetch,
  discoverSolidLocalRoute,
  resolveSolidLocalRouteFromStatus,
  resolveSolidLocalRouteUrl,
} from '../src/local-route-fetch'

type FetchImpl = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

function fetchMock(implementation: FetchImpl) {
  return vi.fn(implementation)
}

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init)
  Object.defineProperty(response, 'url', { value: url, configurable: true })
  return response
}

function dpopPayload(dpop: string): { htu?: string; htm?: string } {
  return JSON.parse(Buffer.from(dpop.split('.')[1] ?? '', 'base64url').toString('utf8'))
}

describe('resolveSolidLocalRouteUrl', () => {
  it('maps a canonical Account control to the current local Gateway', () => {
    expect(resolveSolidLocalRouteUrl(
      'https://node.example/.account/login/password/?returnTo=%2Fsettings',
      [{
        canonicalBaseUrl: 'https://node.example/',
        localBaseUrl: 'http://127.0.0.1:5741/',
      }],
    )?.href).toBe('http://127.0.0.1:5741/.account/login/password/?returnTo=%2Fsettings')
  })

  it('does not map a sibling origin or escape a scoped Pod route', () => {
    const routes = [{
      canonicalBaseUrl: 'https://node.example/alice/',
      localBaseUrl: 'http://127.0.0.1:5741/alice/',
    }]
    expect(resolveSolidLocalRouteUrl('https://other.example/alice/settings', routes)).toBeUndefined()
    expect(resolveSolidLocalRouteUrl('https://node.example/bob/settings', routes)).toBeUndefined()
  })

  it('uses the most specific matching route', () => {
    expect(resolveSolidLocalRouteUrl('https://node.example/alice/settings', [
      { canonicalBaseUrl: 'https://node.example/', localBaseUrl: 'http://127.0.0.1:5741/' },
      { canonicalBaseUrl: 'https://node.example/alice/', localBaseUrl: 'http://127.0.0.1:5741/fast/alice/' },
    ])?.href).toBe('http://127.0.0.1:5741/fast/alice/settings')
  })
})

describe('discoverSolidLocalRoute', () => {
  it('invokes a browser-style fetch with the global receiver', async () => {
    const fetchImpl = fetchMock(function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve(new Response(JSON.stringify({ publicUrl: 'https://pod.example/' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    })

    await expect(discoverSolidLocalRoute({
      fetch: fetchImpl,
      localBaseUrl: 'http://127.0.0.1:3000/',
    })).resolves.toEqual({
      canonicalBaseUrl: 'https://pod.example/',
      localBaseUrl: 'http://127.0.0.1:3000/',
    })
  })

  it('trusts the same-origin provisioning status as the canonical route authority', async () => {
    const fetchImpl = fetchMock(async () => new Response(JSON.stringify({
      publicUrl: 'https://managed-node.example/',
    }), { status: 200 }))

    await expect(discoverSolidLocalRoute({
      fetch: fetchImpl,
      localBaseUrl: 'http://127.0.0.1:5741/',
    })).resolves.toEqual({
      canonicalBaseUrl: 'https://managed-node.example/',
      localBaseUrl: 'http://127.0.0.1:5741/',
    })
    await expect(resolveSolidLocalRouteFromStatus(
      'https://managed-node.example/.account/login/password/',
      { fetch: fetchImpl, localBaseUrl: 'http://127.0.0.1:5741/' },
    )).resolves.toEqual(new URL('http://127.0.0.1:5741/.account/login/password/'))
  })

  it('does not infer ownership when provisioning status is unavailable', async () => {
    const fetchImpl = fetchMock(async () => new Response('{}', { status: 404 }))
    await expect(resolveSolidLocalRouteFromStatus(
      'https://untrusted.example/.account/login/password/',
      { fetch: fetchImpl, localBaseUrl: 'http://127.0.0.1:5741/' },
    )).resolves.toBeUndefined()
  })
})

describe('createSolidLocalRouteFetch', () => {
  it.each([200, 401])('keeps canonical response metadata after local transport (HTTP %i)', async (status) => {
    const localUrl = 'http://127.0.0.1:3000/alice/settings/credentials.ttl'
    const response = responseWithUrl('pod data', { status }, localUrl)
    const baseFetch = fetchMock(async () => response)
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{ canonicalBaseUrl: 'https://node.example/alice/', localBaseUrl: 'http://127.0.0.1:3000/alice/' }],
    })
    const canonicalUrl = 'https://node.example/alice/settings/credentials.ttl'
    const result = await routedFetch(canonicalUrl, { headers: { DPoP: 'signed-for-canonical' } })

    expect(result.url).toBe(canonicalUrl)
    expect(result.clone().url).toBe(canonicalUrl)
    expect(result.status).toBe(status)
    expect(new Headers(baseFetch.mock.calls[0]?.[1]?.headers).get('DPoP')).toBe('signed-for-canonical')
    await expect(result.text()).resolves.toBe('pod data')
  })

  it('routes an owned canonical Pod request through the local Gateway', async () => {
    const baseFetch = fetchMock(async () => new Response('ok'))
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{
        canonicalBaseUrl: 'https://node.example/alice/',
        localBaseUrl: 'http://127.0.0.1:3000/alice/',
      }],
    })

    await routedFetch('https://node.example/alice/settings/credentials.ttl?view=1')

    const [, init] = baseFetch.mock.calls[0] ?? []
    expect(baseFetch.mock.calls[0]?.[0]).toEqual(new URL('http://127.0.0.1:3000/alice/settings/credentials.ttl?view=1'))
    expect(new Headers(init?.headers).get('x-xpod-canonical-host')).toBe('node.example')
    expect(new Headers(init?.headers).get('x-xpod-local-route-url')).toBe('http://127.0.0.1:3000/alice/settings/credentials.ttl?view=1')
    expect(new Headers(init?.headers).get('x-xpod-canonical-origin')).toBe('https://node.example')
    // Forwarded headers describe the transport hop, not the RDF identity.
    expect(new Headers(init?.headers).get('x-forwarded-host')).toBeNull()
    expect(new Headers(init?.headers).get('x-forwarded-proto')).toBeNull()
  })

  it('does not route a sibling or external Pod', async () => {
    const baseFetch = fetchMock(async () => new Response('ok'))
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{
        canonicalBaseUrl: 'https://node.example/alice/',
        localBaseUrl: 'http://127.0.0.1:3000/alice/',
      }],
    })

    await routedFetch('https://node.example/bob/settings/credentials.ttl')
    await routedFetch('https://other.example/alice/settings/credentials.ttl')

    expect(baseFetch).toHaveBeenNthCalledWith(1, 'https://node.example/bob/settings/credentials.ttl')
    expect(baseFetch).toHaveBeenNthCalledWith(2, 'https://other.example/alice/settings/credentials.ttl')
  })

  it('preserves Request method, headers, and body while replacing only its URL', async () => {
    const baseFetch = fetchMock(async () => new Response('ok'))
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{
        canonicalBaseUrl: 'https://node.example/alice/',
        localBaseUrl: 'http://127.0.0.1:3000/alice/',
      }],
    })
    const request = new Request('https://node.example/alice/file.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })

    await routedFetch(request)

    const forwarded = baseFetch.mock.calls[0]?.[0] as Request
    expect(forwarded.url).toBe('http://127.0.0.1:3000/alice/file.txt')
    expect(forwarded.method).toBe('PUT')
    expect(forwarded.headers.get('content-type')).toBe('text/plain')
    expect(forwarded.headers.get('x-xpod-canonical-url')).toBe('https://node.example/alice/file.txt')
    expect(forwarded.headers.get('x-forwarded-proto')).toBeNull()
    await expect(forwarded.text()).resolves.toBe('hello')
  })

  it.each([401, 403])('prevents Inrupt DPoP replay from signing the local route after HTTP %i', async (status) => {
    const localUrl = 'http://127.0.0.1:3000/alice/settings/credentials.ttl?view=raw'
    const canonicalUrl = 'https://node.example/alice/settings/credentials.ttl?view=raw'
    const baseFetch = fetchMock(async () => responseWithUrl('auth failed', { status }, localUrl))
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{
        canonicalBaseUrl: 'https://node.example/alice/',
        localBaseUrl: 'http://127.0.0.1:3000/alice/',
      }],
    })
    const dpopKey = await generateDpopKeyPair()
    const authenticatedFetch = buildAuthenticatedFetch('access-token', {
      dpopKey,
      fetch: routedFetch,
    })

    const response = await authenticatedFetch(canonicalUrl, { method: 'PATCH' })

    expect(response.status).toBe(status)
    expect(response.url).toBe(canonicalUrl)
    expect(response.clone().url).toBe(canonicalUrl)
    expect(baseFetch).toHaveBeenCalledTimes(1)
    const [transportInput, transportInit] = baseFetch.mock.calls[0] ?? []
    expect(transportInput).toEqual(new URL(localUrl))
    const headers = new Headers(transportInit?.headers)
    const dpop = headers.get('DPoP')
    expect(dpop).toBeTruthy()
    const expectedDpop = await createDpopHeader(canonicalUrl, 'PATCH', dpopKey)
    expect(dpopPayload(dpop!).htu).toBe(dpopPayload(expectedDpop).htu)
    expect(dpopPayload(dpop!).htu).not.toContain('127.0.0.1')
    expect(dpopPayload(dpop!).htm).toBe('PATCH')
  })

  it('keeps successful Inrupt DPoP resource requests signed for the canonical URL while using local transport', async () => {
    const localUrl = 'http://127.0.0.1:3000/alice/profile/card'
    const canonicalUrl = 'https://node.example/alice/profile/card'
    const baseFetch = fetchMock(async () => responseWithUrl('ok', { status: 200 }, localUrl))
    const routedFetch = createSolidLocalRouteFetch({
      fetch: baseFetch,
      routes: () => [{
        canonicalBaseUrl: 'https://node.example/alice/',
        localBaseUrl: 'http://127.0.0.1:3000/alice/',
      }],
    })
    const dpopKey = await generateDpopKeyPair()
    const authenticatedFetch = buildAuthenticatedFetch('access-token', {
      dpopKey,
      fetch: routedFetch,
    })

    const response = await authenticatedFetch(canonicalUrl)

    expect(response.status).toBe(200)
    expect(response.url).toBe(canonicalUrl)
    expect(baseFetch).toHaveBeenCalledTimes(1)
    const [transportInput, transportInit] = baseFetch.mock.calls[0] ?? []
    expect(transportInput).toEqual(new URL(localUrl))
    const dpop = new Headers(transportInit?.headers).get('DPoP')
    expect(dpop).toBeTruthy()
    const expectedDpop = await createDpopHeader(canonicalUrl, 'get', dpopKey)
    expect(dpopPayload(dpop!).htu).toBe(dpopPayload(expectedDpop).htu)
    expect(dpopPayload(dpop!).htu).not.toContain('127.0.0.1')
    expect(dpopPayload(dpop!).htm).toBe('GET')
  })
})
