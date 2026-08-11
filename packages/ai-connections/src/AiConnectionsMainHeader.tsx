import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import {
  PROVIDERS,
  useProviderProducts,
  useSelectedProvider,
  type AiConnectionsController,
} from './controller'

export function AiConnectionsMainHeader({
  controller,
}: AppletSlotProps<AiConnectionsController>) {
  const selectedProvider = useSelectedProvider(controller)
  const providerProducts = useProviderProducts(controller)
  const provider = PROVIDERS.find((candidate) => candidate.id === selectedProvider)
  const providerName = providerProducts[selectedProvider]?.name ?? provider?.name ?? selectedProvider

  return (
    <div className="flex h-full min-w-0 items-center px-4">
      <h1 className="truncate text-sm font-medium text-foreground">
        {providerName}
      </h1>
    </div>
  )
}
