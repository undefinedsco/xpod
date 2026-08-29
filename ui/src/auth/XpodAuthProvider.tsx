/* eslint-disable react-refresh/only-export-components */
import { useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  SolidSessionSnapshot,
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
import {
  createXpodLogoutCoordinator,
  type XpodLogoutCoordinator,
} from './xpod-logout';
import { XpodDesktopIdentityBridge } from '../desktop/XpodDesktopIdentityBridge';
import { XpodRememberedLoginBridge } from './XpodRememberedLoginBridge';
import { clearRememberedXpodLogin } from './xpod-remembered-login';

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
  runtime?: Pick<XpodSolidRuntimeValue, 'state' | 'logout' | 'webId' | 'podUrl' | 'currentPod'> & {
    session?: Pick<XpodSolidRuntimeValue['session'], 'getSnapshot'>;
  };
  routes?: readonly WebIdLoginRouteDescriptor[];
  startLogin: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  retryLogin?: (returnTo?: string, selectedStorage?: StorageBinding) => Promise<WebIdLoginTransaction | void>;
  cancelLogin?: () => void;
  selectedStorage?: StorageBinding;
  logoutCoordinator?: XpodLogoutCoordinator;
  logoutState?: ReturnType<XpodLogoutCoordinator['getState']>;
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
    // NOTE: reusing an ambient runtime means XpodSolidRuntimeProvider lives
    // above this provider; if AuthProvider is nested any lower, the runtime's
    // AuthContext read stays null and Account-aware checks (e.g. storage
    // binding ownership) degrade to "not logged in". See the comment in
    // XpodSolidRuntimeProvider.
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

  // Keep one coordinator for this host. Its ports read the latest context via
  // a stable mutable closure, so rerenders do not construct a second
  // transaction or lose partial-failure evidence.
  const [ports] = useState(() => {
    let currentAccount = account;
    let currentRuntime = runtime;
    return {
      update(nextAccount: XpodAuthAccountSource, nextRuntime: XpodSolidRuntimeValue) {
        currentAccount = nextAccount;
        currentRuntime = nextRuntime;
      },
      account: {
        logout: async () => {
          await currentAccount.logout();
          await currentAccount.refetchControls();
        },
        verifyAnonymous: () => currentAccount.isAnonymous?.() ?? !currentAccount.isLoggedIn,
      },
      webId: {
        logout: () => currentRuntime.logout(),
        verifyAnonymous: () => currentRuntime.session.getSnapshot().status === 'anonymous',
      },
    };
  });
  useEffect(() => {
    ports.update(account, runtime);
  }, [account, ports, runtime]);
  const logoutCoordinator = useMemo<XpodLogoutCoordinator>(() => createXpodLogoutCoordinator(ports), [ports]);
  const logoutState = useSyncExternalStore(
    logoutCoordinator.subscribe,
    logoutCoordinator.getState,
    logoutCoordinator.getState,
  );

  const controller = useMemo<XpodLoginControllerApi>(() => createXpodLoginController({
    runtime,
    transactionStore,
    location,
  }), [location, runtime, transactionStore]);
  const activeSelectedStorage = selectedStorage ?? runtime.selectedStorage;
  const value = useMemo(() => createXpodAuthValue({
    account,
    runtime,
    routes: controller.routes,
    startLogin: controller.startLogin,
    retryLogin: controller.retryLogin,
    cancelLogin: controller.cancelLogin,
    selectedStorage: activeSelectedStorage,
    logoutCoordinator,
    logoutState,
  }), [account, activeSelectedStorage, controller, logoutCoordinator, logoutState, runtime]);

  return (
    <XpodAuthContext.Provider value={value}>
      <XpodDesktopIdentityBridge />
      <XpodRememberedLoginBridge />
      {children}
    </XpodAuthContext.Provider>
  );
}

