import {
  AI_CONNECTIONS_PINNED_SECTIONS,
  PROVIDERS,
  useProviderLoadError,
  useProviderProducts,
  useProviderSummaries,
  useSelectedCredentialId,
  useSelectedProvider,
  useSelectedSection,
  type AiConnectionsController,
} from './controller'
import { AiConnectionsPanel } from './AiConnectionsPanel'
import { useEffect } from 'react'

export function AiConnectionsMain({ controller }: { controller: AiConnectionsController }) {
  const selectedSection = useSelectedSection(controller)
  const selectedProvider = useSelectedProvider(controller)
  const selectedCredentialId = useSelectedCredentialId(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerProducts = useProviderProducts(controller)
  const providerLoadError = useProviderLoadError(controller)
  const provider = PROVIDERS.find((item) => item.id === selectedProvider)
  const selectedCredential = selectedProvider === 'custom'
    ? providerProducts.custom?.credentials.find((credential) => credential.id === selectedCredentialId)
    : undefined
  const pinnedLabel = AI_CONNECTIONS_PINNED_SECTIONS.find((item) => item.id === selectedSection)?.title
  const providerName = selectedCredential?.label ?? providerProducts[selectedProvider]?.name ?? provider?.name ?? selectedProvider
  const regionLabel = pinnedLabel ?? `${providerName} 详情`
  const scopedProducts = selectedProvider === 'custom' && selectedCredentialId && providerProducts.custom
    ? {
        ...providerProducts,
        custom: {
          ...providerProducts.custom,
          name: providerName,
          offerings: scopedCustomOfferings(providerProducts.custom, selectedCredential),
          credentials: providerProducts.custom.credentials.filter((credential) => credential.id === selectedCredentialId),
          selectedModels: providerProducts.custom.selectedModels.filter((model) => model.credentialId === selectedCredentialId),
        },
      }
    : providerProducts

  useEffect(() => {
    if (controller.client) void controller.loadProviders()
  }, [controller])

  if (!controller.client) {
    return (
      <section role="alert" aria-label="AI Connections unavailable">
        <h2>AI Connections 尚未就绪</h2>
        <p>宿主需要先提供已登录的 WebID 和可用的 Pod。</p>
      </section>
    )
  }

  return (
    <section role="region" aria-label={regionLabel}>
      <AiConnectionsPanel
        client={controller.client}
        clientConfigurationBridge={controller.clientConfigurationBridge}
        selectedSection={selectedSection}
        selectedProvider={selectedProvider}
        selectedCredentialId={selectedCredentialId}
        openExternal={controller.openExternal}
        providerSummaries={providerSummaries}
        providerProducts={scopedProducts}
        providerLoadError={providerLoadError}
        onProviderStateChange={controller.setProviderState}
      />
    </section>
  )
}

function scopedCustomOfferings(
  product: NonNullable<ReturnType<typeof useProviderProducts>['custom']>,
  credential: NonNullable<ReturnType<typeof useProviderProducts>['custom']>['credentials'][number] | undefined,
) {
  if (!credential) return product.offerings
  const compatibility = credential.compatibility ?? (credential.offeringId === 'anthropic-compatible' ? 'anthropic' : 'openai')
  const base = product.offerings.find((offering) => offering.id === credential.offeringId)
    ?? product.offerings[0]
  if (!base) return []
  return [{
    ...base,
    id: credential.offeringId,
    label: compatibility === 'auto' ? '自动探测' : compatibility === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容',
    endpoints: credential.baseUrl
      ? [{ protocol: compatibility === 'anthropic' ? 'anthropic' : 'chatCompletions', baseUrl: credential.baseUrl }]
      : base.endpoints,
    modelDiscovery: compatibility === 'anthropic'
      ? { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' }
      : compatibility === 'auto'
        ? { strategy: 'auto', path: '/models', endpointProtocol: 'auto' }
        : { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
  }]
}
