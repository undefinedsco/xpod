import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { Badge } from './badge'
import { Button } from './button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'
import { Input } from './input'
import { Label } from './label'
import { ScrollArea } from './scroll-area'
import type { AuthSurfaceMode } from './auth-surface'

export type { AuthSurfaceMode }

export type AccountAuthMode = 'login' | 'register' | 'recovery' | 'reset'

export type AccountAuthState =
  | { status: 'initializing' }
  | { status: 'anonymous'; mode: AccountAuthMode }
  | { status: 'submitting'; mode: AccountAuthMode }
  | { status: 'authenticated' }
  | { status: 'error'; mode: AccountAuthMode; message: string }

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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="account-credentials-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>{isRegister ? copy.registerTitle : copy.loginTitle}</CardTitle>
          <CardDescription>{copy.productName}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isRegister ? (
            <div className="space-y-2">
              <Label htmlFor={usernameId}>{copy.usernameLabel}</Label>
              <Input
                id={usernameId}
                name="username"
                autoComplete="username"
                placeholder={copy.usernamePlaceholder}
                value={values.username ?? ''}
                disabled={pending}
                aria-invalid={errors?.username ? true : undefined}
                aria-describedby={errors?.username ? `${usernameId}-error` : undefined}
                onKeyDown={handleKeyDown}
                onChange={(event) => setCredentialValue(values, 'username', event.currentTarget.value, onChange, onFieldChange)}
              />
              <FieldError id={`${usernameId}-error`} message={errors?.username} />
              {availability === 'checking' ? (
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  <Loader2 aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                  {copy.usernameChecking}
                </p>
              ) : null}
              {availability === 'available' ? (
                <p aria-live="polite" className="flex items-center gap-1 text-sm text-primary">
                  <Check aria-hidden="true" className="h-4 w-4" />
                  {copy.usernameAvailable}
                </p>
              ) : null}
              {availability === 'unavailable' && !errors?.username ? (
                <p aria-live="polite" className="text-sm text-destructive">{typeof usernameAvailability === 'object' && usernameAvailability.message ? usernameAvailability.message : copy.usernameUnavailable}</p>
              ) : null}
              {usernameSuggestions.length > 0 ? (
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

          <div className="space-y-2">
            <Label htmlFor={emailId}>{copy.emailLabel}</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              placeholder={copy.emailPlaceholder}
              value={values.email ?? ''}
              disabled={pending}
              aria-invalid={errors?.email ? true : undefined}
              aria-describedby={errors?.email ? `${emailId}-error` : undefined}
              onKeyDown={handleKeyDown}
              onChange={(event) => setCredentialValue(values, 'email', event.currentTarget.value, onChange, onFieldChange)}
            />
            <FieldError id={`${emailId}-error`} message={errors?.email} />
          </div>

          <div className="space-y-2">
            <Label htmlFor={passwordId}>{copy.passwordLabel}</Label>
            <Input
              id={passwordId}
              name="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={copy.passwordPlaceholder}
              value={values.password}
              disabled={pending}
              aria-invalid={errors?.password ? true : undefined}
              aria-describedby={errors?.password ? `${passwordId}-error` : undefined}
              onKeyDown={handleKeyDown}
              onChange={(event) => setCredentialValue(values, 'password', event.currentTarget.value, onChange, onFieldChange)}
            />
            <FieldError id={`${passwordId}-error`} message={errors?.password} />
          </div>

          {isRegister ? (
            <div className="space-y-2">
              <Label htmlFor={confirmationId}>{copy.confirmationLabel}</Label>
              <Input
                id={confirmationId}
                name="confirmation"
                type="password"
                autoComplete="new-password"
                placeholder={copy.confirmationPlaceholder}
                value={values.confirmation ?? ''}
                disabled={pending}
                aria-invalid={visibleMismatch || errors?.confirmation ? true : undefined}
                aria-describedby={visibleMismatch || errors?.confirmation ? `${confirmationId}-error` : undefined}
                onKeyDown={handleKeyDown}
                onChange={(event) => {
                  setSubmittedMismatch(false)
                  setCredentialValue(values, 'confirmation', event.currentTarget.value, onChange, onFieldChange)
                }}
              />
              <FieldError id={`${confirmationId}-error`} message={visibleMismatch ?? errors?.confirmation} />
            </div>
          ) : null}

          <FieldError id={formErrorId} message={errors?.form} />

          <form onSubmit={submit} className="space-y-3">
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
              {submitLabel}
            </Button>
            {onModeChange ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={pending}
                onClick={() => onModeChange(isRegister ? 'login' : 'register')}
              >
                {isRegister ? copy.switchToLogin : copy.switchToRegister}
              </Button>
            ) : null}
          </form>
        </CardContent>
      </ScrollArea>
    </Card>
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
}: PasswordRecoveryViewProps) {
  const emailId = useId()
  const isPending = pending || status === 'submitting'
  const recover = onSubmit ?? onRecover
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isPending) void recover?.(email)
  }
  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="password-recovery-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
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
      </ScrollArea>
    </Card>
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
  if (status === 'success') {
    return (
      <Card className="w-full border-border bg-card text-card-foreground">
        <ScrollArea data-testid="password-reset-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
          <CardContent><p role="status" aria-live="polite">{copy.successMessage}</p></CardContent>
        </ScrollArea>
      </Card>
    )
  }
  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="password-reset-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={passwordId}>{copy.passwordLabel}</Label>
              <Input id={passwordId} type="password" autoComplete="new-password" placeholder={copy.passwordPlaceholder} value={password} disabled={isPending} onChange={(event) => onPasswordChange(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={confirmationId}>{copy.confirmationLabel}</Label>
              <Input id={confirmationId} type="password" autoComplete="new-password" placeholder={copy.confirmationPlaceholder} value={confirmation} disabled={isPending} aria-invalid={mismatch ? true : undefined} onChange={(event) => onConfirmationChange(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }} />
            </div>
            {error ? <p role="alert" aria-live="polite" className="text-sm text-destructive">{error}</p> : null}
            {mismatch ? <p role="alert" aria-live="polite" className="text-sm text-destructive">{copy.mismatchError}</p> : null}
            <Button type="submit" className="w-full" disabled={isPending || !reset}>{isPending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}{copy.actionLabel}</Button>
          </form>
        </CardContent>
      </ScrollArea>
    </Card>
  )
}
