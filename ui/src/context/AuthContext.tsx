import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storedAccountTokenHeaders, clearAccountSessionToken } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { AuthContext, type AccountAuthState, type Controls, type SanitizedAccountIdentity } from './AuthContextValue';
import { resolveXpodAccountIndex } from './resolve-xpod-account-index';

interface ControlsResponse {
  controls?: Controls;
}

const LOCAL_ACCOUNT_INDEX = '/.account/';

const ACCOUNT_ERROR_MESSAGE = 'Xpod 登录服务暂时不可用，请稍后重试。';
const ACCOUNT_CONTROLS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
// A lone 401/403 can be a transient blip while an OIDC flow re-establishes the
// account session. Confirm it with one delayed probe before discarding the
// stored credential, otherwise self-healing flows degrade into login loops.
const ACCOUNT_UNAUTHENTICATED_CONFIRM_DELAY_MS = 300;
const OIDC_PENDING_PROBE_TIMEOUT_MS = 3_000;

type FetchControlsResult = 'ok' | 'unauthenticated' | 'transient-error' | 'terminal-error' | 'stale';

function isAccountSpaPath(): boolean {
  if (typeof window === 'undefined') return false;
  const pathname = window.location.pathname;
  return pathname === '/.account' || pathname.startsWith('/.account/');
}

