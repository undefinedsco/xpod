import { type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, Loader2, X } from 'lucide-react'
import { cn } from './utils'
import { buttonFocusClass, interactiveFocusClass } from './focus'

// Shared login presentation primitives: restoring/connecting/failure states,
// the remembered-identity card, and the compact card shell. Hosts supply copy
// and callbacks; these views never fetch, navigate, or choose providers.
// Provider chooser / route list product flows are not part of this module.
export type { AuthSurfaceMode } from './auth-surface'

// These defaults belong only to the legacy compatibility wrappers below. The
// canonical authentication surfaces require hosts to provide typed copy.
const LEGACY_LOGIN_ERROR_DEFAULT_COPY = {
  dismissLabel: 'Dismiss',
} as const

const LEGACY_LOGIN_RESTORING_DEFAULT_COPY = {
  label: 'Restoring session…',
} as const

const LEGACY_LOGIN_CONNECTING_DEFAULT_COPY = {
  title: 'Connecting…',
  detail: 'Waiting for the provider',
  cancelLabel: 'Cancel',
} as const

const LEGACY_LOGIN_ACCOUNT_DEFAULT_COPY = {
  expiredTitle: 'Session expired',
  enterLabel: 'Continue',
  switchLabel: 'Switch account',
} as const

const LEGACY_LOGIN_FAILURE_DEFAULT_COPY = {
  title: 'Sign-in failed',
  primaryLabel: 'Retry',
  secondaryLabel: 'Back',
} as const

function legacyLoginLabel(value: string | null | undefined, fallback: string): string {
  return value?.trim() ? value : fallback
}

