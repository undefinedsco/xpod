import { describe, expect, test } from 'bun:test'
import { cancelDesktopLogin, shouldCancelDesktopLoginOnClose } from '../src/login-recovery.js'

describe('native desktop login recovery', () => {
  test.each(['http://127.0.0.1:3000', 'https://cloud.example'])('preserves a signed-in workspace when %s also hosts its issuer', origin => {
    expect(shouldCancelDesktopLoginOnClose('workspace', `${origin}/ai-connections`, origin, `${origin}/`)).toBe(false)
    expect(shouldCancelDesktopLoginOnClose('workspace', `${origin}/settings/pod`, origin, `${origin}/`)).toBe(false)
  })

  test('still cancels compact authentication and cross-origin issuer documents', () => {
    const origin = 'http://127.0.0.1:3000'
    expect(shouldCancelDesktopLoginOnClose('auth', `${origin}/auth/callback`, origin, undefined)).toBe(true)
    expect(shouldCancelDesktopLoginOnClose('account', `${origin}/.account/login/password/`, origin, `${origin}/`)).toBe(true)
    expect(shouldCancelDesktopLoginOnClose('workspace', 'https://id.example/.account/create-pod/', origin, 'https://id.example/')).toBe(true)
    expect(shouldCancelDesktopLoginOnClose('workspace', `${origin}/settings`, origin, undefined)).toBe(false)
  })

  test('stops pending navigation then loads only the configured product entry', async () => {
    const calls: string[] = []
    await cancelDesktopLogin({
      isDestroyed: () => false,
      webContents: { stop: () => { calls.push('stop') } },
      loadURL: async url => { calls.push(url) },
    }, 'http://127.0.0.1:5173/ai-connections?tab=models')
    expect(calls).toEqual(['stop', 'http://127.0.0.1:5173/ai-connections?tab=models&xpod-login=cancelled'])
  })

  test('does not touch a destroyed window', async () => {
    await cancelDesktopLogin({
      isDestroyed: () => true,
      webContents: { stop: () => { throw new Error('destroyed') } },
      loadURL: async () => { throw new Error('destroyed') },
    }, 'http://127.0.0.1:5173/ai-connections')
  })

  test('rejects an unsafe configured destination before operating the window', async () => {
    for (const target of ['javascript:alert(1)', 'file:///tmp/page', 'https://user:password@example.com']) {
      let touched = false
      await expect(cancelDesktopLogin({
        isDestroyed: () => false,
        webContents: { stop: () => { touched = true } },
        loadURL: async () => { touched = true },
      }, target)).rejects.toThrow('trusted HTTP')
      expect(touched).toBe(false)
    }
  })
})
