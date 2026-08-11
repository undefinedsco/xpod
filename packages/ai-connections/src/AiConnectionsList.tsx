import { useContext, useRef, type KeyboardEvent } from 'react'
import { Avatar, AvatarFallback, AvatarImage, cn } from '@undefineds.co/shared-ui'
import { WorkspaceLayoutContext } from '@undefineds.co/extension-sdk/react'
import { getProviderAvatar, getProviderAvatarBackground } from './provider-visuals'
import type { AiConnectionsController, AiProviderDefinition } from './controller'
import {
  PROVIDERS,
  useProviderLoadError,
  useProviderProducts,
  useProviderSearch,
  useProviderStates,
  useSelectedCredentialId,
  useSelectedProvider,
} from './controller'

export function AiConnectionsList({ controller }: { controller: AiConnectionsController }) {
  const workspace = useContext(WorkspaceLayoutContext)
  const selectedProvider = useSelectedProvider(controller)
  const selectedCredentialId = useSelectedCredentialId(controller)
  const searchQuery = useProviderSearch(controller).trim().toLocaleLowerCase()
  const providerStates = useProviderStates(controller)
  const providerProducts = useProviderProducts(controller)
  const providerLoadError = useProviderLoadError(controller)
  const providerItems = PROVIDERS.reduce<ProviderListItem[]>((items, provider) => {
    if (provider.id !== 'custom') return [...items, { ...provider }]
    const credentials = providerProducts.custom?.credentials ?? []
    return [...items, ...(credentials.length > 0
      ? credentials.map((credential) => ({ ...provider, name: credential.label || provider.name, credentialId: credential.id }))
      : [{ ...provider }])]
  }, [])
  const providers = searchQuery
    ? providerItems.filter((provider) => providerDisplayName(provider, providerProducts).toLocaleLowerCase().includes(searchQuery))
    : providerItems

  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = providers.findIndex((provider) => provider.id === selectedProvider && provider.credentialId === selectedCredentialId)

  return (
    <div role="listbox" aria-label="AI 服务" aria-orientation="vertical" className="py-0">
      {providers.map((provider, index) => {
        const selected = selectedProvider === provider.id && provider.credentialId === selectedCredentialId
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
            controller.selectProvider(provider.id, provider.credentialId)
            if (workspace?.mode === 'stack') workspace.openMain()
            return
          }
          else return

          event.preventDefault()
          controller.selectProvider(providers[nextIndex].id, providers[nextIndex].credentialId)
          optionRefs.current[nextIndex]?.focus()
        }

        return (
          <button
            ref={(node) => {
              optionRefs.current[index] = node
            }}
            key={`${provider.id}:${provider.credentialId ?? 'default'}`}
            type="button"
            role="option"
            aria-selected={selected}
            aria-label={providerDisplayName(provider, providerProducts)}
            aria-describedby={`ai-connections-provider-${provider.id}-${provider.credentialId ?? 'default'}-status`}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => {
              controller.selectProvider(provider.id, provider.credentialId)
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
              {providerDisplayName(provider, providerProducts)}
            </span>
            <ProviderStateIndicator state={state} statusId={`ai-connections-provider-${provider.id}-${provider.credentialId ?? 'default'}-status`} />
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
    case 'zhipu': return '智'
    case 'ollama': return 'O'
    case 'custom': return 'C'
  }
}

function providerDisplayName(
  provider: ProviderListItem,
  products: ReturnType<typeof useProviderProducts>,
): string {
  return provider.name || products[provider.id]?.name || provider.id
}

type ProviderListItem = AiProviderDefinition & { credentialId?: string }

function providerStateLabel(state: import('./controller').ProviderProductState): string {
  switch (state) {
    case 'unconfigured': return '未设置'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'attention': return '需处理'
    default: return '读取中'
  }
}
