import { useState, type FormEvent, type ReactNode } from 'react'
import { formatCopy, resolvePodSignInCopy, type PodSignInCopy, type PodSignInLocale } from './copy'
import { IdpChrome } from './IdpChrome'
import {
  ActionButton,
  CheckboxRow,
  ScreenLayout,
  Disclosure,
  Field,
  fieldClass,
  outlineButtonClass,
  primaryButtonClass,
  textButtonClass,
} from './parts'
import { Input } from '../input'
import { cn } from '../utils'

/** Shared by every B-group view: which service's page this is, and the wording. */
export interface IdpViewCommonProps {
  /** Shown in the tinted top bar together with `serviceHost`. */
  serviceName?: string
  serviceHost?: string
  serviceIcon?: ReactNode
  locale?: PodSignInLocale
  copy?: Partial<PodSignInCopy>
}

function resolveIdpCopy({ locale, copy }: IdpViewCommonProps) {
  return resolvePodSignInCopy(locale, copy)
}

export function IdpFrameHeader({ serviceName = 'Xpod', serviceHost, serviceIcon, locale, copy }: IdpViewCommonProps) {
  return (
    <IdpChrome
      serviceName={serviceName}
      serviceHost={serviceHost}
      icon={serviceIcon}
      locale={locale}
      serviceLabel={copy?.serviceLabel}
    />
  )
}

const inputClass = fieldClass

/** A 36px text action: a real link when the host navigates to a page, otherwise a button. */
function TextAction({ href, onClick, disabled, className, children }: {
  href?: string
  onClick?(): void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const classes = cn(textButtonClass, 'inline-flex items-center text-primary hover:underline', className)
  return href && !disabled
    ? <a href={href} className={classes}>{children}</a>
    : <button type="button" className={classes} disabled={disabled} onClick={onClick}>{children}</button>
}

export interface IdpSignInViewProps extends IdpViewCommonProps {
  serviceName: string
  returnToAppName?: string
  /** Form-level failure, announced assertively. */
  error?: string
  fieldErrors?: { email?: string; password?: string }
  pending?: boolean
  remember: boolean
  /** Uncontrolled initial values (a previously used email, for instance). */
  defaultEmail?: string
  defaultPassword?: string
  /** Fires on every edit so a host can clear its own error state. */
  onFieldChange?(field: 'email' | 'password', value: string): void
  /** Shown only when the host offers a remember choice; omit to hide the checkbox. */
  onRememberChange?(value: boolean): void
  onSubmit(values: { email: string; password: string }): void
  /** Hidden when omitted. `forgotHref` renders a real link instead, for hosts that navigate to a page. */
  onForgot?(): void
  forgotHref?: string
  /** Hidden when omitted. `registerHref` renders a real link instead. */
  onRegister?(): void
  registerHref?: string
  onUseOtherSolid?(): void
}

/** B1: sign in to the sign-in service. Email and password only ever appear here. */
export function IdpSignInView(props: IdpSignInViewProps) {
  const {
    serviceName, returnToAppName, error, fieldErrors, pending = false, remember, defaultEmail = '', defaultPassword = '',
    onFieldChange, onRememberChange, onSubmit, onForgot, forgotHref, onRegister, registerHref, onUseOtherSolid,
  } = props
  const copy = resolveIdpCopy(props)
  const [email, setEmail] = useState(defaultEmail)
  const [password, setPassword] = useState(defaultPassword)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!pending) onSubmit({ email: email.trim(), password })
  }

  return (
    <ScreenLayout
      data-pod-sign-in-state="idp-sign-in"
      chrome={<IdpFrameHeader {...props} />}
      onSubmit={submit}
      actions={(
        <>
        {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
        <ActionButton type="submit" className={primaryButtonClass} busy={pending}>{copy.signIn}</ActionButton>
      <div className="flex items-center justify-between gap-2">
        {onRegister || registerHref ? (
          <span className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">{copy.noAccount}</span>
            <TextAction href={registerHref} disabled={pending} onClick={onRegister}>{copy.registerLink}</TextAction>
          </span>
        ) : <span />}
        {onUseOtherSolid ? (
          <button type="button" className={cn(textButtonClass, 'text-primary hover:underline')} disabled={pending} onClick={onUseOtherSolid}>
            {copy.useOtherSolid}
          </button>
        ) : null}
      </div>
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-foreground">{formatCopy(copy.signInTitle, { service: serviceName })}</h1>
        {returnToAppName ? (
          <p className="text-sm text-muted-foreground">{formatCopy(copy.returnToApp, { app: returnToAppName })}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        <Field label={copy.email} error={fieldErrors?.email}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              name="email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className={inputClass}
              value={email}
              disabled={pending}
              onChange={(event) => {
                setEmail(event.target.value)
                onFieldChange?.('email', event.target.value)
              }}
            />
          )}
        </Field>
        <Field
          label={copy.password}
          error={fieldErrors?.password}
          labelAside={onForgot || forgotHref ? (
            <TextAction className="h-7 text-[13px]" href={forgotHref} onClick={onForgot}>{copy.forgotPassword}</TextAction>
          ) : undefined}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              name="password"
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={password}
              disabled={pending}
              onChange={(event) => {
                setPassword(event.target.value)
                onFieldChange?.('password', event.target.value)
              }}
            />
          )}
        </Field>
        {onRememberChange ? (
          <CheckboxRow checked={remember} onChange={onRememberChange} label={copy.rememberDevice} disabled={pending} />
        ) : null}
      </div>
    </ScreenLayout>
  )
}

