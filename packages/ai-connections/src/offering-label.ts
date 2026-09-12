import type { AiProviderOffering } from './ai-connections-client'

// Offering labels are catalog data: whichever catalog supplies the offering owns
// the wording. They stay in English because they name products and categories
// ("API Platform", "Token Plan", "Claude Code Subscription") rather than UI
// actions — a second, localized copy is exactly what made the same offering
// appear under different names on different paths. This module therefore only
// supplies a fallback for offerings that arrive without a label at all.
const FALLBACK_LABEL_BY_KIND: Record<string, string | undefined> = {
  'oauth-subscription': 'Subscription',
  'api-platform': 'API Platform',
  'token-plan': 'Token Plan',
  local: 'Local',
}

export function offeringTitle(offering: AiProviderOffering): string {
  const label = offering.label?.trim()
  if (label) return label

  const byKind = offering.kind ? FALLBACK_LABEL_BY_KIND[offering.kind] : undefined
  if (byKind) return byKind

  if (offering.authModes?.some((mode) => mode === 'apiKey')) return 'API Key'
  if (offering.authModes?.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return 'Account'
  return offering.id
}
