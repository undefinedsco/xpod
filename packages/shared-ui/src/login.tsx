import { useId, useState, type ReactNode } from 'react'
import { AlertCircle, AlertTriangle, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { cn } from './utils'

// Legacy login pieces remain source-compatible while hosts migrate to the
// canonical AuthSurface and Account/WebID presentation views.
export type { AuthSurfaceMode } from './auth-surface'

export type LoginBadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

export interface LoginBadge {
  label: string
  tone: LoginBadgeTone
}

export interface LoginProviderOption {
  id: string
  label: string
  subtitle?: string
  badge?: LoginBadge
  actionLabel?: string
  disabled?: boolean
  connecting?: boolean
}

export interface LoginSpaceProviders {
  cloud?: LoginProviderOption
  local?: LoginProviderOption
}

const badgeToneClassNames: Record<LoginBadgeTone, string> = {
  neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
  primary: 'border-primary/20 bg-primary/5 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/20 bg-destructive/10 text-destructive',
}

export interface LoginProviderListCopy {
  title: string
  backLabel: string
  addLabel: string
  addPlaceholder: string
  addInputLabel: string
  invalidUrlMessage: string
  connectLabel: string
  cancelLabel: string
  emptyMessage: string
  dismissErrorLabel?: string
}

export interface LoginSpaceSelectionCopy {
  accountLabel: string
  storageLabel: string
  cloudLabel: string
  localLabel: string
  cloudDescription: string
  localDescription: string
  continueLabel: string
  moreProvidersLabel: string
  dismissErrorLabel?: string
}

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

const LEGACY_LOGIN_STORAGE_CONFLICT_DEFAULT_COPY = {
  expectedLabel: 'Expected space',
  actualLabel: 'Bound space',
  primaryLabel: 'Use expected space',
  secondaryLabel: 'Return',
} as const

const LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY: LoginProviderListCopy = {
  title: 'Sign in',
  backLabel: 'Back',
  addLabel: 'Add provider',
  addPlaceholder: 'https://example.com',
  addInputLabel: 'Provider URL',
  invalidUrlMessage: 'Enter a valid provider URL.',
  connectLabel: 'Connect',
  cancelLabel: 'Cancel',
  emptyMessage: 'No providers available',
}

const LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY: LoginSpaceSelectionCopy = {
  accountLabel: 'Account',
  storageLabel: 'Storage',
  cloudLabel: 'Remote',
  localLabel: 'Local',
  cloudDescription: 'Use remote storage.',
  localDescription: 'Use local storage.',
  continueLabel: 'Continue',
  moreProvidersLabel: 'More options',
}

function legacyLoginLabel(value: string | null | undefined, fallback: string): string {
  return value?.trim() ? value : fallback
}

export function LoginCardShell({
  children,
  ariaLabel,
  overlayClassName,
  cardClassName,
  cardSize = 'compact',
}: {
  children: ReactNode
  ariaLabel: string
  overlayClassName?: string
  cardClassName?: string
  cardSize?: 'compact' | 'auto'
}) {
  const baseCardClassName = cardSize === 'auto'
    ? 'w-[280px] overflow-hidden rounded-xl border border-border/50 bg-card flex flex-col'
    : 'w-[280px] h-[400px] overflow-hidden rounded-xl border border-border/50 bg-card flex flex-col'

  return (
    <div
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
          className="shrink-0 cursor-pointer text-destructive/60 hover:text-destructive"
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
          className={cn(sizeClassName, 'rounded-full border border-border/50 object-cover')}
        />
      ) : (
        <div
          aria-hidden="true"
          className={cn(sizeClassName, 'flex items-center justify-center rounded-full border border-border/50 bg-muted font-semibold text-muted-foreground')}
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
            className="h-9 w-full cursor-pointer rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
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
          onClick={onEnter}
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {visibleEnterLabel}
        </button>
        {onSwitchAccount ? (
          <button
            type="button"
            onClick={onSwitchAccount}
            className="h-9 w-full cursor-pointer rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {visibleSwitchLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function normalizeLoginProviderUrl(value: string): string {
  const trimmed = value.trim()
  const candidate = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(candidate)
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error('Unsupported provider URL')
  }
  return candidate
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
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visiblePrimaryLabel}
        </button>
        {onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className="h-9 w-full cursor-pointer rounded-md border border-border/60 bg-muted/30 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            {visibleSecondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function LoginStorageConflictView({
  eyebrow,
  accountName,
  avatarUrl,
  description,
  expectedLabel,
  expectedValue,
  actualLabel,
  actualValue,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  eyebrow: string
  accountName: string
  avatarUrl?: string
  description: string
  expectedLabel?: string
  expectedValue: string
  actualLabel?: string
  actualValue?: string
  primaryLabel?: string
  onPrimary?: () => void
  secondaryLabel?: string
  onSecondary: () => void
}) {
  const visiblePrimaryLabel = legacyLoginLabel(
    primaryLabel,
    LEGACY_LOGIN_STORAGE_CONFLICT_DEFAULT_COPY.primaryLabel,
  )
  const visibleSecondaryLabel = legacyLoginLabel(
    secondaryLabel,
    LEGACY_LOGIN_STORAGE_CONFLICT_DEFAULT_COPY.secondaryLabel,
  )
  const visibleExpectedLabel = legacyLoginLabel(
    expectedLabel,
    LEGACY_LOGIN_STORAGE_CONFLICT_DEFAULT_COPY.expectedLabel,
  )
  const visibleActualLabel = legacyLoginLabel(
    actualLabel,
    LEGACY_LOGIN_STORAGE_CONFLICT_DEFAULT_COPY.actualLabel,
  )
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="shrink-0 px-5 pb-4 pt-6">
        <p className="text-center text-[11px] font-medium tracking-wide text-muted-foreground/70">
          {eyebrow}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-center justify-center gap-3 px-5 pb-4">
        <LoginAvatar name={accountName} avatarUrl={avatarUrl} size="lg" />
        <p className="text-base font-semibold text-foreground">{accountName}</p>
        <p className="max-w-[19rem] text-center text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>

      <div className="mx-4 space-y-3 rounded-lg border border-border/60 bg-muted/25 p-4">
        <StorageDetail label={visibleExpectedLabel} value={expectedValue} />
        <StorageDetail label={visibleActualLabel} value={actualValue} />
      </div>

      <div className="mt-auto space-y-2 px-4 pb-4 pt-5">
        {onPrimary ? (
          <button
            type="button"
            onClick={onPrimary}
            className="h-9 w-full cursor-pointer rounded-md border border-border/60 bg-muted/30 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            {visiblePrimaryLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSecondary}
          className="h-9 w-full cursor-pointer rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {visibleSecondaryLabel}
        </button>
      </div>
    </div>
  )
}

function StorageDetail({ label, value }: { label?: string; value?: string }) {
  if (!label) return null
  return (
    <div>
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground/70">{label}</p>
      <div className="mt-1 break-all rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {value}
      </div>
    </div>
  )
}

export function LoginProviderListView({
  title,
  providers,
  error,
  addLabel,
  addPlaceholder,
  copy,
  connectingId,
  onBack,
  onConnect,
  onAddProvider,
  onDismissError,
}: {
  title?: string
  providers: LoginProviderOption[]
  error?: string | null
  addLabel?: string
  addPlaceholder?: string
  copy?: Partial<LoginProviderListCopy>
  connectingId?: string
  onBack?: () => void
  onConnect: (providerId: string) => void
  onAddProvider?: (url: string) => void
  onDismissError?: () => void
}) {
  const [isAdding, setIsAdding] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [customUrlError, setCustomUrlError] = useState<string | null>(null)
  const errorId = useId()
  const visibleCopy: LoginProviderListCopy = {
    title: legacyLoginLabel(copy?.title, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.title),
    backLabel: legacyLoginLabel(copy?.backLabel, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.backLabel),
    addLabel: legacyLoginLabel(copy?.addLabel, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.addLabel),
    addPlaceholder: legacyLoginLabel(copy?.addPlaceholder, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.addPlaceholder),
    addInputLabel: legacyLoginLabel(copy?.addInputLabel, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.addInputLabel),
    invalidUrlMessage: legacyLoginLabel(copy?.invalidUrlMessage, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.invalidUrlMessage),
    connectLabel: legacyLoginLabel(copy?.connectLabel, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.connectLabel),
    cancelLabel: legacyLoginLabel(copy?.cancelLabel, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.cancelLabel),
    emptyMessage: legacyLoginLabel(copy?.emptyMessage, LEGACY_LOGIN_PROVIDER_LIST_DEFAULT_COPY.emptyMessage),
    dismissErrorLabel: legacyLoginLabel(copy?.dismissErrorLabel, LEGACY_LOGIN_ERROR_DEFAULT_COPY.dismissLabel),
  }
  const visibleTitle = legacyLoginLabel(title, visibleCopy.title)
  const visibleBackLabel = visibleCopy.backLabel
  const visibleAddLabel = legacyLoginLabel(addLabel, visibleCopy.addLabel)
  const visibleAddPlaceholder = legacyLoginLabel(addPlaceholder, visibleCopy.addPlaceholder)
  const visibleInputLabel = visibleCopy.addInputLabel
  const visibleInvalidUrlMessage = visibleCopy.invalidUrlMessage
  const visibleConnectLabel = visibleCopy.connectLabel
  const visibleCancelLabel = visibleCopy.cancelLabel
  const visibleEmptyMessage = visibleCopy.emptyMessage

  const handleAdd = () => {
    if (!customUrl.trim() || !onAddProvider) return
    try {
      const normalized = normalizeLoginProviderUrl(customUrl)
      onAddProvider(normalized)
      setCustomUrl('')
      setCustomUrlError(null)
      setIsAdding(false)
    } catch {
      setCustomUrlError(visibleInvalidUrlMessage)
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col px-5 py-5">
      {onBack && visibleBackLabel ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label={visibleBackLabel}
            className="-ml-2 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            {visibleBackLabel}
          </button>
        </div>
      ) : null}
      {visibleTitle ? <h2 className="mt-3 text-base font-semibold text-foreground">{visibleTitle}</h2> : null}

      <LoginErrorBanner
        error={error}
        onDismiss={onDismissError}
        dismissLabel={visibleCopy.dismissErrorLabel}
      />

      <div className="mt-4 flex-1 space-y-2 overflow-y-auto">
        {providers.map((provider) => {
          const connecting = connectingId === provider.id || provider.connecting === true
          return (
            <button
              key={provider.id}
              type="button"
              disabled={provider.disabled || connecting}
              onClick={() => onConnect(provider.id)}
              className="w-full cursor-pointer rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{provider.label}</p>
                    {provider.badge ? (
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          badgeToneClassNames[provider.badge.tone],
                        )}
                      >
                        {provider.badge.label}
                      </span>
                    ) : null}
                  </div>
                  {provider.subtitle ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{provider.subtitle}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {connecting ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
                  ) : provider.actionLabel ? (
                    <span className="text-xs font-medium text-primary">{provider.actionLabel}</span>
                  ) : null}
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
                </div>
              </div>
            </button>
          )
        })}
        {providers.length === 0 && visibleEmptyMessage ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{visibleEmptyMessage}</p>
        ) : null}
      </div>

      {onAddProvider ? (
        <div className="mt-4 space-y-2">
          {isAdding ? (
            <div className="space-y-2">
              <input
                autoFocus
                type="url"
                aria-label={visibleInputLabel}
                aria-invalid={customUrlError ? true : undefined}
                aria-describedby={customUrlError ? errorId : undefined}
                placeholder={visibleAddPlaceholder}
                value={customUrl}
                onChange={(event) => {
                  setCustomUrl(event.target.value)
                  setCustomUrlError(null)
                }}
                onKeyDown={(event) => event.key === 'Enter' && handleAdd()}
                className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              {customUrlError ? (
                <p id={errorId} role="alert" className="flex items-center gap-1.5 text-left text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {customUrlError}
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                {visibleConnectLabel ? <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!customUrl.trim()}
                  className="h-8 rounded-md bg-primary text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {visibleConnectLabel}
                </button> : null}
                {visibleCancelLabel ? <button
                  type="button"
                  onClick={() => {
                    setIsAdding(false)
                    setCustomUrl('')
                    setCustomUrlError(null)
                  }}
                  className="h-8 rounded-md border border-border/50 text-xs text-muted-foreground hover:text-foreground"
                >
                  {visibleCancelLabel}
                </button> : null}
              </div>
            </div>
          ) : visibleAddLabel ? (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {visibleAddLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function LoginSpaceSelectionView({
  productName,
  logo,
  providers,
  error,
  onConnect,
  onMoreProviders,
  onDismissError,
  copy,
}: {
  productName: string
  logo?: ReactNode
  providers: LoginSpaceProviders
  error?: string | null
  onConnect: (providerId: string) => void
  onMoreProviders?: () => void
  onDismissError?: () => void
  copy?: Partial<LoginSpaceSelectionCopy>
}) {
  const defaultSpace = providers.cloud ? 'cloud' : 'local'
  const [space, setSpace] = useState<'cloud' | 'local'>(defaultSpace)
  const selectedProvider = providers[space] ?? providers.cloud ?? providers.local
  const visibleCopy: LoginSpaceSelectionCopy = {
    accountLabel: legacyLoginLabel(copy?.accountLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.accountLabel),
    storageLabel: legacyLoginLabel(copy?.storageLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.storageLabel),
    cloudLabel: legacyLoginLabel(copy?.cloudLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.cloudLabel),
    localLabel: legacyLoginLabel(copy?.localLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.localLabel),
    cloudDescription: legacyLoginLabel(copy?.cloudDescription, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.cloudDescription),
    localDescription: legacyLoginLabel(copy?.localDescription, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.localDescription),
    continueLabel: legacyLoginLabel(copy?.continueLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.continueLabel),
    moreProvidersLabel: legacyLoginLabel(copy?.moreProvidersLabel, LEGACY_LOGIN_SPACE_SELECTION_DEFAULT_COPY.moreProvidersLabel),
    dismissErrorLabel: legacyLoginLabel(copy?.dismissErrorLabel, LEGACY_LOGIN_ERROR_DEFAULT_COPY.dismissLabel),
  }
  const visibleDescription = space === 'local' ? visibleCopy.localDescription : visibleCopy.cloudDescription

  return (
    <div className="flex h-full flex-1 flex-col px-7 py-7 text-center">
      <div className="flex flex-1 flex-col items-center justify-center gap-5">
        {logo ? (
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-[18%] border border-primary/40 bg-primary/10 p-0.5 shadow-sm">
            {logo}
          </div>
        ) : null}
        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-foreground">{productName}</h1>
          <p className="text-sm text-muted-foreground">{visibleCopy.accountLabel}</p>
        </div>

        <div className="w-full space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{visibleCopy.storageLabel}</p>
          <div className="grid grid-cols-2 rounded-xl border border-border/70 bg-muted/30 p-1">
            <button
              type="button"
              disabled={!providers.cloud}
              onClick={() => setSpace('cloud')}
              className={loginSpaceSegmentClass(space === 'cloud')}
            >
              {visibleCopy.cloudLabel}
            </button>
            <button
              type="button"
              disabled={!providers.local}
              onClick={() => setSpace('local')}
              className={loginSpaceSegmentClass(space === 'local')}
            >
              {visibleCopy.localLabel}
            </button>
          </div>
          {visibleDescription ? <p className="text-xs leading-5 text-muted-foreground">{visibleDescription}</p> : null}
        </div>
      </div>

      <LoginErrorBanner
        error={error}
        onDismiss={onDismissError}
        dismissLabel={visibleCopy.dismissErrorLabel}
      />

      <div className="shrink-0 space-y-2">
        <button
          type="button"
          disabled={!selectedProvider}
          onClick={() => selectedProvider && onConnect(selectedProvider.id)}
          className="h-11 w-full cursor-pointer rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visibleCopy.continueLabel}
        </button>
        {onMoreProviders ? (
          <button
            type="button"
            onClick={onMoreProviders}
            className="h-9 w-full cursor-pointer rounded-lg text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            {visibleCopy.moreProvidersLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function loginSpaceSegmentClass(active: boolean): string {
  return cn(
    'h-9 rounded-lg text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
    active
      ? 'bg-background text-foreground shadow-sm'
      : 'cursor-pointer text-muted-foreground hover:text-foreground',
  )
}
