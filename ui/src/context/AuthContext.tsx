import { scopeAccountUrl } from '../utils/account-interaction-url';
import { createSessionAccountFetch } from '../auth/session-account-controls';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bindAccountSessionAuthority, storedAccountTokenHeaders, clearAccountSessionToken, getAccountSessionToken } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { AuthContext, type AccountAuthState, type Controls, type SanitizedAccountIdentity, type AccountSessionTransport } from './AuthContextValue';
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
  const accountIndexRef = useRef<string | undefined>(undefined);
  const controlsRef = useRef<Controls | null>(null);
  // Only server controls or completed logout confirm anonymity.
  const isAnonymousRef = useRef(false);
  const sessionTransportRef = useRef<AccountSessionTransport | undefined>(undefined);
  const controlsTransportRef = useRef<AccountSessionTransport | undefined>(undefined);
  const suppressedTransportRef = useRef<AccountSessionTransport | undefined>(undefined);
  const [sessionTransportVersion, setSessionTransportVersion] = useState(0);

  const accountControlsTokenRef = useRef<string | undefined>(undefined);
  const accountCapabilityEpochRef = useRef(0);
  const accountLogoutOperationsRef = useRef(0);
  const accountCapabilityRevokedRef = useRef(false);
  const accountBinding = useCallback(() => {
    const account = controlsRef.current?.account;
    return account?.logout ? JSON.stringify([
      accountIndexRef.current, account.id, account.logout, account.clientCredentials,
    ]) : undefined;
  }, []);
  const revokeAccountCapabilities = useCallback(() => {
    accountCapabilityEpochRef.current += 1;
    accountCapabilityRevokedRef.current = true;
  }, []);
  const acceptControls = useCallback((next: Controls | null, token?: string, transport?: AccountSessionTransport) => {
    const previous = accountBinding();
    const previousToken = accountControlsTokenRef.current;
    const previousTransport = controlsTransportRef.current;
    controlsRef.current = next;
    accountControlsTokenRef.current = token;
    controlsTransportRef.current = transport;
    if (previous !== accountBinding() || previousToken !== token || previousTransport !== transport) revokeAccountCapabilities();
    accountCapabilityRevokedRef.current = !accountBinding();
  }, [accountBinding, revokeAccountCapabilities]);
  const bindAccountCapability = useCallback(() => {
    const binding = accountBinding();
    const epoch = accountCapabilityEpochRef.current;
    const token = getAccountSessionToken();
    const transport = controlsTransportRef.current;
    let valid = Boolean(binding) && token === accountControlsTokenRef.current && !accountCapabilityRevokedRef.current && accountLogoutOperationsRef.current === 0;
    return () => {
      if (transport) {
        try {
          if (transport !== sessionTransportRef.current || transport !== controlsTransportRef.current) throw new Error('Stale Account source');
          transport.assertCurrent();
        } catch { valid = false; }
      }
      if (!valid || !mountedRef.current || accountCapabilityRevokedRef.current || accountLogoutOperationsRef.current > 0
        || epoch !== accountCapabilityEpochRef.current || binding !== accountBinding() || token !== getAccountSessionToken()) {
        valid = false;
        throw new Error('Account 登录状态已改变，请重新打开客户端凭据操作。');
      }
    };
  }, [accountBinding]);

  const registerAccountSession = useCallback((transport: AccountSessionTransport) => {
    const invalidate = () => {
      // A Cookie-authenticated Account is an independent actor. SDK changes
      // must not restart its controls or overwrite logout failure/retry state.
      if (controlsRef.current?.account?.logout && !controlsTransportRef.current) return;
      fetchGenerationRef.current += 1;
      if (controlsTransportRef.current || (!controlsRef.current?.account?.logout && sessionTransportRef.current)) {
        acceptControls(null);
        setControls(null);
        isAnonymousRef.current = false;
        setAccountState({ status: 'initializing' });
        setIsInitializing(true);
      }
      setSessionTransportVersion((version) => version + 1);
    };
    sessionTransportRef.current = transport;
    invalidate();
    return () => {
      if (sessionTransportRef.current !== transport) return;
      sessionTransportRef.current = undefined;
      invalidate();
    };
  }, [acceptControls]);

  const accountFetch = useCallback<typeof fetch>(async (input, init) => {
    const index = accountIndexRef.current;
    const url = new URL(input instanceof Request ? input.url : String(input), index);
    if (!index || url.origin !== new URL(index).origin || !url.pathname.startsWith('/.account/')
      || url.username || url.password) throw new Error('Account request outside current authority');
    const assertCurrent = bindAccountCapability();
    const transport = controlsTransportRef.current;
    assertCurrent();
    const sourceFetch = transport
      ? createSessionAccountFetch({ accountIndex: index, fetch: transport.fetch, assertCurrent })
      : fetch;
    const response = await sourceFetch(input instanceof Request ? input : url.href, { ...init, redirect: 'error' });
    try { assertCurrent(); } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  }, [bindAccountCapability]);

  const isLoggedIn = accountState.status === 'authenticated';
  const authenticating = isInitializing || accountState.status === 'submitting';

  const acceptAccountIndex = useCallback((accountIndex: string) => {
    const bridgeChanged = bindAccountSessionAuthority(accountIndex);
    if (bridgeChanged || (accountIndexRef.current && accountIndexRef.current !== accountIndex)) {
      fetchGenerationRef.current += 1;
      pendingProbeIdRef.current += 1;
      isAnonymousRef.current = false;
      acceptControls(null);
      setControls(null);
      setHasOidcPending(false);
      setAccountState({ status: 'initializing' });
    }
    accountIndexRef.current = accountIndex;
    setIdpIndex(accountIndex);
  }, [acceptControls]);

  const retryAccountIndex = useCallback(async (): Promise<string | undefined> => {
    setIsInitializing(true);
    setInitError(null);
    setAccountState((prev) => prev.status === 'authenticated' ? prev : { status: 'initializing' });
    try {
      const accountIndex = await resolveXpodAccountIndex();
      if (!mountedRef.current) return undefined;
      acceptAccountIndex(accountIndex);
      return accountIndex;
    } catch {
      if (!mountedRef.current) return undefined;
      acceptControls(null);
      setControls(null);
      setHasOidcPending(false);
      setInitError(ACCOUNT_ERROR_MESSAGE);
      setAccountState({ status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE });
      setIsInitializing(false);
      return undefined;
    }
  }, [acceptAccountIndex, acceptControls]);

  useEffect(() => {
    let active = true;
    void resolveXpodAccountIndex().then((accountIndex) => {
      if (active && mountedRef.current) acceptAccountIndex(accountIndex);
    }).catch(() => {
      if (!active || !mountedRef.current) return;
      acceptControls(null);
      setControls(null);
      setHasOidcPending(false);
      setInitError(ACCOUNT_ERROR_MESSAGE);
      setAccountState({ status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE });
      setIsInitializing(false);
    });
    return () => {
      active = false;
    };
  }, [acceptAccountIndex, acceptControls]);

  useEffect(() => {
    // React Strict Mode intentionally replays effects in development. Restore
    // the mounted flag on every setup so the second initialization is not
    // mistaken for work that completed after an unmount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revokeAccountCapabilities();
      fetchGenerationRef.current += 1;
    };
  }, [revokeAccountCapabilities]);

  const isFetchCurrent = useCallback((generation: number): boolean => {
    return mountedRef.current && generation === fetchGenerationRef.current;
  }, []);

  const checkOidcPending = useCallback(async (): Promise<boolean> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OIDC_PENDING_PROBE_TIMEOUT_MS);
    try {
      const idpIndex = accountIndexRef.current;
      if (!idpIndex) return false;
      const res = await fetch(scopeAccountUrl(new URL('oidc/consent/', idpIndex)), {
        headers: storedAccountTokenHeaders(undefined, idpIndex),
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
  }, []);

  const fetchControlsOnce = useCallback(async ({ exposeTransientError, generation, confirmUnauthenticated }: { exposeTransientError: boolean; generation: number; confirmUnauthenticated?: boolean }): Promise<FetchControlsResult> => {
    const idpIndex = accountIndexRef.current;
    if (!idpIndex) return 'stale';
    const requestToken = getAccountSessionToken();
    const tokenIsCurrent = () => {
      if (requestToken === getAccountSessionToken()) return true;
      revokeAccountCapabilities();
      return false;
    };
    try {
      const res = await fetch(scopeAccountUrl(idpIndex), { headers: storedAccountTokenHeaders(undefined, idpIndex), credentials: 'include' });
      if (!isFetchCurrent(generation)) return 'stale';
      if (!tokenIsCurrent()) return 'transient-error';
      if (res.ok) {
        const json = await res.json() as ControlsResponse | null;
        if (!isFetchCurrent(generation)) return 'stale';
        if (!tokenIsCurrent()) return 'transient-error';
        if (!json?.controls || typeof json.controls !== 'object' || Array.isArray(json.controls)) {
          throw new Error('Invalid CSS Account controls response');
        }
        let nextControls = json.controls;
        let transport: AccountSessionTransport | undefined;
        const sessionTransport = sessionTransportRef.current;
        // Cookie Account authentication is independent from the Solid actor and wins.
        // Only the authority's real anonymous response allows a session-based probe.
        if (!nextControls.account?.logout && sessionTransport && sessionTransport !== suppressedTransportRef.current && accountLogoutOperationsRef.current === 0
          && new URL('.account/', sessionTransport.issuer).href === new URL(idpIndex).href) {
          setAccountState((prev) => prev.status === 'authenticated' ? prev : { status: 'initializing' });
          sessionTransport.assertCurrent();
          const sessionFetch = createSessionAccountFetch({
            accountIndex: idpIndex, fetch: sessionTransport.fetch, assertCurrent: () => sessionTransport.assertCurrent(),
          });
          const sessionResponse = await sessionFetch(scopeAccountUrl(idpIndex), {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(OIDC_PENDING_PROBE_TIMEOUT_MS),
          });
          if (!isFetchCurrent(generation) || sessionTransport !== sessionTransportRef.current) return 'stale';
          sessionTransport.assertCurrent();
          if (!tokenIsCurrent()) return 'transient-error';
          if (sessionResponse.ok) {
            const sessionJson = await sessionResponse.json() as ControlsResponse | null;
            if (!isFetchCurrent(generation) || sessionTransport !== sessionTransportRef.current) return 'stale';
            sessionTransport.assertCurrent();
            if (!tokenIsCurrent()) return 'transient-error';
            if (!sessionJson?.controls || typeof sessionJson.controls !== 'object' || Array.isArray(sessionJson.controls)) {
              throw new Error('Invalid CSS Account controls response');
            }
            nextControls = sessionJson.controls;
            if (nextControls.account?.logout) transport = sessionTransport;
          } else if (sessionResponse.status !== 401 && sessionResponse.status !== 403) {
            // A failed session probe cannot confirm the Cookie response's anonymity.
            // Reuse the bounded retry path instead of presenting another password form.
            if (isTransientAccountControlsStatus(sessionResponse.status)
              || sessionResponse.status === 408 || sessionResponse.status === 429 || sessionResponse.status === 500) {
              throw new Error('Transient CSS Account controls response');
            }
            pendingProbeIdRef.current += 1;
            setHasOidcPending(false);
            revokeAccountCapabilities();
            setInitError(ACCOUNT_ERROR_MESSAGE);
            setAccountState({ status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE });
            return 'terminal-error';
          }
        }
        const probeId = ++pendingProbeIdRef.current;
        setHasOidcPending(false);
        acceptControls(nextControls, requestToken, transport);
        setControls(nextControls);
        setInitError(null);
        const nextAccountState = accountStateForControls(nextControls);
        // Keep synchronous logout verification in lockstep with CSS controls,
        // independently of the loading/error presentation.
        isAnonymousRef.current = nextAccountState.status === 'anonymous';
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
          isAnonymousRef.current = true;
          setHasOidcPending(false);
          acceptControls({});
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
        revokeAccountCapabilities();
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
  }, [acceptControls, checkOidcPending, isFetchCurrent, revokeAccountCapabilities]);

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
  }, [fetchControls, idpIndex, sessionTransportVersion]);

  const refetchControls = useCallback(async (): Promise<AccountAuthState> => {
    const resolvedIndex = await retryAccountIndex();
    if (resolvedIndex && resolvedIndex === idpIndex) {
      const result = await fetchControls();
      if (mountedRef.current) setIsInitializing(false);
      if (result === 'ok') return accountStateForControls(controlsRef.current);
    }
    return { status: 'error', mode: 'login', message: ACCOUNT_ERROR_MESSAGE };
  }, [fetchControls, idpIndex, retryAccountIndex]);

  const retry = useCallback(async () => { await refetchControls(); }, [refetchControls]);

  const logout = useCallback(async () => {
    accountLogoutOperationsRef.current += 1;
    suppressedTransportRef.current = sessionTransportRef.current;
    try {
      revokeAccountCapabilities();
      // Discard controls/consent obtained before the user requested sign-out.
      fetchGenerationRef.current += 1;
      pendingProbeIdRef.current += 1;
      // An anonymous controls cache can predate login in another tab. Confirm
      // current CSS state unless an advertised logout control can revoke it.
      // A session projection is not evidence of a Cookie session. During product
      // logout the SDK may already be revoked; re-read only the Cookie authority.
      if (controlsTransportRef.current || !controlsRef.current?.account?.logout) {
        isAnonymousRef.current = false;
        const accountIndex = accountIndexRef.current ?? await retryAccountIndex();
        if (accountIndex) await fetchControls();
      }
      const idpIndex = accountIndexRef.current;
      const advertisedLogoutUrl = controlsRef.current?.account?.logout;
      const logoutUrl = await resolveHostedAccountControlUrl(advertisedLogoutUrl, fetch, idpIndex);
      let failed = !logoutUrl && (Boolean(advertisedLogoutUrl) || !isAnonymousRef.current);
      if (logoutUrl) {
        try {
          const response = await fetch(scopeAccountUrl(logoutUrl), {
            method: 'POST',
            headers: storedAccountTokenHeaders(undefined, idpIndex),
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
      fetchGenerationRef.current += 1;
      pendingProbeIdRef.current += 1;
      isAnonymousRef.current = true;
      setIsInitializing(false);
      clearAccountSessionToken();
      setHasOidcPending(false);
      acceptControls({});
      setControls({});
      setInitError(null);
      setAccountState({ status: 'anonymous', mode: 'login' });
    } finally {
      accountLogoutOperationsRef.current -= 1;
    }
  }, [acceptControls, fetchControls, retryAccountIndex, revokeAccountCapabilities]);

  const identity = useMemo(() => accountIdentityFromControls(controls), [controls]);

  return (
    <AuthContext.Provider value={{
      controls,
      isInitializing,
      initError,
      idpIndex: idpIndex ?? LOCAL_ACCOUNT_INDEX,
      isLoggedIn,
      isAnonymous: () => isAnonymousRef.current,
      bindAccountCapability,
      authenticating,
      hasOidcPending,
      refetchControls,
      registerAccountSession,
      accountFetch,
      retry,
      logout,
      accountState,
      identity,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
