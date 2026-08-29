import {
  SolidRuntimeProvider,
  type OpenPodRuntime,
  type SolidSessionSnapshot,
  type StorageBinding,
} from '@undefineds.co/solid-sdk';
import { type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import type { WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import { AuthContext } from '../context/AuthContextValue';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  clearXpodSelectedStorage,
  readXpodSelectedStorage,
} from '../auth/xpod-login-transaction';
import { storageBindingKey } from '../auth/xpod-storage-selection';
import { resolveSameOriginAccountControlUrl } from '../utils/account-control-url';
import { storedAccountTokenHeaders } from '../utils/account-session';
import {
  clearCachedInruptDynamicClientRegistration,
  getXpodSolidRuntimeValue,
  clearStoredXpodOidcIssuer,
  isCurrentXpodSessionSnapshot,
  normalizeXpodLoginTransaction,
  resolveXpodLoginContext,
  safeAuthError,
  snapshotToState,
  withXpodProvisionScope,
  XpodSolidRuntimeContext,
  type XpodSolidRuntimeCore,
  type XpodSolidRuntimeValue,
} from './XpodSolidRuntime';
import { currentHostLocalPodRoute } from './xpod-local-route';

export function XpodSolidRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: XpodSolidRuntimeCore;
}) {
  const runtime = value ?? getXpodSolidRuntimeValue();
  const runtimeStorage = useMemo(() => runtime.storage ?? {}, [runtime]);
  // Known limitation: this read depends on provider nesting order. When
  // XpodAuthProvider reuses an ambient runtime that was mounted *above*
  // AuthProvider (see XpodAuthProvider), this context is null and the
  // Account-bindings ownership check below is silently skipped (treated as
  // "not logged in"). Tracked as a follow-up issue; the degraded-open policy
  // in rememberedBindingStillOwned keeps the WebID domain unaffected.
  const accountContext = useContext(AuthContext);
  const accountIsLoggedIn = accountContext?.isLoggedIn ?? false;
  const accountBindingsUrl = accountContext?.controls?.account?.bindings;
  const accountIdpIndex = accountContext?.idpIndex;
  const initialProviderSession = useMemo(() => currentProviderSession(runtime), [runtime]);
  const [snapshot, setSnapshot] = useState(initialProviderSession.snapshot);
  const [issuer, setIssuer] = useState(initialProviderSession.issuer);
  const [currentPod, setCurrentPod] = useState<OpenPodRuntime<SolidDatabase>>();
  const [selectedStorage, setSelectedStorage] = useState<StorageBinding>();
  const [podError, setPodError] = useState<{ webId: string; error: Error }>();
  const [podOpenAttempt, setPodOpenAttempt] = useState(0);
  const [aiClientConfiguration, setAiClientConfiguration] =
    useState<Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>>();
  const [accountClientCredentialsUrl, setAccountClientCredentialsUrl] = useState<string>();
  const snapshotRef = useRef(snapshot);
  const rejectedSessionRef = useRef(initialProviderSession.rejected);
  const rejectedSessionResetRef = useRef<Promise<void> | undefined>(undefined);
  const desktopCanonicalOriginRef = useRef<string | undefined>(undefined);

  const expireAuthenticatedSession = useCallback(() => {
    const current = snapshotRef.current;
    if (current.status !== 'authenticated') return;
    const expired = { status: 'expired', webId: current.webId } as const;
    snapshotRef.current = expired;
    setSnapshot(expired);
    setCurrentPod(undefined);
    setPodError(undefined);
    setAiClientConfiguration(undefined);
    setAccountClientCredentialsUrl(undefined);
    runtime.pod.clear({ webId: current.webId });
  }, [runtime.pod]);

  const exposedFetch = useCallback<typeof fetch>(async (input, init) => {
    if (rejectedSessionRef.current) {
      return Promise.reject(REJECTED_SESSION_FETCH_ERROR);
    }
    const response = await (init === undefined
      ? runtime.session.fetch(input)
      : runtime.session.fetch(input, init));
    if (await isExpiredXpodSessionResponse(response, input, desktopCanonicalOriginRef.current)) {
      expireAuthenticatedSession();
    }
    return response;
  }, [expireAuthenticatedSession, runtime.session]);

  const clearRejectedSession = useCallback(() => {
    if (rejectedSessionResetRef.current) return rejectedSessionResetRef.current;

    const reset = (async () => {
      try {
        await runtime.session.logout();
        const resetSnapshot = runtime.session.getSnapshot();
        if (resetSnapshot.status !== 'authenticated'
          || isCurrentXpodSessionSnapshot(
            resetSnapshot,
            runtime.getIssuer(),
            runtime.getExpectedIssuer?.() ?? window.location.origin,
          )) {
          rejectedSessionRef.current = false;
        }
      } catch {
        // A rejected provider must remain unusable even if its logout endpoint
        // is unavailable. The host clears all local runtime state below.
      } finally {
        const anonymous = { status: 'anonymous' } as const;
        runtime.pod.clear();
        clearXpodSelectedStorage({ storage: runtimeStorage.selectedStorage });
        clearStoredXpodOidcIssuer(runtimeStorage.issuer);
        runtime.setIssuer(undefined);
        snapshotRef.current = anonymous;
        setSnapshot(anonymous);
        setIssuer(undefined);
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        setAccountClientCredentialsUrl(undefined);
      }
    })().finally(() => {
      if (rejectedSessionResetRef.current === reset) {
        rejectedSessionResetRef.current = undefined;
      }
    });
    rejectedSessionResetRef.current = reset;
    return reset;
  }, [runtime, runtimeStorage.issuer, runtimeStorage.selectedStorage]);

  const exposedSession = useMemo(() => ({
    ...runtime.session,
    fetch: exposedFetch,
    getSnapshot: () => snapshotRef.current,
  }), [exposedFetch, runtime.session]);

  useEffect(() => {
    return runtime.session.subscribe((nextSnapshot) => {
      const nextIssuer = runtime.getIssuer();
      if (!isCurrentXpodSessionSnapshot(
        nextSnapshot,
        nextIssuer,
        runtime.getExpectedIssuer?.() ?? window.location.origin,
      )) {
        rejectedSessionRef.current = true;
        void clearRejectedSession();
        return;
      }
      if (nextSnapshot.status === 'authenticated') {
        rejectedSessionRef.current = false;
      }
      const previousSnapshot = snapshotRef.current;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setIssuer(nextIssuer);
      if (nextSnapshot.status !== 'authenticated') {
        desktopCanonicalOriginRef.current = undefined;
        runtime.setLocalPodRoute?.(undefined);
        setCurrentPod(undefined);
        if (nextSnapshot.status !== 'expired') setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        setAccountClientCredentialsUrl(undefined);
        runtime.pod.clear();
      } else if (previousSnapshot.status !== 'authenticated' || nextSnapshot.webId !== previousSnapshot.webId) {
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        setAccountClientCredentialsUrl(undefined);
        runtime.pod.clear(previousSnapshot.status === 'authenticated'
          ? { webId: previousSnapshot.webId }
          : undefined);
      }
    });
  }, [clearRejectedSession, runtime, runtimeStorage]);

  useEffect(() => {
    let active = true;
    const currentSnapshot = runtime.session.getSnapshot();
    const initialization = currentSnapshot.status === 'initializing'
      ? runtime.session.initialize({ restorePreviousSession: true })
      : Promise.resolve(currentSnapshot);
    void initialization.then(async (nextSnapshot) => {
      const nextIssuer = runtime.getIssuer();
      if (!isCurrentXpodSessionSnapshot(
        nextSnapshot,
        nextIssuer,
        runtime.getExpectedIssuer?.() ?? window.location.origin,
      )) {
        rejectedSessionRef.current = true;
        await clearRejectedSession();
        return;
      }
      if (nextSnapshot.status === 'authenticated') {
        rejectedSessionRef.current = false;
      }
      if (!active) return;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setIssuer(nextIssuer);
    });
    return () => {
      active = false;
    };
  }, [clearRejectedSession, runtime, runtimeStorage]);

  useEffect(() => {
    if (snapshot.status !== 'authenticated') {
      return;
    }

    let cancelled = false;
    const rememberedBinding = readXpodSelectedStorage({
      storage: runtimeStorage.selectedStorage,
      origin: typeof window === 'undefined' ? undefined : window.location.origin,
      webId: snapshot.webId,
    });
    if (!rememberedBinding) {
      // Xpod no longer guesses a Pod from profile storage. A public WebID-only
      // session remains valid, while Pod-backed routes wait for an explicit
      // Account binding selected through consent or callback state.
      runtime.pod.clear({ webId: snapshot.webId });
      desktopCanonicalOriginRef.current = undefined;
      runtime.setLocalPodRoute?.(undefined);
      queueMicrotask(() => {
        if (!cancelled) {
          setCurrentPod(undefined);
          setSelectedStorage(undefined);
          setPodError(undefined);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    const openArgs = {
      webId: snapshot.webId,
      podUrl: rememberedBinding.storageUrl,
      fetch: exposedFetch,
    };
    void (async () => {
      try {
        if (!await rememberedBindingStillOwned(
          rememberedBinding,
          accountIsLoggedIn,
          accountBindingsUrl,
          accountIdpIndex,
        )) {
          if (!cancelled) {
            clearXpodSelectedStorage({ storage: runtimeStorage.selectedStorage });
            runtime.pod.clear({ webId: snapshot.webId });
            setCurrentPod(undefined);
            setSelectedStorage(undefined);
            setPodError({ webId: snapshot.webId, error: new Error('Selected Pod binding is no longer available') });
          }
          return;
        }
        const localRoute = await currentHostLocalPodRoute(rememberedBinding.storageUrl, fetch);
        if (cancelled) return;
        desktopCanonicalOriginRef.current = localRoute
          ? new URL(localRoute.canonicalBaseUrl).origin
          : undefined;
        runtime.setLocalPodRoute?.(localRoute);
        const opened = await runtime.pod.open(openArgs);
        if (!cancelled) {
          if (rememberedBinding && (
            opened.webId !== rememberedBinding.webId
            || !sameUrl(opened.podUrl, rememberedBinding.storageUrl)
          )) {
            clearXpodSelectedStorage({ storage: runtimeStorage.selectedStorage });
            setCurrentPod(undefined);
            setSelectedStorage(undefined);
            setPodError({ webId: snapshot.webId, error: new Error('Selected Pod binding mismatch') });
            return;
          }
          setCurrentPod(opened);
          setSelectedStorage(rememberedBinding ?? { webId: opened.webId, storageUrl: opened.podUrl });
          setPodError(undefined);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setPodError({
            webId: snapshot.webId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountBindingsUrl, accountIdpIndex, accountIsLoggedIn, exposedFetch, podOpenAttempt, runtime, runtimeStorage.selectedStorage, snapshot]);

  const retryPodOpen = useCallback(() => {
    setPodError(undefined);
    setPodOpenAttempt((attempt) => attempt + 1);
  }, []);

  const authenticatedWebId = snapshot.status === 'authenticated' ? snapshot.webId : undefined;

  useEffect(() => {
    if (!authenticatedWebId) return;
    let cancelled = false;
    void discoverAccountClientCredentialsUrl(fetch).then((url) => {
      if (!cancelled && runtime.session.getSnapshot().status === 'authenticated' &&
        runtime.session.getSnapshot().webId === authenticatedWebId) {
        setAccountClientCredentialsUrl(url);
      }
    });
    void discoverAiClientConfigurationCapability(exposedFetch).then((capability) => {
      if (!cancelled && runtime.session.getSnapshot().status === 'authenticated' &&
        runtime.session.getSnapshot().webId === authenticatedWebId) {
        setAiClientConfiguration(capability);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [authenticatedWebId, exposedFetch, runtime]);

  const xpodRuntime = useMemo<XpodSolidRuntimeValue>(() => {
    const activeIssuer = issuer ?? runtime.getIssuer();
    const activePodError = snapshot.status === 'authenticated' && podError?.webId === snapshot.webId
      ? podError
      : undefined;
    // Pod failures stay out of the WebID session state: the session is still
    // authenticated, and boundaries must offer "retry Pod" rather than a
    // misleading full re-login.
    const state = snapshotToState(snapshot, currentPod, activeIssuer);

    return {
      session: exposedSession,
      pod: runtime.pod,
      fetch: exposedFetch,
      state: state.status === 'error' ? { ...state, error: safeAuthError(state.error) } : state,
      webId: state.webId,
      podUrl: state.podUrl,
      issuer: state.issuer,
      currentPod,
      selectedStorage,
      ...(activePodError ? { podError: activePodError } : {}),
      retryPodOpen,
      aiClientConfiguration,
      accountClientCredentialsUrl,
      login: async (transaction: WebIdLoginTransaction) => {
        const validated = normalizeXpodLoginTransaction(transaction);
        const loginContext = await resolveXpodLoginContext(
          validated.route.identityProvider.url,
          fetch,
        );
        const oidcIssuer = loginContext.oidcIssuer;
        if (!oidcIssuer) throw new TypeError('Xpod login route has no valid issuer');
        const redirectUrl = new URL('/auth/callback', window.location.origin);
        runtime.setIssuer(oidcIssuer);
        setIssuer(oidcIssuer);
        clearCachedInruptDynamicClientRegistration(runtimeStorage);
        try {
          await runtime.session.login({
            oidcIssuer,
            redirectUrl: redirectUrl.toString(),
            handleRedirect: loginContext.provisionCode
              ? (authorizationUrl) => {
                window.location.assign(withXpodProvisionScope(authorizationUrl, loginContext.provisionCode!));
              }
              : undefined,
          });
        } catch (error) {
          // Inrupt wraps dynamic-registration and persistence failures in a
          // generic `Client registration failed` error. Keep the nested cause
          // in developer diagnostics while the product surface stays concise.
          console.error('[XpodSolidRuntimeProvider] WebID login failed', error,
            error instanceof Error ? error.cause : undefined);
          throw error;
        }
      },
      logout: async () => {
        await runtime.session.logout();
        runtime.pod.clear();
        clearXpodSelectedStorage({ storage: runtimeStorage.selectedStorage });
        clearStoredXpodOidcIssuer(runtimeStorage.issuer);
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setAiClientConfiguration(undefined);
        setAccountClientCredentialsUrl(undefined);
      },
    };
  }, [accountClientCredentialsUrl, aiClientConfiguration, currentPod, exposedFetch, exposedSession, issuer, podError, retryPodOpen, runtime, runtimeStorage, selectedStorage, snapshot]);

  return (
    <SolidRuntimeProvider value={{ session: exposedSession, pod: runtime.pod, currentPod }}>
      <XpodSolidRuntimeContext.Provider value={xpodRuntime}>
        {children}
      </XpodSolidRuntimeContext.Provider>
    </SolidRuntimeProvider>
  );
}

async function discoverAccountClientCredentialsUrl(fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl('/.account/', {
      credentials: 'include',
      headers: storedAccountTokenHeaders({ accept: 'application/json' }),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return undefined;
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || !isRecord(payload.controls) || !isRecord(payload.controls.account)) return undefined;
    const value = payload.controls.account.clientCredentials;
    return resolveSameOriginAccountControlUrl(typeof value === 'string' ? value : undefined);
  } catch {
    return undefined;
  }
}

const ANONYMOUS_SNAPSHOT = { status: 'anonymous' } as const satisfies SolidSessionSnapshot;
const REJECTED_SESSION_FETCH_ERROR = new Error('Xpod session is unavailable');

const XPOD_SERVER_API_PATH_PREFIXES = ['/v1/', '/api/'];

async function isExpiredXpodSessionResponse(
  response: Response,
  input: RequestInfo | URL,
  canonicalServerOrigin?: string,
): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403 && response.status !== 500) return false;
  if (typeof window === 'undefined') return false;
  const url = resolveRequestUrl(input);
  if (!url) return false;
  // Only the Xpod server that issued this WebID session can revoke it: the
  // app origin itself, plus the canonical server origin that desktop shells
  // route through the local Gateway. A third-party 401/403 must never mark
  // the session expired.
  if (url.origin !== window.location.origin && url.origin !== canonicalServerOrigin) return false;
  if (response.status === 401) return true;
  if (response.status === 403) {
    // Pod resources legitimately answer 403 for missing permissions, so only
    // the all-or-nothing server APIs (AI Gateway, management API) treat 403
    // as a revoked token/WebID signal.
    return XPOD_SERVER_API_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  }
  if (!url.pathname.endsWith('/-/sparql')) return false;

  try {
    const message = await response.clone().text();
    return /UnauthorizedHttpError|not logged in|invalid[_ -]?token/iu.test(message);
  } catch {
    return false;
  }
}

function resolveRequestUrl(input: RequestInfo | URL): URL | undefined {
  const requestUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  try {
    return new URL(requestUrl, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  } catch {
    return undefined;
  }
}

function currentProviderSession(runtime: XpodSolidRuntimeCore): {
  snapshot: SolidSessionSnapshot;
  issuer: string | undefined;
  rejected: boolean;
} {
  const snapshot = runtime.session.getSnapshot();
  const issuer = runtime.getIssuer();
  return isCurrentXpodSessionSnapshot(
    snapshot,
    issuer,
    runtime.getExpectedIssuer?.() ?? window.location.origin,
  )
    ? { snapshot, issuer, rejected: false }
    : { snapshot: ANONYMOUS_SNAPSHOT, issuer: undefined, rejected: true };
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

async function rememberedBindingStillOwned(
  binding: StorageBinding,
  accountIsLoggedIn: boolean,
  accountBindingsUrl?: string,
  trustedAccountIndex?: string,
): Promise<boolean> {
  if (!accountIsLoggedIn || !accountBindingsUrl) {
    return true;
  }

  try {
    const bindings = await fetchAccountStorageBindings({
      controls: { account: { bindings: accountBindingsUrl } },
      origin: typeof window === 'undefined' ? undefined : window.location.origin,
      trustedAccountIndex,
    });
    // Only an explicit server answer that omits the binding rejects it.
    return bindings.some((candidate) => storageBindingKey(candidate) === storageBindingKey(binding));
  } catch {
    // A failed ownership check (Account API offline, 5xx, malformed payload)
    // must not drag the independent WebID domain into an error: open the Pod
    // and let the Pod server's own access checks enforce correctness.
    return true;
  }
}

async function discoverAiClientConfigurationCapability(
  fetchImpl: typeof fetch,
): Promise<Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>> {
  try {
    const capabilityUrl = new URL('/api/ai/client-configuration/capability', window.location.href).toString();
    const response = await fetchImpl(capabilityUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      await response.arrayBuffer().catch(() => undefined);
      return manualAiClientConfigurationCapability();
    }
    const payload = await response.json() as unknown;
    if (isRecord(payload) && payload.available === true && payload.authority === 'local-filesystem') {
      return {
        available: true,
        authority: 'local-filesystem',
        manualInstructions: typeof payload.manualInstructions === 'string'
          ? payload.manualInstructions
          : manualAiClientConfigurationCapability().manualInstructions,
      };
    }
  } catch {
    // Capability discovery is optional; unsupported hosts fall back to manual setup.
  }
  return manualAiClientConfigurationCapability();
}

function manualAiClientConfigurationCapability(): Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'> {
  return {
    available: false,
    manualInstructions: 'manual client setup is available',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
