import desktopClient from '../../../src/identity/oidc/xpod-desktop-client.json';
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
import {
  clearXpodSelectedStorage,
  readXpodSelectedStorage,
} from '../auth/xpod-login-transaction';
import {
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
import { currentHostLocalPodRoutes } from './xpod-local-route';
import { createAccountClientCredentialsCapability } from '../auth/account-client-credentials';
import {
  createSessionRequestCredential,
  withRequestPodAuthorization,
  type SessionRequestCredential,
} from '../auth/session-request-credential';
import { AuthContext } from '../context/AuthContextValue';

export function XpodSolidRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: XpodSolidRuntimeCore;
}) {
  const runtime = value ?? getXpodSolidRuntimeValue();
  const runtimeStorage = useMemo(() => runtime.storage ?? {}, [runtime]);
  const initialProviderSession = useMemo(() => currentProviderSession(runtime), [runtime]);
  const [snapshot, setSnapshot] = useState(initialProviderSession.snapshot);
  const [issuer, setIssuer] = useState(initialProviderSession.issuer);
  const [currentPod, setCurrentPod] = useState<OpenPodRuntime<SolidDatabase>>();
  const [selectedStorage, setSelectedStorage] = useState<StorageBinding>();
  const [podError, setPodError] = useState<{ webId: string; error: Error }>();
  const [podOpenAttempt, setPodOpenAttempt] = useState(0);
  const [aiClientConfiguration, setAiClientConfiguration] =
    useState<Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>>();
  const snapshotRef = useRef(snapshot);
  const rejectedSessionRef = useRef(initialProviderSession.rejected);
  const rejectedSessionResetRef = useRef<Promise<void> | undefined>(undefined);

  const exposedFetch = useCallback<typeof fetch>(async (input, init) => {
    if (rejectedSessionRef.current) {
      return Promise.reject(REJECTED_SESSION_FETCH_ERROR);
    }
    return init === undefined
      ? runtime.session.fetch(input)
      : runtime.session.fetch(input, init);
  }, [runtime.session]);

  // Public/session fetch retains anonymous semantics. Pod and business work
  // receives a capability revoked by the SDK when its session ends or changes.
  const boundFetch = useMemo(() => snapshot.status === 'authenticated'
    ? runtime.session.createAuthenticatedFetch(snapshot.webId)
    : undefined, [runtime.session, snapshot]);
  const authenticatedFetch = useCallback<typeof fetch>(async (input, init) => {
    if (!boundFetch || rejectedSessionRef.current) throw REJECTED_SESSION_FETCH_ERROR;
    return init === undefined ? boundFetch(input) : boundFetch(input, init);
  }, [boundFetch]);

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
      }
    })().finally(() => {
      if (rejectedSessionResetRef.current === reset) {
        rejectedSessionResetRef.current = undefined;
      }
    });
    rejectedSessionResetRef.current = reset;
    return reset;
  }, [runtime, runtimeStorage.issuer, runtimeStorage.selectedStorage]);

  // API calls that open the user's Pod retry with this session's request credential; Pod traffic,
  // capability calls and other origins keep using the session itself.
  const podAuthorizedFetch = useCallback<typeof fetch>(
    (input, init) => withRequestPodAuthorization(
      authenticatedFetch,
      () => requestCredentialRef.current?.authorization() ?? Promise.resolve(undefined),
    )(input, init),
    [authenticatedFetch],
  );
  const exposedSession = useMemo(() => ({
    ...runtime.session,
    fetch: withRequestPodAuthorization(
      exposedFetch,
      () => requestCredentialRef.current?.authorization() ?? Promise.resolve(undefined),
    ),
    getSnapshot: () => snapshotRef.current,
  }), [exposedFetch, runtime.session]);

  // The Account session is what may create a client credential for this WebID, so the holder is
  // rebuilt whenever the Account binding changes and released when it goes away.
  const account = useContext(AuthContext);
  const accountBinding = useMemo(() => ({
    collection: account?.controls?.account?.clientCredentials,
    webId: account?.identity?.webId,
    bind: account?.bindAccountCapability,
  }), [account?.controls?.account?.clientCredentials, account?.identity?.webId, account?.bindAccountCapability]);
  const requestCredentialRef = useRef<SessionRequestCredential | undefined>(undefined);
  if (!requestCredentialRef.current) {
    requestCredentialRef.current = createSessionRequestCredential({});
  }
  useEffect(() => {
    const previous = requestCredentialRef.current;
    const capability = accountBinding.collection && accountBinding.bind
      ? createAccountClientCredentialsCapability({
        collection: accountBinding.collection,
        assertCurrent: accountBinding.bind(),
        accountIndex: account?.idpIndex ?? window.location.origin,
      })
      : undefined;
    const next = createSessionRequestCredential({
      ...(capability ? { capability } : {}),
      ...(accountBinding.webId ? { webId: accountBinding.webId } : {}),
    });
    requestCredentialRef.current = next;
    return () => {
      requestCredentialRef.current = createSessionRequestCredential({});
      void previous?.release().catch(() => undefined);
      void next.release().catch(() => undefined);
    };
  }, [accountBinding, account?.idpIndex]);

  useEffect(() => {
    const projectSnapshot = (nextSnapshot: SolidSessionSnapshot) => {
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
        runtime.setLocalPodRoutes?.(undefined);
        setCurrentPod(undefined);
        if (nextSnapshot.status !== 'expired') setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        runtime.pod.clear();
      } else if (previousSnapshot !== nextSnapshot) {
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        runtime.pod.clear(previousSnapshot.status === 'authenticated'
          ? { webId: previousSnapshot.webId }
          : undefined);
      }
    };
    const unsubscribe = runtime.session.subscribe(projectSnapshot);
    // Child route boundaries can restore synchronously before this parent
    // effect subscribes. Project the settled snapshot once after subscribing
    // so no authenticated transition is lost between render and effect setup.
    projectSnapshot(runtime.session.getSnapshot());
    return unsubscribe;
  }, [clearRejectedSession, runtime, runtimeStorage]);

  useEffect(() => {
    if (rejectedSessionRef.current) void clearRejectedSession();
  }, [clearRejectedSession]);

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
    const openArgs = {
      webId: snapshot.webId,
      ...(rememberedBinding ? { podUrl: rememberedBinding.storageUrl } : {}),
      fetch: podAuthorizedFetch,
    };
    void (async () => {
      try {
        const opened = await runtime.pod.open(openArgs);
        const localRoutes = await currentHostLocalPodRoutes(opened.podUrl, fetch);
        if (cancelled) return;
        runtime.setLocalPodRoutes?.(localRoutes);
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
  }, [authenticatedFetch, podOpenAttempt, runtime, runtimeStorage.selectedStorage, snapshot]);

  const retryPodOpen = useCallback(() => {
    setPodError(undefined);
    setPodOpenAttempt((attempt) => attempt + 1);
  }, []);

  const authenticatedWebId = snapshot.status === 'authenticated' ? snapshot.webId : undefined;

  useEffect(() => {
    if (!authenticatedWebId) return;
    let cancelled = false;
    void discoverAiClientConfigurationCapability(authenticatedFetch).then((capability) => {
      if (!cancelled && runtime.session.getSnapshot().status === 'authenticated' &&
        runtime.session.getSnapshot().webId === authenticatedWebId) {
        setAiClientConfiguration(capability);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [authenticatedFetch, authenticatedWebId, runtime]);

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
      fetch: authenticatedFetch,
      state: state.status === 'error' ? { ...state, error: safeAuthError(state.error) } : state,
      webId: state.webId,
      podUrl: state.podUrl,
      issuer: state.issuer,
      currentPod,
      selectedStorage,
      ...(activePodError ? { podError: activePodError } : {}),
      retryPodOpen,
      aiClientConfiguration,
      // Bound here rather than passed by reference: the value is handed to
      // callers that do not share the core object.
      resolveLocalUrl: (url: string) => runtime.resolveLocalUrl(url),
      requestPodAuthorization: () => requestCredentialRef.current?.authorization() ?? Promise.resolve(undefined),
      login: async (transaction: WebIdLoginTransaction) => {
        const validated = normalizeXpodLoginTransaction(transaction);
        const loginContext = await resolveXpodLoginContext(
          validated.route.identityProvider.url,
          fetch,
        );
        const oidcIssuer = loginContext.oidcIssuer;
        if (!oidcIssuer) throw new TypeError('Xpod login route has no valid issuer');
        const redirectUrl = new URL('/auth/callback', window.location.origin);
        const desktopClientId = globalThis.xpodDesktop
          ? desktopClient.client_id
          : undefined;
        try {
          await runtime.session.login({
            ...(desktopClientId ? { clientId: desktopClientId } : {}),
            oidcIssuer,
            redirectUrl: redirectUrl.toString(),
            handleRedirect: (authorizationUrl) => {
                runtime.setIssuer(oidcIssuer);
                setIssuer(oidcIssuer);
                const authorization = new URL(authorizationUrl);
                if (validated.prompt) {
                  authorization.searchParams.set('prompt', validated.prompt);
                } else if (desktopClientId && authorization.searchParams.get('prompt') === 'consent') {
                  // Inrupt defaults every interactive login to forced consent.
                  // A fixed app identity lets the IdP decide whether
                  // its grant is sufficient; new grants still require consent.
                  authorization.searchParams.delete('prompt');
                }
                window.location.assign(loginContext.provisionCode
                  ? withXpodProvisionScope(authorization.href, loginContext.provisionCode)
                  : authorization.href);
              },
          });
          runtime.setIssuer(oidcIssuer);
          setIssuer(oidcIssuer);
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
        await requestCredentialRef.current?.release().catch(() => undefined);
        await runtime.session.logout();
        runtime.pod.clear();
        clearXpodSelectedStorage({ storage: runtimeStorage.selectedStorage });
        clearStoredXpodOidcIssuer(runtimeStorage.issuer);
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setAiClientConfiguration(undefined);
      },
    };
  }, [aiClientConfiguration, authenticatedFetch, currentPod, exposedSession, issuer, podError, retryPodOpen, runtime, runtimeStorage, selectedStorage, snapshot]);

  return (
    <SolidRuntimeProvider value={{ session: exposedSession, pod: runtime.pod, currentPod }}>
      <XpodSolidRuntimeContext.Provider value={xpodRuntime}>
        {children}
      </XpodSolidRuntimeContext.Provider>
    </SolidRuntimeProvider>
  );
}

const ANONYMOUS_SNAPSHOT = { status: 'anonymous' } as const satisfies SolidSessionSnapshot;
const REJECTED_SESSION_FETCH_ERROR = new Error('Xpod session is unavailable');

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
