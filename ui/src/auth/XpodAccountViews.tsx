import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react'
import {
  AuthSurface,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  ScrollArea,
  cn,
  type AuthSurfaceHost,
  type AuthSurfaceMode,
  type AuthSurfacePresentation,
} from '@undefineds.co/shared-ui'

export type { AuthSurfaceHost, AuthSurfaceMode, AuthSurfacePresentation }
export type { AccountAuthMode, AccountAuthState } from '../context/AuthContextValue'

export interface AccountCredentialsValues {
  username?: string
  email?: string
  password: string
  confirmation?: string
}

export type AccountCredentialField = keyof AccountCredentialsValues

export interface AccountCredentialsCopy {
  productName: string
  loginTitle: string
  registerTitle: string
  usernameLabel: string
  usernamePlaceholder: string
  emailLabel: string
  emailPlaceholder: string
  passwordLabel: string
  passwordPlaceholder: string
  confirmationLabel: string
  confirmationPlaceholder: string
  loginAction: string
  registerAction: string
  switchToRegister: string
  switchToLogin: string
  usernameChecking: string
  usernameAvailable: string
  usernameUnavailable: string
  suggestionsLabel: string
  mismatchError: string
}

export interface AccountCredentialsViewProps {
  mode: 'login' | 'register'
  values: AccountCredentialsValues
  onChange: (values: AccountCredentialsValues) => void
  onSubmit: (values: AccountCredentialsValues) => void | Promise<void>
  onFieldChange?: (field: AccountCredentialField, value: string) => void
  onModeChange?: (mode: 'login' | 'register') => void
  pending?: boolean
  errors?: Partial<Record<AccountCredentialField | 'form', string>>
  usernameAvailability?: 'idle' | 'checking' | 'available' | 'unavailable' | { status: 'idle' | 'checking' | 'available' | 'unavailable'; message?: string }
  usernameSuggestions?: readonly string[]
  copy: AccountCredentialsCopy
  frame?: 'card' | 'bare'
  showHeader?: boolean
  presentation?: AuthSurfacePresentation
}

function AccountCredentialsFrame({
  frame,
  children,
}: {
  frame: 'card' | 'bare'
  children: ReactNode
}) {
  if (frame === 'bare') {
    return (
      <div data-account-credentials-frame="bare" className="w-full text-card-foreground">
        {children}
      </div>
    )
  }

  return (
    <Card data-account-credentials-frame="card" className="w-full border-border bg-card text-card-foreground">
      {children}
    </Card>
  )
}

function setCredentialValue(
  values: AccountCredentialsValues,
  field: AccountCredentialField,
  value: string,
  onChange: AccountCredentialsViewProps['onChange'],
  onFieldChange?: AccountCredentialsViewProps['onFieldChange'],
) {
  onChange({ ...values, [field]: value })
  onFieldChange?.(field, value)
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" aria-live="polite" className="flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
      {message}
    </p>
  )
}

interface FloatingCredentialFieldProps {
  id: string
  label: string
  error?: string
  children: ReactNode
}

