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
import {
  AiCredentialPoolSection,
  type AiOfferingActionError,
  type AiOfferingQuotaState,
} from './AiCredentialPoolSection'
import { offeringTitle } from './offering-label'

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
  attemptOfferingId,
  apiKey,
  baseUrl = '',
  busy,
  disabled = false,
  error,
  quotas,
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
  onCreateLocalCredential,
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
  attemptOfferingId?: string
  apiKey: string
  baseUrl?: string
  busy: boolean
  disabled?: boolean
  error?: AiOfferingActionError
  quotas?: Partial<Record<string, AiOfferingQuotaState>>
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
    proxyUrl?: string
    priority: number
  }) => Promise<void>
  onCreateLocalCredential?: (offering: AiProviderOffering) => Promise<void>
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
    proxyUrl?: string
  }) => Promise<void>
  onDeleteCredential?: (credential: AiProviderCredentialSummary) => void
  onTestCredential?: (credential: AiProviderCredentialSummary) => void
  onReorderCredentials?: (offering: AiProviderOffering, credentials: AiProviderCredentialSummary[], fromIndex: number, toIndex: number) => void
  onRefreshQuota: (offering: AiProviderOffering, credential?: AiProviderCredentialSummary) => void
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
  const catalogError = models.length === 0 && error?.message && !error.offeringId
    ? error.message
    : undefined
  const [modelSearch, setModelSearch] = useState('')
  const [copiedModelId, setCopiedModelId] = useState<string>()
  const [localSelectedModelIds, setLocalSelectedModelIds] = useState<string[]>(selectedModelIds ?? [])
  const effectiveSelectedModelIds = selectedModelIds ?? localSelectedModelIds
  const offeringSources = useMemo(() => new Map(
    product?.offerings.map((offering) => [offering.id, {
      id: offering.id,
      label: offeringTitle(offering),
    }]) ?? [],
  ), [product?.offerings])

  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    if (!query) return models
    return models.filter((model) => modelSearchText(model, offeringSources).includes(query))
  }, [models, modelSearch, offeringSources])
  const selectableVisibleModels = visibleModels.filter((model) => model.availability !== 'unavailable')
  const selectedVisibleCount = selectableVisibleModels.filter((model) => effectiveSelectedModelIds.includes(modelSelectionId(model))).length
  const allVisibleSelected = selectableVisibleModels.length > 0 && selectedVisibleCount === selectableVisibleModels.length
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected
  const unavailableModelCount = models.filter((model) => model.availability === 'unavailable').length

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

  const toggleVisibleModels = () => {
    const next = new Set(effectiveSelectedModelIds)
    for (const model of selectableVisibleModels) {
      const selectionId = modelSelectionId(model)
      if (allVisibleSelected) next.delete(selectionId)
      else next.add(selectionId)
    }
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
                      className="cursor-help rounded-sm text-muted-foreground/50 focus:outline-none focus-visible:text-foreground"
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
          attemptOfferingId={attemptOfferingId}
          apiKey={apiKey}
          baseUrl={baseUrl}
          busy={busy}
          disabled={disabled}
          error={error}
          suppressError={Boolean(catalogError)}
          quotas={quotas}
          onApiKeyChange={onApiKeyChange}
          onBaseUrlChange={onBaseUrlChange}
          onBeginApiKey={onBeginApiKey}
          onBeginOffering={onBeginOffering}
          onBeginBrowser={onBeginBrowser}
          onSaveApiKey={onSaveApiKey}
          onDisconnect={onDisconnect}
          onCreateApiKeyCredential={product?.offerings.length ? onCreateApiKeyCredential : undefined}
          onCreateLocalCredential={product?.offerings.length ? onCreateLocalCredential : undefined}
          onUpdateCredential={onUpdateCredential}
          onDeleteCredential={onDeleteCredential}
          onTestCredential={onTestCredential}
          onReorderCredentials={onReorderCredentials}
          onRefreshQuota={onRefreshQuota}
          onDismissError={onDismissError}
        />

        <section className="space-y-4">
          <div
            data-testid="provider-models-header"
            className="flex flex-col gap-3 border-b border-border/40 pb-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Box className="h-4 w-4 shrink-0 text-primary" />
              <h3 className="shrink-0 text-sm font-medium text-foreground/90">可用模型</h3>
              <span className="text-xs text-muted-foreground">
                共 {models.length} · 已加入 {effectiveSelectedModelIds.length} · 已失效 {unavailableModelCount}
              </span>
            </div>
            <div
              data-testid="provider-models-actions"
              className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap sm:justify-end"
            >
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
                  {onVerify && models.length > 0 ? (
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
                      {verifyPending ? '同步中...' : '刷新模型'}
                    </Button>
                  ) : onVerify ? (
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
                      {verifyPending ? '同步中...' : '同步模型'}
                    </Button>
                  ) : null}
                </>
              ) : null}
              <div className="relative w-full sm:w-auto">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="搜索模型..."
                  className="h-8 w-full bg-background pl-8 text-xs sm:w-[232px]"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore
                />
              </div>
            </div>
          </div>

          {models.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/50 bg-muted/5 py-12 text-center text-sm text-muted-foreground">
              {catalogError ? (
                <p className="text-destructive">{catalogError}</p>
              ) : (
                '暂无可用模型'
              )}
            </div>
          ) : visibleModels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/50 bg-muted/5 py-12 text-center text-sm text-muted-foreground">
              未找到匹配的模型
            </div>
          ) : (
            <div className="grid gap-2">
              <div className="flex items-center justify-between px-1 py-1">
                <button
                  type="button"
                  role="checkbox"
                  aria-label="全选当前结果"
                  aria-checked={someVisibleSelected ? 'mixed' : allVisibleSelected}
                  disabled={disabled || busy || selectableVisibleModels.length === 0}
                  onClick={toggleVisibleModels}
                  className="flex items-center gap-2 text-xs text-muted-foreground disabled:opacity-50"
                >
                  <span className={cn(
                    'flex h-4 w-4 items-center justify-center rounded border',
                    allVisibleSelected || someVisibleSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}>
                    {someVisibleSelected ? <span aria-hidden="true">−</span> : <Check aria-hidden="true" className={cn('h-3 w-3', !allVisibleSelected && 'invisible')} />}
                  </span>
                  全选当前结果
                </button>
              </div>
              {visibleModels.map((model) => {
                const selectionId = modelSelectionId(model)
                const isSelected = effectiveSelectedModelIds.includes(selectionId)
                const isUnavailable = model.availability === 'unavailable'
                const modelLabel = model.displayName ?? model.id
                const source = modelOfferingSource(model, offeringSources)
                const iconTokens = [
                  ...(model.inputModalities ?? []).filter((modality) => modality !== 'text'),
                  ...(model.capabilities ?? []),
                ]
                return (
                  <div
                    key={selectionId}
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
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus:outline-none focus-visible:border-ring',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-transparent hover:border-primary/60',
                      )}
                      disabled={disabled || busy || (isUnavailable && !isSelected)}
                      onClick={() => toggleModel(selectionId)}
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
                        {source ? (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px] font-normal"
                            aria-label={`模型来源：${source.label}`}
                            title={source.id}
                          >
                            {source.label}
                          </Badge>
                        ) : null}
                        {model.custom ? <Badge variant="outline" className="shrink-0 text-[10px] font-normal">手工</Badge> : null}
                        {isUnavailable ? (
                          <Badge variant="destructive" className="shrink-0 text-[10px] font-normal">
                            已失效
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
          className="flex cursor-help items-center justify-center rounded-sm opacity-80 transition-opacity hover:opacity-100 focus:outline-none focus-visible:opacity-100"
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
    case 'zhipu': return '智'
    case 'ollama': return 'O'
    case 'custom': return 'C'
  }
}

function modelSelectionId(model: AiGatewayModel): string {
  return model.resourceId
    ?? (model.offeringId ? `${model.offeringId}:${model.id}` : model.id)
}

function modelSearchText(model: AiGatewayModel, offeringSources: Map<string, ModelOfferingSource>): string {
  const source = modelOfferingSource(model, offeringSources)
  return [
    model.id,
    model.displayName,
    source?.label,
    source?.id,
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase()
}

function modelOfferingSource(
  model: AiGatewayModel,
  offeringSources: Map<string, ModelOfferingSource>,
): ModelOfferingSource | undefined {
  if (!model.offeringId) return undefined
  return offeringSources.get(model.offeringId) ?? { id: model.offeringId, label: model.offeringId }
}

type ModelOfferingSource = {
  id: string
  label: string
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
