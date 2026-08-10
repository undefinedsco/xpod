import { useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Input,
  LoginConnectingView,
  LoginFailureView,
  cn,
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
  AiQuotaSnapshot,
} from './ai-connections-client'
import type {
  AiProviderDefinition,
} from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import { offeringLabel } from './offering-label'
import { AiQuotaCard } from './AiQuotaCard'

export interface AiOfferingActionError {
  message: string
  offeringId?: string
}

export interface AiOfferingQuotaState {
  quota?: AiQuotaSnapshot
  busy: boolean
  error?: string
  credentialId?: string
}

export function AiCredentialPoolSection({
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
  quotas = {},
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
  onRefreshQuota?: (offering: AiProviderOffering, credential?: AiProviderCredentialSummary) => void
  onDismissError?: () => void
}) {
  const fallbackOfferings: AiProviderOffering[] = [{
    id: 'api-platform',
    label: 'API Key',
    kind: 'api-platform',
    authModes: ['apiKey'],
  }]
  const credentials = product?.credentials ?? []
  const offerings = product?.offerings.length ? product.offerings : fallbackOfferings

  return (
    <section className="space-y-4" aria-label="当前连接">
      <div className="flex items-center gap-2 border-b border-border/40 pb-2">
        <Settings2 className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium text-foreground/90">当前连接</h3>
      </div>

      <div className="space-y-3">
        {offerings.map((offering) => {
          const mode = modeForOffering(offering, definition)
          const offeringAttempt = attemptOfferingId === offering.id ? attempt : undefined
          const offeringCredentials = credentials
            .filter((credential) => credential.offeringId === offering.id)
            .sort((left, right) => left.priority - right.priority)
          const offeringError = error?.offeringId === offering.id ? error.message : undefined
          const quotaCredential = offeringCredentials.find((credential) => credential.enabled)
            ?? offeringCredentials[0]
          const quotaState = quotas[offering.id]
          const visibleQuotaState = quotaCredential && quotaState?.credentialId === quotaCredential.id
            ? quotaState
            : undefined
          const quotaCard = (
            <AiQuotaCard
              providerName={definition.name}
              offeringName={offeringTitle(offering)}
              quota={visibleQuotaState?.quota}
              busy={visibleQuotaState?.busy ?? false}
              disabled={disabled || (Boolean(product) && !quotaCredential)}
              credentialLabel={quotaCredential ? credentialDisplayLabel(quotaCredential) : undefined}
              error={visibleQuotaState?.error}
              onRefresh={() => onRefreshQuota?.(offering, quotaCredential)}
            />
          )

          if (offering.lifecycle === 'unavailable') {
            return (
              <OfferingItem key={offering.id} offering={offering}>
                <p className="text-sm text-muted-foreground">
                  暂不可用：该 Offering 尚未提供可用的连接流程。
                </p>
              </OfferingItem>
            )
          }

          if (offeringError && offeringAttempt?.status === 'unsupported' && mode === 'deviceCodeOAuth') {
            return (
              <OfferingItem key={offering.id} offering={offering}>
                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-3">
                  <p className="text-sm font-medium text-foreground">当前部署未启用账号授权</p>
                  <p className="mt-1 text-xs text-muted-foreground">仍可使用其他已提供的接入方式。</p>
                </div>
                {quotaCard}
              </OfferingItem>
            )
          }

          if (offeringError && mode === 'deviceCodeOAuth') {
            return (
              <OfferingItem key={offering.id} offering={offering}>
                <LoginFailureView
                  title="登录未完成"
                  description={offeringError}
                  primaryLabel="重试登录"
                  onPrimary={() => onBeginOffering?.(offering, mode)}
                  secondaryLabel="关闭"
                  onSecondary={onDismissError ?? (() => undefined)}
                />
                {quotaCard}
              </OfferingItem>
            )
          }

          if (isPendingAttempt(offeringAttempt) && mode === 'deviceCodeOAuth') {
            return (
              <OfferingItem key={offering.id} offering={offering}>
                <LoginConnectingView
                  title="正在连接"
                  detail={offeringAttempt?.userCode ? `验证码：${offeringAttempt.userCode}` : '请在打开的页面完成授权。'}
                  providerLabel={offeringTitle(offering)}
                  providerHost={definition.name}
                />
                {quotaCard}
              </OfferingItem>
            )
          }

          if (mode === 'deviceCodeOAuth') {
            return (
              <OfferingItem key={offering.id} offering={offering}>
                <div className="space-y-2">
                  {offeringCredentials.map((credential) => (
                    <CredentialRow
                      key={credential.id}
                      credential={credential}
                      label={credential.label ? maskAccountLabel(credential.label) : credentialDisplayLabel(credential)}
                      busy={busy}
                      disabled={disabled}
                      onToggle={onUpdateCredential}
                      onTest={onTestCredential}
                      onDelete={() => onDisconnect(credential)}
                      deleteAriaLabel={`${credential.label ? maskAccountLabel(credential.label) : credentialDisplayLabel(credential)} 移除`}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || disabled} onClick={() => onBeginOffering?.(offering, mode)}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                    {offeringCredentials.length ? '添加账号' : '登录'}
                  </Button>
                </div>
                {quotaCard}
              </OfferingItem>
            )
          }

          return (
            <OfferingItem key={offering.id} offering={offering}>
              <ApiKeyPool
                definition={definition}
                offering={offering}
                status={status}
                accountLabel={accountLabel}
                credentials={offeringCredentials}
                attempt={attempt}
                apiKey={apiKey}
                baseUrl={baseUrl}
                busy={busy}
                disabled={disabled}
                error={offeringError}
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
              {quotaCard}
            </OfferingItem>
          )
        })}
        {error && !error.offeringId ? (
          <p className="rounded-md border border-destructive/30 px-3 py-2 text-sm text-destructive">
            {error.message}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function OfferingItem({ offering, children }: { offering: AiProviderOffering; children: ReactNode }) {
  const endpoints = offering.endpoints ?? []
  return (
    <section className="space-y-3 rounded-lg border border-border/50 bg-card p-3" aria-labelledby={`offering-${offering.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 id={`offering-${offering.id}`} className="text-sm font-medium text-foreground">{offeringTitle(offering)}</h4>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {offering.productLabel ? <span>{offering.productLabel}</span> : null}
            {offering.kind ? <span>{offeringKindLabel(offering.kind)}</span> : null}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{authMethodLabel(offering)}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {offering.consoleUrl ? <OfferingLink href={offering.consoleUrl} label="控制台" /> : null}
        {offering.subscriptionUrl ? <OfferingLink href={offering.subscriptionUrl} label="订阅与账单" /> : null}
        {offering.quota?.url ? <OfferingLink href={offering.quota.url} label="额度与用量" /> : null}
        {offering.usagePolicyUrl ? <OfferingLink href={offering.usagePolicyUrl} label="使用政策" /> : null}
      </div>
      {endpoints.length ? (
        <dl className="space-y-1 text-[11px] text-muted-foreground">
          {endpoints.map((endpoint) => (
            <div key={`${endpoint.protocol}:${endpoint.baseUrl}`} className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-foreground/70">{endpointProtocolLabel(endpoint.protocol)}</dt>
              <dd className="min-w-0 truncate font-mono" title={endpoint.baseUrl}>
                {endpointDisplayValue(endpoint.baseUrl)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </section>
  )
}

function OfferingLink({ href, label }: { href: string; label: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{label}</a>
}

function offeringTitle(offering: AiProviderOffering): string {
  return offering.label?.trim() || offeringLabel(offering)
}

function offeringEndpoint(offering: AiProviderOffering): string | undefined {
  const protocol = offering.modelDiscovery?.endpointProtocol
  return offering.endpoints?.find((endpoint) => endpoint.protocol === protocol)?.baseUrl
    ?? offering.endpoints?.[0]?.baseUrl
}

function endpointDisplayValue(value: string): string {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname.replace(/\/$/u, '')}`
  } catch {
    return value
  }
}

function endpointProtocolLabel(protocol: string): string {
  if (protocol === 'responses') return 'Responses API'
  if (protocol === 'chatCompletions') return 'Chat API'
  if (protocol === 'anthropic') return 'Anthropic API'
  return protocol
}

function offeringKindLabel(kind: string): string {
  if (kind === 'oauth-subscription') return '账号订阅'
  if (kind === 'api-platform') return 'API 平台'
  if (kind === 'token-plan') return 'Token 套餐'
  return kind
}

function authMethodLabel(offering: AiProviderOffering): string {
  const labels = (offering.authModes ?? []).map((mode) => mode === 'oauth' || mode === 'deviceCode' ? '账号授权' : 'API Key')
  return [...new Set(labels)].join(' / ')
}

function ApiKeyPool({
  definition,
  offering,
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
  offering: AiProviderOffering
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
  const [showAdvanced, setShowAdvanced] = useState(false)

  const openCreateForm = () => {
    setFormMode('create')
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setShowAdvanced(false)
  }

  const openEditForm = (credential: AiProviderCredentialSummary) => {
    setFormMode('edit')
    setEditingCredential(credential)
    setPoolLabel(credential.label ?? '')
    setPoolApiKey('')
    setPoolBaseUrl(credential.baseUrl ?? '')
    setShowAdvanced(false)
  }

  const closePoolForm = () => {
    setFormMode(undefined)
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setShowAdvanced(false)
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
              <CredentialRow
                key={credential.id}
                credential={credential}
                label={credentialDisplayLabel(credential)}
                busy={busy}
                disabled={disabled}
                onToggle={onUpdateCredential}
                onTest={onTestCredential}
                onEdit={() => openEditForm(credential)}
                onDelete={() => onDeleteCredential?.(credential)}
                deleteAriaLabel={`删除 ${credentialDisplayLabel(credential)}`}
                beforeActions={<>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`上移 ${credentialDisplayLabel(credential)}`}
                    disabled={index === 0 || disabled || busy}
                    onClick={() => onMoveCredential?.(index, index - 1)}
                  >
                    <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`下移 ${credentialDisplayLabel(credential)}`}
                    disabled={index === credentials.length - 1 || disabled || busy}
                    onClick={() => onMoveCredential?.(index, index + 1)}
                  >
                    <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </>}
              />
            ))}
          </div>
        ) : accountLabel ? (
          <p className="text-xs text-muted-foreground">{maskAccountLabel(accountLabel)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">Provider 凭证保存在当前 Pod，由 Pod 权限保护。</p>
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
          {formMode === 'edit' ? (
            <Input
              autoComplete="off"
              aria-label={`${definition.name} API Key 标签`}
              placeholder="名称，例如 Work key"
              value={poolLabel}
              onChange={(event) => setPoolLabel(event.target.value)}
            />
          ) : null}
          {formMode === 'create' ? (
            <Input
              type={showKey ? 'text' : 'password'}
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              aria-label={`${definition.name} API Key 输入`}
              placeholder={definition.apiKeyPlaceholder || '从官方控制台复制 API Key'}
              value={poolApiKey}
              onChange={(event) => setPoolApiKey(event.target.value)}
              className="font-mono"
            />
          ) : null}
          {formMode === 'edit' || showAdvanced ? (
            <Input
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore
              aria-label={`${definition.name} Base URL 输入`}
              placeholder={offeringEndpoint(offering) || definition.defaultBaseUrl || '默认服务地址'}
              value={poolBaseUrl}
              onChange={(event) => setPoolBaseUrl(event.target.value)}
              className="font-mono text-xs"
            />
          ) : null}
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
            {formMode === 'create' ? (
              <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((current) => !current)}>
                {showAdvanced ? '收起高级设置' : '高级设置'}
              </Button>
            ) : null}
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
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
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

function CredentialRow({
  credential,
  label,
  busy,
  disabled,
  beforeActions,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  deleteAriaLabel,
}: {
  credential: AiProviderCredentialSummary
  label: string
  busy: boolean
  disabled: boolean
  beforeActions?: ReactNode
  onToggle?: (credential: AiProviderCredentialSummary, patch: { enabled?: boolean }) => void
  onTest?: (credential: AiProviderCredentialSummary) => void
  onEdit?: () => void
  onDelete?: () => void
  deleteAriaLabel?: string
}) {
  const actionDisabled = disabled || busy
  return (
    <div
      data-credential-state={credential.enabled ? 'enabled' : 'disabled'}
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-border/50 p-3',
        credential.enabled ? 'bg-background' : 'bg-muted/40 text-muted-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        {credential.maskedHint ? <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{credential.maskedHint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge variant={credential.enabled ? 'secondary' : 'outline'}>{credential.enabled ? '启用' : '停用'}</Badge>
        <Badge variant={healthBadgeVariant(credential.health)}>{healthLabel(credential.health)}</Badge>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {beforeActions}
        {onTest ? (
          <Button variant="ghost" size="sm" aria-label={`测试连接 ${label}`} disabled={actionDisabled} onClick={() => onTest(credential)}>
            <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />测试连接
          </Button>
        ) : null}
        {onEdit ? (
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`编辑 ${label}`} disabled={actionDisabled} onClick={onEdit}>
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {onToggle ? (
          <Button variant="ghost" size="sm" aria-label={`${credential.enabled ? '停用' : '启用'} ${label}`} disabled={actionDisabled} onClick={() => onToggle(credential, { enabled: !credential.enabled })}>
            {credential.enabled ? '停用' : '启用'}
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={deleteAriaLabel ?? `删除 ${label}`} disabled={actionDisabled} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function healthLabel(health: AiProviderCredentialSummary['health']): string {
  if (health === 'healthy') return '有效'
  if (health === 'unknown') return '未验证'
  if (health === 'expired') return '已过期'
  return '错误'
}

function healthBadgeVariant(health: AiProviderCredentialSummary['health']): 'secondary' | 'outline' | 'destructive' {
  if (health === 'healthy') return 'secondary'
  if (health === 'unknown') return 'outline'
  return 'destructive'
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

function credentialDisplayLabel(credential: AiProviderCredentialSummary): string {
  if (credential.label?.trim()) return credential.label
  if (credential.maskedHint) return `API Key · ${credential.maskedHint}`
  if (credential.authMode === 'oauth' || credential.authMode === 'deviceCode') return '已授权账号'
  return 'API Key'
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
