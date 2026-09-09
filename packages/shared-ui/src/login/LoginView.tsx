import type { ReactNode } from 'react'
import { cn } from '../utils'
import { LoginModal } from './LoginModal'
import type {
  AuthWindowStatus,
  ConnectingProviderInfo,
  LoginProviderOption,
  LoginModalProps,
  StoredAccount,
} from './types'

export type LoginViewState =
  | 'restoring'
  | 'idle'
  | 'connecting'
  | 'authenticated'
  | 'error'

export interface LoginViewActions {
  continue: () => void
  switchAccount: () => void
  connect: (providerId: string) => void
  cancel: () => void
  dismissError: () => void
}

/**
 * LinX-controlled authentication presentation. Xpod does not render this.
 *
 * `error` is idle-context copy, not a fifth product phase. Session creation,
 * restoration and Account/WebID composition belong to the host.
 */
export interface LoginViewProps {
  state: LoginViewState
  identity: StoredAccount | null
  error?: string | null
  restorable?: boolean
  providers: readonly LoginProviderOption[]
  brand?: ReactNode
  host?: 'document' | 'window'
  ariaLabel: string
  actions: LoginViewActions
  authWindowStatus?: AuthWindowStatus
  connectingProvider?: ConnectingProviderInfo | null
  allowAdditionalProviders?: boolean
  overlayClassName?: string
  cardClassName?: string
}

const CLOSED_AUTH_WINDOW: AuthWindowStatus = {
  open: false,
  reason: 'dismissed',
  ready: false,
}

export function LoginView({
  state,
  identity,
  error = null,
  restorable = false,
  providers,
  brand,
  host = 'document',
  ariaLabel,
  actions,
  authWindowStatus = CLOSED_AUTH_WINDOW,
  connectingProvider = null,
  allowAdditionalProviders = false,
  overlayClassName,
  cardClassName,
}: LoginViewProps) {
  if (state === 'authenticated') return null
  const windowHost = host === 'window'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={windowHost ? 'auth-surface-modal' : 'auth-surface-page'}
      data-auth-surface-host={windowHost ? 'window' : undefined}
      data-auth-view="controlled"
      className={cn(windowHost ? 'fixed inset-0 z-[100] bg-card' : 'contents')}
    >
      <LoginModal
        view="default"
        state={state as LoginModalProps['state']}
        error={error}
        storedAccount={identity}
        storageConflict={null}
        hasRestorableSession={restorable}
        providers={[...providers]}
        localOnboarding={null}
        localProviderSource="local"
        brand={brand}
        capabilities={{
          storageSelection: false,
          additionalProviders: allowAdditionalProviders,
          providerAddition: allowAdditionalProviders,
        }}
        overlayClassName={cn(
          windowHost && 'fixed inset-0 z-50 flex items-stretch justify-stretch overflow-hidden bg-card p-0',
          overlayClassName,
        )}
        cardClassName={cardClassName}
        authWindowStatus={authWindowStatus}
        connectingProvider={connectingProvider}
        onContinueStoredAccount={actions.continue}
        onSwitchAccount={actions.switchAccount}
        onConnect={actions.connect}
        onCancelConnecting={actions.cancel}
        onClearError={actions.dismissError}
        onAddProvider={() => undefined}
        onBackFromLocal={() => undefined}
        onContinueLocalLogin={() => undefined}
        onSaveLocalTunnelToken={() => undefined}
        onTestLocalConnectivity={() => undefined}
        onDismissStorageConflict={() => undefined}
        onOpenCurrentSpacePodSetup={() => undefined}
        localLoginStatus={{ active: false, message: null }}
      />
    </div>
  )
}
