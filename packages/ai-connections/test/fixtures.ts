/**
 * Test fixtures, derived from the real catalog.
 *
 * Hand-written offerings used to drift from `provider-catalog.ts`: a fixture
 * could name a real provider while inventing its label, auth modes or lifecycle,
 * and the suite then locked the invention in. Two defects came from exactly
 * that — an `API Key` label that outlived its catalog rename, and an OpenAI
 * subscription that silently dropped the desktop import path.
 *
 * So: a fixture that means *the real provider* goes through `catalogProvider` /
 * `catalogOffering`, which read `provider-catalog.ts` and fail loudly when the
 * pair no longer exists. A fixture that means *some provider with these traits*
 * stays synthetic and uses `makeProvider` / `makeOffering`.
 */
import type {
  AiConnectionsProvider,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
} from '../src/ai-connections-client'
import { providerOfferings } from '../src/provider-catalog'
import { providerDisplayName } from '../src/display-wording'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Offerings the shared catalog publishes for a provider. `importAvailable` picks
 * the desktop variant of the OpenAI subscription, which the browser cannot offer.
 */
export function catalogOfferings(
  provider: AiConnectionsProvider,
  importAvailable = false,
): AiProviderOffering[] {
  return clone(providerOfferings(provider, importAvailable))
}

/**
 * One real offering. Throws when the provider/offering pair is gone, so a catalog
 * rename breaks the fixture instead of leaving a test to pass against a stale id.
 */
export function catalogOffering(
  provider: AiConnectionsProvider,
  offeringId: string,
  { patch = {}, importAvailable = false }: { patch?: Partial<AiProviderOffering>; importAvailable?: boolean } = {},
): AiProviderOffering {
  const available = providerOfferings(provider, importAvailable)
  const found = available.find((offering) => offering.id === offeringId)
  if (!found) {
    throw new Error(
      `provider-catalog publishes no ${provider}/${offeringId}; it has: ${available.map((offering) => offering.id).join(', ') || 'nothing'}`,
    )
  }
  return { ...clone(found), ...patch }
}

/** Provider summary carrying the catalog's offerings; `patch` overrides any field. */
export function catalogProvider(
  provider: AiConnectionsProvider,
  patch: Partial<AiProviderSummary> = {},
): AiProviderSummary {
  return makeProvider({
    ...patch,
    id: provider,
    name: patch.name ?? providerDisplayName(provider),
    offerings: patch.offerings ?? catalogOfferings(provider),
  })
}

/** Provider summary with explicit content — use when the traits are the point. */
export function makeProvider(
  patch: Partial<AiProviderSummary> & { id: AiConnectionsProvider },
): AiProviderSummary {
  return {
    name: providerDisplayName(patch.id),
    status: 'unconfigured',
    offerings: [],
    credentials: [],
    selectedModels: [],
    ...patch,
  }
}

export function makeOffering(patch: Partial<AiProviderOffering> & { id: string }): AiProviderOffering {
  return { lifecycle: 'active', ...patch }
}

export function makeCredential(
  patch: Partial<AiProviderCredentialSummary> & { offeringId: string },
): AiProviderCredentialSummary {
  return {
    id: `${patch.offeringId}-credential`,
    authMode: 'apiKey',
    enabled: true,
    priority: 10,
    health: 'unknown',
    version: 1,
    ...patch,
  }
}
