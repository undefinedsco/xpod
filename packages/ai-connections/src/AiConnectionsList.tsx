import { useContext, useRef, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import { Avatar, AvatarFallback, AvatarImage, cn } from '@undefineds.co/shared-ui'
import { WorkspaceLayoutContext } from '@undefineds.co/extension-sdk/react'
import { KeyRound } from 'lucide-react'
import { getProviderAvatar, getProviderAvatarBackground } from './provider-visuals'
import type { AiConnectionsController, AiProviderDefinition } from './controller'
import {
  AI_CONNECTIONS_PINNED_SECTIONS,
  PROVIDERS,
  useProviderLoadError,
  useProviderProducts,
  useProviderSearch,
  useProviderStates,
  useSelectedCredentialId,
  useSelectedProvider,
  useSelectedSection,
  type AiConnectionsPinnedSection,
} from './controller'

export function AiConnectionsList({ controller }: { controller: AiConnectionsController }) {
  const workspace = useContext(WorkspaceLayoutContext)
  const selectedSection = useSelectedSection(controller)
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
  const items: WorkspaceListItem[] = [
    ...AI_CONNECTIONS_PINNED_SECTIONS.map((section) => ({ kind: 'section' as const, id: section.id, label: section.label })),
    ...providers.map((provider) => ({ kind: 'provider' as const, provider })),
  ]

  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = items.findIndex((item) => item.kind === 'section'
    ? selectedSection === item.id
    : selectedSection === 'provider' && item.provider.id === selectedProvider && item.provider.credentialId === selectedCredentialId)

  const activate = (item: WorkspaceListItem) => {
    if (item.kind === 'section') controller.selectSection(item.id)
    else controller.selectProvider(item.provider.id, item.provider.credentialId)
    if (workspace?.mode === 'stack') workspace.openMain()
  }

  return (
    <div role="listbox" aria-label="AI 服务" aria-orientation="vertical" className="py-2">
      <section className="mb-3" aria-label="API Keys">
        {items.filter((item) => item.kind === 'section').map((item) => {
          const index = items.indexOf(item)
          return (
            <WorkspaceOption
              key={item.id}
              index={index}
              selected={selectedSection === item.id}
              tabbable={selectedIndex === index || (selectedIndex < 0 && index === 0)}
              label={item.label}
              optionRefs={optionRefs}
              onActivate={() => activate(item)}
              onMove={(nextIndex) => moveSelection(items, nextIndex, controller, optionRefs)}
            >
              <PinnedMark section={item.id} />
              <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', selectedSection === item.id ? 'text-foreground' : 'text-foreground/80')}>
                {item.label}
              </span>
            </WorkspaceOption>
          )
        })}
      </section>
      <section>
        <h2 className="px-5 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Provider</h2>
        {providers.map((provider) => {
          const index = items.findIndex((item) => item.kind === 'provider'
            && item.provider.id === provider.id
            && item.provider.credentialId === provider.credentialId)
          const selected = selectedSection === 'provider' && selectedProvider === provider.id && provider.credentialId === selectedCredentialId
          const state = providerStates[provider.id] ?? 'loading'
          return (
            <WorkspaceOption
              key={`${provider.id}:${provider.credentialId ?? 'default'}`}
              index={index}
              selected={selected}
              tabbable={selected || (selectedIndex < 0 && index === 0)}
              label={providerDisplayName(provider, providerProducts)}
              describedBy={`ai-connections-provider-${provider.id}-${provider.credentialId ?? 'default'}-status`}
              optionRefs={optionRefs}
              onActivate={() => activate({ kind: 'provider', provider })}
              onMove={(nextIndex) => moveSelection(items, nextIndex, controller, optionRefs)}
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
              <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', selected ? 'text-foreground' : 'text-foreground/80')}>
                {providerDisplayName(provider, providerProducts)}
              </span>
              <ProviderStateIndicator state={state} statusId={`ai-connections-provider-${provider.id}-${provider.credentialId ?? 'default'}-status`} />
            </WorkspaceOption>
          )
        })}
        {providers.length === 0 ? (
          <p className="p-8 text-center text-xs text-muted-foreground">无结果</p>
        ) : null}
      </section>
      {providerLoadError ? (
        <p className="px-4 py-2 text-xs text-destructive">Provider 状态读取失败：{providerLoadError}</p>
      ) : null}
    </div>
  )
}

function WorkspaceOption({
  index,
  selected,
  tabbable,
  label,
  describedBy,
  statusId,
  optionRefs,
  onActivate,
  onMove,
  children,
}: {
  index: number
  selected: boolean
  tabbable: boolean
  label: string
  describedBy?: string
  statusId?: string
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>
  onActivate: () => void
  onMove: (nextIndex: number) => void
  children: ReactNode
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') onMove(index + 1)
    else if (event.key === 'ArrowUp') onMove(index - 1)
    else if (event.key === 'Home') onMove(0)
    else if (event.key === 'End') onMove(Number.POSITIVE_INFINITY)
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate()
      return
    }
    else return
    event.preventDefault()
  }

  return (
    <button
      ref={(node) => {
        optionRefs.current[index] = node
      }}
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={label}
      aria-describedby={describedBy ?? statusId}
      tabIndex={tabbable ? 0 : -1}
      onClick={onActivate}
      onKeyDown={handleKeyDown}
      className={cn(
        'group flex w-full items-center gap-3 border-l-[3px] border-transparent px-4 py-3 text-left transition-colors',
        selected ? 'border-l-primary bg-accent/80' : 'hover:bg-muted/40',
      )}
    >
      {children}
    </button>
  )
}

function moveSelection(
  items: WorkspaceListItem[],
  requestedIndex: number,
  controller: AiConnectionsController,
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>,
) {
  const nextIndex = Math.min(Math.max(requestedIndex, 0), items.length - 1)
  const item = items[nextIndex]
  if (!item) return
  if (item.kind === 'section') controller.selectSection(item.id)
  else controller.selectProvider(item.provider.id, item.provider.credentialId)
  optionRefs.current[nextIndex]?.focus()
}

function PinnedMark({ section: _section }: { section: AiConnectionsPinnedSection }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/20 bg-muted text-muted-foreground">
      <KeyRound className="h-4 w-4" aria-hidden="true" />
    </span>
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

type WorkspaceListItem =
  | { kind: 'section'; id: AiConnectionsPinnedSection; label: string }
  | { kind: 'provider'; provider: ProviderListItem }

function providerStateLabel(state: import('./controller').ProviderProductState): string {
  switch (state) {
    case 'unconfigured': return '未设置'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'attention': return '需处理'
    default: return '读取中'
  }
}
