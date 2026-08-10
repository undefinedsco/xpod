import { createContext, useContext } from 'react';
import type {
  StorageBinding,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import type { AccountAuthState } from '@undefineds.co/shared-ui';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

export interface XpodAuthAccountSource {
  accountState: AccountAuthState;
  isLoggedIn: boolean;
  identity?: SanitizedAccountIdentity;
  retry: () => Promise<void>;
  refetchControls: () => Promise<void>;
  logout: () => Promise<void>;
}

export interface XpodRouteReadiness {
  dashboard: boolean;
  localSettings: true;
  podSettings: boolean;
}

export interface XpodAuthValue {
  readonly account: XpodAuthAccountSource;
  readonly runtime?: XpodSolidRuntimeValue;
  readonly routes: readonly WebIdLoginRouteDescriptor[];
  readonly webIdState: WebIdAuthState;
  readonly readiness: XpodRouteReadiness;
  readonly selectedStorage?: StorageBinding;
  readonly startLogin: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  readonly retryLogin: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  readonly cancelLogin: () => void;
  readonly logout: () => Promise<void>;
}

export const XpodAuthContext = createContext<XpodAuthValue | null>(null);

export function useXpodAuth(): XpodAuthValue {
  const value = useContext(XpodAuthContext);
  if (!value) throw new Error('useXpodAuth must be used within XpodAuthProvider');
  return value;
}
