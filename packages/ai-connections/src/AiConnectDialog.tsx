import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  LoginConnectingView,
  LoginFailureView,
} from '@undefineds.co/shared-ui'
import type {
  AiConnectAttempt,
  AiConnectionsMode,
  AiProviderAuthorizationMethod,
  AiProviderCredentialSummary,
  AiProviderOffering,
} from './ai-connections-client'
import type { AiProviderDefinition } from './controller'
import type { ProviderConnectionState } from './AiProviderCard'
import type { AiOfferingActionError } from './AiCredentialPoolSection'
import { offeringTitle } from './offering-label'
import {
  authorizationMethodsForOffering,
  connectModeForMethod,
  isApiKeyMethod,
  isOAuthMethod,
  isOAuthMode,
  isPendingAttempt,
  modeForOffering,
} from './authorization-methods'
import { AiApiKeyPool } from './AiApiKeyPool'
import type { AiConnectDialogController } from './useAiConnectDialog'

/**
 * The connect dialog: one fieldset per offering, each showing whichever step that
 * offering is on - unavailable, waiting for an authorization, failed, or the API
 * key form. The dialog owns no state of its own; `useAiConnectDialog` holds the
 * lifecycle the toolbar drives and this component renders it.
 */
export function AiConnectDialog({
  controller,
  definition,
  offerings,
  apiOfferings,
  credentials,
  status,
  attempt,
  attemptOfferingId,
  apiKey,
  baseUrl = '',
  busy,
  disabled = false,
  error,
  onApiKeyChange,
  onBaseUrlChange,
  onBeginApiKey,
  onBeginBrowser,
  onSaveApiKey,
  onDisconnect,
  onUpdateCredential,
  onCreateApiKeyCredential,
  onBeginOffering,
  onCancelConnect,
  onDismissError,
}: {
  controller: AiConnectDialogController
  definition: AiProviderDefinition
  offerings: AiProviderOffering[]
  apiOfferings: AiProviderOffering[]
  credentials: AiProviderCredentialSummary[]
  status: ProviderConnectionState
  attempt?: AiConnectAttempt
  attemptOfferingId?: string
  apiKey: string
  baseUrl?: string
  busy: boolean
  disabled?: boolean
  error?: AiOfferingActionError
  onApiKeyChange: (value: string) => void
  onBaseUrlChange?: (value: string) => void
  onBeginApiKey: () => void
  onBeginBrowser: () => void
  onSaveApiKey: () => void
  onDisconnect: (credential?: AiProviderCredentialSummary) => void
  onUpdateCredential?: (credential: AiProviderCredentialSummary, patch: {
    label?: string
    enabled?: boolean
    priority?: number
    baseUrl?: string
    proxyUrl?: string
  }) => Promise<void>
  onCreateApiKeyCredential?: (offering: AiProviderOffering, input: {
    apiKey: string
    label?: string
    baseUrl?: string
    proxyUrl?: string
    priority: number
  }) => Promise<void>
  onBeginOffering?: (offering: AiProviderOffering, mode: AiConnectionsMode, method?: AiProviderAuthorizationMethod) => void
  onCancelConnect?: (attempt: Pick<AiConnectAttempt, 'attemptId' | 'state' | 'signature' | 'offeringId'> & Partial<Pick<AiConnectAttempt, 'mode'>>) => void
  onDismissError?: () => void
}) {
  const { editing, authorizationOfferingId, error: dialogError, saving } = controller
  const dialogOfferings = editing || authorizationOfferingId
    ? offerings.filter((offering) => offering.id === (editing?.offeringId ?? authorizationOfferingId))
    : apiOfferings
  return (
    <Dialog open={controller.open} onOpenChange={(open) => {
      if (open || saving) return
      if (attempt && isPendingAttempt(attempt) && isOAuthMode(attempt.mode)) {
        onCancelConnect?.({ mode: attempt.mode, attemptId: attempt.attemptId, state: attempt.state,
          signature: attempt.signature, ...(attempt.offeringId ? { offeringId: attempt.offeringId } : {}) })
      }
      controller.close()
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{controller.title}</DialogTitle></DialogHeader>
        <div className="space-y-5" aria-label="添加连接">
          {dialogOfferings.map((offering) => {
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
            const attemptedMode = authorizationError?.mode ?? offeringAttempt?.mode ?? (attemptedMethod ? connectModeForMethod(attemptedMethod) : modeForOffering(offering))
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
                      secondaryLabel="关闭" onSecondary={() => { onDismissError?.(); controller.close() }} />}
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
                    controller.close()
                  }}>取消连接</Button>
              </fieldset>
            }
            return <fieldset data-create-offering={offering.id} key={offering.id} disabled={actionDisabled} className="space-y-3 border-t border-border/50 pt-3 first:border-t-0 first:pt-0" aria-label={`${offeringTitle(offering)}接入操作`}>
              <legend className="px-1 text-sm font-medium">{offeringTitle(offering)}</legend>
              {supportsApiKey ? <AiApiKeyPool key={`${offering.id}:${editing?.id ?? ''}`}
                definition={definition} offering={offering} status={status}
                createOfferings={[offering]} initialCreate={!editing}
                credentials={credentials} initialEditing={editing?.offeringId === offering.id ? editing : undefined}
                onCloseEdit={controller.close} onSavingChange={controller.setSaving}
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
  )
}
