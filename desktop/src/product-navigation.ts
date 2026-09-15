import { isSameOriginProductUrl } from './navigation-policy.js'

export interface DesktopProductNavigationWindow {
  webContents: {
    getURL(): string
    send(channel: string, route: string): void
  }
  loadURL(url: string): Promise<void>
}

/** Keep the existing renderer and its authenticated Session during tray navigation. */
export async function navigateDesktopProduct(
  window: DesktopProductNavigationWindow,
  route: string,
  origin: string,
  shellReady: boolean,
): Promise<void> {
  const target = new URL(route, origin)
  if (shellReady && isSameOriginProductUrl(window.webContents.getURL(), origin)
    && isSameOriginProductUrl(target.href, origin)) {
    window.webContents.send('xpod:navigate', `${target.pathname}${target.search}${target.hash}`)
    return
  }
  await window.loadURL(target.href)
}
