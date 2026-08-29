import { describe, expect, it } from 'bun:test'
import { resolveDesktopTargetUrl } from '../src/target-url.js'

describe('desktop target URL', () => {
  it('opens the Account-protected Status overview on a first launch', () => {
    expect(resolveDesktopTargetUrl({ argv: ['electron', 'main.js'], env: {} })).toBe(
      'http://127.0.0.1:3000/status/overview',
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

  it('derives the desktop route from the shared Web runtime base URL', () => {
    expect(resolveDesktopTargetUrl({
      argv: ['electron', 'main.js'],
      env: { CSS_BASE_URL: 'http://localhost:5739/' },
    })).toBe('http://localhost:5739/status/overview')
  })

  it('keeps the desktop-specific override ahead of the shared runtime base URL', () => {
    expect(resolveDesktopTargetUrl({
      argv: ['electron', 'main.js'],
      env: {
        XPOD_DESKTOP_URL: 'http://127.0.0.1:4333/settings/ai-config',
        CSS_BASE_URL: 'http://localhost:5739/',
      },
    })).toBe('http://127.0.0.1:4333/settings/ai-config')
  })

  it('chooses the first safe loopback URL instead of trusting an external CLI origin', () => {
    expect(resolveDesktopTargetUrl({
      argv: ['electron', 'main.js', '--url', 'https://login.example/status/overview'],
      env: { XPOD_DESKTOP_URL: 'https://localhost:4333/settings/ai-config' },
    })).toBe('https://localhost:4333/settings/ai-config')
  })

  it('accepts HTTP(S) localhost, 127/8, and IPv6 loopback targets', () => {
    const urls = [
      'http://localhost:3000/status/overview',
      'https://127.42.1.9:3443/settings/services',
      'http://[::1]:3000/network',
    ]

    for (const url of urls) {
      expect(resolveDesktopTargetUrl({
        argv: ['electron', 'main.js', '--url', url],
        env: {},
      })).toBe(url)
    }
  })

  it('falls back to the packaged default when CLI and environment candidates are unsafe', () => {
    const unsafeUrls = [
      'https://localhost.example/status/overview',
      'http://127.0.0.1.example/status/overview',
      'file:///tmp/xpod.html',
      'http://user:secret@localhost:3000/status/overview',
    ]

    for (const url of unsafeUrls) {
      expect(resolveDesktopTargetUrl({
        argv: ['electron', 'main.js', '--url', url],
        env: { XPOD_DESKTOP_URL: 'https://cloud.example/settings' },
      })).toBe('http://127.0.0.1:3000/status/overview')
    }
  })
})
