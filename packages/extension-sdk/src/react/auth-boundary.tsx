import { useId, useState, type ReactNode } from 'react'
import {
  Button,
  ConnectHeader,
  ConnectSurface,
  Input,
  LoginProviderListView,
  LoginSpaceSelectionView,
  normalizeLoginProviderUrl,
  SolidConnectForm,
  type LoginProviderOption,
  type LoginSpaceProviders,
} from '@undefineds.co/shared-ui'
import type { WebIdAuthState, WebIdLoginRouteDescriptor } from '@undefineds.co/solid-sdk'
import { SolidAuthBoundary } from './solid-auth-boundary'

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

/**
 * Compatibility-only mapping for the pre-route AuthBoundary contract.
 * New hosts should render SolidAuthBoundary with opaque route ids directly;
 * this adapter maps legacy issuer/provider values to host actions without
 * exposing those values as route identifiers.
 */
interface LegacyRouteBinding {
  route: WebIdLoginRouteDescriptor
  loginValue: string
}

function legacyEndpoint(value: string, label: string): { url: string; label: string } {
  const candidate = value.trim()
  try {
    const normalized = /^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`
    return { url: new URL(normalized).href, label }
  } catch {
    return { url: 'https://legacy.invalid/', label }
  }
}

function legacyRouteBindings(loginView?: AuthBoundaryProps['loginView']): LegacyRouteBinding[] {
  const spaceProviders = loginView?.spaceProviders
    ? [loginView.spaceProviders.cloud, loginView.spaceProviders.local].filter(
      (provider): provider is LoginProviderOption => provider !== undefined,
    )
    : []
  const providers = spaceProviders.length > 0 ? spaceProviders : loginView?.providers ?? []
  if (providers.length === 0) {
    const loginValue = loginView?.defaultIssuer?.trim() || ''
    return [{
      route: {
        id: 'legacy-default',
        label: typeof loginView?.title === 'string' ? loginView.title : 'Solid login',
        identityProvider: legacyEndpoint(loginValue, 'Legacy identity provider'),
        availability: loginValue ? 'ready' : 'unavailable',
        ...(loginValue ? {} : { unavailableReason: 'No legacy identity provider was configured.' }),
      },
      loginValue,
    }]
  }

  return providers.map((provider, index) => ({
    route: {
      id: `legacy-provider-${index + 1}`,
      label: provider.label,
      ...(provider.subtitle === undefined ? {} : { description: provider.subtitle }),
      ...(provider.badge === undefined ? {} : { badge: provider.badge }),
      identityProvider: legacyEndpoint(provider.id, provider.label),
      availability: provider.disabled ? 'unavailable' : 'ready',
      ...(provider.disabled ? { unavailableReason: 'This provider is unavailable.' } : {}),
    },
    loginValue: provider.id,
  }))
}

function legacyStateToSolidState(
  state: AuthBoundaryState,
  bindings: readonly LegacyRouteBinding[],
): WebIdAuthState {
  switch (state.status) {
    case 'loading':
      return { status: 'restoring' }
    case 'anonymous':
      return { status: 'anonymous' }
    case 'authenticated':
      return { status: 'authenticated', webId: 'legacy' }
    case 'error':
      return {
        status: 'error',
        message: state.message,
        retryRouteId: bindings.length === 1 ? bindings[0]?.route.id : undefined,
      }
  }
}

function LegacyCustomProviderAffordance({
  onAddProvider,
}: {
  onAddProvider: (url: string) => void
}) {
  const [isAdding, setIsAdding] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [customUrlError, setCustomUrlError] = useState<string | null>(null)

  const handleAdd = () => {
    if (!customUrl.trim()) return
    try {
      onAddProvider(normalizeLoginProviderUrl(customUrl))
      setCustomUrl('')
      setCustomUrlError(null)
      setIsAdding(false)
    } catch {
      setCustomUrlError('Enter a valid provider URL.')
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
      {isAdding ? (
        <div className="space-y-2">
          <Input
            autoFocus
            type="url"
            aria-label="Provider URL"
            aria-invalid={customUrlError ? true : undefined}
            placeholder="https://example.com"
            value={customUrl}
            onChange={(event) => {
              setCustomUrl(event.target.value)
              setCustomUrlError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAdd()
            }}
          />
          {customUrlError ? <p role="alert" className="text-xs text-destructive">{customUrlError}</p> : null}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" onClick={handleAdd} disabled={!customUrl.trim()}>Connect</Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsAdding(false)
                setCustomUrl('')
                setCustomUrlError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="ghost" className="w-full" onClick={() => setIsAdding(true)}>
          Add provider
        </Button>
      )}
    </div>
  )
}

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
  const bindings = legacyRouteBindings(loginView)
  const solidState = legacyStateToSolidState(state, bindings)
  const loginByRoute = (routeId: string) => {
    const binding = bindings.find((candidate) => candidate.route.id === routeId)
    if (binding) void login(binding.loginValue)
  }

  return (
    <SolidAuthBoundary
      state={solidState}
      routes={bindings.map((binding) => binding.route)}
      onLogin={loginByRoute}
      onRetry={loginByRoute}
      auxiliary={state.status === 'anonymous' && loginView?.onAddProvider ? (
        <LegacyCustomProviderAffordance onAddProvider={loginView.onAddProvider} />
      ) : undefined}
      copy={{
        route: {
          title: typeof loginView?.title === 'string' ? loginView.title : defaultLoginTitle,
          description: typeof loginView?.description === 'string' ? loginView.description : undefined,
          restoringLabel: `${restoringLabel}...`,
          failureTitle: 'Sign-in failed',
        },
      }}
    >
      {children}
    </SolidAuthBoundary>
  )
}
