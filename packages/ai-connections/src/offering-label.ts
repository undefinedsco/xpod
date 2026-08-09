import type { AiProviderOffering } from './ai-connections-client'

export function offeringLabel(offering: AiProviderOffering): string {
  if (offering.kind === 'oauth-subscription') return '账号订阅'
  if (offering.kind === 'api-platform') return 'API 平台'
  if (offering.kind === 'token-plan') return 'Token 套餐'
  if (offering.label) return offering.label
  if (offering.authModes?.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return '账号登录'
  if (offering.authModes?.some((mode) => mode === 'apiKey')) return 'API Key'
  return offering.id
}