function FloatingCredentialField({ id, label, error, children }: FloatingCredentialFieldProps) {
  return (
    <div className="space-y-1.5">
      <div data-floating-field="true" className="relative">
        {children}
        <Label
          htmlFor={id}
          className="pointer-events-none absolute left-3 top-0 z-[1] -translate-y-1/2 bg-card px-1 text-xs leading-none text-muted-foreground transition-[color,font-size,top,transform] duration-150 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:text-sm peer-focus:top-0 peer-focus:-translate-y-1/2 peer-focus:text-xs peer-focus:text-ring peer-disabled:opacity-50 peer-aria-[invalid=true]:text-destructive"
        >
          {label}
        </Label>
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

function StackedCredentialField({ id, label, error, children }: FloatingCredentialFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

function CredentialField({
  id,
  label,
  error,
  floating,
  children,
}: FloatingCredentialFieldProps & { floating: boolean }) {
  const Field = floating ? FloatingCredentialField : StackedCredentialField
  return (
    <Field id={id} label={label} error={error}>
      {children}
    </Field>
  )
}

function AuxiliaryAuthFrame({
  frame,
  testId,
  children,
}: {
  frame: 'card' | 'bare'
  testId: string
  children: ReactNode
}) {
  if (frame === 'bare') {
    return (
      <div data-testid={testId} data-account-auxiliary-frame="bare" className="w-full text-card-foreground">
        {children}
      </div>
    )
  }

  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid={testId} className="max-h-[min(70vh,36rem)] overflow-y-auto">
        {children}
      </ScrollArea>
    </Card>
  )
}

export function AccountCredentialsView({
  mode,
  values,
  onChange,
  onSubmit,
  onFieldChange,
  onModeChange,
  pending = false,
  errors,
  usernameAvailability = 'idle',
  usernameSuggestions = [],
  copy,
  frame = 'card',
  showHeader = true,
  presentation = 'standard',
}: AccountCredentialsViewProps) {
  const [submittedMismatch, setSubmittedMismatch] = useState(false)
  const usernameId = useId()
  const emailId = useId()
  const passwordId = useId()
  const confirmationId = useId()
  const formErrorId = useId()
  const isRegister = mode === 'register'
  const availability = typeof usernameAvailability === 'string' ? usernameAvailability : usernameAvailability.status
  const mismatch = isRegister
    && values.password.length > 0
    && values.confirmation !== undefined
    && values.password !== values.confirmation
  const visibleMismatch = mismatch && (submittedMismatch || values.confirmation !== undefined) ? copy.mismatchError : undefined
  const submitLabel = isRegister ? copy.registerAction : copy.loginAction
  const isCompact = presentation === 'compact'
  const inputClassName = isCompact
    ? 'peer h-11 rounded-xl px-3 pb-2 pt-4'
    : undefined

  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (pending) return
    if (isRegister && mismatch) {
      setSubmittedMismatch(true)
      return
    }
    setSubmittedMismatch(false)
    void onSubmit(values)
  }

  const content = (
    <>
      {showHeader ? (
        <CardHeader>
          <CardTitle>{isRegister ? copy.registerTitle : copy.loginTitle}</CardTitle>
          <CardDescription>{copy.productName}</CardDescription>
        </CardHeader>
      ) : null}
      <CardContent className={cn(
        frame === 'bare'
          ? isCompact ? 'p-0' : 'p-0'
          : showHeader ? undefined : 'pt-6',
      )}>
        <form onSubmit={submit} className={isCompact ? 'space-y-3' : 'space-y-4'}>
          {isRegister ? (
            <div className="space-y-2">
              <CredentialField floating={isCompact} id={usernameId} label={copy.usernameLabel} error={errors?.username}>
                <Input
                  id={usernameId}
                  name="username"
                  autoComplete="username"
                  placeholder={isCompact ? ' ' : copy.usernamePlaceholder}
                  title={copy.usernamePlaceholder}
                  value={values.username ?? ''}
                  disabled={pending}
                  aria-invalid={errors?.username ? true : undefined}
                  aria-describedby={errors?.username ? `${usernameId}-error` : undefined}
                  className={inputClassName}
                  onChange={(event) => setCredentialValue(values, 'username', event.currentTarget.value, onChange, onFieldChange)}
                />
              </CredentialField>
              {availability === 'checking' ? (
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  <Loader2 aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                  {copy.usernameChecking}
                </p>
              ) : null}
              {availability === 'available' ? (
                <p aria-live="polite" className="flex items-center gap-1 text-sm text-primary">
                  <CheckCircle aria-hidden="true" className="h-4 w-4" />
                  {copy.usernameAvailable}
                </p>
              ) : null}
              {availability === 'unavailable' && !errors?.username ? (
                <p aria-live="polite" className="text-sm text-destructive">{typeof usernameAvailability === 'object' && usernameAvailability.message ? usernameAvailability.message : copy.usernameUnavailable}</p>
              ) : null}
              {!isCompact && usernameSuggestions.length > 0 ? (
                <div className="space-y-2" aria-label={copy.suggestionsLabel}>
                  <p className="text-sm text-muted-foreground">{copy.suggestionsLabel}</p>
                  <div className="flex flex-wrap gap-2">
                    {usernameSuggestions.map((suggestion) => (
                      <Button
                        key={suggestion}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => setCredentialValue(values, 'username', suggestion, onChange, onFieldChange)}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <CredentialField floating={isCompact} id={emailId} label={copy.emailLabel} error={errors?.email}>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              placeholder={isCompact ? ' ' : copy.emailPlaceholder}
              title={copy.emailPlaceholder}
              value={values.email ?? ''}
              disabled={pending}
              aria-invalid={errors?.email ? true : undefined}
              aria-describedby={errors?.email ? `${emailId}-error` : undefined}
              className={inputClassName}
              onChange={(event) => setCredentialValue(values, 'email', event.currentTarget.value, onChange, onFieldChange)}
            />
          </CredentialField>

          <CredentialField floating={isCompact} id={passwordId} label={copy.passwordLabel} error={errors?.password}>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={isCompact ? ' ' : copy.passwordPlaceholder}
              title={copy.passwordPlaceholder}
              value={values.password}
              disabled={pending}
              aria-invalid={errors?.password ? true : undefined}
              aria-describedby={errors?.password ? `${passwordId}-error` : undefined}
              className={inputClassName}
              onChange={(event) => setCredentialValue(values, 'password', event.currentTarget.value, onChange, onFieldChange)}
            />
          </CredentialField>

          {isRegister ? (
            <CredentialField
              floating={isCompact}
              id={confirmationId}
              label={copy.confirmationLabel}
              error={visibleMismatch ?? errors?.confirmation}
            >
              <Input
                id={confirmationId}
                name="confirmation"
                type="password"
                autoComplete="new-password"
                placeholder={isCompact ? ' ' : copy.confirmationPlaceholder}
                title={copy.confirmationPlaceholder}
                value={values.confirmation ?? ''}
                disabled={pending}
                aria-invalid={visibleMismatch || errors?.confirmation ? true : undefined}
                aria-describedby={visibleMismatch || errors?.confirmation ? `${confirmationId}-error` : undefined}
                className={inputClassName}
                onChange={(event) => {
                  setSubmittedMismatch(false)
                  setCredentialValue(values, 'confirmation', event.currentTarget.value, onChange, onFieldChange)
                }}
              />
            </CredentialField>
          ) : null}

          <FieldError id={formErrorId} message={errors?.form} />

          <div className="space-y-3">
            <Button type="submit" className={cn('w-full', isCompact && 'h-10 rounded-xl')} disabled={pending}>
              {pending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
            {onModeChange ? (
              <Button
                type="button"
                variant="ghost"
                className={cn('w-full', isCompact && 'h-9 rounded-lg text-xs')}
                disabled={pending}
                onClick={() => onModeChange(isRegister ? 'login' : 'register')}
              >
                {isRegister ? copy.switchToLogin : copy.switchToRegister}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </>
  )

  return (
    <AccountCredentialsFrame frame={frame}>
      {content}
    </AccountCredentialsFrame>
  )
}

export interface AccountCredentialsSurfaceProps extends AccountCredentialsViewProps {
  surface: AuthSurfaceMode
  surfaceTitle: string
  presentation?: AuthSurfacePresentation
  host?: AuthSurfaceHost
  lead?: ReactNode
  footer?: ReactNode
  onClose?: () => void
  closeLabel?: string
  closeOnEscape?: boolean
  surfaceClassName?: string
  contentClassName?: string
}

/**
 * Complete Account credentials presentation for hosts that want the public
 * page, modal or embedded surface without stacking two Card frames.
 */
export function AccountCredentialsSurface({
  surface,
  surfaceTitle,
  presentation,
  host,
  lead,
  footer,
  onClose,
  closeLabel,
  closeOnEscape,
  surfaceClassName,
  contentClassName,
  ...credentials
}: AccountCredentialsSurfaceProps) {
  return (
    <AuthSurface
      mode={surface}
      title={surfaceTitle}
      presentation={presentation}
      host={host}
      lead={lead}
      onClose={onClose}
      closeLabel={closeLabel}
      closeOnEscape={closeOnEscape}
      className={surfaceClassName}
    >
      <div className={contentClassName ?? (presentation === 'compact'
        ? 'flex min-h-0 flex-1 flex-col justify-center px-5 pb-5 pt-4'
        : 'p-4')}
      >
        <AccountCredentialsView
          {...credentials}
          frame="bare"
          showHeader={false}
          presentation={presentation}
        />
        {footer ? <div className={presentation === 'compact' ? 'mt-3 space-y-2' : 'mt-4 space-y-2'}>{footer}</div> : null}
      </div>
    </AuthSurface>
  )
}

export interface AccountLoginMethod {
  id: string
  label: string
  description?: string
  badge?: { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }
  disabled?: boolean
}

export interface AccountLoginMethodListViewProps {
  methods: readonly AccountLoginMethod[]
  onSelect?: (methodId: string) => void
  onSelectMethod?: (methodId: string) => void
  copy: {
    title: string
    description?: string
    methodActionLabel?: string
    emptyMessage?: string
  }
  pending?: boolean
}

export function AccountLoginMethodListView({
  methods,
  onSelect,
  onSelectMethod,
  copy,
  pending = false,
}: AccountLoginMethodListViewProps) {
  const selectMethod = onSelect ?? onSelectMethod
  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="account-login-method-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {methods.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.emptyMessage}</p>
          ) : methods.map((method) => (
            <Button
              key={method.id}
              type="button"
              variant="outline"
              className="h-auto w-full justify-between gap-3 px-4 py-3 text-left"
              disabled={pending || method.disabled || !selectMethod}
              onClick={() => selectMethod?.(method.id)}
            >
              <span className="min-w-0">
                <span className="block truncate">{method.label}</span>
                {method.description ? <span className="mt-1 block text-sm font-normal text-muted-foreground">{method.description}</span> : null}
              </span>
              {method.badge ? <Badge variant={method.badge.tone === 'danger' ? 'destructive' : method.badge.tone === 'neutral' ? 'outline' : method.badge.tone === 'warning' ? 'secondary' : 'default'}>{method.badge.label}</Badge> : null}
              {copy.methodActionLabel ? <span className="sr-only">{copy.methodActionLabel}</span> : null}
            </Button>
          ))}
        </CardContent>
      </ScrollArea>
    </Card>
  )
}

export interface PasswordRecoveryCopy {
  title: string
  description?: string
  emailLabel: string
  emailPlaceholder: string
  actionLabel: string
  successTitle: string
  successMessage: string
}

export interface PasswordRecoveryViewProps {
  email: string
  onEmailChange: (email: string) => void
  onSubmit?: (email: string) => void | Promise<void>
  onRecover?: (email: string) => void | Promise<void>
  pending?: boolean
  status?: 'idle' | 'submitting' | 'success' | 'error'
  error?: string
  copy: PasswordRecoveryCopy
  frame?: 'card' | 'bare'
  showHeader?: boolean
}

export function PasswordRecoveryView({
  email,
  onEmailChange,
  onSubmit,
  onRecover,
  pending = false,
  status = 'idle',
  error,
  copy,
  frame = 'card',
  showHeader = true,
}: PasswordRecoveryViewProps) {
  const emailId = useId()
  const isPending = pending || status === 'submitting'
  const recover = onSubmit ?? onRecover
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isPending) void recover?.(email)
  }
  const body = (
    <>
      {showHeader ? (
        <CardHeader className={frame === 'bare' ? 'p-0 pb-4' : undefined}>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={frame === 'bare' ? 'p-0' : undefined}>
        {status === 'success' ? (
          <div role="status" aria-live="polite" className="space-y-2">
            <p className="font-medium text-foreground">{copy.successTitle}</p>
            <p className="text-sm text-muted-foreground">{copy.successMessage}</p>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={emailId}>{copy.emailLabel}</Label>
              <Input id={emailId} type="email" autoComplete="email" placeholder={copy.emailPlaceholder} value={email} disabled={isPending} onChange={(event) => onEmailChange(event.currentTarget.value)} />
            </div>
            {error ? <p role="alert" aria-live="polite" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={isPending || !email.trim() || !recover}>{isPending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}{copy.actionLabel}</Button>
          </form>
        )}
      </CardContent>
    </>
  )
  return (
    <AuxiliaryAuthFrame frame={frame} testId="password-recovery-scroll">
      {body}
    </AuxiliaryAuthFrame>
  )
}

export interface PasswordResetCopy {
  title: string
  description?: string
  passwordLabel: string
  passwordPlaceholder: string
  confirmationLabel: string
  confirmationPlaceholder: string
  actionLabel: string
  successMessage: string
  mismatchError: string
}

export interface PasswordResetViewProps {
  password: string
  confirmation: string
  onPasswordChange: (password: string) => void
  onConfirmationChange: (confirmation: string) => void
  onSubmit?: (values: { password: string; confirmation: string }) => void | Promise<void>
  onReset?: (values: { password: string; confirmation: string }) => void | Promise<void>
  pending?: boolean
  status?: 'idle' | 'submitting' | 'success' | 'error'
  error?: string
  copy: PasswordResetCopy
  frame?: 'card' | 'bare'
  showHeader?: boolean
}

export function PasswordResetView({
  password,
  confirmation,
  onPasswordChange,
  onConfirmationChange,
  onSubmit,
  onReset,
  pending = false,
  status = 'idle',
  error,
  copy,
  frame = 'card',
  showHeader = true,
}: PasswordResetViewProps) {
  const passwordId = useId()
  const confirmationId = useId()
  const isPending = pending || status === 'submitting'
  const reset = onSubmit ?? onReset
  const mismatch = password.length > 0 && password !== confirmation
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (isPending) return
    if (mismatch) {
      return
    }
    void reset?.({ password, confirmation })
  }
  const body = status === 'success' ? (
    <CardContent className={frame === 'bare' ? 'p-0' : undefined}>
      <p role="status" aria-live="polite">{copy.successMessage}</p>
    </CardContent>
  ) : (
    <>
      {showHeader ? (
        <CardHeader className={frame === 'bare' ? 'p-0 pb-4' : undefined}>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={frame === 'bare' ? 'p-0' : undefined}>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={passwordId}>{copy.passwordLabel}</Label>
            <Input id={passwordId} type="password" autoComplete="new-password" placeholder={copy.passwordPlaceholder} value={password} disabled={isPending} onChange={(event) => onPasswordChange(event.currentTarget.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={confirmationId}>{copy.confirmationLabel}</Label>
            <Input id={confirmationId} type="password" autoComplete="new-password" placeholder={copy.confirmationPlaceholder} value={confirmation} disabled={isPending} aria-invalid={mismatch ? true : undefined} onChange={(event) => onConfirmationChange(event.currentTarget.value)} />
          </div>
          {error ? <p role="alert" aria-live="polite" className="text-sm text-destructive">{error}</p> : null}
          {mismatch ? <p role="alert" aria-live="polite" className="text-sm text-destructive">{copy.mismatchError}</p> : null}
          <Button type="submit" className="w-full" disabled={isPending || !reset}>{isPending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}{copy.actionLabel}</Button>
        </form>
      </CardContent>
    </>
  )
  return (
    <AuxiliaryAuthFrame frame={frame} testId="password-reset-scroll">
      {body}
    </AuxiliaryAuthFrame>
  )
}