function accountIdentityFromControls(controls: Controls | null): SanitizedAccountIdentity | undefined {
  const account = controls?.account;
  if (!account) return undefined;
  // `controls.account.webId` is the CSS Account API endpoint used to manage
  // linked WebIDs, not the authenticated person's WebID. The latter belongs
  // to the independently restored Solid session.
  const identity = {
    ...(typeof account.id === 'string' ? { id: account.id } : {}),
    ...(typeof account.username === 'string' ? { username: account.username } : {}),
    ...(typeof account.displayName === 'string' ? { displayName: account.displayName } : {}),
  } satisfies SanitizedAccountIdentity;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function accountStateForControls(controls: Controls | null): AccountAuthState {
  if (controls?.account?.logout) return { status: 'authenticated' };
  return { status: 'anonymous', mode: 'login' };
}

function isTransientAccountControlsStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function transientAccountState(exposeError: boolean): AccountAuthState {
  return exposeError
    ? { status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE }
    : { status: 'initializing' };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [idpIndex, setIdpIndex] = useState<string>();
  const [controls, setControls] = useState<Controls | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [hasOidcPending, setHasOidcPending] = useState(false);
  const [accountState, setAccountState] = useState<AccountAuthState>({ status: 'initializing' });
  const pendingProbeIdRef = useRef(0);
  const mountedRef = useRef(true);
  const fetchGenerationRef = useRef(0);

  const isLoggedIn = accountState.status === 'authenticated';
  const authenticating = isInitializing || accountState.status === 'submitting';
  const isLoggedInRef = useRef(isLoggedIn);
  useEffect(() => {
    let active = true;
    void resolveXpodAccountIndex().then((accountIndex) => {
      if (active) setIdpIndex(accountIndex);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    isLoggedInRef.current = isLoggedIn;
  }, [isLoggedIn]);

  useEffect(() => {
    // React Strict Mode intentionally replays effects in development. Restore
    // the mounted flag on every setup so the second initialization is not
    // mistaken for work that completed after an unmount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchGenerationRef.current += 1;
    };
  }, []);

  const isFetchCurrent = useCallback((generation: number): boolean => {
    return mountedRef.current && generation === fetchGenerationRef.current;
  }, []);

  const checkOidcPending = useCallback(async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OIDC_PENDING_PROBE_TIMEOUT_MS);
    try {
      if (!idpIndex) return false;
      const res = await fetch(new URL('oidc/consent/', idpIndex), {
        headers: storedAccountTokenHeaders(),
        credentials: 'include',
        signal: controller.signal,
      });
      // If we get 200 and valid client info, there's an OIDC flow waiting
      if (res.ok) {
        const data = await res.json();
        return Boolean(data.client);
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }, [idpIndex]);

  const fetchControlsOnce = useCallback(async ({ exposeTransientError, generation, confirmUnauthenticated }: { exposeTransientError: boolean; generation: number; confirmUnauthenticated?: boolean }): Promise<FetchControlsResult> => {
    if (!idpIndex) return 'stale';
    try {
      const res = await fetch(idpIndex, { headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (!isFetchCurrent(generation)) return 'stale';
      if (res.ok) {
        const json = await res.json().catch(() => ({})) as ControlsResponse;
        if (!isFetchCurrent(generation)) return 'stale';
        const nextControls = json.controls || {};
        const probeId = ++pendingProbeIdRef.current;
        setHasOidcPending(false);
        setControls(nextControls);
        setInitError(null);
        const nextAccountState = accountStateForControls(nextControls);
        // Keep synchronous logout verification in lockstep with controls;
        // the React effect that mirrors isLoggedIn may not have run yet.
        isLoggedInRef.current = nextAccountState.status === 'authenticated';
        setAccountState(nextAccountState);

        // The controls response establishes Account authentication. Consent is
        // an optional OIDC continuation probe and must not delay that state.
        if (nextControls.account?.logout && isAccountSpaPath()) {
          void checkOidcPending().then((pending) => {
            if (isFetchCurrent(generation) && probeId === pendingProbeIdRef.current) setHasOidcPending(pending);
          });
        }
        return 'ok';
      } else {
        if (res.status === 401 || res.status === 403) {
          if (!confirmUnauthenticated) return 'unauthenticated';
          pendingProbeIdRef.current += 1;
          clearAccountSessionToken();
          isLoggedInRef.current = false;
          setHasOidcPending(false);
          setControls({});
          setAccountState({ status: 'anonymous', mode: 'login' });
          setInitError(null);
          return 'ok';
        }
        pendingProbeIdRef.current += 1;
        setHasOidcPending(false);
        if (isTransientAccountControlsStatus(res.status)) {
          setInitError(null);
          setAccountState((prev) => prev.status === 'authenticated'
            ? prev
            : transientAccountState(exposeTransientError));
          return 'transient-error';
        }
        const message = `Failed to load account controls (Status: ${res.status})`;
        setInitError(message);
        setAccountState({ status: 'error', mode: 'login', message });
        return 'terminal-error';
      }
    } catch {
      if (!isFetchCurrent(generation)) return 'stale';
      pendingProbeIdRef.current += 1;
      setHasOidcPending(false);
      setInitError(null);
      setAccountState((prev) => prev.status === 'authenticated'
        ? prev
        : transientAccountState(exposeTransientError));
      return 'transient-error';
    }
  }, [checkOidcPending, idpIndex, isFetchCurrent]);

  const fetchControls = useCallback(async (): Promise<FetchControlsResult> => {
    const generation = ++fetchGenerationRef.current;
    for (let attempt = 0; attempt <= ACCOUNT_CONTROLS_RETRY_DELAYS_MS.length; attempt += 1) {
      const finalAttempt = attempt === ACCOUNT_CONTROLS_RETRY_DELAYS_MS.length;
      const result = await fetchControlsOnce({ exposeTransientError: finalAttempt, generation });
      if (result === 'unauthenticated') {
        if (!isFetchCurrent(generation)) return 'stale';
        await wait(ACCOUNT_UNAUTHENTICATED_CONFIRM_DELAY_MS);
        if (!isFetchCurrent(generation)) return 'stale';
        return fetchControlsOnce({ exposeTransientError: true, generation, confirmUnauthenticated: true });
      }
      if (result !== 'transient-error') return result;
      if (!isFetchCurrent(generation)) return 'stale';
      if (!finalAttempt) {
        setAccountState((prev) => prev.status === 'authenticated' ? prev : { status: 'initializing' });
        await wait(ACCOUNT_CONTROLS_RETRY_DELAYS_MS[attempt]);
        if (!isFetchCurrent(generation)) return 'stale';
      }
    }
    return 'transient-error';
  }, [fetchControlsOnce, isFetchCurrent]);

  useEffect(() => {
    if (!idpIndex) return;
    let active = true;
    (async () => {
      await fetchControls();
      if (active && mountedRef.current) setIsInitializing(false);
    })();
    return () => {
      active = false;
    };
  }, [fetchControls, idpIndex]);

  const refetchControls = useCallback(async () => {
    await fetchControls();
  }, [fetchControls]);

  const logout = useCallback(async () => {
    const advertisedLogoutUrl = controls?.account?.logout;
    const logoutUrl = await resolveHostedAccountControlUrl(advertisedLogoutUrl, fetch, idpIndex);
    let failed = Boolean(advertisedLogoutUrl && !logoutUrl);
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
    // The host logout coordinator verifies this value immediately after the
    // logout promise settles, before React has necessarily flushed effects.
    isLoggedInRef.current = false;
    clearAccountSessionToken();
    setHasOidcPending(false);
    setControls({});
    setInitError(null);
    setAccountState({ status: 'anonymous', mode: 'login' });
  }, [controls?.account?.logout, idpIndex]);

  const identity = useMemo(() => accountIdentityFromControls(controls), [controls]);

  return (
    <AuthContext.Provider value={{
      controls,
      isInitializing,
      initError,
      idpIndex: idpIndex ?? LOCAL_ACCOUNT_INDEX,
      isLoggedIn,
      isAnonymous: () => !isLoggedInRef.current,
      authenticating,
      hasOidcPending,
      refetchControls,
      retry: refetchControls,
      logout,
      accountState,
      identity,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
