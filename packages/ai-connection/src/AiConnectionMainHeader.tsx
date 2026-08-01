import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import {
  PROVIDERS,
  useSelectedProvider,
  type AiConnectionController,
} from './controller'

export function AiConnectionMainHeader({
  controller,
}: AppletSlotProps<AiConnectionController>) {
  const selectedProvider = useSelectedProvider(controller)
  const provider = PROVIDERS.find((candidate) => candidate.id === selectedProvider)

  return (
    <div className="flex h-full min-w-0 items-center px-4">
      <h1 className="truncate text-sm font-medium text-foreground">
        {provider?.name ?? selectedProvider}
      </h1>
    </div>
  )
}
