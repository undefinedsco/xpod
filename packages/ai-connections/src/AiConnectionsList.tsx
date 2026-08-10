import { useContext, useRef, type KeyboardEvent } from 'react'
import { Avatar, AvatarFallback, AvatarImage, cn } from '@undefineds.co/shared-ui'
import { WorkspaceLayoutContext } from '@undefineds.co/extension-sdk/react'
import { getProviderAvatar, getProviderAvatarBackground } from './provider-visuals'
import type { AiConnectionsController } from './controller'
import {
  PROVIDERS,
  useProviderLoadError,
  useProviderSearch,
  useProviderStates,
  useSelectedProvider,
} from './controller'

export function AiConnectionsList({ controller }: { controller: AiConnectionsController }) {
  const workspace = useContext(WorkspaceLayoutContext)
  const selectedProvider = useSelectedProvider(controller)
  const searchQuery = useProviderSearch(controller).trim().toLocaleLowerCase()
  const providerStates = useProviderStates(controller)
  const providerLoadError = useProviderLoadError(controller)
  const providers = searchQuery
    ? PROVIDERS.filter((provider) => provider.name.toLocaleLowerCase().includes(searchQuery))
    : PROVIDERS

  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = providers.findIndex((provider) => provider.id === selectedProvider)

  return (
    <div role="listbox" aria-label="AI 服务" aria-orientation="vertical" className="py-0">
      {providers.map((provider, index) => {
        const selected = selectedProvider === provider.id
        const tabbable = selected || (selectedIndex < 0 && index === 0)
        const state = providerStates[provider.id] ?? 'loading'

        const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          let nextIndex: number
          if (event.key === 'ArrowDown') nextIndex = Math.min(index + 1, providers.length - 1)
          else if (event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0)
          else if (event.key === 'Home') nextIndex = 0
          else if (event.key === 'End') nextIndex = providers.length - 1
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            controller.selectProvider(provider.id)
            if (workspace?.mode === 'stack') workspace.openMain()
            return
          }
          else return

          event.preventDefault()
          controller.selectProvider(providers[nextIndex].id)
          optionRefs.current[nextIndex]?.focus()
        }

        return (
          <button
            ref={(node) => {
              optionRefs.current[index] = node
            }}
            key={provider.id}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={provider.name}
            aria-describedby={`ai-connections-provider-${provider.id}-status`}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => {
              controller.selectProvider(provider.id)
              if (workspace?.mode === 'stack') workspace.openMain()
            }}
            onKeyDown={handleKeyDown}
            className={cn(
              'group flex w-full items-center gap-3 border-l-[3px] border-transparent px-4 py-3 text-left transition-colors',
              selected ? 'border-l-primary bg-accent/80' : 'hover:bg-muted/40',
            )}
          >
            <Avatar
              className="h-9 w-9 shrink-0 rounded-md border border-border/20"
              style={getProviderAvatarBackground(provider.id) ? { backgroundColor: getProviderAvatarBackground(provider.id) } : undefined}
            >
              <AvatarImage src={getProviderAvatar(provider.id)} className="object-cover" />
              <AvatarFallback className="rounded-md bg-muted text-[10px] font-bold uppercase text-muted-foreground">
                {providerMark(provider.id)}
              </AvatarFallback>
            </Avatar>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm font-medium',
                selected ? 'text-foreground' : 'text-foreground/80',
              )}
            >
              {provider.name}
            </span>
            <ProviderStateIndicator state={state} statusId={`ai-connections-provider-${provider.id}-status`} />
          </button>
        )
      })}
      {providers.length === 0 ? (
        <p className="p-8 text-center text-xs text-muted-foreground">无结果</p>
      ) : null}
      {providerLoadError ? (
        <p className="px-4 py-2 text-xs text-destructive">Provider 状态读取失败：{providerLoadError}</p>
      ) : null}
    </div>
  )
}

function ProviderStateIndicator({
  state,
  statusId,
}: {
  state: import('./controller').ProviderProductState
  statusId: string
}) {
  const active = state === 'configured' || state === 'connected'
  return (
    <span id={statusId} role="status" aria-live="polite" className="flex shrink-0 items-center gap-1.5">
      {active ? <span className="h-2 w-2 rounded-full bg-primary" aria-hidden="true" /> : null}
      <span className="text-[11px] font-normal text-muted-foreground">{providerStateLabel(state)}</span>
    </span>
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
