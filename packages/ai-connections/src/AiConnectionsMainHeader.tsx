import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTIONS_PINNED_SECTIONS,
  PROVIDERS,
  useProviderProducts,
  useSelectedProvider,
  useSelectedSection,
  type AiConnectionsController,
} from './controller'

export function AiConnectionsMainHeader({
  controller,
}: AppletSlotProps<AiConnectionsController>) {
  const selectedSection = useSelectedSection(controller)
  const selectedProvider = useSelectedProvider(controller)
  const providerProducts = useProviderProducts(controller)
  const provider = PROVIDERS.find((candidate) => candidate.id === selectedProvider)
  const title = AI_CONNECTIONS_PINNED_SECTIONS.find((item) => item.id === selectedSection)?.title
    ?? providerProducts[selectedProvider]?.name
    ?? provider?.name
    ?? selectedProvider

  return (
    <div className="flex h-full min-w-0 items-center px-4">
      <h1 className="truncate text-sm font-medium text-foreground">
        {title}
      </h1>
    </div>
  )
}
