import type { AiProviderAuthorizationMethod, AiProviderOffering } from '@undefineds.co/ai-connections-core/client'
import { authorizationMethodsForOffering } from './authorization-methods'

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

/** Name of the offering kind. Same taxonomy as the title fallback, so it reuses the one map. */
export function offeringKindLabel(kind: string): string {
  return FALLBACK_LABEL_BY_KIND[kind] ?? kind
}

/** How this offering can be authorized, e.g. "API Key / 账号授权". */
export function authMethodLabel(offering: AiProviderOffering, methods?: AiProviderAuthorizationMethod[]): string {
  const labels = (methods?.length ? methods : authorizationMethodsForOffering(offering))
    .map((method) => method.authMode === 'apiKey'
      ? 'API Key'
      : method.authMode === 'local'
        ? method.label
        : '账号授权')
  return [...new Set(labels)].join(' / ')
}
