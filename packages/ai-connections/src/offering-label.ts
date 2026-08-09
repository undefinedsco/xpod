import type { AiProviderOffering } from './ai-connections-client'

export function offeringLabel(offering: AiProviderOffering): string {
  if (offering.label) return offering.label
  if (offering.authModes?.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return '账号登录'
  if (offering.authModes?.some((mode) => mode === 'apiKey')) return 'API Key'
  return offering.id
}
