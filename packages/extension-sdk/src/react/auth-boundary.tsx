import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input } from '@undefineds.co/shared-ui'

export type AuthBoundaryState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated' }
  | { status: 'error'; message: string }

export interface LoginViewProps {
  title: ReactNode
  description?: ReactNode
  defaultIssuer?: string
  logo?: ReactNode
  error?: string
  onLogin: (issuer: string) => void | Promise<void>
}

export interface AuthBoundaryProps {
  state: AuthBoundaryState
  login: (issuer: string) => void | Promise<void>
  children: ReactNode
  loginView?: Omit<LoginViewProps, 'error' | 'onLogin'>
}

const defaultLoginTitle = 'Connect Solid Pod'
const safeLoginErrorMessage = '登录失败，请重试。'

function normalizeLoginError(): string {
  return safeLoginErrorMessage
}

function AuthSurface({
  children,
  labelledBy,
}: {
  children: ReactNode
  labelledBy?: string
}) {
  return (
    <section
      className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground"
      aria-labelledby={labelledBy}
      data-auth-boundary="surface"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-layout-content px-8 py-7 shadow-sm">
        {children}
      </div>
    </section>
  )
}

export function LoginView({
  title,
  description,
  defaultIssuer = '',
  logo,
  error,
  onLogin,
}: LoginViewProps) {
  const titleId = useId()
  const issuerId = useId()
  const errorId = useId()
  const [issuer, setIssuer] = useState(defaultIssuer)
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>()
  const normalizedIssuer = issuer.trim()
  const visibleError = submitError ?? error

  const describedBy = useMemo(() => (
    visibleError ? errorId : undefined
  ), [errorId, visibleError])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!normalizedIssuer || pending) {
      return
    }

    setPending(true)
    setSubmitError(undefined)

    try {
      await onLogin(normalizedIssuer)
    } catch {
      setSubmitError(normalizeLoginError())
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthSurface labelledBy={titleId}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 text-center">
          {logo ? (
            <div className="flex justify-center" aria-hidden="true">
              {logo}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <h1 id={titleId} className="text-2xl font-semibold leading-8 tracking-normal">
              {title}
            </h1>
            {description ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>

        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-2 text-left">
            <label className="text-sm font-medium leading-5 text-foreground" htmlFor={issuerId}>
              Solid issuer
            </label>
            <Input
              id={issuerId}
              value={issuer}
              disabled={pending}
              aria-describedby={describedBy}
              placeholder="https://solidcommunity.net"
              onChange={(event) => setIssuer(event.currentTarget.value)}
            />
          </div>

          {visibleError ? (
            <p
              id={errorId}
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-5 text-destructive"
              role="alert"
            >
              {visibleError}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={!normalizedIssuer || pending}
          >
            {pending ? '登录中...' : '登录'}
          </Button>
        </form>
      </div>
    </AuthSurface>
  )
}

export function AuthBoundary({
  state,
  login,
  children,
  loginView,
}: AuthBoundaryProps) {
  if (state.status === 'authenticated') {
    return <>{children}</>
  }

  if (state.status === 'loading') {
    return (
      <AuthSurface>
        <div
          className="flex flex-col items-center gap-3 text-center text-sm leading-6 text-muted-foreground"
          role="status"
          aria-label="认证状态"
        >
          <span className="h-8 w-8 rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
          <span>正在检查登录状态</span>
        </div>
      </AuthSurface>
    )
  }

  return (
    <LoginView
      title={loginView?.title ?? defaultLoginTitle}
      description={loginView?.description}
      defaultIssuer={loginView?.defaultIssuer}
      logo={loginView?.logo}
      error={state.status === 'error' ? state.message : undefined}
      onLogin={login}
    />
  )
}
