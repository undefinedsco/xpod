import { describe, expect, it } from 'vitest'
import { isTrustedOidcNavigation, resolveDesktopOidcIssuer, isOidcAuthorizationRequest } from '../src/navigation-policy.js'

describe('isTrustedOidcNavigation', () => {
  it('keeps the configured Cloud IdP inside Electron so the callback shares browser state', () => {
    expect(isTrustedOidcNavigation(
      'https://id.undefineds.co/.oidc/auth?client_id=desktop',
      'https://id.undefineds.co/',
    )).toBe(true)
  })

  it('does not trust unrelated external links or malformed configuration', () => {
    expect(isTrustedOidcNavigation('https://example.com/', 'https://id.undefineds.co/')).toBe(false)
    expect(isTrustedOidcNavigation('https://id.undefineds.co.evil.example/', 'https://id.undefineds.co/')).toBe(false)
    expect(isTrustedOidcNavigation('https://id.undefineds.co/', undefined)).toBe(false)
  })
})


describe('Gateway-owned login authority', () => {
  it('discovers a custom Local issuer even before node registration', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ managed: true, registered: false, oidcIssuer: 'https://custom.example/' }))
    expect(await resolveDesktopOidcIssuer('http://127.0.0.1:3000', fetchImpl)).toBe('https://custom.example/')
  })
  it('uses standard discovery for standalone and Cloud', async () => {
    const fetchImpl = async (input: string | URL | Request) => String(input).endsWith('/provision/status')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ issuer: 'https://standalone.example/' }))
    expect(await resolveDesktopOidcIssuer('http://127.0.0.1:3000', fetchImpl)).toBe('https://standalone.example/')
  })
  it('does not guess an issuer when managed status is unavailable', async () => {
    expect(await resolveDesktopOidcIssuer('http://127.0.0.1:3000', async () => new Response('', { status: 503 }))).toBeUndefined()
  })
  it('rejects URL credentials in navigation and discovery', async () => {
    expect(isTrustedOidcNavigation('https://user:secret@id.example/', 'https://id.example/')).toBe(false)
    expect(await resolveDesktopOidcIssuer('http://127.0.0.1:3000', async () => new Response(JSON.stringify({ managed: true, oidcIssuer: 'https://user:secret@id.example/' })))).toBeUndefined()
  })
})


it('recognizes callback-bound authorization without treating it as trusted', () => {
  const request = 'https://custom.example/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Fauth%2Fcallback'
  expect(isOidcAuthorizationRequest(request, 'http://127.0.0.1:5173')).toBe(true)
  expect(isOidcAuthorizationRequest(request, 'http://127.0.0.1:3000')).toBe(false)
  expect(isTrustedOidcNavigation(request, undefined)).toBe(false)
  expect(isOidcAuthorizationRequest('https://example.com/', 'http://127.0.0.1:5173')).toBe(false)
})
