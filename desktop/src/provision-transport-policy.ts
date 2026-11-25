import { isTrustedDesktopShellSender } from './ipc-policy.js'
import { isTrustedOidcNavigation } from './navigation-policy.js'

export function canRequestDesktopProvision(input: {
  isCurrentWindow: boolean; isMainFrame: boolean;
  committedUrl: string; frameUrl: string; contentsUrl: string;
}, productOrigin: string, issuer: string | undefined): boolean {
  if (isTrustedDesktopShellSender(input, productOrigin)) return true
  if (!input.isCurrentWindow || !input.isMainFrame) return false
  // User Pod HTML can share the issuer origin. Only reserved Account documents
  // may use onboarding, and pushState cannot promote an untrusted document.
  return [input.committedUrl, input.frameUrl, input.contentsUrl].every(value => {
    if (!isTrustedOidcNavigation(value, issuer)) return false
    const path = new URL(value).pathname
    return path.startsWith('/.account/') && !path.includes('%')
  })
}
