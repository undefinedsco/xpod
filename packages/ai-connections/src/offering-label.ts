import type { AiProviderOffering } from './ai-connections-client'

// 服务端目录目前只提供英文 label，这里按 offering id 给出中文标题；
// 未收录的 id 回退到服务端 label，未知场景再回退到品类标签。
const OFFERING_TITLE_BY_ID: Record<string, string> = {
  'official-subscription': '账号订阅',
  'subscription-key': 'Token 套餐',
  'api-platform': 'API 平台',
  'pay-as-you-go': '按量付费',
  'token-plan': 'Token 套餐',
  'token-plan-team': 'Token 套餐（团队版）',
  'coding-plan': 'Coding 套餐',
  local: '本地服务',
  'openai-compatible': 'OpenAI 兼容',
  'anthropic-compatible': 'Anthropic 兼容',
}

const CJK_PATTERN = /[一-鿿]/u

export function offeringTitle(offering: AiProviderOffering): string {
  const label = offering.label?.trim()
  if (label && CJK_PATTERN.test(label)) return label
  return OFFERING_TITLE_BY_ID[offering.id] ?? label ?? offeringLabel(offering)
}

export function offeringLabel(offering: AiProviderOffering): string {
  if (offering.kind === 'oauth-subscription') return '账号订阅'
  if (offering.kind === 'api-platform') return 'API 平台'
  if (offering.kind === 'token-plan') return 'Token 套餐'
  if (offering.label) return offering.label
  if (offering.authModes?.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return '账号登录'
  if (offering.authModes?.some((mode) => mode === 'apiKey')) return 'API Key'
  return offering.id
}
