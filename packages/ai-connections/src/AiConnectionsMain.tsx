import {
  AI_CONNECTIONS_PINNED_SECTIONS,
  PROVIDERS,
  useLiveRevision,
  useProviderLoadError,
  useProviderProducts,
  useProviderSummaries,
  useSelectedCredentialId,
  useSelectedProvider,
  useSelectedSection,
  type AiConnectionsController,
} from './controller'
import { useCredentialRows, type CredentialRow } from './collections'
import { AiConnectionsPanel } from './AiConnectionsPanel'
import { useEffect } from 'react'

/**
 * The page's live credentials table.
 *
 * `useCredentialRows` subscribes to the controller's snapshot of the collection:
 * the rows it returns already include optimistic writes, so a create/update/
 * delete shows before the Pod has confirmed it, and the projection diff keeps
 * unchanged rows identical. Both the table and the layer that reads it are
 * loaded lazily, so this hook is a plain `useSyncExternalStore` over whatever the
 * controller has - which is nothing until the collection's first read lands.
 *
 * Until then - while the layer is still loading, after a failed first read, or
 * when the host offers no collection at all - `credentialRows` stays undefined
 * and the page keeps rendering what the store reported, so a table that cannot
 * load is never shown as an empty table.
 */
export function AiConnectionsMain({ controller, renderToaster = true }: { controller: AiConnectionsController; renderToaster?: boolean }) {
  const liveCredentialRows = useCredentialRows(controller)
  return (
    <AiConnectionsMainBody
      controller={controller}
      renderToaster={renderToaster}
      liveCredentialRows={liveCredentialRows}
    />
  )
}

function AiConnectionsMainBody({
  controller,
  renderToaster,
  liveCredentialRows,
}: {
  controller: AiConnectionsController
  renderToaster: boolean
  liveCredentialRows?: readonly CredentialRow[]
}) {
  const selectedSection = useSelectedSection(controller)
  const selectedProvider = useSelectedProvider(controller)
  const selectedCredentialId = useSelectedCredentialId(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerProducts = useProviderProducts(controller)
  const providerLoadError = useProviderLoadError(controller)
  const liveRevision = useLiveRevision(controller)
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
    // The open page holds the live subscriptions for the tables it renders, and
    // releases them when it goes away. Re-entrant, so StrictMode is harmless.
    return controller.watchPageTables()
  }, [controller])

  useEffect(() => {
    if (controller.client) void controller.loadProviders()
    return () => controller.cancelProviderLoads()
  }, [controller, liveRevision])

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
        renderToaster={renderToaster}
        clientConfigurationBridge={controller.clientConfigurationBridge}
        selectedSection={selectedSection}
        selectedProvider={selectedProvider}
        selectedCredentialId={selectedCredentialId}
        openExternal={controller.openExternal}
        providerSummaries={providerSummaries}
        providerProducts={scopedProducts}
        providerLoadError={providerLoadError}
        providerLoading={!providerProducts[selectedProvider] && !providerLoadError}
        onProviderStateChange={controller.setProviderState}
        liveRevision={liveRevision}
        liveCredentialRows={liveCredentialRows}
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
