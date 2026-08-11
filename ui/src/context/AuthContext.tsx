import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storedAccountTokenHeaders, clearAccountSessionToken } from '../utils/account-session';
import { AuthContext, type AccountAuthState, type Controls, type SanitizedAccountIdentity } from './AuthContextValue';

interface ControlsResponse {
  controls?: Controls;
}

const IDP_INDEX = '/.account/';

const ACCOUNT_ERROR_MESSAGE = 'Account service is temporarily unavailable. Please try again.';

function accountIdentityFromControls(controls: Controls | null): SanitizedAccountIdentity | undefined {
  const account = controls?.account;
  if (!account) return undefined;
  const identity = {
    ...(typeof account.id === 'string' ? { id: account.id } : {}),
    ...(typeof account.username === 'string' ? { username: account.username } : {}),
    ...(typeof account.displayName === 'string' ? { displayName: account.displayName } : {}),
    ...(typeof account.webId === 'string' ? { webId: account.webId } : {}),
  } satisfies SanitizedAccountIdentity;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function accountStateForControls(controls: Controls | null): AccountAuthState {
  if (controls?.account?.logout) return { status: 'authenticated' };
  return { status: 'anonymous', mode: 'login' };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Pure SPA mode: No server-side injection.
  // We assume the IDP index is always at '/.account/' relative to the domain root.
  const idpIndex = IDP_INDEX;
  const [controls, setControls] = useState<Controls | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [hasOidcPending, setHasOidcPending] = useState(false);
  const [accountState, setAccountState] = useState<AccountAuthState>({ status: 'initializing' });

  const isLoggedIn = accountState.status === 'authenticated';
  const authenticating = isInitializing || accountState.status === 'submitting';
  const isLoggedInRef = useRef(isLoggedIn);
  useEffect(() => {
    isLoggedInRef.current = isLoggedIn;
  }, [isLoggedIn]);

  const checkOidcPending = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/.account/oidc/consent/', {
        headers: storedAccountTokenHeaders(),
        credentials: 'include',
      });
      // If we get 200 and valid client info, there's an OIDC flow waiting
      if (res.ok) {
        const data = await res.json();
        return Boolean(data.client);
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const fetchControls = useCallback(async () => {
    try {
      const res = await fetch(idpIndex, { headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        const json = await res.json().catch(() => ({})) as ControlsResponse;
        
        // If user is logged in, check if there's an OIDC flow waiting BEFORE setting state
        // This ensures hasOidcPending is set before isLoggedIn becomes true
        let pending = false;
        if (json.controls?.account?.logout) {
          pending = await checkOidcPending();
        }
        
        // Set both states together to avoid race condition
        const nextControls = json.controls || {};
        setHasOidcPending(pending);
        setControls(nextControls);
        setInitError(null);
        setAccountState(accountStateForControls(nextControls));
      } else {
        if (res.status === 401 || res.status === 403) {
          clearAccountSessionToken();
          setHasOidcPending(false);
          setControls({});
          setAccountState({ status: 'anonymous', mode: 'login' });
          setInitError(null);
          return;
        }
        const message = res.status === 502
          ? ACCOUNT_ERROR_MESSAGE
          : `Failed to load account controls (Status: ${res.status})`;
        setInitError(res.status === 502 ? null : message);
        setAccountState({ status: 'error', mode: 'login', message });
      }
    } catch {
      setInitError(null);
      setAccountState({ status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE });
    }
  }, [checkOidcPending, idpIndex]);

  useEffect(() => {
    (async () => {
      await fetchControls();
      setIsInitializing(false);
    })();
  }, [fetchControls]);

  const refetchControls = useCallback(async () => {
    await fetchControls();
  }, [fetchControls]);

  const logout = useCallback(async () => {
    const logoutUrl = controls?.account?.logout;
    let failed = false;
    if (logoutUrl) {
      try {
        const response = await fetch(logoutUrl, {
          method: 'POST',
          headers: storedAccountTokenHeaders(),
          credentials: 'include',
        });
        failed = !response.ok && response.status !== 401 && response.status !== 403;
      } catch {
        failed = true;
      }
    }
    if (failed) {
      // Keep the controls/token available for a deterministic retry. The
      // host logout coordinator must not claim Account success before the CSS
      // controls verify an anonymous session.
      setAccountState({ status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE });
      return;
    }
    clearAccountSessionToken();
    setHasOidcPending(false);
    setControls({});
    setInitError(null);
    setAccountState({ status: 'anonymous', mode: 'login' });
  }, [controls?.account?.logout]);

  const identity = useMemo(() => accountIdentityFromControls(controls), [controls]);

  return (
    <AuthContext.Provider value={{
      controls,
      isInitializing,
      initError,
      idpIndex,
      isLoggedIn,
      isAnonymous: () => !isLoggedInRef.current,
      authenticating,
      hasOidcPending,
      refetchControls,
      retry: refetchControls,
      logout,
      accountState,
      accountAuthState: accountState,
      authState: accountState,
      state: accountState,
      identity,
      accountIdentity: identity,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
