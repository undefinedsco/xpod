import { isSameOriginProductUrl } from './navigation-policy.js'
import { navigateDesktopProduct, type DesktopProductNavigationWindow } from './product-navigation.js'

export const XPOD_DESKTOP_PROTOCOL = 'xpod'

/** The return link carries navigation only, never OAuth codes or arbitrary routes. */
export function desktopProtocolRoute(value: string): '/ai-connections' | undefined {
  return value === 'xpod://ai-connections' || value === 'xpod://ai-connections/'
    ? '/ai-connections' : undefined
}

export function desktopProtocolRouteFromArgv(argv: readonly string[]): '/ai-connections' | undefined {
  return argv.map(desktopProtocolRoute).find(route => route !== undefined)
}

/** Leave an in-progress Account/PKCE document intact until the product shell is ready. */
export async function resumeDesktopProtocolNavigation(
  window: DesktopProductNavigationWindow,
  origin: string,
  shellReady: boolean,
): Promise<boolean> {
  if (!shellReady || !isSameOriginProductUrl(window.webContents.getURL(), origin)) return false
  await navigateDesktopProduct(window, '/ai-connections', origin, true)
  return true
}
