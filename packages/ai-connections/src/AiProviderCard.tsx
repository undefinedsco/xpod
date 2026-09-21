import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  TooltipProvider,
  cn,
} from '@undefineds.co/shared-ui'
import { getProviderAvatar, getProviderAvatarBackground } from './provider-visuals'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiGatewayModel,
  AiProviderCredentialSummary,
  AiProviderAuthorizationMethod,
  AiProviderOffering,
  AiProviderSummary,
} from './contract/ai-connections-client'
import {
  Box,
  Check,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react'
import { AiProviderHeader } from './AiProviderHeader'
import {
  AiCredentialPoolSection,
  type AiOfferingActionError,
  type AiOfferingQuotaState,
} from './AiCredentialPoolSection'
import {
  AiModelEmptyPanel,
  AiModelSearchInput,
  AiModelEnableToggle,
  AiModelRow,
  modelIconTokens,
} from './AiModelCatalog'

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
  onCancelConnect,
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
  modelSelectionStatus,
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
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCancelConnect?: (attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature'>) => void
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
  onCreateLocalCredential?: (offering: AiProviderOffering, method?: AiProviderAuthorizationMethod) => Promise<void>
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
  modelSelectionStatus?: 'saving' | 'saved' | 'error'
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
  const [localSelectedModelIds, setLocalSelectedModelIds] = useState<string[]>(selectedModelIds ?? [])
  const effectiveSelectedModelIds = selectedModelIds ?? localSelectedModelIds
  const catalog = useMemo(() => aggregateProviderModels(models), [models])
  const isModelSelected = (model: CatalogModel) => model.selectionIds.some((id) => effectiveSelectedModelIds.includes(id))
  const visibleModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase()
    if (!query) return catalog
    return catalog.filter((model) => model.searchText.includes(query))
  }, [catalog, modelSearch])
  const selectedModelCount = catalog.filter(isModelSelected).length
  const unavailableModelCount = catalog.filter((model) => model.availability === 'unavailable').length

  const toggleModel = (model: CatalogModel) => {
    const next = new Set(effectiveSelectedModelIds)
    const remove = isModelSelected(model)
    for (const id of remove ? model.selectionIds : model.availableSelectionIds) {
      if (remove) next.delete(id)
      else next.add(id)
    }
    const nextModelIds = [...next]
    if (selectedModelIds === undefined) setLocalSelectedModelIds(nextModelIds)
    onModelSelectionChange?.(definition.id, nextModelIds)
  }

  return (
    <TooltipProvider>
      <div className="space-y-8">
        <AiProviderHeader
          name={definition.name}
          mark={providerMark(definition.id)}
          avatar={getProviderAvatar(definition.id)}
          avatarBackground={getProviderAvatarBackground(definition.id)}
          infoLabel="提供商说明"
          infoLines={[definition.description, 'Provider 凭证保存在当前 Pod，由 Pod 权限保护。']}
          link={{ href: definition.homeUrl, label: '访问官网' }}
          badge={(
            <Badge variant={isConnected || isConfigured ? 'default' : 'secondary'}>
              {connectionStatusLabel(status)}
            </Badge>
          )}
        />

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
          onCancelConnect={onCancelConnect}
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

        <section className="space-y-8">
          <div
            data-testid="provider-models-header"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground/90">
                <Box aria-hidden="true" className="h-4 w-4 text-primary" />可用模型
              </h3>
              <span className="text-xs text-muted-foreground">
                共 {catalog.length} · 已加入 {selectedModelCount} · 已失效 {unavailableModelCount}
              </span>
              {/* Saving confirms itself; a failure is reported where every other
                  failure in this applet is reported, as a toast. The header line
                  used to narrate all three states and stayed red until the next
                  attempt. */}
              {modelSelectionStatus === 'saving' ? (
                <span role="status" aria-live="polite" aria-atomic="true"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                  保存中…
                </span>
              ) : null}
              {modelSelectionStatus === 'saved' ? (
                <span role="status" aria-live="polite" aria-atomic="true"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Check aria-hidden="true" className="h-3 w-3" />
                  已保存
                </span>
              ) : null}
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
              <AiModelSearchInput value={modelSearch} onChange={setModelSearch} />
            </div>
          </div>

          {models.length === 0 ? (
            <AiModelEmptyPanel tone={catalogError ? 'destructive' : undefined}>
              {catalogError ?? '暂无可用模型'}
            </AiModelEmptyPanel>
          ) : visibleModels.length === 0 ? (
            <AiModelEmptyPanel>未找到匹配的模型</AiModelEmptyPanel>
          ) : (
            <div className="grid gap-2">
              {visibleModels.map((model) => {
                const selectionId = modelSelectionId(model)
                const isSelected = isModelSelected(model)
                const isUnavailable = model.availability === 'unavailable'
                const modelLabel = model.displayName ?? model.id
                const iconTokens = modelIconTokens(model)
                return (
                  <AiModelRow
                    key={selectionId}
                    label={modelLabel}
                    modelId={model.id}
                    iconTokens={iconTokens}
                    enabled={isSelected}
                    toggleDisabled={disabled || busy || (isUnavailable && !isSelected)}
                    onToggle={() => toggleModel(model)}
                    onEdit={model.custom && onEditModel ? () => onEditModel(model) : undefined}
                    onDelete={model.custom && onDeleteModel ? () => onDeleteModel(model) : undefined}
                    unavailable={isUnavailable}
                    badges={(
                      <>
                        {model.custom ? <Badge variant="outline" className="shrink-0 text-[10px] font-normal">手工</Badge> : null}
                        {isUnavailable ? (
                          <Badge variant="destructive" className="shrink-0 text-[10px] font-normal">
                            已失效
                          </Badge>
                        ) : null}
                      </>
                    )}
                  />
                )
              })}
            </div>
          )}
        </section>
      </div>
    </TooltipProvider>
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

type CatalogModel = AiGatewayModel & {
  selectionIds: string[]
  availableSelectionIds: string[]
  searchText: string
}

function aggregateProviderModels(models: AiGatewayModel[]): CatalogModel[] {
  const catalog = new Map<string, CatalogModel>()
  for (const model of models) {
    const key = `${model.provider}\0${model.id}`
    const selectionId = modelSelectionId(model)
    const existing = catalog.get(key)
    const searchText = [model.id, model.displayName].filter(Boolean).join('\n').toLocaleLowerCase()
    if (!existing) {
      catalog.set(key, {
        ...model,
        selectionIds: [selectionId],
        availableSelectionIds: model.availability === 'unavailable' ? [] : [selectionId],
        searchText,
      })
      continue
    }
    if (!existing.selectionIds.includes(selectionId)) existing.selectionIds.push(selectionId)
    if (model.availability !== 'unavailable' && !existing.availableSelectionIds.includes(selectionId)) {
      existing.availableSelectionIds.push(selectionId)
    }
    if (model.availability !== 'unavailable') existing.availability = model.availability
    existing.capabilities = [...new Set([...(existing.capabilities ?? []), ...(model.capabilities ?? [])])]
    existing.inputModalities = [...new Set([...(existing.inputModalities ?? []), ...(model.inputModalities ?? [])])]
    existing.searchText += `\n${searchText}`
  }
  return [...catalog.values()]
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
