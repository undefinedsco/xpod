// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiProviderCard } from '../src/AiProviderCard'
import { PROVIDERS } from '../src/controller'
import { providerProductsForDeployment } from '../../../src/api/ai-gateway/providers/ProviderRegistry'
import type {
  AiConnectionsProvider,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
} from '../src/contract/ai-connections-client'

/** Real server catalog drives this regression: the pool summary is computed
 * from stored credential health/enabled, not from any UI-side tally. */

afterEach(() => {
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

function serverProduct(provider: AiConnectionsProvider): AiProviderSummary {
  const product = providerProductsForDeployment('cloud').find((candidate) => candidate.id === provider)
  if (!product) throw new Error(`the server catalog publishes no ${provider}`)
  return {
    id: provider,
    name: product.label,
    offerings: product.offerings as unknown as AiProviderOffering[],
    credentials: [],
    selectedModels: [],
    status: 'unconfigured',
  }
}

function credential(
  patch: Partial<AiProviderCredentialSummary> & { id: string },
): AiProviderCredentialSummary {
  return {
    offeringId: 'api-platform',
    authMode: 'apiKey',
    enabled: true,
    priority: 10,
    health: 'unknown',
    version: 1,
    ...patch,
  }
}

function renderPool(credentials: AiProviderCredentialSummary[]) {
  const definition = PROVIDERS.find((candidate) => candidate.id === 'openai')
  if (!definition) throw new Error('no provider definition for openai')
  return render(
    <AiProviderCard
      definition={definition}
      product={{ ...serverProduct('openai'), credentials }}
      status="connected"
      apiKey=""
      busy={false}
      models={[]}
      onApiKeyChange={vi.fn()}
      onBeginApiKey={vi.fn()}
      onBeginBrowser={vi.fn()}
      onSaveApiKey={vi.fn()}
      onDisconnect={vi.fn()}
    />,
  )
}

describe('provider credential pool summary', () => {
  it('omits the summary when every credential is healthy', () => {
    renderPool([credential({ id: 'a', health: 'healthy' })])
    expect(screen.queryByText(/条里有 \d+ 条已验证可用/)).toBeNull()
  })

  it('counts only enabled healthy credentials, over all credentials', () => {
    renderPool([
      credential({ id: 'a', health: 'healthy', enabled: true }),
      credential({ id: 'b', health: 'healthy', enabled: false }),
      credential({ id: 'c', health: 'expired', enabled: true }),
    ])
    expect(screen.getByText('3 条里有 1 条已验证可用')).toBeTruthy()
  })

  it('shows the summary for an invalid credential', () => {
    renderPool([credential({ id: 'a', health: 'invalid' })])
    expect(screen.getByText('1 条里有 0 条已验证可用')).toBeTruthy()
  })

  it('treats a quota-exhausted credential as a failure and excludes it from the healthy count', () => {
    // Published shape: health stays healthy/expired/invalid/unknown; quota exhaustion is the
    // optional lastFailureCode the server sets from insufficient_quota/402
    // (src/api/ai-gateway/providers/ProviderRuntimeAdapter.ts:736-741, connect/index.ts:371).
    renderPool([
      credential({ id: 'a', health: 'healthy' }),
      credential({ id: 'b', health: 'healthy', lastFailureCode: 'quota_exhausted' }),
    ])
    expect(screen.getByText('2 条里有 1 条已验证可用')).toBeTruthy()
  })
})
