import { describe, expect, test, mock } from 'bun:test'
import {
  clearDesktopNavigationCache,
  loadDesktopUrlWithoutStaleCache,
  type DesktopNavigationSession,
  type DesktopNavigationWindow,
} from '../src/navigation-cache.js'

function session(overrides: Partial<DesktopNavigationSession> = {}): DesktopNavigationSession {
  return {
    clearCache: mock(async () => undefined),
    clearCodeCaches: mock(async () => undefined),
    ...overrides,
  }
}

describe('desktop navigation cache', () => {
  test('clears HTTP and code cache for the target URL before loading', async () => {
    const calls: string[] = []
    const targetSession = session({
      clearCache: mock(async () => {
        calls.push('clear-cache')
      }),
      clearCodeCaches: mock(async (options) => {
        calls.push(`clear-code:${options.urls?.[0]}`)
      }),
    })
    const window: DesktopNavigationWindow = {
      webContents: { session: targetSession },
      loadURL: mock(async (url: string) => {
        calls.push(`load:${url}`)
      }),
    }

    await loadDesktopUrlWithoutStaleCache(window, 'http://127.0.0.1:3000/status/overview')

    expect(targetSession.clearCache).toHaveBeenCalledTimes(1)
    expect(targetSession.clearCodeCaches).toHaveBeenCalledWith({ urls: ['http://127.0.0.1:3000/status/overview'] })
    expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3000/status/overview')
    expect(calls.at(-1)).toBe('load:http://127.0.0.1:3000/status/overview')
  })

  test('still loads the app if cache clearing fails', async () => {
    const warnings: string[] = []
    const targetSession = session({
      clearCache: mock(async () => {
        throw new Error('cache locked')
      }),
      clearCodeCaches: mock(async () => {
        throw new Error('code cache locked')
      }),
    })
    const window: DesktopNavigationWindow = {
      webContents: { session: targetSession },
      loadURL: mock(async () => undefined),
    }

    await expect(loadDesktopUrlWithoutStaleCache(
      window,
      'http://127.0.0.1:3000/settings',
      (message) => warnings.push(message),
    )).resolves.toBeUndefined()
    expect(window.loadURL).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Cache invalidation incomplete')
    expect(warnings[0]).toContain('HTTP cache: cache locked')
    expect(warnings[0]).toContain('code cache: code cache locked')
  })

  test('does not clear browser storage or auth caches', async () => {
    const targetSession = {
      ...session(),
      clearStorageData: mock(async () => undefined),
      clearAuthCache: mock(async () => undefined),
    }

    await clearDesktopNavigationCache(targetSession, 'http://127.0.0.1:3000/')

    expect(targetSession.clearCache).toHaveBeenCalledTimes(1)
    expect(targetSession.clearCodeCaches).toHaveBeenCalledTimes(1)
    expect(targetSession.clearStorageData).not.toHaveBeenCalled()
    expect(targetSession.clearAuthCache).not.toHaveBeenCalled()
  })
})
