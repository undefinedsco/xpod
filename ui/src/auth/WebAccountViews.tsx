import { useId } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

export interface WebAccountRestoringViewProps {
  label?: string
  accountName?: string
}

export function WebAccountRestoringView({
  label = '正在恢复登录状态…',
  accountName,
}: WebAccountRestoringViewProps) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-44 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
      <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-primary" />
      {accountName ? <p className="text-sm font-medium text-foreground">{accountName}</p> : null}
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

export interface WebAccountFailureViewProps {
  title?: string
  description?: string | null
  primaryLabel?: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

export function WebAccountFailureView({
  title = '操作未完成',
  description,
  primaryLabel = '重试',
  onPrimary,
  secondaryLabel = '返回',
  onSecondary,
}: WebAccountFailureViewProps) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-4 px-5 py-8 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle aria-hidden="true" className="h-5 w-5 text-destructive" />
      </div>
      <div className="space-y-2">
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description ? <p role="alert" className="text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex w-full flex-col gap-2 sm:max-w-xs">
        <button
          type="button"
          onClick={onPrimary}
          className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primaryLabel}
        </button>
        {onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className="h-9 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:border-ring"
          >
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export interface WebAccountErrorBannerProps {
  error: string | null | undefined
  onDismiss?: () => void
  dismissLabel?: string
}

export function WebAccountErrorBanner({
  error,
  onDismiss,
  dismissLabel = '关闭',
}: WebAccountErrorBannerProps) {
  if (!error) return null
  return (
    <div role="alert" aria-live="polite" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 leading-6">{error}</p>
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="rounded-md px-1 text-lg leading-none text-destructive/70 transition-colors hover:text-destructive focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

type MaybePromise<T> = T | Promise<T>

export interface WebAccountConsentOption {
  id: string
  label: string
  description?: string
  webId?: string
  storageUrl?: string
}

export interface WebAccountConsentSelection {
  webIdId: string
  storageId?: string
  rememberClient: boolean
}

export interface WebAccountConsentViewProps {
  client: {
    name: string
    description?: string
  }
  webIds: readonly WebAccountConsentOption[]
  storageOptions?: readonly WebAccountConsentOption[]
  selectedWebIdId?: string
  selectedStorageId?: string
  rememberClient: boolean
  onWebIdChange?: (optionId: string) => void
  onStorageChange?: (optionId: string) => void
  onRememberClientChange?: (remember: boolean) => void
  onApprove: (selection: WebAccountConsentSelection) => MaybePromise<void>
  onDeny: () => MaybePromise<void>
  onEditAccount?: () => MaybePromise<void>
  onSwitchAccount?: () => MaybePromise<void>
  pending?: boolean
  showIdentitySelection?: boolean
  copy: {
    description: string
    webIdLabel: string
    storageLabel: string
    rememberClientLabel: string
    approveLabel: string
    denyLabel: string
    editAccountLabel?: string
    switchAccountLabel?: string
  }
}

function WebAccountSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly WebAccountConsentOption[]
  disabled: boolean
  onChange?: (optionId: string) => void
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled || !onChange}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {!value ? <option value="" disabled>{label}</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </div>
  )
}

function WebAccountSelectedOption({
  label,
  option,
}: {
  label: string
  option?: WebAccountConsentOption
}) {
  if (!option) return null
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-foreground">{option.webId ?? option.label}</p>
      {option.description ? <p className="mt-1 break-words text-sm text-muted-foreground">{option.description}</p> : null}
      {option.storageUrl ? <p className="mt-1 break-all text-xs text-muted-foreground">{option.storageUrl}</p> : null}
    </div>
  )
}

