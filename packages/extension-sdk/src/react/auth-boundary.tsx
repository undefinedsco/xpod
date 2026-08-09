import { useId, useState, type ReactNode } from 'react'
import {
  ConnectHeader,
  ConnectSurface,
  LoginFailureView,
  LoginProviderListView,
  LoginRestoringView,
  LoginSpaceSelectionView,
  SolidConnectForm,
  type LoginProviderOption,
  type LoginSpaceProviders,
} from '@undefineds.co/shared-ui'

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
  providers?: LoginProviderOption[]
  spaceProviders?: LoginSpaceProviders
  providerListTitle?: string
  connectingProviderId?: string
  onAddProvider?: (url: string) => void
  onDismissError?: () => void
}

export interface AuthBoundaryProps {
  state: AuthBoundaryState
  login: (issuer: string) => void | Promise<void>
  children: ReactNode
  loginView?: Omit<LoginViewProps, 'error' | 'onLogin' | 'onDismissError'>
  restoringLabel?: string
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
  providers,
  spaceProviders,
  providerListTitle,
  connectingProviderId,
  onAddProvider,
  onDismissError,
}: LoginViewProps) {
  const titleId = useId()
  const [showProviderList, setShowProviderList] = useState(false)
  const usesProviderList = Boolean(providers?.length || onAddProvider)

  if (spaceProviders && !showProviderList) {
    return (
      <ConnectSurface labelledBy={titleId}>
        <LoginSpaceSelectionView
          productName={typeof title === 'string' ? title : 'Xpod'}
          logo={logo}
          providers={spaceProviders}
          error={error}
          onConnect={(providerId) => void onLogin(providerId)}
          onMoreProviders={usesProviderList ? () => setShowProviderList(true) : undefined}
          onDismissError={onDismissError}
        />
      </ConnectSurface>
    )
  }

  return (
    <ConnectSurface labelledBy={titleId}>
      <div className="flex flex-col gap-6">
        <ConnectHeader title={title} titleId={titleId} description={description} logo={logo} />
        {usesProviderList ? (
          <LoginProviderListView
            title={providerListTitle ?? '选择登录方式'}
            providers={providers ?? []}
            error={error}
            connectingId={connectingProviderId}
            onBack={spaceProviders ? () => setShowProviderList(false) : undefined}
            onConnect={(providerId) => void onLogin(providerId)}
            onAddProvider={onAddProvider}
            onDismissError={onDismissError}
          />
        ) : (
          <SolidConnectForm
            defaultIssuer={defaultIssuer}
            error={error}
            submitErrorMessage={safeLoginErrorMessage}
            onConnect={onLogin}
          />
        )}
      </div>
    </ConnectSurface>
  )
}

export function AuthBoundary({
  state,
  login,
  children,
  loginView,
  restoringLabel = '正在检查登录状态',
}: AuthBoundaryProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null)

  if (state.status === 'authenticated') {
    return <>{children}</>
  }

  if (state.status === 'loading') {
    return (
      <ConnectSurface>
        <LoginRestoringView label={`${restoringLabel}...`} />
      </ConnectSurface>
    )
  }

  const errorMessage = state.status === 'error' ? state.message : undefined

  if (errorMessage && dismissedError !== errorMessage) {
    const retryIssuer = loginView?.defaultIssuer ?? loginView?.providers?.[0]?.id
    return (
      <ConnectSurface>
        <LoginFailureView
          description={errorMessage}
          primaryLabel="重新登录"
          onPrimary={() => {
            if (retryIssuer) void login(retryIssuer)
          }}
          secondaryLabel="重新选择登录方式"
          onSecondary={() => setDismissedError(errorMessage)}
        />
      </ConnectSurface>
    )
  }

  return (
    <LoginView
      title={loginView?.title ?? defaultLoginTitle}
      description={loginView?.description}
      defaultIssuer={loginView?.defaultIssuer}
      logo={loginView?.logo}
      providers={loginView?.providers}
      spaceProviders={loginView?.spaceProviders}
      providerListTitle={loginView?.providerListTitle}
      connectingProviderId={loginView?.connectingProviderId}
      onAddProvider={loginView?.onAddProvider}
      onDismissError={() => setDismissedError(null)}
      error={errorMessage}
      onLogin={login}
    />
  )
}
