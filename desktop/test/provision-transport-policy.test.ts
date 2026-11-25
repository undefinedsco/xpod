import { describe, expect, test } from 'bun:test'
import { canRequestDesktopProvision } from '../src/provision-transport-policy.js'
const product = 'http://127.0.0.1:3000'
const issuer = 'https://id.example/'
function sender(url: string) {
  return { isCurrentWindow: true, isMainFrame: true, committedUrl: url, frameUrl: url, contentsUrl: url }
}
describe('Local onboarding sender admission', () => {
  test.each([`${product}/ai-connections`, `${issuer}.account/interaction/current/create-pod/`, `${issuer}.account/manage-pod/`])('admits reserved main document %s', url => {
    expect(canRequestDesktopProvision(sender(url), product, issuer)).toBe(true)
  })
  test.each([`${product}/alice/evil.html`, `${issuer}alice/evil.html`, `${issuer}.account%2Fmanage-pod/`, `${issuer}.account/%252e%252e/alice/evil.html`, 'https://foreign.example/.account/manage-pod/'])('rejects user content and ambiguous routes %s', url => {
    expect(canRequestDesktopProvision(sender(url), product, issuer)).toBe(false)
  })
  test('rejects iframes, old windows, unknown issuer and same-origin pushState impersonation', () => {
    const trusted = sender(`${issuer}.account/create-pod/`)
    expect(canRequestDesktopProvision({ ...trusted, isMainFrame: false }, product, issuer)).toBe(false)
    expect(canRequestDesktopProvision({ ...trusted, isCurrentWindow: false }, product, issuer)).toBe(false)
    expect(canRequestDesktopProvision(trusted, product, undefined)).toBe(false)
    for (const field of ['committedUrl', 'frameUrl', 'contentsUrl']) {
      expect(canRequestDesktopProvision({ ...trusted, [field]: `${issuer}alice/evil.html` }, product, issuer)).toBe(false)
    }
  })
})