export interface IdpRegisterViewProps extends IdpViewCommonProps {
  serviceName: string
  returnToAppName?: string
  /** e.g. "将创建你的 WebID 和 Pod：pod.undefineds.co/xiaolin/" */
  usernamePreview?: string
  /** Decided by the service's CSS controls. */
  requireUsername: boolean
  fieldErrors?: Partial<Record<'username' | 'email' | 'password', string | undefined>>
  /** Form-level failure, announced assertively. */
  error?: string
  pending?: boolean
  defaultEmail?: string
  defaultPassword?: string
  defaultUsername?: string
  /** Fires on every edit so a host can check the name and clear its own errors. */
  onFieldChange?(field: 'username' | 'email' | 'password', value: string): void
  onSubmit(values: { username?: string; email: string; password: string }): void
  /** Hidden when omitted. */
  onSignIn?(): void
}

/** B2: register. The explicit form is what makes creating a WebID and Pod not implicit. */
export function IdpRegisterView(props: IdpRegisterViewProps) {
  const {
    serviceName, returnToAppName, usernamePreview, requireUsername, fieldErrors, error, pending = false,
    defaultEmail = '', defaultPassword = '', defaultUsername = '', onFieldChange, onSubmit, onSignIn,
  } = props
  const copy = resolveIdpCopy(props)
  const [username, setUsername] = useState(defaultUsername)
  const [email, setEmail] = useState(defaultEmail)
  const [password, setPassword] = useState(defaultPassword)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    onSubmit({
      ...(requireUsername ? { username: username.trim() } : {}),
      email: email.trim(),
      password,
    })
  }

  return (
    <ScreenLayout
      data-pod-sign-in-state="idp-register"
      chrome={<IdpFrameHeader {...props} />}
      onSubmit={submit}
      actions={(
        <>
        {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
        <ActionButton type="submit" className={primaryButtonClass} busy={pending}>{copy.registerSubmit}</ActionButton>
      {onSignIn ? (
        <button type="button" className={cn(textButtonClass, 'self-center text-primary hover:underline')} disabled={pending} onClick={onSignIn}>
          {copy.haveAccount}
        </button>
      ) : null}
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-foreground">{formatCopy(copy.registerTitle, { service: serviceName })}</h1>
        {returnToAppName ? (
          <p className="text-sm text-muted-foreground">{formatCopy(copy.returnToApp, { app: returnToAppName })}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-4">
        {requireUsername ? (
          <Field
            label={copy.username}
            error={fieldErrors?.username}
            hint={usernamePreview ? <span role="status" className="font-mono text-xs">{usernamePreview}</span> : undefined}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className={inputClass}
                value={username}
                disabled={pending}
                onChange={(event) => {
                  setUsername(event.target.value)
                  onFieldChange?.('username', event.target.value)
                }}
              />
            )}
          </Field>
        ) : null}
        <Field label={copy.email} error={fieldErrors?.email}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              name="email"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              className={inputClass}
              value={email}
              disabled={pending}
              onChange={(event) => {
                setEmail(event.target.value)
                onFieldChange?.('email', event.target.value)
              }}
            />
          )}
        </Field>
        <Field label={copy.password} error={fieldErrors?.password}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              name="password"
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={password}
              disabled={pending}
              onChange={(event) => {
                setPassword(event.target.value)
                onFieldChange?.('password', event.target.value)
              }}
            />
          )}
        </Field>
        <Disclosure summary={copy.podElsewhereSummary}>{copy.podElsewhereBody}</Disclosure>
      </div>
    </ScreenLayout>
  )
}

