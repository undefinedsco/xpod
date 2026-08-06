import {
  Badge,
  Button,
  Input,
} from '@undefineds.co/shared-ui'
import type {
  AiConnectAttempt,
  AiGatewayModel,
  AiProviderModel,
  AiProviderModelCatalog,
  AiQuotaSnapshot,
} from './ai-connection-client'
import {
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  RotateCw,
} from 'lucide-react'
import { AiQuotaCard } from './AiQuotaCard'

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

export function isProviderModelSelectionReady(
  status?: ProviderConnectionState,
): boolean {
  return status === 'connected' || status === 'configured'
}

export function AiProviderCard({
  definition,
  status,
  accountLabel,
  attempt,
  apiKey,
  busy,
  disabled = false,
  connectDisabled = false,
  error,
  quota,
  models,
  modelCatalog,
  modelLoading = false,
  modelSaving = false,
  modelError,
  modelSearch = '',
  selectedModelIds,
  modelDirty = false,
  modelSaved = false,
  onApiKeyChange,
  onBeginApiKey,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onRefreshQuota,
  onModelSearch,
  onToggleModel,
  onSaveModels,
  onRetryModels,
}: {
  definition: AiProviderDefinition
  status: ProviderConnectionState
  accountLabel?: string
  attempt?: AiConnectAttempt
  apiKey: string
  busy: boolean
  disabled?: boolean
  connectDisabled?: boolean
  error?: string
  quota?: AiQuotaSnapshot
  models: AiGatewayModel[]
  modelCatalog?: AiProviderModelCatalog
  modelLoading?: boolean
  modelSaving?: boolean
  modelError?: string
  modelSearch?: string
  selectedModelIds?: string[]
  modelDirty?: boolean
  modelSaved?: boolean
  onApiKeyChange: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: () => void
  onRefreshQuota: () => void
  onModelSearch?: (value: string) => void
  onToggleModel?: (model: AiProviderModel) => void
  onSaveModels?: () => void
  onRetryModels?: () => void
}) {
  const controlsDisabled = disabled || connectDisabled
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const pickerModels = modelCatalog?.models ?? []
  const selectedModelIdSet = new Set(selectedModelIds ?? pickerModels.filter((model) => model.selected).map((model) => model.id))
  const persistedModelIdSet = new Set(pickerModels.filter((model) => model.selected).map((model) => model.id))
  const hasNewModelSelections = [...selectedModelIdSet].some((id) => !persistedModelIdSet.has(id))
  const modelAdditionsBlocked = Boolean(
    modelCatalog
    && modelDirty
    && hasNewModelSelections
    && !isProviderModelSelectionReady(status),
  )
  const filteredPickerModels = modelSearch?.trim()
    ? pickerModels.filter((model) => `${model.displayName ?? ''} ${model.id}`.toLowerCase().includes(modelSearch.trim().toLowerCase()))
    : pickerModels

  return (
    <div>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{definition.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {providerDescription(definition.id)}
          </p>
        </div>
        <Badge variant={isConnected || isConfigured ? 'default' : 'secondary'}>
          {connectionStatusLabel(status)}
        </Badge>
      </header>

      <section className="border-t border-border/60 py-5" aria-label="当前连接">
        <div className="mb-4">
          <h3 className="text-sm font-medium">当前连接</h3>
          {accountLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {maskAccountLabel(accountLabel)}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Provider 凭证保存在当前 Pod，并受 Pod 权限保护。
            </p>
          )}
        </div>

        {attempt?.userCode ? (
          <div className="mb-4 border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm">
            验证码：<strong className="font-mono">{attempt.userCode}</strong>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {isConnected ? (
            <>
              <Button variant="outline" size="sm" disabled={busy || controlsDisabled} onClick={onBeginBrowser}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
                重新连接
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || controlsDisabled} onClick={onDisconnect}>
                <LogOut className="mr-2 h-4 w-4" />
                断开连接
              </Button>
            </>
          ) : isConfigured ? (
            <>
              <Button
                variant="outline"
                size="sm"
                aria-label="更新 API Key"
                disabled={busy || controlsDisabled}
                onClick={onBeginApiKey}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                更新 API Key
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || controlsDisabled} onClick={onDisconnect}>
                移除配置
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || controlsDisabled || definition.browserMode === 'connectUnsupported'}
                onClick={onBeginBrowser}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                {definition.browserLabel}
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${definition.name} API Key`}
                disabled={busy || controlsDisabled}
                onClick={onBeginApiKey}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                配置 API Key
              </Button>
            </>
          )}
        </div>

        {connectDisabled ? (
          <p className="mt-3 text-sm text-muted-foreground" role="status">
            AI Connection 管理功能已由此 Xpod 部署禁用。
          </p>
        ) : null}

        {apiKeyAttempt ? (
          <div className="mt-4 space-y-2">
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${definition.name} API Key 输入`}
              placeholder="从官方控制台复制 API Key"
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
            />
            <Button
              size="sm"
              aria-label={`保存 ${definition.name} API Key`}
              disabled={!apiKey.trim() || busy || controlsDisabled}
              onClick={onSaveApiKey}
            >
              保存 API Key
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </section>

      <section className="border-t border-border/60 py-5">
        <AiQuotaCard
          providerName={definition.name}
          quota={quota}
          busy={busy}
          disabled={controlsDisabled}
          onRefresh={onRefreshQuota}
        />
      </section>

      <section className="border-t border-border/60 py-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">模型选择</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {modelCatalog ? `已选 ${selectedModelIdSet.size} 个` : '从供应商目录中选择模型'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onRetryModels ? (
              <Button
                variant="outline"
                size="sm"
                aria-label="刷新模型"
                onClick={onRetryModels}
                disabled={controlsDisabled || modelLoading || modelSaving}
              >
                {modelLoading ? '读取中…' : '刷新模型'}
              </Button>
            ) : null}
            {modelSaved ? <span className="text-xs text-muted-foreground" role="status">已保存</span> : null}
            {modelCatalog && modelDirty && onSaveModels ? (
              <Button
                size="sm"
                disabled={modelSaving || controlsDisabled || modelAdditionsBlocked}
                onClick={onSaveModels}
              >
                {modelSaving ? '保存中…' : '保存模型'}
              </Button>
            ) : null}
          </div>
        </div>

        {modelAdditionsBlocked ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            请先重新连接后再添加模型。
          </p>
        ) : null}

        {modelError ? (
          <div className="mt-3 space-y-2" role="alert">
            <p className="text-sm text-destructive">{modelError}</p>
            {onRetryModels ? (
                <Button variant="outline" size="sm" aria-label="重试读取模型" onClick={onRetryModels} disabled={controlsDisabled}>
                重新读取模型
              </Button>
            ) : null}
          </div>
        ) : null}

        {modelLoading ? (
          <div className="mt-3 space-y-2" role="status" aria-busy="true">
            <div className="h-9 animate-pulse rounded-md bg-muted" />
            <div className="h-10 animate-pulse rounded-md bg-muted" />
            <span className="sr-only">正在读取供应商模型</span>
          </div>
        ) : modelCatalog ? (
          <>
            {modelCatalog.status === 'statusUnknown' ? (
              <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                供应商目录暂时无法确认；已选模型保持不变。
              </p>
            ) : null}
            {pickerModels.length > 0 ? (
              <div className="mt-3 space-y-3">
                <Input
                  type="search"
                  role="searchbox"
                  aria-label="搜索模型"
                  placeholder="搜索模型"
                  value={modelSearch ?? ''}
                  onChange={(event) => onModelSearch?.(event.target.value)}
                />
                {filteredPickerModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">没有匹配的模型</p>
                ) : (
                  <ul className="divide-y divide-border/50 rounded-md border text-sm">
                    {filteredPickerModels.map((model) => {
                      const selected = selectedModelIdSet.has(model.id)
                      const canSelect = (
                        selected
                        || (
                          modelCatalog.status !== 'statusUnknown'
                          && isProviderModelSelectionReady(status)
                          && model.availability === 'available'
                        )
                      )
                      return (
                        <li key={model.id} className="flex items-start gap-3 px-3 py-2.5">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-input accent-primary"
                            aria-label={`${model.displayName ?? model.id} (${model.id})`}
                            checked={selected}
                            disabled={!canSelect || controlsDisabled || modelSaving}
                            onChange={() => onToggleModel?.(model)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span>{model.displayName ?? model.id}</span>
                              {model.availability === 'unavailable' ? (
                                <Badge variant="secondary">供应商已不可用</Badge>
                              ) : model.availability === 'statusUnknown' ? (
                                <Badge variant="secondary">状态暂不可确认</Badge>
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                              {model.id}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ) : modelCatalog.status === 'notFetched' && models.length > 0 ? (
              <ul className="mt-3 divide-y divide-border/50 text-sm">
                {models.map((model) => (
                  <li key={model.id} className="flex items-center justify-between gap-4 py-2.5">
                    <span>{model.displayName ?? model.id}</span>
                    {model.displayName ? (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {model.id}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">供应商暂未返回可选模型。</p>
            )}
          </>
        ) : models.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">当前身份暂无可用模型</p>
        ) : (
          <ul className="mt-3 divide-y divide-border/50 text-sm">
            {models.map((model) => (
              <li key={model.id} className="flex items-center justify-between gap-4 py-2.5">
                <span>{model.displayName ?? model.id}</span>
                {model.displayName ? (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function providerDescription(provider: AiProviderDefinition['id']): string {
  switch (provider) {
    case 'openai': return 'OpenAI 模型与编码能力'
    case 'anthropic': return 'Claude 模型与编码能力'
    case 'kimi': return 'Moonshot AI 模型服务'
    case 'bailian': return '阿里云百炼模型服务'
    case 'deepseek': return 'DeepSeek 模型服务'
  }
}

function connectionStatusLabel(status: ProviderConnectionState): string {
  switch (status) {
    case 'pending': return '连接中'
    case 'configured': return '已配置'
    case 'connected': return '已连接'
    case 'disconnected': return '未设置'
    case 'reauthRequired': return '需要重新鉴权'
    case 'failed': return '连接失败'
    default: return '未检查'
  }
}

function maskAccountLabel(value: string): string {
  const at = value.indexOf('@')
  if (at > 0) {
    const accountName = value.slice(0, at)
    const visible = accountName.length > 1
      ? `${accountName[0]}***${accountName[accountName.length - 1]}`
      : `${accountName[0]}***`
    return `${visible}${value.slice(at)}`
  }
  if (value.length <= 2) return `${value[0] ?? ''}***`
  return `${value[0]}***${value[value.length - 1]}`
}
