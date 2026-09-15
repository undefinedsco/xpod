import { describe, expect, test } from 'bun:test'
import { canCancelDesktopLogin } from '../src/login-recovery.js'

describe('desktop login cancellation IPC authority', () => {
  const product = 'http://127.0.0.1:3000'
  const issuer = 'https://id.example/'
  const sender = { isCurrentWindow: true, isMainFrame: true, url: `${issuer}.account/interaction/expired/oidc/consent/` }

  test('accepts the current main frame at the configured issuer or product', () => {
    expect(canCancelDesktopLogin(sender, product, issuer)).toBe(true)
    expect(canCancelDesktopLogin({ ...sender, url: `${product}/auth/callback` }, product, issuer)).toBe(true)
  })

  test('rejects a trusted-origin iframe or another window', () => {
    expect(canCancelDesktopLogin({ ...sender, isMainFrame: false }, product, issuer)).toBe(false)
    expect(canCancelDesktopLogin({ ...sender, isCurrentWindow: false }, product, issuer)).toBe(false)
  })

  test('rejects untrusted origins, credential URLs, invalid URLs and undiscovered issuer', () => {
    for (const url of ['https://evil.example/', 'https://id.example.evil.test/', 'https://user@id.example/', 'file:///tmp/a', 'not a URL']) {
      expect(canCancelDesktopLogin({ ...sender, url }, product, issuer)).toBe(false)
    }
    expect(canCancelDesktopLogin(sender, product, undefined)).toBe(false)
  })
})
