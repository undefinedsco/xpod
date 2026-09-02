import type { LoginState, StoredAccount, ProviderOption } from '@undefineds.co/solid-sdk/login-store'
import type { LocalSpaceKind, LocalOnboardingSnapshot, LocalOnboardingState } from './host-types'
import type { StorageConflict, LoginModalHostProps } from './host-types'
export type { LoginState, StoredAccount, ProviderOption }

export interface LocalPodRuntime {
  kind: 'local-pod'
  providerId?: string
  status: 'running' | 'starting' | 'stopped' | 'error' | 'missing'
  canStart: boolean
  canCreate: boolean
  onboarding?: {
    state: LocalOnboardingState
    spaceKind: LocalSpaceKind | null
    message: string | null
  }
}

export type LoginProviderSource = 'cloud' | 'custom' | 'local' | 'standalone'
export type LocalLoginProviderSource = Extract<LoginProviderSource, 'local' | 'standalone'>
export type LoginEndpointKind = 'cloud' | 'custom' | 'local'

export interface LoginEndpoint {
  kind: LoginEndpointKind
  url: string
  label: string
}

export interface LoginProviderOption extends ProviderOption {
  source: LoginProviderSource
  oidcProvider: LoginEndpoint
  storageProvider: LoginEndpoint
  runtime?: LocalPodRuntime
}

export interface LocalLoginStatus {
  active: boolean
  message: string | null
}

export interface AuthWindowStatus {
  open: boolean
  reason: 'opened' | 'completed' | 'dismissed'
  ready: boolean
}

export interface ConnectingProviderInfo {
  issuerLabel: string
  issuerUrl: string
  storageProviderLabel: string
  storageProviderUrl: string
}

export interface LoginModalProps extends LoginModalHostProps {
  view: 'default' | 'local'
  state: LoginState
  error: string | null
  storedAccount: StoredAccount | null
  storageConflict: StorageConflict | null
  hasRestorableSession: boolean
  providers: LoginProviderOption[]
  localOnboarding: LocalOnboardingSnapshot | null
  localProviderSource: LocalLoginProviderSource
  onBackFromLocal: () => void
  onContinueLocalLogin: () => void
  /** Host-owned desktop/settings action; the shared modal knows no product bridge. */
  onOpenLocalSettings?: () => void
  onSaveLocalTunnelToken: (token: string) => Promise<void> | void
  onTestLocalConnectivity: () => Promise<void> | void
  onSwitchAccount: () => void
  onContinueStoredAccount: () => void
  onConnect: (providerKey: string) => void
  onCancelConnecting: () => void
  onAddProvider: (url: string, label?: string) => void
  onClearError: () => void
  onDismissStorageConflict: () => void
  onOpenCurrentSpacePodSetup: () => void
  localLoginStatus: LocalLoginStatus
  authWindowStatus: AuthWindowStatus
  connectingProvider: ConnectingProviderInfo | null
}

export type {
  LocalSpaceKind,
  LocalOnboardingState,
  LocalOnboardingCapabilities,
  LocalOnboardingProgress,
  LocalOnboardingRouteKind,
  LocalOnboardingRouteProbe,
  LocalOnboardingConnectivity,
  LocalOnboardingTunnel,
  LocalOnboardingSnapshot,
  StorageConflict,
  LoginModalHostProps,
} from './host-types'
