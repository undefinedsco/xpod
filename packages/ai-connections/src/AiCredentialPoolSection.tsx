import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  LoginConnectingView,
  LoginFailureView,
  TooltipProvider,
} from '@undefineds.co/shared-ui'
import { ExternalLink, Plus, Settings2 } from 'lucide-react'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderCredentialSummary,
  AiProviderOffering,
  AiProviderSummary,
  AiQuotaSnapshot,
} from './ai-connections-client'
import type {
  AiProviderDefinition,
} from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import { offeringTitle } from './offering-label'
import {
  authorizationMethodsForOffering,
  connectModeForMethod,
  isApiKeyMethod,
  isLocalMethod,
  isOAuthMethod,
  isOAuthMode,
  isPendingAttempt,
  modeForOffering,
} from './authorization-methods'
import { credentialDisplayLabel, maskAccountLabel } from './credential-labels'
import { AiQuotaCard } from './AiQuotaCard'
import { AiApiKeyPool } from './AiApiKeyPool'
import { AiAuthorizationActions } from './AiAuthorizationActions'
import { AiCredentialRow } from './AiCredentialRow'
import { AiOfferingDetails } from './AiOfferingDetails'
import { AiSortableCredentialList } from './AiSortableCredentialList'

export interface AiOfferingActionError {
  message: string
  offeringId?: string
  authorization?: Pick<AiConnectAttempt, 'mode' | 'authorizationMethodId'>
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
  suppressError = false,
  quotas = {},
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
  suppressError?: boolean
  quotas?: Partial<Record<string, AiOfferingQuotaState>>
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCancelConnect?: (attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>) => void
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

