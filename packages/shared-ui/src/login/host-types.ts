import type { ReactNode } from 'react'

export type LocalSpaceKind = 'local' | 'standalone'

export type LocalOnboardingState =
  | 'space_required'
  | 'idle'
  | 'checking'
  | 'starting'
  | 'repair_required'
  | 'ready'
  | 'error'

export interface LocalOnboardingCapabilities {
  supported: boolean
  contract: string | null
  baseUrl: string | null
  version: string | null
}

export interface LocalOnboardingProgress {
  phase: string
  label: string
  detail?: string | null
}

export type LocalOnboardingRouteKind = 'local' | 'public'

export interface LocalOnboardingRouteProbe {
  kind: LocalOnboardingRouteKind
  url: string | null
  reachable: boolean
  sameNode: boolean | null
  latencyMs: number | null
  baseUrl: string | null
  message: string | null
}

export interface LocalOnboardingConnectivity {
  status: 'unknown' | 'checking' | 'ready' | 'local-only' | 'failed' | 'mismatch'
  checkedAt: number | null
  local: LocalOnboardingRouteProbe | null
  public: LocalOnboardingRouteProbe | null
  message: string | null
}

export interface LocalOnboardingTunnel {
  provider: 'cloudflare' | null
  hasToken: boolean
  endpoint: string | null
}

export interface LocalOnboardingSnapshot {
  state: LocalOnboardingState
  spaceKind: LocalSpaceKind | null
  localUrl: string | null
  baseUrl: string | null
  publicUrl: string | null
  tunnel: LocalOnboardingTunnel | null
  connectivity: LocalOnboardingConnectivity | null
  capabilities: LocalOnboardingCapabilities | null
  cloudIdentityUrl: string | null
  provisionCode: string | null
  provisionUrl: string | null
  nodeId: string | null
  message: string | null
  progress?: LocalOnboardingProgress | null
  errorCode: string | null
  canRetry: boolean
  canOpenSettings: boolean
}

export interface StorageConflict {
  expectedStorageUrl: string
  actualStorageUrl: string | null
  storageProviderUrl: string | null
  managementUrl: string | null
  setupUrl?: string | null
  setupKind?: 'account-management' | 'create-pod'
}

export interface LoginModalHostProps {
  /** Presentational seam only; hosts supply their own product brand. */
  brand?: ReactNode
  /** Accessible dialog label for the login surface. */
  ariaLabel?: string
  /** Optional affordances. Omitted values preserve the complete LinX source UI. */
  capabilities?: {
    storageSelection?: boolean
    additionalProviders?: boolean
    providerAddition?: boolean
  }
  overlayClassName?: string
  cardClassName?: string
}
