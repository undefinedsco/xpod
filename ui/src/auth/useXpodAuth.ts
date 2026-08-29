import { createContext, useContext } from 'react';
import type {
  StorageBinding,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import type { AccountAuthState, SanitizedAccountIdentity } from '../context/AuthContextValue';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import type { XpodLogoutCoordinator, XpodLogoutState } from './xpod-logout';

export interface XpodAuthAccountSource {
  accountState: AccountAuthState;
  isLoggedIn: boolean;
  isAnonymous?: () => boolean;
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
  readonly logout: () => Promise<XpodLogoutState>;
  readonly retryLogout: () => Promise<XpodLogoutState>;
  readonly logoutState: XpodLogoutState;
  readonly logoutCoordinator: XpodLogoutCoordinator;
  readonly switchAccount: () => Promise<XpodLogoutState>;
}

export const XpodAuthContext = createContext<XpodAuthValue | null>(null);

export function useXpodAuth(): XpodAuthValue {
  const value = useContext(XpodAuthContext);
  if (!value) throw new Error('useXpodAuth must be used within XpodAuthProvider');
  return value;
}