export function LoginCardShell({
  children,
  ariaLabel,
  overlayClassName,
  cardClassName,
  surfaceTestId,
  surfaceHost,
  cardSize = 'compact',
}: {
  children: ReactNode
  ariaLabel: string
  overlayClassName?: string
  cardClassName?: string
  surfaceTestId?: string
  surfaceHost?: string
  cardSize?: 'compact' | 'auto'
}) {
  const baseCardClassName = cardSize === 'auto'
    ? 'w-compact-modal warm-card overflow-hidden rounded-xl flex flex-col'
    : 'w-compact-modal h-compact-modal warm-card overflow-hidden rounded-xl flex flex-col'

  return (
    <div
      data-testid={surfaceTestId}
      data-auth-surface-host={surfaceHost}
      className={cn('fixed inset-0 z-[999] flex items-center justify-center bg-black/50', overlayClassName)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-login-card-size={cardSize}
        className={cn(baseCardClassName, cardClassName)}
      >
        {children}
      </div>
    </div>
  )
}
export function LoginErrorBanner({
  error,
  onDismiss,
  dismissLabel,
}: {
  error: string | null | undefined
  onDismiss?: () => void
  dismissLabel?: string
}) {
  if (!error) return null
  const visibleDismissLabel = legacyLoginLabel(
    dismissLabel,
    LEGACY_LOGIN_ERROR_DEFAULT_COPY.dismissLabel,
  )
  return (
    <div role="alert" className="mx-5 mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <p className="flex-1 text-xs leading-relaxed text-destructive">{error}</p>
      {onDismiss ? (
        <button
          type="button"
          aria-label={visibleDismissLabel}
          onClick={onDismiss}
          className={cn(
            'shrink-0 cursor-pointer text-destructive/60 hover:text-destructive',
            interactiveFocusClass,
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export function LoginAvatar({
  name,
  avatarUrl,
  size = 'lg',
  marker,
}: {
  name: string
  avatarUrl?: string
  size?: 'md' | 'lg'
  marker?: ReactNode
}) {
  const sizeClassName = size === 'lg' ? 'h-16 w-16 text-xl' : 'h-10 w-10 text-sm'
  return (
    <div className="relative shrink-0">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name}
          className={cn(sizeClassName, 'rounded-[18%] border border-border/50 object-cover shadow-sm')}
        />
      ) : (
        <div
          aria-hidden="true"
          className={cn(sizeClassName, 'flex items-center justify-center rounded-[18%] bg-primary/10 font-semibold text-primary shadow-sm')}
        >
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {marker ? (
        <div className="absolute -bottom-1 -right-1">{marker}</div>
      ) : null}
    </div>
  )
}

export function LoginRestoringView({
  accountName,
  avatarUrl,
  label,
}: {
  accountName?: string
  avatarUrl?: string
  label?: string
}) {
  const visibleLabel = legacyLoginLabel(label, LEGACY_LOGIN_RESTORING_DEFAULT_COPY.label)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6" role="status">
      {accountName ? (
        <>
          <LoginAvatar name={accountName} avatarUrl={avatarUrl} size="lg" />
          <p className="text-sm font-medium text-foreground">{accountName}</p>
        </>
      ) : null}
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">{visibleLabel}</p>
    </div>
  )
}

export function LoginConnectingView({
  title,
  detail,
  providerLabel,
  providerHost,
  onCancel,
  cancelLabel,
}: {
  title?: string
  detail?: string
  providerLabel?: string
  providerHost?: string
  onCancel?: () => void
  cancelLabel?: string
}) {
  const visibleTitle = legacyLoginLabel(title, LEGACY_LOGIN_CONNECTING_DEFAULT_COPY.title)
  const visibleDetail = legacyLoginLabel(detail, LEGACY_LOGIN_CONNECTING_DEFAULT_COPY.detail)
  const visibleCancelLabel = legacyLoginLabel(cancelLabel, LEGACY_LOGIN_CONNECTING_DEFAULT_COPY.cancelLabel)
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center" role="status">
        <Loader2 className="mb-4 h-8 w-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">{visibleTitle}</p>
        <p className="mt-1 text-xs text-muted-foreground">{visibleDetail}</p>
        {providerLabel || providerHost ? (
          <div className="mt-4 w-full max-w-[18rem] rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            {providerLabel ? (
              <p className="truncate text-xs font-medium text-foreground">{providerLabel}</p>
            ) : null}
            {providerHost ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{providerHost}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {onCancel ? (
        <div className="shrink-0 px-5 pb-5">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'h-9 w-full cursor-pointer rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground',
              interactiveFocusClass,
            )}
          >
            {visibleCancelLabel}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function LoginAccountView({
  name,
  avatarUrl,
  bindingLabel,
  expired = false,
  expiredTitle,
  expiredDescription,
  enterLabel,
  switchLabel,
  error,
  onDismissError,
  dismissErrorLabel,
  onEnter,
  onSwitchAccount,
  onReauthenticate,
}: {
  name: string
  avatarUrl?: string
  bindingLabel?: string
  expired?: boolean
  expiredTitle?: string
  expiredDescription?: string
  enterLabel?: string
  switchLabel?: string
  error?: string | null
  onDismissError?: () => void
  dismissErrorLabel?: string
  onEnter: () => void
  onSwitchAccount?: () => void
  onReauthenticate?: () => void
}) {
  const visibleExpiredTitle = legacyLoginLabel(expiredTitle, LEGACY_LOGIN_ACCOUNT_DEFAULT_COPY.expiredTitle)
  const visibleEnterLabel = legacyLoginLabel(enterLabel, LEGACY_LOGIN_ACCOUNT_DEFAULT_COPY.enterLabel)
  const visibleSwitchLabel = legacyLoginLabel(switchLabel, LEGACY_LOGIN_ACCOUNT_DEFAULT_COPY.switchLabel)
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 py-8">
        {expired ? (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-[11px] font-medium text-primary">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {visibleExpiredTitle}
          </div>
        ) : null}
        <LoginAvatar name={name} avatarUrl={avatarUrl} size="lg" />
        <div className="space-y-1 text-center">
          <p className="text-base font-semibold text-foreground">{name}</p>
          {bindingLabel ? <p className="text-xs text-muted-foreground">{bindingLabel}</p> : null}
        </div>
        {expired && expiredDescription ? (
          <p className="max-w-[18rem] text-center text-xs leading-5 text-muted-foreground">{expiredDescription}</p>
        ) : null}
      </div>

      {!expired ? (
        <LoginErrorBanner
          error={error}
          onDismiss={onDismissError}
          dismissLabel={dismissErrorLabel}
        />
      ) : null}

      <div className="shrink-0 space-y-2 px-5 pb-5 pt-2">
        <button
          type="button"
          onClick={expired && onReauthenticate ? onReauthenticate : onEnter}
          className={cn(
            'h-10 w-full cursor-pointer rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:bg-primary/80',
            buttonFocusClass,
          )}
        >
          {visibleEnterLabel}
        </button>
        {onSwitchAccount ? (
          <button
            type="button"
            onClick={onSwitchAccount}
            className={cn(
              'h-9 w-full cursor-pointer rounded-lg text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:text-foreground',
              buttonFocusClass,
            )}
          >
            {visibleSwitchLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export type SessionLoginStatus = 'restoring' | 'idle' | 'connecting' | 'authenticated' | 'error'

/**
 * Product-neutral remembered identity used by the shared login presentation.
 * Hosts decide whether this represents one session or a verified composition
 * of several independent sessions.
 */
export interface RememberedLoginIdentity {
  displayName: string
  avatarUrl?: string
  bindingLabel?: string
}

export type SessionLoginPresentationState =
  | { status: 'restoring'; remembered?: RememberedLoginIdentity }
  | { status: 'idle'; remembered?: RememberedLoginIdentity; sessionRestorable?: boolean }
  | { status: 'connecting'; remembered?: RememberedLoginIdentity; title?: string; detail?: string; canCancel?: boolean }
  | { status: 'authenticated'; remembered?: RememberedLoginIdentity }
  | { status: 'error'; remembered?: RememberedLoginIdentity; message: string; sessionExpired?: boolean }

export interface RememberedLoginViewCopy {
  restoringLabel: string
  continueLabel: (displayName: string) => string
  reauthenticateLabel: (displayName: string) => string
  switchAccountLabel: string
  expiredTitle: string
  expiredDescription?: string
  connectingTitle: string
  connectingDetail: string
  cancelLabel: string
}

export function RememberedLoginView({
  state,
  copy,
  onContinue,
  onReauthenticate,
  onSwitchAccount,
  onCancel,
  onDismissError,
}: {
  state: SessionLoginPresentationState
  copy: RememberedLoginViewCopy
  onContinue: () => void
  onReauthenticate: () => void
  onSwitchAccount: () => void
  onCancel?: () => void
  onDismissError?: () => void
}) {
  if (state.status === 'authenticated') return null
  if (state.status === 'restoring') {
    return (
      <LoginRestoringView
        accountName={state.remembered?.displayName}
        avatarUrl={state.remembered?.avatarUrl}
        label={copy.restoringLabel}
      />
    )
  }
  if (state.status === 'connecting') {
    return (
      <LoginConnectingView
        title={state.title ?? copy.connectingTitle}
        detail={state.detail ?? copy.connectingDetail}
        onCancel={state.canCancel ? onCancel : undefined}
        cancelLabel={copy.cancelLabel}
      />
    )
  }

  const remembered = state.remembered
  if (!remembered) return null
  const expired = state.status === 'error' && state.sessionExpired === true
  const canContinue = state.status === 'idle' && state.sessionRestorable === true
  return (
    <LoginAccountView
      name={remembered.displayName}
      avatarUrl={remembered.avatarUrl}
      bindingLabel={remembered.bindingLabel}
      expired={expired}
      expiredTitle={copy.expiredTitle}
      expiredDescription={copy.expiredDescription}
      enterLabel={canContinue
        ? copy.continueLabel(remembered.displayName)
        : copy.reauthenticateLabel(remembered.displayName)}
      switchLabel={copy.switchAccountLabel}
      error={state.status === 'error' && !expired ? state.message : undefined}
      onDismissError={onDismissError}
      onEnter={canContinue ? onContinue : onReauthenticate}
      onSwitchAccount={onSwitchAccount}
    />
  )
}

export function LoginFailureView({
  title,
  description,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  title?: string
  description?: string | null
  primaryLabel?: string
  onPrimary: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  const visibleTitle = legacyLoginLabel(title, LEGACY_LOGIN_FAILURE_DEFAULT_COPY.title)
  const visiblePrimaryLabel = legacyLoginLabel(primaryLabel, LEGACY_LOGIN_FAILURE_DEFAULT_COPY.primaryLabel)
  const visibleSecondaryLabel = legacyLoginLabel(secondaryLabel, LEGACY_LOGIN_FAILURE_DEFAULT_COPY.secondaryLabel)
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-5 pt-7 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
        </div>
        <p className="text-base font-semibold text-foreground">{visibleTitle}</p>
        {description ? (
          <p className="max-w-[19rem] text-sm leading-6 text-muted-foreground" role="alert">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 space-y-2 px-4 pb-5">
        <button
          type="button"
          onClick={onPrimary}
          className={cn(
            'h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50',
            buttonFocusClass,
          )}
        >
          {visiblePrimaryLabel}
        </button>
        {onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className={cn(
              'h-9 w-full cursor-pointer rounded-md border border-border/60 bg-muted/30 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:bg-muted/50',
              buttonFocusClass,
            )}
          >
            {visibleSecondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}
