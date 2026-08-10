import {
  PROVIDERS,
  useProviderLoadError,
  useProviderSummaries,
  useSelectedProvider,
  type AiConnectionsController,
} from './controller'
import { AiConnectionsPanel } from './AiConnectionsPanel'
import { SolidAuthBoundary } from '@undefineds.co/extension-sdk/react'
import type { WebIdAuthState } from '@undefineds.co/solid-sdk'
import { useEffect } from 'react'

export function AiConnectionsMain({ controller }: { controller: AiConnectionsController }) {
  const selectedProvider = useSelectedProvider(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerLoadError = useProviderLoadError(controller)
  const provider = PROVIDERS.find((item) => item.id === selectedProvider)

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
    <section role="region" aria-label={`${provider?.name ?? selectedProvider} 详情`}>
      <AiConnectionsPanel
        client={controller.client}
        selectedProvider={selectedProvider}
        openExternal={controller.openExternal}
        clientConfigurationBridge={controller.clientConfigurationBridge}
        providerSummaries={providerSummaries}
        providerProducts={controller.providerSummaries}
        providerLoadError={providerLoadError}
        serviceAccessGranted
        onProviderStateChange={controller.setProviderState}
      />
    </section>
  )
}

function authState(controller: AiConnectionsController): WebIdAuthState {
  if (controller.sessionStatus === 'authenticating' || controller.podStatus === 'opening') {
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
