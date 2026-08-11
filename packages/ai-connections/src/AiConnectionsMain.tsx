import {
  PROVIDERS,
  useProviderLoadError,
  useProviderProducts,
  useProviderSummaries,
  useSelectedCredentialId,
  useSelectedProvider,
  type AiConnectionsController,
} from './controller'
import { AiConnectionsPanel } from './AiConnectionsPanel'
import { SolidAuthBoundary } from '@undefineds.co/extension-sdk/react'
import type { WebIdAuthState } from '@undefineds.co/solid-sdk'
import { useEffect } from 'react'

export function AiConnectionsMain({ controller }: { controller: AiConnectionsController }) {
  const selectedProvider = useSelectedProvider(controller)
  const selectedCredentialId = useSelectedCredentialId(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerProducts = useProviderProducts(controller)
  const providerLoadError = useProviderLoadError(controller)
  const provider = PROVIDERS.find((item) => item.id === selectedProvider)
  const selectedCredential = selectedProvider === 'custom'
    ? providerProducts.custom?.credentials.find((credential) => credential.id === selectedCredentialId)
    : undefined
  const providerName = selectedCredential?.label ?? providerProducts[selectedProvider]?.name ?? provider?.name ?? selectedProvider
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
      <SolidAuthBoundary
        state={authState(controller)}
        routes={controller.loginRoutes}
        onLogin={(routeId) => void controller.login(routeId)}
        onRetry={(routeId) => void controller.login(routeId)}
        copy={{
          route: {
            title: '登录 Xpod',
            description: '登录后即可管理当前 Pod 的 AI 连接。',
            startLabel: '登录',
            restoringLabel: '正在打开当前 Pod',
            retryLabel: '重新登录',
            failureTitle: '登录未完成',
            expiredTitle: '登录已过期',
          },
        }}
      >
        {null}
      </SolidAuthBoundary>
    )
  }

  return (
    <section role="region" aria-label={`${providerName} 详情`}>
      <AiConnectionsPanel
        client={controller.client}
        selectedProvider={selectedProvider}
        selectedCredentialId={selectedCredentialId}
        openExternal={controller.openExternal}
        clientConfigurationBridge={controller.clientConfigurationBridge}
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

function authState(controller: AiConnectionsController): WebIdAuthState {
  if (controller.podStatus === 'opening') {
    return { status: 'restoring' }
  }
  if (controller.sessionStatus === 'expired') {
    return {
      status: 'expired',
    }
  }
  const error = controller.error
    ?? (controller.sessionStatus === 'authenticated' && controller.podStatus !== 'ready'
      ? new Error('当前 Pod 尚未就绪')
      : undefined)
  if (error) {
    return {
      status: 'error',
      message: error.message,
      retryRouteId: controller.loginRoutes.length === 1 ? controller.loginRoutes[0]?.id : undefined,
    }
  }
  return { status: 'anonymous' }
}