export function WebAccountConsentView({
  client,
  webIds,
  storageOptions,
  selectedWebIdId,
  selectedStorageId,
  rememberClient,
  onWebIdChange,
  onStorageChange,
  onRememberClientChange,
  onApprove,
  onDeny,
  onEditAccount,
  onSwitchAccount,
  pending = false,
  showIdentitySelection = true,
  copy,
}: WebAccountConsentViewProps) {
  // Preserve the CSS consent form's stable control identifiers for OIDC automation.
  const webIdSelectId = 'oidc-consent-webid'
  const storageSelectId = 'oidc-consent-storage'
  const rememberId = useId()
  const resolvedWebIdId = selectedWebIdId ?? ''
  const resolvedStorageId = selectedStorageId ?? ''
  const resolvedStorageOptions = storageOptions ?? []
  const selectedWebIdOption = webIds.find((option) => option.id === resolvedWebIdId)
  const selectedStorageOption = resolvedStorageOptions.find((option) => option.id === resolvedStorageId)
  const hasStorageOptions = resolvedStorageOptions.length > 0
  const approveDisabled = pending || !selectedWebIdOption || (hasStorageOptions && !selectedStorageOption)
  const approve = () => {
    const selection: WebAccountConsentSelection = {
      webIdId: resolvedWebIdId,
      storageId: resolvedStorageId || undefined,
      rememberClient,
    }
    void onApprove(selection)
  }

  return (
    <div className="space-y-5 text-card-foreground">
      <div className="space-y-2">
        <p className="text-sm leading-6 text-muted-foreground">{copy.description}</p>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
        <p className="text-sm font-medium text-foreground">{client.name}</p>
        {client.description ? <p className="mt-1 break-words text-xs text-muted-foreground">{client.description}</p> : null}
      </div>

      {showIdentitySelection && webIds.length > 1 ? (
        <WebAccountSelect
          id={webIdSelectId}
          label={copy.webIdLabel}
          value={resolvedWebIdId}
          options={webIds}
          disabled={pending}
          onChange={onWebIdChange}
        />
      ) : (
        <WebAccountSelectedOption label={copy.webIdLabel} option={selectedWebIdOption ?? webIds[0]} />
      )}

      {showIdentitySelection && hasStorageOptions ? (
        resolvedStorageOptions.length > 1 ? (
          <WebAccountSelect
            id={storageSelectId}
            label={copy.storageLabel}
            value={resolvedStorageId}
            options={resolvedStorageOptions}
            disabled={pending}
            onChange={onStorageChange}
          />
        ) : (
          <WebAccountSelectedOption label={copy.storageLabel} option={selectedStorageOption ?? resolvedStorageOptions[0]} />
        )
      ) : null}

      <label htmlFor={rememberId} className="flex items-center justify-between gap-4 rounded-xl border border-border/60 px-3 py-2 text-sm text-foreground">
        <span>{copy.rememberClientLabel}</span>
        <input
          id={rememberId}
          type="checkbox"
          checked={rememberClient}
          disabled={pending || !onRememberClientChange}
          onChange={(event) => onRememberClientChange?.(event.currentTarget.checked)}
          className="h-4 w-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={approveDisabled}
          onClick={approve}
          className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.approveLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void onDeny()}
          className="h-10 rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copy.denyLabel}
        </button>
        {onEditAccount && copy.editAccountLabel ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onEditAccount()}
            className="h-9 rounded-lg px-4 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.editAccountLabel}
          </button>
        ) : null}
        {onSwitchAccount && copy.switchAccountLabel ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onSwitchAccount()}
            className="h-9 rounded-lg px-4 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.switchAccountLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export type WebAccountStorageBootstrapStatus =
  | 'creation'
  | 'creating'
  | 'waiting'
  | 'waiting_for_binding'
  | 'ready'
  | 'conflict'
  | 'error'

export type WebAccountStorageBootstrapState =
  | WebAccountStorageBootstrapStatus
  | {
      status: WebAccountStorageBootstrapStatus
      message?: string
    }

export interface WebAccountStorageBootstrapViewProps {
  state: WebAccountStorageBootstrapState
  copy: {
    title?: string
    description?: string
    creationMessage: string
    waitingMessage: string
    readyMessage: string
    conflictMessage: string
    errorMessage: string
    createLabel: string
    continueLabel: string
    retryLabel: string
    cancelLabel: string
  }
  pending?: boolean
  onCreate?: () => MaybePromise<void>
  onContinue?: () => MaybePromise<void>
  onRetry?: () => MaybePromise<void>
  onCancel?: () => MaybePromise<void>
}

function normalizeStorageBootstrapState(state: WebAccountStorageBootstrapState): {
  status: WebAccountStorageBootstrapStatus
  message?: string
} {
  if (typeof state === 'string') return { status: state }
  return state
}

export function WebAccountStorageBootstrapView({
  state: stateInput,
  copy,
  pending = false,
  onCreate,
  onContinue,
  onRetry,
  onCancel,
}: WebAccountStorageBootstrapViewProps) {
  const state = normalizeStorageBootstrapState(stateInput)
  const canCreate = state.status === 'creation'
  const isCreating = state.status === 'creating'
  const isWaiting = state.status === 'waiting' || state.status === 'waiting_for_binding'
  const isError = state.status === 'conflict' || state.status === 'error'
  const showProgress = isCreating || isWaiting || (canCreate && pending)
  const message = state.message ?? (
    canCreate || isCreating
      ? copy.creationMessage
      : isWaiting
        ? copy.waitingMessage
        : state.status === 'ready'
          ? copy.readyMessage
          : state.status === 'conflict'
            ? copy.conflictMessage
            : copy.errorMessage
  )

  return (
    <div className="space-y-5 text-card-foreground">
      {copy.title || copy.description ? (
        <div className="space-y-2">
          {copy.title ? <p className="text-base font-semibold text-foreground">{copy.title}</p> : null}
          {copy.description ? <p className="text-sm leading-6 text-muted-foreground">{copy.description}</p> : null}
        </div>
      ) : null}

      {isError ? (
        <div role="alert" aria-live="polite" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
          {message}
        </div>
      ) : showProgress ? (
        <div role="status" aria-live="polite" className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
          <Loader2 aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 animate-spin text-primary" />
          <span>{message}</span>
        </div>
      ) : (
        <p role="status" aria-live="polite" className="text-sm leading-6 text-foreground">{message}</p>
      )}

      <div className="flex flex-col gap-2">
        {canCreate && onCreate ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onCreate()}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.createLabel}
          </button>
        ) : null}
        {state.status === 'ready' && onContinue ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onContinue()}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.continueLabel}
          </button>
        ) : null}
        {isError && onRetry ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onRetry()}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.retryLabel}
          </button>
        ) : null}
        {(isWaiting || isCreating) && onCancel ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void onCancel()}
            className="h-10 rounded-xl border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copy.cancelLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}
