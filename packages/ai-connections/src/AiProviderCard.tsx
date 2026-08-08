import { useMemo, useState } from 'react'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from '@undefineds.co/shared-ui'
import { getProviderAvatar, getProviderAvatarBackground } from './provider-visuals'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiGatewayModel,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
  AiQuotaSnapshot,
} from './ai-connections-client'
import {
  Box,
  Brain,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Image as ImageIcon,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Trash2,
} from 'lucide-react'
import { AiQuotaCard } from './AiQuotaCard'
import { AiCredentialPoolSection } from './AiCredentialPoolSection'

export type { AiProviderDefinition } from './controller'
import type { AiProviderDefinition } from './controller'

export type ProviderConnectionState =
  | 'unknown'
  | 'pending'
  | 'configured'
  | 'connected'
  | 'disconnected'
  | 'reauthRequired'
  | 'failed'

export function AiProviderCard({
  definition,
  product,
  status,
  accountLabel,
  attempt,
  apiKey,
  baseUrl = '',
  busy,
  disabled = false,
  error,
  quota,
  models,
  verifyPending = false,
  onApiKeyChange,
  onBaseUrlChange,
  onBeginApiKey,
  onBeginOffering,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onCreateApiKeyCredential,
  onUpdateCredential,
  onDeleteCredential,
  onTestCredential,
  onReorderCredentials,
  onRefreshQuota,
  onVerify,
  onAddModel,
  onEditModel,
  onDeleteModel,
  selectedModelIds,
  onModelSelectionChange,
  onDismissError,
}: {
  definition: AiProviderDefinition
  product?: AiProviderSummary
  status: ProviderConnectionState
  accountLabel?: string
  attempt?: AiConnectAttempt
  apiKey: string
  baseUrl?: string
  busy: boolean
  disabled?: boolean
  error?: string
  quota?: AiQuotaSnapshot
  models: AiGatewayModel[]
  verifyPending?: boolean
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode) => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: (credential?: AiProviderCredentialSummary) => void
  onCreateApiKeyCredential?: (offering: AiProviderOffering, input: {
    apiKey: string
    label?: string
    baseUrl?: string
    priority: number
  }) => void
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
  }) => void
  onDeleteCredential?: (credential: AiProviderCredentialSummary) => void
  onTestCredential?: (credential: AiProviderCredentialSummary) => void
  onReorderCredentials?: (offering: AiProviderOffering, credentials: AiProviderCredentialSummary[], fromIndex: number, toIndex: number) => void
  onRefreshQuota: () => void
  onVerify?: () => void
  onAddModel?: () => void
  onEditModel?: (model: AiGatewayModel) => void
  onDeleteModel?: (model: AiGatewayModel) => void
  selectedModelIds?: string[]
  onModelSelectionChange?: (provider: AiProviderSummary['id'], modelIds: string[]) => void
  onDismissError?: () => void
}) {
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const [modelSearch, setModelSearch] = useState('')
  const [copiedModelId, setCopiedModelId] = useState<string>()
  const [localSelectedModelIds, setLocalSelectedModelIds] = useState<string[]>(selectedModelIds ?? [])
  const effectiveSelectedModelIds = selectedModelIds ?? localSelectedModelIds

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    if (!query) return models
    return models.filter((model) =>
      model.id.toLocaleLowerCase().includes(query)
      || model.displayName?.toLocaleLowerCase().includes(query))
  }, [models, modelSearch])

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId)
      setCopiedModelId(modelId)
      setTimeout(() => setCopiedModelId((current) => (current === modelId ? undefined : current)), 1_500)
    } catch {
      setCopiedModelId(undefined)
    }
  }

  const toggleModel = (modelId: string) => {
    const next = new Set(effectiveSelectedModelIds)
    if (next.has(modelId)) next.delete(modelId)
    else next.add(modelId)
    const nextModelIds = [...next]
    if (selectedModelIds === undefined) setLocalSelectedModelIds(nextModelIds)
    onModelSelectionChange?.(definition.id, nextModelIds)
  }

  return (
    <TooltipProvider>
      <div className="space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar
              className="h-9 w-9 shrink-0 rounded-lg border border-border/50 bg-muted/50 shadow-sm"
              style={getProviderAvatarBackground(definition.id) ? { backgroundColor: getProviderAvatarBackground(definition.id) } : undefined}
            >
              <AvatarImage src={getProviderAvatar(definition.id)} className="object-cover" />
              <AvatarFallback className="rounded-lg bg-transparent text-sm font-bold uppercase text-muted-foreground">
                {providerMark(definition.id)}
              </AvatarFallback>
            </Avatar>
            <div className="flex flex-col justify-center gap-0.5">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold leading-none tracking-tight text-foreground">{definition.name}</h2>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="提供商说明"
                      className="cursor-help rounded-sm text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Info aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs text-xs">{definition.description}</TooltipContent>
                </Tooltip>
              </div>
              <a
                href={definition.homeUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-0.5 text-[10px] leading-none text-muted-foreground transition-colors hover:text-primary"
              >
                访问官网 <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
              </a>
            </div>
          </div>
          <Badge variant={isConnected || isConfigured ? 'default' : 'secondary'}>
            {connectionStatusLabel(status)}
          </Badge>
        </header>

        <AiCredentialPoolSection
          definition={definition}
          product={product}
          status={status}
          accountLabel={accountLabel}
          attempt={attempt}
          apiKey={apiKey}
          baseUrl={baseUrl}
          busy={busy}
          disabled={disabled}
          error={error}
          onApiKeyChange={onApiKeyChange}
          onBaseUrlChange={onBaseUrlChange}
          onBeginApiKey={onBeginApiKey}
          onBeginOffering={onBeginOffering}
          onBeginBrowser={onBeginBrowser}
          onSaveApiKey={onSaveApiKey}
          onDisconnect={onDisconnect}
          onCreateApiKeyCredential={product?.offerings.length ? onCreateApiKeyCredential : undefined}
          onUpdateCredential={onUpdateCredential}
          onDeleteCredential={onDeleteCredential}
          onTestCredential={onTestCredential}
          onReorderCredentials={onReorderCredentials}
          onDismissError={onDismissError}
        />

        <section className="space-y-4">
          <AiQuotaCard
            providerName={definition.name}
            quota={quota}
            busy={busy}
            disabled={disabled}
            onRefresh={onRefreshQuota}
          />
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-border/40 pb-4">
            <div className="flex items-center gap-2">
              <Box className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium text-foreground/90">可用模型</h3>
              <Badge variant="secondary" className="ml-2 text-xs font-normal">{models.length}</Badge>
              <Badge variant="outline" className="text-xs font-normal">
                已选择 {effectiveSelectedModelIds.length}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {(isConfigured || isConnected) && (onVerify || onAddModel) ? (
                <>
                  {onAddModel ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={disabled || busy}
                      onClick={onAddModel}
                    >
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                      添加模型
                    </Button>
                  ) : null}
                  {onVerify ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={disabled || busy || verifyPending}
                      onClick={onVerify}
                    >
                      {verifyPending
                        ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                        : <RotateCw aria-hidden="true" className="h-3.5 w-3.5" />}
                      {verifyPending ? '验证中...' : '验证'}
                    </Button>
                  ) : null}
                </>
              ) : null}
              {models.length > 0 ? (
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="搜索模型..."
                    className="h-8 w-[180px] bg-muted/20 pl-8 text-xs"
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore
                  />
                </div>
              ) : null}
            </div>
          </div>

          {models.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/50 bg-muted/5 py-12 text-center text-sm text-muted-foreground">
              暂无可用模型
            </div>
          ) : visibleModels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/50 bg-muted/5 py-12 text-center text-sm text-muted-foreground">
              未找到匹配的模型
            </div>
          ) : (
            <div className="grid gap-2">
              {visibleModels.map((model) => {
                const isSelected = effectiveSelectedModelIds.includes(model.id)
                const isUnavailable = model.availability === 'unavailable'
                const modelLabel = model.displayName ?? model.id
                const iconTokens = [
                  ...(model.inputModalities ?? []).filter((modality) => modality !== 'text'),
                  ...(model.capabilities ?? []),
                ]
                return (
                  <div
                    key={model.id}
                    className={cn(
                      'group flex items-center gap-3 rounded-lg border bg-card p-3 transition-all duration-200 hover:border-border/60 hover:bg-accent/30',
                      isSelected ? 'border-primary/40 bg-primary/[0.03]' : 'border-border/40',
                      isUnavailable && 'opacity-75',
                    )}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={`${isSelected ? '取消选择' : '选择'} ${modelLabel}`}
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-transparent hover:border-primary/60',
                      )}
                      disabled={disabled || busy}
                      onClick={() => toggleModel(model.id)}
                    >
                      <Check aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                    <div className="shrink-0 rounded bg-muted/50 p-2 text-muted-foreground transition-colors group-hover:text-primary">
                      <Box className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground/90">{modelLabel}</span>
                        <div className="flex items-center gap-1">
                          {iconTokens.map((token) => <CapabilityIcon key={token} type={token} />)}
                        </div>
                        <Badge variant={isSelected ? 'default' : 'secondary'} className="shrink-0 text-[10px] font-normal">
                          {isSelected ? '已选择' : '未选择'}
                        </Badge>
                        <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                          {model.custom ? '手工' : '上游'}
                        </Badge>
                        {isUnavailable ? (
                          <Badge variant="destructive" className="shrink-0 text-[10px] font-normal">
                            不可用
                          </Badge>
                        ) : null}
                      </div>
                      {model.displayName ? (
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <code className="max-w-[300px] truncate font-mono text-[10px] text-muted-foreground opacity-70">{model.id}</code>
                          <button
                            type="button"
                            onClick={() => void copyModelId(model.id)}
                            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
                            aria-label={`复制 ${model.displayName} ID`}
                            title="复制 ID"
                          >
                            {copiedModelId === model.id
                              ? <Check aria-hidden="true" className="h-3 w-3 text-primary" />
                              : <Copy aria-hidden="true" className="h-3 w-3" />}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {model.custom && (onEditModel || onDeleteModel) ? (
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                        {onEditModel ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`编辑 ${model.displayName ?? model.id}`}
                            onClick={() => onEditModel(model)}
                          >
                            <Pencil aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        ) : null}
                        {onDeleteModel ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`删除 ${model.displayName ?? model.id}`}
                            onClick={() => onDeleteModel(model)}
                          >
                            <Trash2 aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </TooltipProvider>
  )
}

function CapabilityIcon({ type }: { type: string }) {
  const capability = {
    image: { icon: ImageIcon, label: '视觉识别', className: 'text-green-500' },
    web: { icon: Globe, label: '联网搜索', className: 'text-blue-500' },
    tool_call: { icon: Box, label: '函数调用', className: 'text-orange-500' },
    reasoning: { icon: Brain, label: '推理', className: 'text-purple-500' },
  }[type]
  if (!capability) return null

  const Icon = capability.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={capability.label}
          className="flex cursor-help items-center justify-center rounded-sm opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon aria-hidden="true" className={cn('h-3.5 w-3.5', capability.className)} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{capability.label}</TooltipContent>
    </Tooltip>
  )
}

function providerMark(provider: AiProviderDefinition['id']): string {
  switch (provider) {
    case 'openai': return 'OA'
    case 'anthropic': return 'A'
    case 'kimi': return 'K'
    case 'bailian': return '百'
    case 'deepseek': return 'DS'
  }
}

function connectionStatusLabel(status: ProviderConnectionState): string {
  switch (status) {
    case 'pending': return '连接中'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'disconnected': return '未设置'
    case 'reauthRequired': return '需要重新登录'
    case 'failed': return '连接失败'
    default: return '未检查'
  }
}
