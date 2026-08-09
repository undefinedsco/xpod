import { describe, expect, it } from 'bun:test'
import { resolveDesktopTargetUrl } from '../src/target-url.js'

describe('desktop target URL', () => {
  it('opens the anonymous local Network overview on a first launch', () => {
    expect(resolveDesktopTargetUrl({ argv: ['electron', 'main.js'], env: {} })).toBe(
      'http://127.0.0.1:3000/network/overview',
    )
  })

  it('keeps the explicit CLI URL ahead of the environment override', () => {
    expect(resolveDesktopTargetUrl({
      argv: ['electron', 'main.js', '--url', 'http://127.0.0.1:4111/settings/services'],
      env: { XPOD_DESKTOP_URL: 'http://127.0.0.1:4222/status/overview' },
    })).toBe('http://127.0.0.1:4111/settings/services')
  })

  it('uses the environment override when no complete CLI URL is present', () => {
    expect(resolveDesktopTargetUrl({
      argv: ['electron', 'main.js', '--url'],
      env: { XPOD_DESKTOP_URL: 'http://127.0.0.1:4333/settings/ai-config' },
    })).toBe('http://127.0.0.1:4333/settings/ai-config')
  })
})