  const [editing, setEditing] = useState<AiProviderCredentialSummary>()
  const [showCreate, setShowCreate] = useState(false)
  const [authorizationOfferingId, setAuthorizationOfferingId] = useState<string>()
  const [dialogError, setDialogError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const completedAttemptRef = useRef(attempt)
  const apiOfferings = offerings.filter((offering) => authorizationMethodsForOffering(offering).some((method) => method.lifecycle === 'active' && isApiKeyMethod(method)))
  const authorizationPending = isPendingAttempt(attempt) && isOAuthMode(attempt?.mode)
  const dialogOpen = showCreate || Boolean(editing) || Boolean(authorizationOfferingId)
  const closeDialog = () => {
    setShowCreate(false)
    setAuthorizationOfferingId(undefined)
    setEditing(undefined)
    setDialogError(undefined)
  }
  useEffect(() => {
    const previous = completedAttemptRef.current
    completedAttemptRef.current = attempt
    if (dialogOpen && attempt !== previous && attempt?.status === 'completed') closeDialog()
  }, [attempt, dialogOpen])
  const orderedCredentials = [...credentials].sort((a, b) => a.priority - b.priority)
  const quotaBusy = credentials.some((credential) => quotas[credential.id]?.busy)

  return (
    <TooltipProvider>
      <section className="space-y-3" aria-label="当前连接">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground/90">
            <Settings2 className="h-4 w-4 text-primary" />当前连接
          </h3>
          <div className="flex flex-wrap items-center justify-end gap-2">
          {credentials.length > 1 ? (
            <Button variant="ghost" size="sm" aria-label={`刷新全部 ${definition.name}额度`}
              disabled={disabled || quotaBusy || !credentials.some((c) => c.enabled) || !onRefreshQuota}
              onClick={() => offerings.forEach((offering) => onRefreshQuota?.(offering))}>
              {quotaBusy ? '查询中' : '刷新全部额度'}
            </Button>
          ) : null}
          {offerings.map((offering) => {
            const methods = authorizationMethodsForOffering(offering).filter((method) =>
              method.lifecycle === 'active' && (isOAuthMethod(method) || isLocalMethod(method)))
            if (!methods.length) return null
            return <div key={offering.id} role="group" aria-label={`${offeringTitle(offering)}快捷接入`}>
              <AiAuthorizationActions methods={methods} offering={offering}
                hasCredentials={credentials.some((credential) => credential.offeringId === offering.id)}
                busy={busy || saving} disabled={disabled || authorizationPending}
                onBeginOffering={onBeginOffering ? (target, mode, method) => {
                  setDialogError(undefined)
                  onDismissError?.()
                  setAuthorizationOfferingId(target.id)
                  onBeginOffering(target, mode, method)
                } : undefined}
                onCreateLocalCredential={onCreateLocalCredential ? async (target, method) => {
                  setSaving(true)
                  setDialogError(undefined)
                  onDismissError?.()
                  try { await onCreateLocalCredential(target, method) }
                  catch (cause) { setDialogError(cause instanceof Error ? cause.message : '连接失败，请重试') }
                  finally { setSaving(false) }
                } : undefined} />
            </div>
          })}
          {apiOfferings.length > 0 && !offerings.some((offering) =>
            authorizationMethodsForOffering(offering).some((method) =>
              method.lifecycle === 'active' && (isOAuthMethod(method) || isLocalMethod(method))))
            && definition.browserMode === 'browserAssistedApiKey' ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label={`${definition.name} 登录`}
            disabled={busy || saving || disabled || authorizationPending} onClick={() => {
              setDialogError(undefined)
              onDismissError?.()
              onBeginBrowser()
            }}>
            <ExternalLink className="h-3.5 w-3.5" />{definition.browserLabel}
          </Button>
          ) : null}
          {apiOfferings.length > 0 ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label="新建 API Key 连接" disabled={busy || saving || disabled || authorizationPending || (!product && status === 'pending' && !attempt)} onClick={() => {
            setDialogError(undefined)
            onDismissError?.()
            setShowCreate(true)
          }}><Plus className="h-3.5 w-3.5" />API Key</Button>
          ) : null}
          </div>
        </div>
        <div aria-label="凭据列表" className="space-y-2">
          <AiSortableCredentialList credentials={orderedCredentials} disabled={busy || disabled}
            onMove={onReorderCredentials ? (from, to) => {
              const offering = offerings.find((item) => item.id === orderedCredentials[from]?.offeringId)
              if (offering) onReorderCredentials(offering, orderedCredentials, from, to)
            } : undefined}>
            {(credential, handle) => {
              const offering = offerings.find((item) => item.id === credential.offeringId)
              if (!offering) return null
              const label = credential.authMode === 'apiKey' ? credentialDisplayLabel(credential)
                : credential.label ? maskAccountLabel(credential.label) : credentialDisplayLabel(credential)
              const state = quotas[credential.id]
              const quotaState = state?.credentialId === credential.id ? state : undefined
              return <AiCredentialRow credential={credential} label={label} dragHandle={handle}
                kindLabel={credential.authMode === 'apiKey' ? 'API Key' : offeringTitle(offering)}
                busy={busy} disabled={disabled} onToggle={onUpdateCredential} onTest={onTestCredential}
                onEdit={credential.authMode === 'apiKey' ? () => setEditing(credential) : undefined}
                onDelete={() => credential.authMode === 'apiKey' ? onDeleteCredential?.(credential) : onDisconnect(credential)}
                deleteAriaLabel={credential.authMode === 'apiKey' ? `删除 ${label}` : `${label} 移除`}
                quota={<AiQuotaCard compact providerName={definition.name} offeringName={offeringTitle(offering)}
                  credentialLabel={credentialDisplayLabel(credential)} multiple={credentials.length > 1}
                  quota={quotaState?.quota} busy={quotaState?.busy ?? false} error={quotaState?.error}
                  paused={!credential.enabled} disabled={disabled || !onRefreshQuota}
                  onRefresh={() => onRefreshQuota?.(offering, credential)} />} />
            }}
          </AiSortableCredentialList>
          {!credentials.length ? <p className="py-2 text-xs text-muted-foreground">{accountLabel ? maskAccountLabel(accountLabel) : '尚未添加连接'}</p> : null}
          {credentials.length === 0 && (status === 'configured' || status === 'connected') ? (
            <Button variant="ghost" size="sm" disabled={busy || disabled} onClick={() => onDisconnect()}>
              {status === 'configured' ? '移除配置' : '断开连接'}
            </Button>
          ) : null}
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => {
          if (open || saving) return
          if (attempt && isPendingAttempt(attempt) && isOAuthMode(attempt.mode)) {
            onCancelConnect?.({ mode: attempt.mode, attemptId: attempt.attemptId, state: attempt.state,
              signature: attempt.signature, ...(attempt.offeringId ? { offeringId: attempt.offeringId } : {}) })
          }
          closeDialog()
        }}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
            <DialogHeader><DialogTitle>{editing ? '编辑连接' : authorizationOfferingId ? '连接账号' : '新建连接'}</DialogTitle></DialogHeader>
        <div className="space-y-5" aria-label="添加连接">
          {(editing || authorizationOfferingId ? offerings.filter((offering) => offering.id === (editing?.offeringId ?? authorizationOfferingId)) : apiOfferings).map((offering) => {
            const otherAuthorizationPending = isPendingAttempt(attempt) && isOAuthMode(attempt?.mode)
              && (attemptOfferingId ?? attempt?.offeringId) !== offering.id
            const actionDisabled = disabled || saving || otherAuthorizationPending
            const methods = authorizationMethodsForOffering(offering)
            const activeMethods = methods.filter((method) => method.lifecycle === 'active')
            const supportsApiKey = activeMethods.some(isApiKeyMethod)
            const offeringAttempt = attemptOfferingId === offering.id ? attempt : undefined
            const authorizationError = error?.offeringId === offering.id ? error.authorization : undefined
            const attemptedMethod = methods.find((method) => method.id === (authorizationError?.authorizationMethodId ?? offeringAttempt?.authorizationMethodId))
              ?? activeMethods.find(isOAuthMethod)
            const attemptedMode = authorizationError?.mode ?? offeringAttempt?.mode ?? (attemptedMethod ? connectModeForMethod(attemptedMethod) : modeForOffering(offering, definition))
            const offeringError = error?.offeringId === offering.id ? error.message : undefined
            if (offering.lifecycle === 'unavailable' && activeMethods.length === 0) {
              return <fieldset data-create-offering={offering.id} key={offering.id} className="space-y-2 border-t border-border/50 pt-3 first:border-t-0 first:pt-0">
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                <p className="text-xs text-muted-foreground">{offering.kind === 'oauth-subscription'
                  ? '暂不可用：账号订阅需在 Xpod 桌面版中导入本机客户端（如 Codex CLI）的登录态，浏览器中无法完成。'
                  : '暂不可用：该接入方式尚未提供可用的连接流程。'}</p>
              </fieldset>
            }
            const failedAuthorizationMode = authorizationError?.mode
            if (offeringError && isOAuthMode(failedAuthorizationMode)) {
              return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                {offeringAttempt?.status === 'unsupported'
                  ? <p className="text-sm">当前部署未启用账号授权</p>
                  : <LoginFailureView title="登录未完成" description={offeringError} primaryLabel="重试登录"
                      onPrimary={() => onBeginOffering?.(offering, failedAuthorizationMode, attemptedMethod)}
                      secondaryLabel="关闭" onSecondary={() => { onDismissError?.(); closeDialog() }} />}
              </fieldset>
            }
            if (isPendingAttempt(offeringAttempt) && isOAuthMode(attemptedMode)) {
              return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
                <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
                <LoginConnectingView title="正在连接"
                  detail={attemptedMode === 'authorizationCodeOAuth' ? '等待网页授权，请在打开的页面完成登录。' : offeringAttempt?.userCode ? `验证码：${offeringAttempt.userCode}` : '请在打开的页面完成授权。'}
                  providerLabel={attemptedMethod?.label ?? offeringTitle(offering)} providerHost={definition.name} />
                <Button variant="ghost" size="sm" disabled={disabled}
                  onClick={() => {
                    if (offeringAttempt) onCancelConnect?.({
                    mode: offeringAttempt.mode,
                    attemptId: offeringAttempt.attemptId,
                    state: offeringAttempt.state,
                    signature: offeringAttempt.signature,
                    ...(offeringAttempt.offeringId ? { offeringId: offeringAttempt.offeringId } : {}),
                    })
                    closeDialog()
                  }}>取消连接</Button>
              </fieldset>
            }
            return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
              <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
              {supportsApiKey ? <AiApiKeyPool key={`${offering.id}:${editing?.id ?? ''}`}
                definition={definition} offering={offering} status={status}
                createOfferings={[offering]} initialCreate={!editing}
                credentials={credentials} initialEditing={editing?.offeringId === offering.id ? editing : undefined}
                onCloseEdit={closeDialog} onSavingChange={setSaving}
                attempt={offeringAttempt ?? (attempt?.mode === 'browserAssistedApiKey' ? attempt : undefined)}
                apiKey={apiKey} baseUrl={baseUrl} busy={busy} disabled={actionDisabled}
                onApiKeyChange={onApiKeyChange} onBaseUrlChange={onBaseUrlChange}
                onBeginApiKey={onBeginApiKey} onBeginBrowser={onBeginBrowser} onSaveApiKey={onSaveApiKey}
                onDisconnect={onDisconnect} onUpdateCredential={onUpdateCredential}
                onCreateApiKeyCredential={onCreateApiKeyCredential} /> : null}
              {authorizationOfferingId && !offeringError ? <LoginConnectingView title="正在连接"
                detail="正在启动授权，请稍候。" providerLabel={offeringTitle(offering)} providerHost={definition.name} /> : null}
              {offeringError ? <p className="w-full text-sm text-destructive">{offeringError}</p> : null}
            </fieldset>
          })}
        </div>
            {dialogError ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
          </DialogContent>
        </Dialog>
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">接入信息</summary>
          <div className="mt-2 space-y-3">
            {offerings.map((offering) => <AiOfferingDetails key={offering.id} offering={offering} />)}
          </div>
        </details>
        {dialogError && !dialogOpen && dialogError !== error?.message ? <p role="alert" className="text-sm text-destructive">{dialogError}</p> : null}
        {error && (error.offeringId ? !dialogOpen : !suppressError)
          ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      </section>
    </TooltipProvider>
  )
}
