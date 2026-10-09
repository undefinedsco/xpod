import { describe, expect, mock, test } from 'bun:test'
import { desktopProtocolRoute, desktopProtocolRouteFromArgv, resumeDesktopProtocolNavigation } from '../src/product-protocol.js'

describe('desktop return protocol', () => {
  test.each(['xpod://ai-connections', 'xpod://ai-connections/'])('accepts only the fixed return target %s', value => {
    expect(desktopProtocolRoute(value)).toBe('/ai-connections')
  })
  test.each([
    'https://ai-connections', 'xpod://other', 'xpod://ai-connections/settings',
    'xpod://ai-connections?code=secret', 'xpod://ai-connections#state',
    'xpod://user:password@ai-connections', 'xpod://ai-connections:1455',
    'xpod://ai-connections/../', ' xpod://ai-connections', '',
  ])('rejects untrusted targets and callback parameters %s', value => {
    expect(desktopProtocolRoute(value)).toBeUndefined()
  })
  test('finds the fixed protocol target among platform startup arguments', () => {
    expect(desktopProtocolRouteFromArgv(['Xpod', '--other', 'xpod://ai-connections'])).toBe('/ai-connections')
    expect(desktopProtocolRouteFromArgv(['Xpod', 'xpod://ai-connections?state=secret'])).toBeUndefined()
  })
  test('returns through the existing renderer instead of restarting its authenticated session', async () => {
    const window = { webContents: { getURL: () => 'http://127.0.0.1:3000/network', send: mock() }, loadURL: mock() }
    expect(await resumeDesktopProtocolNavigation(window, 'http://127.0.0.1:3000', true)).toBe(true)
    expect(window.webContents.send).toHaveBeenCalledWith('xpod:navigate', '/ai-connections')
    expect(window.loadURL).not.toHaveBeenCalled()
  })
  test.each([
    ['about:blank', false],
    ['http://127.0.0.1:3000/ai-connections', false],
    ['https://id.undefineds.co/authorize?state=transaction', true],
  ] as const)('does not interrupt an initial load or ongoing sign-in at %s', async (current, ready) => {
    const window = { webContents: { getURL: () => current, send: mock() }, loadURL: mock() }
    expect(await resumeDesktopProtocolNavigation(window, 'http://127.0.0.1:3000', ready)).toBe(false)
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(window.loadURL).not.toHaveBeenCalled()
  })
})
