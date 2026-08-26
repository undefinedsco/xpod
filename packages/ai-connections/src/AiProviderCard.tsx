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
  AiModelSummary,
  AiQuotaSnapshot,
} from './ai-connections-client'
import {
  Box,
  Brain,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Image as ImageIcon,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Settings2,
  Trash2,
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

export function AiProviderCard({
  definition,
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
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onRefreshQuota,
  onVerify,
  onAddModel,
  onEditModel,
  onDeleteModel,
}: {
  definition: AiProviderDefinition
  status: ProviderConnectionState
  accountLabel?: string
  attempt?: AiConnectAttempt
  apiKey: string
  baseUrl?: string
  busy: boolean
  disabled?: boolean
  error?: string
  quota?: AiQuotaSnapshot
  models: AiModelSummary[]
  verifyPending?: boolean
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: () => void
  onRefreshQuota: () => void
  onVerify?: () => void
  onAddModel?: () => void
  onEditModel?: (model: AiModelSummary) => void
  onDeleteModel?: (model: AiModelSummary) => void
}) {
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const [showKey, setShowKey] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [copiedModelId, setCopiedModelId] = useState<string>()

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

        <section className="space-y-4" aria-label="当前连接">
          <div className="flex items-center gap-2 border-b border-border/40 pb-2">
            <Settings2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground/90">当前连接</h3>
          </div>
          <div>
            {accountLabel ? (
              <p className="text-xs text-muted-foreground">{maskAccountLabel(accountLabel)}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Provider 凭证保存在当前 Pod，不会在连接列表中展示。</p>
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
                <Button variant="outline" size="sm" disabled={busy || disabled} onClick={onBeginBrowser}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
                  重新连接
                </Button>
                <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={onDisconnect}>
                  <LogOut className="mr-2 h-4 w-4" />
                  断开连接
                </Button>
              </>
            ) : isConfigured ? (
              <>
                <Button variant="outline" size="sm" aria-label="更新 API Key" disabled={busy || disabled} onClick={onBeginApiKey}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  更新 API Key
                </Button>
                <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={onDisconnect}>
                  移除配置
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || disabled || definition.browserMode === 'connectUnsupported'}
                  onClick={onBeginBrowser}
                >
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                  {definition.browserLabel}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${definition.name} API Key`}
                  disabled={busy || disabled}
                  onClick={onBeginApiKey}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  配置 API Key
                </Button>
              </>
            )}
          </div>

          {apiKeyAttempt ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">API Key</span>
                {definition.apiKeyUrl ? (
                  <a href={definition.apiKeyUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                    获取 API Key
                  </a>
                ) : null}
              </div>
              <div className="group relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  aria-label={`${definition.name} API Key 输入`}
                  placeholder={definition.apiKeyPlaceholder || '从官方控制台复制 API Key'}
                  value={apiKey}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  onInput={(event) => onApiKeyChange(event.currentTarget.value)}
                  className="border-border/60 bg-muted/20 pr-10 font-mono transition-colors focus:border-primary/50 focus:bg-background"
                />
                <div className="absolute bottom-1 right-1 top-1 flex items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-full w-8 rounded hover:bg-muted"
                    onClick={() => setShowKey((current) => !current)}
                    aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                  >
                    {showKey
                      ? <EyeOff className="h-4 w-4 text-muted-foreground" />
                      : <Eye className="h-4 w-4 text-muted-foreground" />}
                  </Button>
                </div>
              </div>
              {onBaseUrlChange ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Base URL（选填）</span>
                  </div>
                  <Input
                    autoComplete="off"
                    data-lpignore="true"
                    data-1p-ignore
                    aria-label={`${definition.name} Base URL 输入`}
                    placeholder={definition.defaultBaseUrl || '默认服务地址'}
                    value={baseUrl}
                    onChange={(event) => onBaseUrlChange(event.target.value)}
                    onInput={(event) => onBaseUrlChange(event.currentTarget.value)}
                    className="border-border/60 bg-muted/20 font-mono text-xs transition-colors focus:border-primary/50 focus:bg-background"
                  />
                  <p className="break-all font-mono text-[11px] text-muted-foreground opacity-80">
                    <span className="mr-1 select-none opacity-50">预览:</span>
                    {(baseUrl.trim() || definition.defaultBaseUrl || '').replace(/\/+$/, '')}/chat/completions
                  </p>
                </div>
              ) : null}
              <Button
                size="sm"
                aria-label={`保存 ${definition.name} API Key`}
                disabled={disabled}
                onClick={onSaveApiKey}
              >
                保存 API Key
              </Button>
            </div>
          ) : null}
          {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        </section>

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
            </div>
            <div className="flex items-center gap-2">
              {(isConfigured || isConnected) && (onVerify || onAddModel) ? (
                <>
                  {onAddModel ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={disabled}
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
                const iconTokens = [
                  ...(model.inputModalities ?? []).filter((modality) => modality !== 'text'),
                  ...(model.capabilities ?? []),
                ]
                return (
                  <div
                    key={model.id}
                    className="group flex items-center gap-3 rounded-lg border border-border/40 bg-card p-3 transition-all duration-200 hover:border-border/60 hover:bg-accent/30"
                  >
                    <div className="shrink-0 rounded bg-muted/50 p-2 text-muted-foreground transition-colors group-hover:text-primary">
                      <Box className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground/90">{model.displayName ?? model.id}</span>
                        <div className="flex items-center gap-1">
                          {iconTokens.map((token) => <CapabilityIcon key={token} type={token} />)}
                        </div>
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
