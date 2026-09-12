import { useEffect, useRef, useState } from 'react'
import { Button, Input, cn } from '@undefineds.co/shared-ui'
import { ExternalLink, Eye, EyeOff, KeyRound, Loader2, LogOut, Plus, RotateCw } from 'lucide-react'
import type {
  AiConnectAttempt,
  AiProviderCredentialSummary,
  AiProviderOffering,
} from './ai-connections-client'
import { normalizeProxyUrl } from './ai-connections-client'
import type { AiProviderDefinition } from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import { offeringTitle } from './offering-label'
import { nextCredentialPriority } from './credential-labels'
import { offeringEndpoint } from './offering-endpoints'

export function AiApiKeyPool({
  definition,
  offering,
  createOfferings,
  status,
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
  initialEditing,
  initialCreate = false,
  onSavingChange,
  onCloseEdit,
}: {
  definition: AiProviderDefinition
  offering: AiProviderOffering
  createOfferings: AiProviderOffering[]
  status: ProviderConnectionState
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
  onCreateApiKeyCredential?: (offering: AiProviderOffering, input: {
    apiKey: string
    label?: string
    baseUrl?: string
    proxyUrl?: string
    priority: number
  }) => Promise<void>
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
    proxyUrl?: string
  }) => Promise<void>
  initialEditing?: AiProviderCredentialSummary
  initialCreate?: boolean
  onSavingChange?: (saving: boolean) => void
  onCloseEdit: () => void
}) {
  const apiKeyAttempt = attempt?.mode === 'browserAssistedApiKey' && attempt.status === 'pending'
  const isConfigured = status === 'configured'
  const isConnected = status === 'connected'
  const hasPoolActions = Boolean(onCreateApiKeyCredential)
  const [createOfferingId, setCreateOfferingId] = useState(offering.id)
  const formOffering = createOfferings.find((item) => item.id === createOfferingId) ?? offering
  const [showKey, setShowKey] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit' | undefined>(initialEditing ? 'edit' : initialCreate && onCreateApiKeyCredential ? 'create' : undefined)
  const [editingCredential, setEditingCredential] = useState<AiProviderCredentialSummary | undefined>(initialEditing)
  const [poolLabel, setPoolLabel] = useState(initialEditing?.label ?? '')
  const [poolApiKey, setPoolApiKey] = useState('')
  const [poolBaseUrl, setPoolBaseUrl] = useState(initialEditing?.baseUrl ?? '')
  const [poolProxyUrl, setPoolProxyUrl] = useState(initialEditing?.proxyUrl ?? '')
  const [poolFormError, setPoolFormError] = useState<string>()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const legacyBeginRef = useRef(false)
  useEffect(() => {
    if (initialCreate && !onCreateApiKeyCredential && !legacyBeginRef.current) {
      legacyBeginRef.current = true
      onBeginApiKey()
    }
  }, [initialCreate, onCreateApiKeyCredential, onBeginApiKey])

  const openCreateForm = () => {
    setCreateOfferingId(offering.id)
    setFormMode('create')
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setPoolProxyUrl('')
    setPoolFormError(undefined)
    setShowAdvanced(false)
  }

  const closePoolForm = () => {
    onCloseEdit()
    setFormMode(undefined)
    setEditingCredential(undefined)
    setPoolLabel('')
    setPoolApiKey('')
    setPoolBaseUrl('')
    setPoolProxyUrl('')
    setPoolFormError(undefined)
    setShowAdvanced(false)
  }

  const savePoolForm = async () => {
    if (busy || disabled || saveInFlight.current) return
    let normalizedProxyUrl: string | undefined
    try {
      normalizedProxyUrl = normalizeProxyUrl(poolProxyUrl)
    } catch {
      setPoolFormError('Proxy URL 格式无效（支持 http、https）')
      return
    }
    setPoolFormError(undefined)
    if (formMode === 'create') {
      const trimmedKey = poolApiKey.trim()
      if (!trimmedKey || !onCreateApiKeyCredential) return
      saveInFlight.current = true
      setSaving(true)
      onSavingChange?.(true)
      try {
        await onCreateApiKeyCredential(formOffering, {
          apiKey: trimmedKey,
          label: poolLabel.trim() || undefined,
          baseUrl: poolBaseUrl.trim() || undefined,
          proxyUrl: normalizedProxyUrl,
          priority: nextCredentialPriority(credentials.filter((credential) => credential.offeringId === formOffering.id)),
        })
        closePoolForm()
      } catch (error) {
        setPoolFormError(error instanceof Error ? error.message : '保存失败，请重试')
      } finally {
        saveInFlight.current = false
        setSaving(false)
        onSavingChange?.(false)
      }
      return
    }
    if (formMode === 'edit' && editingCredential && onUpdateCredential) {
      const proxyChanged = poolProxyUrl.trim() !== (editingCredential.proxyUrl ?? '').trim()
      saveInFlight.current = true
      setSaving(true)
      onSavingChange?.(true)
      try {
        await onUpdateCredential(editingCredential, {
          label: poolLabel.trim() || undefined,
          baseUrl: poolBaseUrl.trim() || undefined,
          ...(proxyChanged ? { proxyUrl: normalizedProxyUrl } : {}),
        })
        closePoolForm()
      } catch (error) {
        setPoolFormError(error instanceof Error ? error.message : '保存失败，请重试')
      } finally {
        saveInFlight.current = false
        setSaving(false)
        onSavingChange?.(false)
      }
    }
  }

  return (
    <div className={cn('space-y-3', formMode && 'w-full')}>
      {attempt?.userCode ? (
        <div className="border-l-2 border-primary bg-muted/30 px-3 py-2 text-sm">
          验证码：<strong className="font-mono">{attempt.userCode}</strong>
        </div>
      ) : null}

      {!initialCreate && !initialEditing ? <div className="flex flex-wrap gap-2">
        {onCreateApiKeyCredential && createOfferings.length > 0 ? (
          <Button variant="outline" size="sm" disabled={busy || disabled || saving} onClick={openCreateForm}>
            <Plus className="mr-2 h-4 w-4" />
            添加 API Key
          </Button>
        ) : null}
        {hasPoolActions ? null : isConnected ? (
          <>
            <Button variant="outline" size="sm" disabled={busy || disabled || saving} onClick={onBeginBrowser}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
              重新连接
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || disabled || saving} onClick={onDisconnect}>
              <LogOut className="mr-2 h-4 w-4" />
              断开连接
            </Button>
          </>
        ) : isConfigured ? (
          <>
            <Button variant="outline" size="sm" aria-label="更新 API Key" disabled={busy || disabled || saving} onClick={onBeginApiKey}>
              <KeyRound className="mr-2 h-4 w-4" />
              更新 API Key
            </Button>
            <Button variant="ghost" size="sm" disabled={busy || disabled || saving} onClick={onDisconnect}>
              移除配置
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || disabled || saving || definition.browserMode === 'connectUnsupported'}
              onClick={onBeginBrowser}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
              {definition.browserLabel}
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`${definition.name} API Key`}
              disabled={busy || disabled || saving}
              onClick={onBeginApiKey}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              配置 API Key
            </Button>
          </>
        )}
      </div> : null}

      {formMode ? (
        <div className="space-y-2 rounded-lg border border-border/50 bg-muted/10 p-3">
          {formMode === 'create' && createOfferings.length > 1 ? (
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>套餐 / 区域</span>
              <select aria-label={`${definition.name} 套餐 / 区域`} value={createOfferingId}
                disabled={busy || disabled || saving}
                onChange={(event) => { setCreateOfferingId(event.target.value); setPoolFormError(undefined) }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
                {createOfferings.map((item) => <option key={item.id} value={item.id}>{offeringTitle(item)}</option>)}
              </select>
            </label>
          ) : null}
          {formMode === 'edit' ? (
            <Input
              disabled={busy || disabled || saving}
              autoComplete="off"
              aria-label={`${definition.name} API Key 标签`}
              placeholder="名称，例如 Work key"
              value={poolLabel}
              onChange={(event) => setPoolLabel(event.target.value)}
            />
          ) : null}
          {formMode === 'create' ? (
            <Input
              disabled={busy || disabled || saving}
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
            <>
              <Input
                disabled={busy || disabled || saving}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Base URL 输入`}
                placeholder={offeringEndpoint(formMode === 'edit' ? offering : formOffering) || definition.defaultBaseUrl || '默认服务地址'}
                value={poolBaseUrl}
                onChange={(event) => setPoolBaseUrl(event.target.value)}
                className="font-mono text-xs"
              />
              <Input
                disabled={busy || disabled || saving}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore
                aria-label={`${definition.name} Proxy URL 输入`}
                placeholder="http://127.0.0.1:7890"
                value={poolProxyUrl}
                onChange={(event) => setPoolProxyUrl(event.target.value)}
                className="font-mono text-xs"
              />
            </>
          ) : null}
          {poolFormError ? <p className="text-xs text-destructive">{poolFormError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              aria-label={formMode === 'create' ? `保存 ${definition.name} API Key` : '保存凭证'}
              disabled={busy || disabled || saving || (formMode === 'create' && !poolApiKey.trim())}
              onClick={savePoolForm}
            >
              {formMode === 'create' ? '保存 API Key' : '保存凭证'}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={closePoolForm}>
              取消
            </Button>
            {formMode === 'create' ? (
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => setShowAdvanced((current) => !current)}>
                {showAdvanced ? '收起高级设置' : '高级设置'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {apiKeyAttempt && !formMode ? (
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
              disabled={busy || disabled || saving}
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
                disabled={busy || disabled || saving}
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
