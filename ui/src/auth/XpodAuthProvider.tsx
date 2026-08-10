/* eslint-disable react-refresh/only-export-components */
import { useContext, useMemo, type ReactNode } from 'react';
import type {
  StorageBinding,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import { AuthProvider } from '../context/AuthContext';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import {
  XpodSolidRuntimeContext,
  type XpodSolidRuntimeCore,
  type XpodSolidRuntimeState,
  type XpodSolidRuntimeValue,
} from '../solid/XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from '../solid/XpodSolidRuntimeProvider';
import {
  createXpodLoginController,
  type XpodLoginControllerApi,
} from './XpodLoginController';
import { createXpodLoginRoute } from './xpod-login-route';
import {
  XpodAuthContext,
  type XpodAuthAccountSource,
  type XpodAuthValue,
  type XpodRouteReadiness,
} from './useXpodAuth';
import type { XpodLoginTransactionStore } from './xpod-login-transaction';

export interface XpodAuthProviderProps {
  children: ReactNode;
  account?: XpodAuthAccountSource;
  runtime?: XpodSolidRuntimeCore;
  transactionStore?: XpodLoginTransactionStore;
  selectedStorage?: StorageBinding;
  location?: Location | URL | string;
}

export interface CreateXpodAuthValueOptions {
  account: XpodAuthAccountSource;
  runtime?: Pick<XpodSolidRuntimeValue, 'state' | 'logout' | 'webId' | 'podUrl' | 'currentPod'>;
  routes?: readonly WebIdLoginRouteDescriptor[];
  startLogin: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  retryLogin?: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  cancelLogin?: () => void;
  selectedStorage?: StorageBinding;
}

export function XpodAuthProvider({
  children,
  account,
  runtime,
  transactionStore,
  selectedStorage,
  location,
}: XpodAuthProviderProps) {
  const ambientRuntime = useContext(XpodSolidRuntimeContext);
  const coordinator = (
    <XpodAuthCoordinator
      account={account}
      transactionStore={transactionStore}
      selectedStorage={selectedStorage}
      location={location}
    >
      {children}
    </XpodAuthCoordinator>
  );

  if (ambientRuntime) {
    return account ? coordinator : <AuthProvider>{coordinator}</AuthProvider>;
  }

  return account ? (
    <XpodSolidRuntimeProvider value={runtime}>{coordinator}</XpodSolidRuntimeProvider>
  ) : (
    <AuthProvider>
      <XpodSolidRuntimeProvider value={runtime}>{coordinator}</XpodSolidRuntimeProvider>
    </AuthProvider>
  );
}

function XpodAuthCoordinator({
  children,
  account: accountOverride,
  transactionStore,
  selectedStorage,
  location,
}: {
  children: ReactNode;
  account?: XpodAuthAccountSource;
  transactionStore?: XpodLoginTransactionStore;
  selectedStorage?: StorageBinding;
  location?: Location | URL | string;
}) {
  const authContext = useContext(AuthContext);
  const account = accountOverride ?? accountSourceFromContext(authContext);
  const runtime = useContext(XpodSolidRuntimeContext);
  if (!runtime) throw new Error('XpodAuthProvider requires XpodSolidRuntimeProvider');

  const controller = useMemo<XpodLoginControllerApi>(() => createXpodLoginController({
    runtime,
    transactionStore,
    location,
  }), [location, runtime, transactionStore]);
  const value = useMemo(() => createXpodAuthValue({
    account,
    runtime,
    routes: controller.routes,
    startLogin: controller.startLogin,
    retryLogin: controller.retryLogin,
    cancelLogin: controller.cancelLogin,
    selectedStorage,
  }), [account, controller, runtime, selectedStorage]);

  return (
    <XpodAuthContext.Provider value={value}>
      {children}
    </XpodAuthContext.Provider>
  );
}

export function createXpodAuthValue(options: CreateXpodAuthValueOptions): XpodAuthValue {
  const routes = [createXpodLoginRoute(typeof window === 'undefined' ? 'http://localhost' : window.location)];
  const selected = options.selectedStorage;
  const baseStartLogin = options.startLogin;
  const startLogin = async (returnTo?: string, selectedStorage?: StorageBinding) => {
    if (options.runtime?.state.status === 'authenticated' && !options.account.isLoggedIn) {
      try {
        options.cancelLogin?.();
      } catch {
        // A stale transaction may already have expired; logout still proceeds.
      }
      await options.runtime.logout();
    }
    return baseStartLogin(returnTo, selectedStorage);
  };
  const retryLogin = options.retryLogin
    ? async (returnTo?: string, selectedStorage?: StorageBinding) => {
      if (options.runtime?.state.status === 'authenticated' && !options.account.isLoggedIn) {
        try {
          options.cancelLogin?.();
        } catch {
          // A stale transaction may already have expired; logout still proceeds.
        }
        await options.runtime.logout();
      }
      return options.retryLogin?.(returnTo, selectedStorage);
    }
    : startLogin;
  const readiness = getXpodRouteReadiness({
    account: options.account,
    solidState: options.runtime?.state ?? { status: 'anonymous' },
    selectedStorage: selected,
  });
  const logout = async () => {
    if (options.runtime) await options.runtime.logout();
    await options.account.logout();
  };

  return {
    account: options.account,
    runtime: options.runtime as XpodSolidRuntimeValue | undefined,
    routes,
    webIdState: webIdStateFromRuntime(options.runtime?.state),
    readiness,
    selectedStorage: selected,
    startLogin,
    retryLogin,
    cancelLogin: options.cancelLogin ?? (() => undefined),
    logout,
  };
}

export function getXpodRouteReadiness({
  account,
  solidState,
  selectedStorage,
}: {
  account: Pick<XpodAuthAccountSource, 'isLoggedIn'>;
  solidState: XpodSolidRuntimeState;
  selectedStorage?: StorageBinding;
}): XpodRouteReadiness {
  const podSettings = solidState.status === 'authenticated'
    && Boolean(solidState.webId)
    && Boolean(selectedStorage)
    && selectedStorage?.webId === solidState.webId
    && (!solidState.podUrl || sameUrl(selectedStorage.storageUrl, solidState.podUrl));
  return {
    dashboard: account.isLoggedIn,
    localSettings: true,
    podSettings,
  };
}

function webIdStateFromRuntime(state?: XpodSolidRuntimeState): WebIdAuthState {
  if (!state || state.status === 'anonymous') return { status: 'anonymous' };
  if (state.status === 'loading') return { status: 'restoring' };
  if (state.status === 'expired') return { status: 'expired' };
  if (state.status === 'authenticated') return { status: 'authenticated', webId: state.webId };
  return { status: 'error', message: state.error.message };
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function accountSourceFromContext(context: AuthContextType | null): XpodAuthAccountSource {
  if (!context) throw new Error('XpodAuthProvider requires AuthProvider or an Account source');
  return {
    accountState: context.accountState,
    isLoggedIn: context.isLoggedIn,
    identity: context.identity,
    retry: context.retry,
    refetchControls: context.refetchControls,
    logout: context.logout,
  };
}
