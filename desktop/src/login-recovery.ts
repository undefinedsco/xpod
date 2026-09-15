import { isSameOriginProductUrl, isTrustedOidcNavigation } from './navigation-policy.js'
import { isCompactDesktopWindowMode } from './window-devtools.js'
import type { DesktopWindowMode } from './window-mode.js'

export interface DesktopLoginRecoveryWindow {
  isDestroyed(): boolean
  webContents: { stop(): void }
  loadURL(url: string): Promise<void>
}

/** Return to the configured product entry without executing the stuck renderer. */
export async function cancelDesktopLogin(window: DesktopLoginRecoveryWindow, targetUrl: string): Promise<void> {
  if (window.isDestroyed()) return
  const destination = new URL(targetUrl)
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
    throw new Error('Desktop login recovery requires a trusted HTTP product entry')
  }
  destination.searchParams.set('xpod-login', 'cancelled')
  window.webContents.stop()
  await window.loadURL(destination.href)
}
export function shouldCancelDesktopLoginOnClose(
  mode: DesktopWindowMode | null,
  currentUrl: string,
  productOrigin: string,
  issuer: string | undefined,
): boolean {
  // Cloud and standalone can serve both the product and issuer on one origin.
  // Closing their workspace must retain its renderer, not cancel a login.
  return isCompactDesktopWindowMode(mode)
    || (!isSameOriginProductUrl(currentUrl, productOrigin) && isTrustedOidcNavigation(currentUrl, issuer))
}

/** Renderer IPC may cancel only the current window's trusted main document. */
export function canCancelDesktopLogin(
  sender: { isCurrentWindow: boolean; isMainFrame: boolean; url: string },
  productOrigin: string,
  issuer: string | undefined,
): boolean {
  return sender.isCurrentWindow && sender.isMainFrame
    && (isSameOriginProductUrl(sender.url, productOrigin) || isTrustedOidcNavigation(sender.url, issuer))
}
