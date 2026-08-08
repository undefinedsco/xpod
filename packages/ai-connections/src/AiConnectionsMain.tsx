import {
  PROVIDERS,
  useProviderLoadError,
  useProviderSummaries,
  useServiceAccessState,
  useSelectedProvider,
  type AiConnectionsController,
  type ServiceAccessState,
} from './controller'
import { AiConnectionsPanel } from './AiConnectionsPanel'
import { AuthBoundary, type AuthBoundaryState } from '@undefineds.co/extension-sdk/react'

export function AiConnectionsMain({ controller }: { controller: AiConnectionsController }) {
  const selectedProvider = useSelectedProvider(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerLoadError = useProviderLoadError(controller)
  const serviceAccessState = useServiceAccessState(controller)
  const provider = PROVIDERS.find((item) => item.id === selectedProvider)

  if (!controller.client) {
    return (
      <AuthBoundary
        state={authBoundaryState(controller)}
        login={() => void controller.login()}
        restoringLabel="正在打开当前 Pod"
        loginView={{
          title: '登录 Xpod',
          description: '登录后即可管理当前 Pod 的 AI 连接。',
          providers: [{
            id: 'xpod',
            label: '登录',
          }],
          providerListTitle: '选择登录方式',
        }}
      >
        {null}
      </AuthBoundary>
    )
  }

  return (
    <section role="region" aria-label={`${provider?.name ?? selectedProvider} 详情`}>
      <p className="px-6 pt-4 text-xs text-muted-foreground" role="status">
        {serviceAccessStateLabel(serviceAccessState)}
      </p>
      <AiConnectionsPanel
        client={controller.client}
        selectedProvider={selectedProvider}
        openExternal={controller.openExternal}
        clientConfigurationBridge={controller.clientConfigurationBridge}
        providerSummaries={providerSummaries}
        providerProducts={controller.providerSummaries}
        providerLoadError={providerLoadError}
        serviceAccessGranted={serviceAccessState === 'granted'}
        onProviderStateChange={controller.setProviderState}
      />
    </section>
  )
}

function authBoundaryState(controller: AiConnectionsController): AuthBoundaryState {
  if (controller.sessionStatus === 'authenticating' || controller.podStatus === 'opening') {
    return { status: 'loading' }
  }
  const error = controller.error
    ?? (controller.sessionStatus === 'expired'
      ? new Error('当前登录已过期，请重新登录后继续。')
      : controller.sessionStatus === 'authenticated' && controller.podStatus !== 'ready'
        ? new Error('当前 Pod 尚未就绪')
        : undefined)
  if (error) return { status: 'error', message: error.message }
  return { status: 'anonymous' }
}

function serviceAccessStateLabel(state: ServiceAccessState): string {
  if (state === 'granted') return '服务访问已授权'
  if (state === 'checking') return '服务访问检查中'
  return '服务访问未授权'
}
