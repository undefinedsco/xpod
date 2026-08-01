import { AppletList, AppletListItem } from '@undefineds.co/shared-ui'
import type { AiConnectionController } from './controller'
import {
  PROVIDERS,
  useProviderLoadError,
  useProviderSearch,
  useProviderStates,
  useSelectedProvider,
} from './controller'

export function AiConnectionList({ controller }: { controller: AiConnectionController }) {
  const selectedProvider = useSelectedProvider(controller)
  const searchQuery = useProviderSearch(controller).trim().toLocaleLowerCase()
  const providerStates = useProviderStates(controller)
  const providerLoadError = useProviderLoadError(controller)
  const providers = searchQuery
    ? PROVIDERS.filter((provider) => provider.name.toLocaleLowerCase().includes(searchQuery))
    : PROVIDERS

  return (
    <AppletList aria-label="AI 服务">
      {providers.map((provider) => (
        <ProviderListItem
          key={provider.id}
          provider={provider}
          selected={selectedProvider === provider.id}
          state={providerStates[provider.id] ?? 'loading'}
          onSelect={() => controller.selectProvider(provider.id)}
        />
      ))}
      {providers.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          没有匹配的 Provider
        </p>
      ) : null}
      {providerLoadError ? (
        <p className="px-3 py-2 text-xs text-destructive">
          Provider 状态读取失败：{providerLoadError}
        </p>
      ) : null}
    </AppletList>
  )
}

function ProviderListItem({
  provider,
  selected,
  state,
  onSelect,
}: {
  provider: (typeof PROVIDERS)[number]
  selected: boolean
  state: import('./controller').ProviderProductState
  onSelect: () => void
}) {
  const statusId = `ai-connection-provider-${provider.id}-status`
  const stateLabel = providerStateLabel(state)
  return (
    <AppletListItem
      selected={selected}
      aria-label={provider.name}
      aria-describedby={statusId}
      onClick={onSelect}
      className="gap-3 py-2.5"
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground"
      >
        {providerMark(provider.id)}
      </span>
      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
      <span
        id={statusId}
        role="status"
        aria-live="polite"
        className="shrink-0 text-[11px] font-normal text-muted-foreground"
      >
        {stateLabel}
      </span>
    </AppletListItem>
  )
}

function providerMark(provider: (typeof PROVIDERS)[number]['id']): string {
  switch (provider) {
    case 'openai': return 'OA'
    case 'anthropic': return 'A'
    case 'kimi': return 'K'
    case 'bailian': return '百'
    case 'deepseek': return 'DS'
  }
}

function providerStateLabel(state: import('./controller').ProviderProductState): string {
  switch (state) {
    case 'unconfigured': return '未设置'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'attention': return '需处理'
    default: return '读取中'
  }
}
