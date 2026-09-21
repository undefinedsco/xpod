import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
} from './contract/ai-connections-client'
import { withAuthorizationMethodLabels } from './display-wording'

/**
 * Authorization methods an offering exposes, worded for display.
 *
 * An offering that declares them keeps that list - including an empty one, which
 * is how the server says "this offering has no connect entry here" instead of
 * publishing an entry that cannot be used. The rest derive one method per entry
 * of `authModes`, which is what a payload without the field (a catalog consumer
 * that never asked the server) falls back to.
 *
 * Neither branch carries wording of its own: every path that renders a connect
 * entry goes through here, so this is the one place the applet's wording table
 * is applied, and an entry the table does not know keeps whatever the payload
 * declared - or stays unrendered, which is how "the offering did not ask for
 * this button" has always been said.
 */
export function authorizationMethodsForOffering(offering: AiProviderOffering): AiProviderAuthorizationMethod[] {
  return withAuthorizationMethodLabels(declaredOrDerivedMethods(offering))
}

function declaredOrDerivedMethods(offering: AiProviderOffering): AiProviderAuthorizationMethod[] {
  if (Array.isArray(offering.authorizationMethods)) return offering.authorizationMethods
  const lifecycle = offering.lifecycle === 'unavailable' ? 'unavailable' : 'active'
  return [...new Set(offering.authModes ?? [])].map((mode): AiProviderAuthorizationMethod => {
    if (mode === 'apiKey') {
      return {
        id: 'api-key',
        authMode: 'apiKey',
        connectMode: 'browserAssistedApiKey',
        lifecycle,
      }
    }
    if (mode === 'local') {
      const localService = offering.kind === 'local'
      return {
        id: localService ? 'local-service' : 'local-session-import',
        authMode: 'local',
        lifecycle,
      }
    }
    return {
      id: 'device-code',
      authMode: mode,
      connectMode: 'deviceCodeOAuth',
      lifecycle,
    }
  })
}

export function connectModeForMethod(method: AiProviderAuthorizationMethod): AiConnectionsMode | undefined {
  if (method.connectMode) return method.connectMode
  if (method.authMode === 'oauth' || method.authMode === 'deviceCode') return 'deviceCodeOAuth'
  if (method.authMode === 'apiKey') return 'browserAssistedApiKey'
  return undefined
}

export function isOAuthMode(mode: AiConnectionsMode | undefined): mode is 'deviceCodeOAuth' | 'authorizationCodeOAuth' {
  return mode === 'deviceCodeOAuth' || mode === 'authorizationCodeOAuth'
}

export function isOAuthMethod(method: AiProviderAuthorizationMethod): boolean {
  return isOAuthMode(connectModeForMethod(method))
}

export function isApiKeyMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.authMode === 'apiKey' || connectModeForMethod(method) === 'browserAssistedApiKey'
}

/** The catalog id of the entry that collects a key inside Xpod's own form. */
export const API_KEY_METHOD_ID = 'api-key'

/**
 * The catalog's console entry: it opens the provider's own page so the user
 * signs in there and mints the key, which then arrives as an `apiKey` credential
 * - which is why `isApiKeyMethod` covers it too.
 *
 * The two apiKey entries are different actions, and the id separates them:
 * `api-key` is the in-app form, a declaration naming the browser-assisted
 * connect mode is the console trip. Both are data; nothing here invents one.
 */
export function isBrowserConnectMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.connectMode === 'browserAssistedApiKey' && method.id !== API_KEY_METHOD_ID
}

/**
 * Where a connect entry belongs in a provider page's toolbar.
 *
 * The rank is a property of the method kind and of nothing else - not the
 * provider, not the offering, not the order an offering happens to declare its
 * methods in - so every page reads 浏览器登录 → 设备码登录 → 已有登录态 →
 * 添加 API Key, with 本地服务 wherever a local service stands in for the login
 * state. That is what keeps the API-key entry last and the browser entry first
 * even when the browser entry reaches the page from another offering than the
 * rest of the split (kimi's subscription binding is exactly that case).
 */
export function connectEntryRank(method: AiProviderAuthorizationMethod): number {
  const connectMode = connectModeForMethod(method)
  if (isBrowserConnectMethod(method) || connectMode === 'authorizationCodeOAuth') return 0
  if (connectMode === 'deviceCodeOAuth') return 1
  if (isLocalMethod(method)) return 2
  if (isApiKeyMethod(method)) return 3
  return 4
}

export function isLocalMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.authMode === 'local'
}

/** Connect mode to fall back to when an offering declares no authorization method. */
export function modeForOffering(
  offering: AiProviderOffering,
): AiConnectionsMode {
  const modes = offering.authModes ?? []
  if (modes.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return 'deviceCodeOAuth'
  return 'browserAssistedApiKey'
}

export function isPendingAttempt(attempt: AiConnectAttempt | undefined): boolean {
  return attempt?.status === 'pending' || attempt?.status === 'authorization_pending' || attempt?.status === 'slow_down'
}
