import type { AppletSlotProps } from '@undefineds.co/extension-sdk/web'
import {
  AI_CONNECTIONS_PINNED_SECTIONS,
  PROVIDERS,
  useLiveUpdates,
  useProviderProducts,
  useSelectedProvider,
  useSelectedSection,
  type AiConnectionsController,
} from './controller'

/** One short line per state; the title carries the explanation. */
const LIVE_UPDATE_AFFORDANCE = {
  live: {
    label: '实时',
    title: '实时更新已开启：Pod 中的改动会立即反映到本页。',
    dotClass: 'bg-emerald-500',
  },
  unavailable: {
    label: '实时不可用',
    title: '实时更新当前不可用；本页仍会正常读取与操作。',
    dotClass: 'bg-muted-foreground/60',
  },
} as const

export function AiConnectionsMainHeader({
  controller,
}: AppletSlotProps<AiConnectionsController>) {
  const selectedSection = useSelectedSection(controller)
  const selectedProvider = useSelectedProvider(controller)
  const providerProducts = useProviderProducts(controller)
  const liveUpdates = useLiveUpdates(controller)
  const provider = PROVIDERS.find((candidate) => candidate.id === selectedProvider)
  const title = AI_CONNECTIONS_PINNED_SECTIONS.find((item) => item.id === selectedSection)?.title
    ?? providerProducts[selectedProvider]?.name
    ?? provider?.name
    ?? selectedProvider
  const liveAffordance = liveUpdates === 'idle' ? undefined : LIVE_UPDATE_AFFORDANCE[liveUpdates]

  return (
    <div className="flex h-full min-w-0 items-center gap-2 px-4">
      <h1 className="truncate text-sm font-medium text-foreground">
        {title}
      </h1>
      {liveAffordance && (
        <span
          data-live-updates={liveUpdates}
          title={liveAffordance.title}
          aria-label={liveAffordance.title}
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${liveAffordance.dotClass}`}
          />
          {liveAffordance.label}
        </span>
      )}
    </div>
  )
}
