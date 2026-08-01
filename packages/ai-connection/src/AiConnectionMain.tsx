import {
  PROVIDERS,
  useProviderLoadError,
  useProviderSummaries,
  useServiceAccessState,
  useSelectedProvider,
  type AiConnectionController,
  type ServiceAccessState,
} from './controller'
import { AiConnectionPanel } from './AiConnectionPanel'
import { Button } from '@undefineds.co/shared-ui'

export function AiConnectionMain({ controller }: { controller: AiConnectionController }) {
  const selectedProvider = useSelectedProvider(controller)
  const providerSummaries = useProviderSummaries(controller)
  const providerLoadError = useProviderLoadError(controller)
  const serviceAccessState = useServiceAccessState(controller)
  const provider = PROVIDERS.find((item) => item.id === selectedProvider)

  if (!controller.client) {
    const expired = controller.sessionStatus === 'expired'
    const opening = controller.sessionStatus === 'authenticating'
      || controller.podStatus === 'opening'
    const error = controller.error
      ?? (controller.sessionStatus === 'authenticated' && controller.podStatus !== 'ready'
        ? new Error('当前 Pod 尚未就绪')
        : undefined)

    if (opening) {
      return (
        <section aria-label="AI Connection" className="space-y-3 p-6">
          <p role="status">正在打开当前 Pod...</p>
        </section>
      )
    }

    if (error) {
      return (
        <section aria-label="AI Connection" className="space-y-3 p-6">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button size="sm" onClick={() => void controller.login()}>
            重试登录
          </Button>
        </section>
      )
    }

    return (
      <section aria-label="AI Connection" className="space-y-3 p-6">
        <p>
          {expired
            ? '当前登录已过期，请重新登录后继续。'
            : '登录后即可管理当前 Pod 的 AI 连接。'}
        </p>
        <Button size="sm" onClick={() => void controller.login()}>
          {expired ? '重新登录' : '登录'}
        </Button>
      </section>
    )
  }

  return (
    <section role="region" aria-label={`${provider?.name ?? selectedProvider} 详情`}>
      <p className="px-6 pt-4 text-xs text-muted-foreground" role="status">
        {serviceAccessStateLabel(serviceAccessState)}
      </p>
      <AiConnectionPanel
        client={controller.client}
        selectedProvider={selectedProvider}
        openExternal={controller.openExternal}
        clientConfigurationBridge={controller.clientConfigurationBridge}
        providerSummaries={providerSummaries}
        providerLoadError={providerLoadError}
        serviceAccessGranted={serviceAccessState === 'granted'}
        onProviderStateChange={controller.setProviderState}
      />
    </section>
  )
}

function serviceAccessStateLabel(state: ServiceAccessState): string {
  if (state === 'granted') return '服务访问已授权'
  if (state === 'checking') return '服务访问检查中'
  return '服务访问未授权'
}
