import { describe, expect, test } from 'bun:test'
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec.js'
import { requestDesktopProvision } from '../src/provision-transport.js'

const issuer = 'https://id.example/'
const productOrigin = 'http://127.0.0.1:3000'
const codec = new ProvisionCodeCodec(issuer)
function code(overrides: Record<string, unknown> = {}) {
  return codec.encode({
    nodeId: 'this-device', spDomain: 'this-device.nodes.example', spUrl: 'https://this-device.nodes.example/',
    serviceAccessToken: 'short-test-token', serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 60,
    exp: Math.floor(Date.now() / 1000) + 60, ...overrides,
  })
}
function fixture(statusOverrides: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    return new Response(JSON.stringify(url.endsWith('/provision/status') ? {
      registered: true, managed: true, oidcIssuer: issuer, provisionCode: code(),
      publicUrl: 'https://this-device.nodes.example/', ...statusOverrides,
    } : { provisionReceipt: 'test-receipt' }), { status: 200 })
  }
  return { calls, options: { productOrigin, issuer, fetchImpl } }
}
const request = () => ({ provisionCode: code(), path: '/provision/pods', body: { podName: 'my-pod', webId: 'https://id.example/me#me' } })

describe('same-device provisioning transport', () => {
  test('prepares through the fixed loopback Gateway with the original short-lived capability', async () => {
    const { calls, options } = fixture()
    expect(await requestDesktopProvision(request(), options)).toEqual({ status: 200, body: { provisionReceipt: 'test-receipt' } })
    expect(calls.map(call => call.url)).toEqual([`${productOrigin}/provision/status`, `${productOrigin}/provision/pods`])
    expect(calls[1].init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer short-test-token' } })
    expect(calls[0].init?.headers).toEqual({ Accept: 'application/json' })
  })

  test('supports the same bounded transport for ownership lookup', async () => {
    const { calls, options } = fixture()
    await requestDesktopProvision({ provisionCode: code(), path: '/provision/webids', body: { webIds: ['https://id.example/me#me'] } }, options)
    expect(calls[1].url).toBe(`${productOrigin}/provision/webids`)
  })

  test.each([
    null, { ...request(), path: '/api/admin' }, { ...request(), path: 'https://attacker.example/provision/pods' },
    { ...request(), path: '/provision/pods?redirect=elsewhere' }, { ...request(), body: [] },
    { ...request(), provisionCode: code({ exp: 1 }) },
    { ...request(), provisionCode: code({ serviceAccessTokenExp: 1 }) },
    { ...request(), provisionCode: 'invalid' },
  ])('rejects malformed or expired operations before any network access (%#)', async input => {
    const { calls, options } = fixture()
    await expect(requestDesktopProvision(input, options)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test.each([
    { provisionCode: code({ nodeId: 'other-device' }) },
    { publicUrl: 'https://other-device.nodes.example/' },
    { oidcIssuer: 'https://other-id.example/' },
    { registered: false }, { managed: false },
  ])('never sends a capability to a mismatched Local device (%#)', async status => {
    const { calls, options } = fixture(status)
    await expect(requestDesktopProvision(request(), options)).rejects.toThrow('does not belong')
    expect(calls).toHaveLength(1)
  })

  test.each(['https://remote.example', 'http://192.168.1.2:3000', 'http://user:password@127.0.0.1:3000'])('rejects a non-loopback product target %s', async target => {
    const { calls, options } = fixture()
    await expect(requestDesktopProvision(request(), { ...options, productOrigin: target })).rejects.toThrow('unavailable')
    expect(calls).toHaveLength(0)
  })

  test('cancels an oversized response before consuming the complete stream', async () => {
    const { options } = fixture()
    let cancelled = false
    let chunks = 0
    const fetchImpl: typeof fetch = (input, init) => String(input).endsWith('/provision/status')
      ? options.fetchImpl(input, init)
      : Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1
          if (chunks > 10) controller.close()
          else controller.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel() { cancelled = true },
      })))
    await expect(requestDesktopProvision(request(), { ...options, fetchImpl })).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
    expect(chunks).toBeLessThan(10)
  })
})
