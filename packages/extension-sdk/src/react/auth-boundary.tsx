import { useId, type ReactNode } from 'react'
import { ConnectHeader, ConnectSurface, SolidConnectForm } from '@undefineds.co/shared-ui'

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

const defaultLoginTitle = '连接 Solid Pod'
const safeLoginErrorMessage = '登录失败，请重试。'

export function LoginView({
  title,
  description,
  defaultIssuer = '',
  logo,
  error,
  onLogin,
}: LoginViewProps) {
  const titleId = useId()

  return (
    <ConnectSurface labelledBy={titleId}>
      <div className="flex flex-col gap-6">
        <ConnectHeader title={title} titleId={titleId} description={description} logo={logo} />
        <SolidConnectForm
          defaultIssuer={defaultIssuer}
          error={error}
          submitErrorMessage={safeLoginErrorMessage}
          onConnect={onLogin}
        />
      </div>
    </ConnectSurface>
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
      <ConnectSurface>
        <div
          className="flex flex-col items-center gap-3 text-center text-sm leading-6 text-muted-foreground"
          role="status"
          aria-label="认证状态"
        >
          <span className="h-8 w-8 rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
          <span>正在检查登录状态</span>
        </div>
      </ConnectSurface>
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
