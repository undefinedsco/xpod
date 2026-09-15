import { describe, expect, test, mock } from 'bun:test'
import { navigateDesktopProduct } from '../src/product-navigation.js'

describe('desktop product navigation', () => {
  test('keeps the current document when the product Shell handles a tray route', async () => {
    const window = {
      webContents: { getURL: () => 'http://127.0.0.1:5173/ai-connections', send: mock() },
      loadURL: mock(async () => undefined),
    }
    await navigateDesktopProduct(window, '/settings/pod?tab=storage#current', 'http://127.0.0.1:5173', true)
    expect(window.webContents.send).toHaveBeenCalledWith('xpod:navigate', '/settings/pod?tab=storage#current')
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  test.each([
    ['about:blank', false],
    ['http://127.0.0.1:5173/status', false],
    ['https://id.undefineds.co/.account/login/password/', true],
  ] as const)('loads the destination when %s has no usable product Shell', async (currentUrl, ready) => {
    const window = {
      webContents: { getURL: () => currentUrl, send: mock() },
      loadURL: mock(async () => undefined),
    }
    await navigateDesktopProduct(window, '/ai-connections', 'http://127.0.0.1:5173', ready)
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/ai-connections')
  })
})
