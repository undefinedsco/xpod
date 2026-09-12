import { Button, TooltipProvider } from '@undefineds.co/shared-ui'
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
  isApiKeyMethod,
  isLocalMethod,
  isOAuthMethod,
  isOAuthMode,
  isPendingAttempt,
} from './authorization-methods'
import { credentialDisplayLabel, maskAccountLabel } from './credential-labels'
import { AiQuotaCard } from './AiQuotaCard'
import { AiAuthorizationActions } from './AiAuthorizationActions'
import { AiConnectDialog } from './AiConnectDialog'
import { AiCredentialRow } from './AiCredentialRow'
import { AiOfferingDetails } from './AiOfferingDetails'
import { AiSortableCredentialList } from './AiSortableCredentialList'
import { useAiConnectDialog } from './useAiConnectDialog'

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

/**
 * The offering's toolbar plus the credential list it acts on. Everything the
 * dialog needs - which form is open, the busy state, the errors - belongs to
 * `useAiConnectDialog`, so the two views of that lifecycle stay in step.
 */
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
  const apiOfferings = offerings.filter((offering) => authorizationMethodsForOffering(offering).some((method) => method.lifecycle === 'active' && isApiKeyMethod(method)))
  const authorizationPending = isPendingAttempt(attempt) && isOAuthMode(attempt?.mode)
  const orderedCredentials = [...credentials].sort((a, b) => a.priority - b.priority)
  const quotaBusy = credentials.some((credential) => quotas[credential.id]?.busy)
  const dialog = useAiConnectDialog({
    attempt,
    onDismissError,
    onBeginOffering,
    onBeginBrowser,
    onCreateLocalCredential,
  })

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
                busy={busy || dialog.saving} disabled={disabled || authorizationPending}
                onBeginOffering={onBeginOffering ? dialog.beginAuthorization : undefined}
                onCreateLocalCredential={onCreateLocalCredential ? dialog.beginLocal : undefined} />
            </div>
          })}
          {apiOfferings.length > 0 && !offerings.some((offering) =>
            authorizationMethodsForOffering(offering).some((method) =>
              method.lifecycle === 'active' && (isOAuthMethod(method) || isLocalMethod(method))))
            && definition.browserMode === 'browserAssistedApiKey' ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label={`${definition.name} 登录`}
            disabled={busy || dialog.saving || disabled || authorizationPending} onClick={dialog.beginBrowser}>
            <ExternalLink className="h-3.5 w-3.5" />{definition.browserLabel}
          </Button>
          ) : null}
          {apiOfferings.length > 0 ? (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" aria-label="新建 API Key 连接" disabled={busy || dialog.saving || disabled || authorizationPending || (!product && status === 'pending' && !attempt)} onClick={dialog.beginApiKey}>
            <Plus className="h-3.5 w-3.5" />API Key</Button>
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
                onEdit={credential.authMode === 'apiKey' ? () => dialog.beginEdit(credential) : undefined}
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
        <AiConnectDialog controller={dialog} definition={definition} offerings={offerings} apiOfferings={apiOfferings}
          credentials={credentials} status={status} attempt={attempt} attemptOfferingId={attemptOfferingId}
          apiKey={apiKey} baseUrl={baseUrl} busy={busy} disabled={disabled} error={error}
          onApiKeyChange={onApiKeyChange} onBaseUrlChange={onBaseUrlChange} onBeginApiKey={onBeginApiKey}
          onBeginBrowser={onBeginBrowser} onSaveApiKey={onSaveApiKey} onDisconnect={onDisconnect}
          onUpdateCredential={onUpdateCredential} onCreateApiKeyCredential={onCreateApiKeyCredential}
          onBeginOffering={onBeginOffering} onCancelConnect={onCancelConnect} onDismissError={onDismissError} />
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">接入信息</summary>
          <div className="mt-2 space-y-3">
            {offerings.map((offering) => <AiOfferingDetails key={offering.id} offering={offering} />)}
          </div>
        </details>
        {dialog.error && !dialog.open && dialog.error !== error?.message ? <p role="alert" className="text-sm text-destructive">{dialog.error}</p> : null}
        {error && (error.offeringId ? !dialog.open : !suppressError)
          ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      </section>
    </TooltipProvider>
  )
}