export function createXpodAuthValue(options: CreateXpodAuthValueOptions): XpodAuthValue {
  const routes = options.routes && options.routes.length > 0
    ? options.routes
    : [createXpodLoginRoute(typeof window === 'undefined' ? 'http://localhost' : window.location)];
  const selected = options.selectedStorage;
  const baseStartLogin = options.startLogin;
  const logoutCoordinator = options.logoutCoordinator ?? createXpodLogoutCoordinator({
    account: {
      logout: async () => {
        await options.account.logout();
        await options.account.refetchControls();
      },
      verifyAnonymous: () => options.account.isAnonymous?.() ?? !options.account.isLoggedIn,
    },
    webId: {
      logout: () => options.runtime?.logout() ?? Promise.resolve(),
      verifyAnonymous: () => options.runtime?.session
        ? options.runtime.session.getSnapshot().status === 'anonymous'
        : options.runtime?.state.status !== 'authenticated',
    },
  });
  const clearStaleSession = async () => {
    try {
      options.cancelLogin?.();
    } catch {
      // A stale transaction may already have expired; logout still proceeds.
    }
    const staleLogout = await logoutCoordinator.logout();
    if (staleLogout.status !== 'complete') throw new Error('Existing Xpod session could not be cleared');
    // A completed transaction is terminal by design. Reset it before starting
    // a new login so the next logout can run both domain ports again.
    logoutCoordinator.reset();
  };
  const resetTerminalLogout = () => {
    if (logoutCoordinator.getState().status === 'complete') logoutCoordinator.reset();
  };
  const startLogin = async (returnTo?: string, selectedStorage?: StorageBinding) => {
    if (options.runtime?.state.status === 'authenticated' && !options.account.isLoggedIn) {
      await clearStaleSession();
    } else {
      resetTerminalLogout();
    }
    return baseStartLogin(returnTo, selectedStorage);
  };
  const retryLogin = options.retryLogin
    ? async (returnTo?: string, selectedStorage?: StorageBinding) => {
      if (options.runtime?.state.status === 'authenticated' && !options.account.isLoggedIn) {
        await clearStaleSession();
      } else {
        resetTerminalLogout();
      }
      return options.retryLogin?.(returnTo, selectedStorage);
    }
    : startLogin;
  const readiness = getXpodRouteReadiness({
    account: options.account,
    solidState: options.runtime?.state ?? { status: 'anonymous' },
    selectedStorage: selected,
  });
  const logout = () => logoutCoordinator.logout();
  const retryLogout = () => logoutCoordinator.retry();
  const switchAccount = async () => {
    const logoutState = await logoutCoordinator.logout();
    if (logoutState.status !== 'complete') return logoutState;
    logoutCoordinator.reset();
    clearRememberedXpodLogin();
    return logoutState;
  };

  return {
    account: options.account,
    runtime: options.runtime as XpodSolidRuntimeValue | undefined,
    routes,
    webIdState: webIdStateFromRuntime(options.runtime),
    readiness,
    selectedStorage: selected,
    startLogin,
    retryLogin,
    cancelLogin: options.cancelLogin ?? (() => undefined),
    logout,
    retryLogout,
    logoutState: options.logoutState ?? logoutCoordinator.getState(),
    logoutCoordinator,
    switchAccount,
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

function webIdStateFromRuntime(
  runtime?: CreateXpodAuthValueOptions['runtime'],
): WebIdAuthState {
  const sessionSnapshot = runtime?.session?.getSnapshot?.();
  if (sessionSnapshot) return webIdStateFromSessionSnapshot(sessionSnapshot);

  return webIdStateFromRuntimeState(runtime?.state);
}

function webIdStateFromSessionSnapshot(snapshot: SolidSessionSnapshot): WebIdAuthState {
  switch (snapshot.status) {
    case 'initializing':
      return { status: 'restoring' };
    case 'anonymous':
      return { status: 'anonymous' };
    case 'expired':
      return { status: 'expired' };
    case 'authenticated':
      return { status: 'authenticated', webId: snapshot.webId };
    case 'error':
      return { status: 'error', message: snapshot.error.message };
  }
}

function webIdStateFromRuntimeState(state?: XpodSolidRuntimeState): WebIdAuthState {
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
    isAnonymous: context.isAnonymous,
    identity: context.identity,
    retry: context.retry,
    refetchControls: context.refetchControls,
    logout: context.logout,
  };
}
