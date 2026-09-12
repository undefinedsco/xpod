import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
} from './ai-connections-client'
import type { AiProviderDefinition } from './controller'

/**
 * Authorization methods an offering exposes. Offerings that declare them keep
 * that list; the rest derive one method per entry of `authModes`, which is what
 * the shared catalog publishes for most providers.
 */
export function authorizationMethodsForOffering(offering: AiProviderOffering): AiProviderAuthorizationMethod[] {
  if (offering.authorizationMethods?.length) return offering.authorizationMethods
  const lifecycle = offering.lifecycle === 'unavailable' ? 'unavailable' : 'active'
  return [...new Set(offering.authModes ?? [])].map((mode): AiProviderAuthorizationMethod => {
    if (mode === 'apiKey') {
      return {
        id: 'api-key',
        authMode: 'apiKey',
        connectMode: 'browserAssistedApiKey',
        label: 'API Key',
        lifecycle,
      }
    }
    if (mode === 'local') {
      const localService = offering.kind === 'local'
      return {
        id: localService ? 'local-service' : 'local-session-import',
        authMode: 'local',
        label: localService ? '本地服务' : '已有登录态',
        lifecycle,
      }
    }
    return {
      id: 'device-code',
      authMode: mode,
      connectMode: 'deviceCodeOAuth',
      label: '',
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

export function isLocalMethod(method: AiProviderAuthorizationMethod): boolean {
  return method.authMode === 'local'
}

/** Connect mode to fall back to when an offering declares no authorization method. */
export function modeForOffering(
  offering: AiProviderOffering,
  definition: AiProviderDefinition,
): AiConnectionsMode {
  const modes = offering.authModes ?? []
  if (modes.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return 'deviceCodeOAuth'
  if (modes.some((mode) => mode === 'apiKey' || mode === 'local')) return 'browserAssistedApiKey'
  return definition.browserMode === 'connectUnsupported' ? 'browserAssistedApiKey' : definition.browserMode
}

export function isPendingAttempt(attempt: AiConnectAttempt | undefined): boolean {
  return attempt?.status === 'pending' || attempt?.status === 'authorization_pending' || attempt?.status === 'slow_down'
}