export interface IdpNoWebIdViewProps extends IdpViewCommonProps {
  appName: string
  /**
   * The name prefilled in the field. Omit it when the host cannot create a WebID
   * here: the name field is then not shown, and the primary action just calls `onCreate('')`.
   */
  defaultName?: string
  /** Live availability of the name; ok is announced politely, error assertively. */
  nameHint?: { tone: 'ok' | 'muted' | 'error'; text: string }
  /** Form-level failure (e.g. a creation request failed), assertive and not blocking a retry. */
  error?: string
  pending?: boolean
  /** Fired on every edit so the host can check availability live. */
  onNameChange?(name: string): void
  onCreate(name: string): void
  /** Hidden when omitted. */
  onChooseOtherLocation?(): void
}

/** B3: the account has no WebID. Create one here, or leave for the account page to store it elsewhere. */
export function IdpNoWebIdView(props: IdpNoWebIdViewProps) {
  const { appName, defaultName, nameHint, error, pending = false, onNameChange, onCreate, onChooseOtherLocation } = props
  const copy = resolveIdpCopy(props)
  const [name, setName] = useState(defaultName ?? '')
  const hasNameField = defaultName !== undefined
  const trimmed = name.trim()
  const canSubmit = !hasNameField || (Boolean(trimmed) && nameHint?.tone !== 'error')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!pending && canSubmit) onCreate(trimmed)
  }

  return (
    <ScreenLayout
      data-pod-sign-in-state="idp-no-webid"
      chrome={<IdpFrameHeader {...props} />}
      onSubmit={submit}
      actions={(
        <>
        {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
        <ActionButton type="submit" className={primaryButtonClass} busy={pending} disabled={!canSubmit}>
          {copy.createAndContinue}
        </ActionButton>
        {onChooseOtherLocation ? (
          <ActionButton type="button" variant="outline" className={outlineButtonClass} disabled={pending} onClick={onChooseOtherLocation}>
            {copy.chooseOtherLocation}
          </ActionButton>
        ) : null}
        </>
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-foreground">{copy.noWebIdTitle}</h1>
        <p className="text-sm leading-[22px] text-muted-foreground">{formatCopy(copy.noWebIdLead, { app: appName })}</p>
      </div>
      <div className="flex flex-col gap-4">
        {hasNameField ? (
          <Field
            label={copy.webIdName}
            error={nameHint?.tone === 'error' ? nameHint.text : undefined}
            hint={nameHint && nameHint.tone !== 'error'
              ? <span role="status">{nameHint.text}</span>
              : <span>{copy.noWebIdLocation}</span>}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                name="webIdName"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className={inputClass}
                value={name}
                disabled={pending}
                onChange={(event) => {
                  setName(event.target.value)
                  onNameChange?.(event.target.value)
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
    </ScreenLayout>
  )
}
