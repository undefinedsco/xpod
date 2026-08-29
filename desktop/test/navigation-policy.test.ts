import { describe, expect, it } from 'vitest'
import { isTrustedOidcNavigation } from '../src/navigation-policy.js'

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
