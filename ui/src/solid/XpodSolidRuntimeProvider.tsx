import {
  SolidRuntimeProvider,
  type OpenPodRuntime,
  type SolidSessionSnapshot,
  type StorageBinding,
} from '@undefineds.co/solid-sdk';
import { type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import type { WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  clearXpodSelectedStorage,
  readXpodSelectedStorage,
} from '../auth/xpod-login-transaction';
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

  const exposedSession = useMemo(() => ({
    ...runtime.session,
    fetch: exposedFetch,
    getSnapshot: () => snapshotRef.current,
  }), [exposedFetch, runtime.session]);

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
        runtime.setLocalPodRoute?.(undefined);
        setCurrentPod(undefined);
        if (nextSnapshot.status !== 'expired') setSelectedStorage(undefined);
        setPodError(undefined);
        setAiClientConfiguration(undefined);
        runtime.pod.clear();
      } else if (previousSnapshot.status !== 'authenticated' || nextSnapshot.webId !== previousSnapshot.webId) {
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
      fetch: exposedFetch,
    };
    void (async () => {
      try {
        const opened = await runtime.pod.open(openArgs);
        const localRoute = await currentHostLocalPodRoute(opened.podUrl, fetch);
        if (cancelled) return;
        runtime.setLocalPodRoute?.(localRoute);
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
  }, [exposedFetch, podOpenAttempt, runtime, runtimeStorage.selectedStorage, snapshot]);

  const retryPodOpen = useCallback(() => {
    setPodError(undefined);
    setPodOpenAttempt((attempt) => attempt + 1);
  }, []);

  const authenticatedWebId = snapshot.status === 'authenticated' ? snapshot.webId : undefined;

  useEffect(() => {
    if (!authenticatedWebId) return;
    let cancelled = false;
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
      },
    };
  }, [aiClientConfiguration, currentPod, exposedFetch, exposedSession, issuer, podError, retryPodOpen, runtime, runtimeStorage, selectedStorage, snapshot]);

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
