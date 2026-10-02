import { normalizeXpodReturnPath, isXpodProductPath } from '../../src/shared/xpod-route-policy.js'
import { isSameOriginProductUrl } from './navigation-policy.js'

/** Account documents and user Pod HTML share an origin but never own host capabilities. */
export function isTrustedDesktopShellUrl(value: string, origin: string): boolean {
  if (!isSameOriginProductUrl(value, origin)) return false
  try {
    const url = new URL(value)
    if (['/static/app/index.html', '/static/app/auth.html', '/auth', '/auth/', '/auth/callback', '/auth/callback/'].includes(url.pathname)) return true
    // The actual served pathname must match a reserved product route as well as the
    // shared decoded-path policy; encoded slashes must not grant a Pod route trust.
    if (!isXpodProductPath(url.pathname)) return false
    return normalizeXpodReturnPath(`${url.pathname}${url.search}`) !== undefined
  } catch { return false }
}

export function isTrustedDesktopShellSender(input: {
  isCurrentWindow: boolean
  isMainFrame: boolean
  committedUrl: string
  frameUrl: string
  contentsUrl: string
}, origin: string): boolean {
  return input.isCurrentWindow && input.isMainFrame
    && isTrustedDesktopShellUrl(input.committedUrl, origin)
    && isTrustedDesktopShellUrl(input.frameUrl, origin)
    && isTrustedDesktopShellUrl(input.contentsUrl, origin)
}
