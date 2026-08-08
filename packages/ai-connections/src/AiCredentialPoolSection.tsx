import { useState } from 'react'
import {
  Button,
  Input,
  LoginConnectingView,
  LoginFailureView,
  LoginProviderListView,
  type LoginProviderOption,
} from '@undefineds.co/shared-ui'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RotateCw,
  Settings2,
  Trash2,
} from 'lucide-react'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
} from './ai-connections-client'
import type {
  AiProviderDefinition,
} from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import { AiOfferingTabs, offeringLabel } from './AiOfferingTabs'

export function AiCredentialPoolSection({
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
  onDismissError?: () => void
}) {
  const fallbackOfferings = [{
    id: 'api-platform',
    label: 'API Key',
    authModes: ['apiKey' as const],
  }]
  const credentials = product?.credentials ?? []

  return (
    <section className="space-y-4" aria-label="当前连接">
      <div className="flex items-center gap-2 border-b border-border/40 pb-2">
        <Settings2 className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium text-foreground/90">当前连接</h3>
      </div>

      <AiOfferingTabs product={product} fallbackOfferings={fallbackOfferings}>
        {(offering) => {
          const mode = modeForOffering(offering, definition)
          const offeringCredentials = credentials
            .filter((credential) => credential.offeringId === offering.id)
            .sort((left, right) => left.priority - right.priority)

          if (error && mode === 'deviceCodeOAuth') {
            return (
              <LoginFailureView
                description={error}
                primaryLabel="重试登录"
                onPrimary={() => onBeginOffering?.(offering, mode)}
                secondaryLabel="关闭"
                onSecondary={onDismissError ?? (() => undefined)}
              />
            )
          }

          if (isPendingAttempt(attempt) && mode === 'deviceCodeOAuth') {
            return (
              <LoginConnectingView
                title="正在连接"
                detail={attempt?.userCode ? `验证码：${attempt.userCode}` : '请在打开的页面完成授权。'}
                providerLabel={offeringLabel(offering)}
                providerHost={definition.name}
              />
            )
          }

          if (mode === 'deviceCodeOAuth') {
            return (
              <div className="space-y-3">
                <LoginProviderListView
                  title={offeringLabel(offering)}
                  providers={oauthProviderOptions(offering, offeringCredentials)}
                  connectingId={isPendingAttempt(attempt) ? definition.id : undefined}
                  onConnect={(credentialId) => {
                    const credential = offeringCredentials.find((item) => item.id === credentialId)
                    if (credential) {
                      onDisconnect(credential)
                      return
                    }
                    onBeginOffering?.(offering, mode)
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || disabled} onClick={() => onBeginOffering?.(offering, mode)}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                    {offeringCredentials.length ? '添加账号' : '登录'}
                  </Button>
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </div>
            )
          }

          return (
            <ApiKeyPool
              definition={definition}
              status={status}
              accountLabel={accountLabel}
              credentials={offeringCredentials}
              attempt={attempt}
              apiKey={apiKey}
              baseUrl={baseUrl}
              busy={busy}
              disabled={disabled}
              error={error}
              onApiKeyChange={onApiKeyChange}
              onBaseUrlChange={onBaseUrlChange}
              onBeginApiKey={onBeginApiKey}
              onBeginBrowser={onBeginBrowser}
              onSaveApiKey={onSaveApiKey}
              onDisconnect={onDisconnect}
              onCreateApiKeyCredential={onCreateApiKeyCredential
                ? (input) => onCreateApiKeyCredential(offering, input)
                : undefined}
              onUpdateCredential={onUpdateCredential}
              onDeleteCredential={onDeleteCredential}
              onTestCredential={onTestCredential}
              onMoveCredential={(fromIndex, toIndex) => onReorderCredentials?.(
                offering,
                offeringCredentials,
                fromIndex,
                toIndex,
              )}
            />
          )
        }}
      </AiOfferingTabs>
    </section>
  )
}

function ApiKeyPool({
  definition,
  status,
  accountLabel,
  credentials,
  attempt,
  apiKey,
  baseUrl,
  busy,
  disabled,
  error,
  onApiKeyChange,
  onBaseUrlChange,
  onBeginApiKey,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onCreateApiKeyCredential,
  onUpdateCredential,
  onDeleteCredential,
  onTestCredential,
  onMoveCredential,
}: {
  definition: AiProviderDefinition
  status: ProviderConnectionState
  accountLabel?: string
  credentials: AiProviderCredentialSummary[]
  attempt?: AiConnectAttempt
  apiKey: string
  baseUrl: string
  busy: boolean
  disabled: boolean
  error?: string
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: () => void
  onCreateApiKeyCredential?: (input: {
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
  onMoveCredential?: (fromIndex: number, toIndex: number) => void
}) {
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const hasPoolActions = Boolean(onCreateApiKeyCredential)
  const [showKey, setShowKey] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>()
  const [editingCredential, setEditingCredential] = useState<AiProviderCredentialSummary>()
  const [poolLabel, setPoolLabel] = useState('')
  const [poolApiKey, setPoolApiKey] = useState('')
  const [poolBaseUrl, setPoolBaseUrl] = useState('')

  const openCreateForm = () => {
    setFormMode('create')
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
  }

  const openEditForm = (credential: AiProviderCredentialSummary) => {
    setFormMode('edit')
    setEditingCredential(credential)
    setPoolLabel(credential.label ?? '')
    setPoolApiKey('')
    setPoolBaseUrl(credential.baseUrl ?? '')
  }

  const closePoolForm = () => {
    setFormMode(undefined)
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
  }

  const savePoolForm = () => {
    if (formMode === 'create') {
      const trimmedKey = poolApiKey.trim()
      if (!trimmedKey || !onCreateApiKeyCredential) return
      onCreateApiKeyCredential({
        apiKey: trimmedKey,
        label: poolLabel.trim() || undefined,
        baseUrl: poolBaseUrl.trim() || undefined,
        priority: nextCredentialPriority(credentials),
      })
      closePoolForm()
      return
    }
    if (formMode === 'edit' && editingCredential && onUpdateCredential) {
      onUpdateCredential(editingCredential, {
        label: poolLabel.trim() || undefined,
        baseUrl: poolBaseUrl.trim() || undefined,
      })
      closePoolForm()
    }
  }

  return (
    <div className="space-y-4">
      <div>
        {credentials.length > 0 ? (
          <div className="space-y-2">
            {credentials.map((credential, index) => (
              <div key={credential.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{credential.label ?? credential.id}</p>
                  {credential.maskedHint ? (
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{credential.maskedHint}</p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {credential.enabled ? '启用' : '停用'}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`上移 ${credential.label ?? credential.id}`}
                    disabled={index === 0 || disabled || busy}
                    onClick={() => onMoveCredential?.(index, index - 1)}
                  >
                    <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`下移 ${credential.label ?? credential.id}`}
                    disabled={index === credentials.length - 1 || disabled || busy}
                    onClick={() => onMoveCredential?.(index, index + 1)}
                  >
                    <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`测试 ${credential.label ?? credential.id}`}
                    disabled={disabled || busy}
                    onClick={() => onTestCredential?.(credential)}
                  >
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`编辑 ${credential.label ?? credential.id}`}
                    disabled={disabled || busy}
                    onClick={() => openEditForm(credential)}
                  >
                    <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`${credential.enabled ? '停用' : '启用'} ${credential.label ?? credential.id}`}
                    disabled={disabled || busy}
                    onClick={() => onUpdateCredential?.(credential, { enabled: !credential.enabled })}
                  >
                    {credential.enabled ? '停' : '启'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`删除 ${credential.label ?? credential.id}`}
                    disabled={disabled || busy}
                    onClick={() => onDeleteCredential?.(credential)}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : accountLabel ? (
          <p className="text-xs text-muted-foreground">{maskAccountLabel(accountLabel)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Provider 凭证加密保存在当前 Pod。</p>
        )}
      </div>

      {attempt?.userCode ? (
        <div className="border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm">
          验证码：<strong className="font-mono">{attempt.userCode}</strong>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {onCreateApiKeyCredential ? (
          <Button variant="outline" size="sm" disabled={busy || disabled} onClick={openCreateForm}>
            <Plus className="mr-2 h-4 w-4" />
            添加 API Key
          </Button>
        ) : null}
        {hasPoolActions ? null : isConnected ? (
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

      {formMode ? (
        <div className="space-y-2 rounded-lg border border-border/50 bg-muted/10 p-3">
          <Input
            autoComplete="off"
            aria-label={`${definition.name} API Key 标签`}
            placeholder="名称，例如 Work key"
            value={poolLabel}
            onChange={(event) => setPoolLabel(event.target.value)}
          />
          {formMode === 'create' ? (
            <Input
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              aria-label={`${definition.name} API Key 输入`}
              placeholder={definition.apiKeyPlaceholder || '从官方控制台复制 API Key'}
              value={poolApiKey}
              onChange={(event) => setPoolApiKey(event.target.value)}
              className="font-mono"
            />
          ) : null}
          <Input
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore
            aria-label={`${definition.name} Base URL 输入`}
            placeholder={definition.defaultBaseUrl || '默认服务地址'}
            value={poolBaseUrl}
            onChange={(event) => setPoolBaseUrl(event.target.value)}
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              aria-label={formMode === 'create' ? `保存 ${definition.name} API Key` : '保存凭证'}
              disabled={busy || disabled || (formMode === 'create' && !poolApiKey.trim())}
              onClick={savePoolForm}
            >
              {formMode === 'create' ? '保存 API Key' : '保存凭证'}
            </Button>
            <Button variant="ghost" size="sm" onClick={closePoolForm}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {apiKeyAttempt ? (
        <div className="space-y-2">
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
              <span className="text-xs font-medium text-muted-foreground">Base URL（选填）</span>
              <Input
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Base URL 输入`}
                placeholder={definition.defaultBaseUrl || '默认服务地址'}
                value={baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
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
            disabled={!apiKey.trim() || busy || disabled}
            onClick={onSaveApiKey}
          >
            保存 API Key
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}

function oauthProviderOptions(
  offering: AiProviderOffering,
  credentials: AiProviderCredentialSummary[],
): LoginProviderOption[] {
  if (credentials.length === 0) {
    return [{
      id: offering.id,
      label: offeringLabel(offering),
      subtitle: '使用官方账号授权',
      actionLabel: '登录',
    }]
  }

  return credentials.map((credential) => ({
    id: credential.id,
    label: credential.label ? maskAccountLabel(credential.label) : credential.id,
    subtitle: credential.maskedHint,
    actionLabel: '退出',
    badge: {
      label: credential.enabled ? '启用' : '停用',
      tone: credential.health === 'healthy' ? 'success' : credential.health === 'unknown' ? 'neutral' : 'warning',
    },
    disabled: !credential.enabled && credential.health === 'unknown',
  }))
}

function modeForOffering(
  offering: AiProviderOffering,
  definition: AiProviderDefinition,
): AiConnectionsMode {
  const modes = offering.authModes ?? []
  if (modes.some((mode) => mode === 'oauth' || mode === 'deviceCode')) return 'deviceCodeOAuth'
  if (modes.some((mode) => mode === 'apiKey' || mode === 'local')) return 'browserAssistedApiKey'
  return definition.browserMode === 'connectUnsupported' ? 'browserAssistedApiKey' : definition.browserMode
}

function isPendingAttempt(attempt: AiConnectAttempt | undefined): boolean {
  return attempt?.status === 'pending' || attempt?.status === 'authorization_pending' || attempt?.status === 'slow_down'
}

function nextCredentialPriority(credentials: AiProviderCredentialSummary[]): number {
  if (credentials.length === 0) return 10
  return Math.max(...credentials.map((credential) => credential.priority)) + 10
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
