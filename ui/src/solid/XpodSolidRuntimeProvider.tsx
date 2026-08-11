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
  getXpodSolidRuntimeValue,
  clearStoredXpodOidcIssuer,
  isCurrentXpodSessionSnapshot,
  normalizeXpodOidcIssuer,
  normalizeXpodLoginTransaction,
  safeAuthError,
  snapshotToState,
  XpodSolidRuntimeContext,
  type XpodSolidRuntimeCore,
  type XpodSolidRuntimeValue,
} from './XpodSolidRuntime';

export function XpodSolidRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value?: XpodSolidRuntimeCore;
}) {
  const runtime = value ?? getXpodSolidRuntimeValue();
  const accountContext = useContext(AuthContext);
  const accountIsLoggedIn = accountContext?.isLoggedIn ?? false;
  const accountBindingsUrl = accountContext?.controls?.account?.bindings;
  const initialProviderSession = useMemo(() => currentProviderSession(runtime), [runtime]);
  const [snapshot, setSnapshot] = useState(initialProviderSession.snapshot);
  const [issuer, setIssuer] = useState(initialProviderSession.issuer);
  const [currentPod, setCurrentPod] = useState<OpenPodRuntime<SolidDatabase>>();
  const [selectedStorage, setSelectedStorage] = useState<StorageBinding>();
  const [podError, setPodError] = useState<{ webId: string; error: Error }>();
  const [aiClientConfiguration, setAiClientConfiguration] =
    useState<Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>>();
  const [accountClientCredentialsUrl, setAccountClientCredentialsUrl] = useState<string>();
  const snapshotRef = useRef(snapshot);
  const rejectedSessionRef = useRef(initialProviderSession.rejected);
  const rejectedSessionResetRef = useRef<Promise<void> | undefined>(undefined);

  const exposedFetch = useCallback<typeof fetch>((input, init) => {
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
          || isCurrentXpodSessionSnapshot(resetSnapshot, runtime.getIssuer())) {
          rejectedSessionRef.current = false;
        }
      } catch {
        // A rejected provider must remain unusable even if its logout endpoint
        // is unavailable. The host clears all local runtime state below.
      } finally {
        const anonymous = { status: 'anonymous' } as const;
        runtime.pod.clear();
        clearXpodSelectedStorage();
        clearStoredXpodOidcIssuer();
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
  }, [runtime]);

  const exposedSession = useMemo(() => ({
    ...runtime.session,
    fetch: exposedFetch,
    getSnapshot: () => snapshotRef.current,
  }), [exposedFetch, runtime.session]);

  useEffect(() => {
    return runtime.session.subscribe((nextSnapshot) => {
      const nextIssuer = runtime.getIssuer();
      if (!isCurrentXpodSessionSnapshot(nextSnapshot, nextIssuer)) {
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
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
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
  }, [clearRejectedSession, runtime]);

  useEffect(() => {
    let active = true;
    const currentSnapshot = runtime.session.getSnapshot();
    const initialization = currentSnapshot.status === 'initializing'
      ? runtime.session.initialize({ restorePreviousSession: true })
      : Promise.resolve(currentSnapshot);
    void initialization.then(async (nextSnapshot) => {
      const nextIssuer = runtime.getIssuer();
      if (!isCurrentXpodSessionSnapshot(nextSnapshot, nextIssuer)) {
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
  }, [clearRejectedSession, runtime]);

  useEffect(() => {
    if (snapshot.status !== 'authenticated') {
      return;
    }

    let cancelled = false;
    const rememberedBinding = readXpodSelectedStorage({
      origin: typeof window === 'undefined' ? undefined : window.location.origin,
      webId: snapshot.webId,
    });
    if (!rememberedBinding) {
      // Xpod no longer guesses a Pod from profile storage. A public WebID-only
      // session remains valid, while Pod-backed routes wait for an explicit
      // Account binding selected through consent or callback state.
      runtime.pod.clear({ webId: snapshot.webId });
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
        if (!await rememberedBindingStillOwned(rememberedBinding, accountIsLoggedIn, accountBindingsUrl)) {
          if (!cancelled) {
            clearXpodSelectedStorage();
            runtime.pod.clear({ webId: snapshot.webId });
            setCurrentPod(undefined);
            setSelectedStorage(undefined);
            setPodError({ webId: snapshot.webId, error: new Error('Selected Pod binding is no longer available') });
          }
          return;
        }
        const opened = await runtime.pod.open(openArgs);
        if (!cancelled) {
          if (rememberedBinding && (
            opened.webId !== rememberedBinding.webId
            || !sameUrl(opened.podUrl, rememberedBinding.storageUrl)
          )) {
            clearXpodSelectedStorage();
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
  }, [accountBindingsUrl, accountIsLoggedIn, exposedFetch, runtime, snapshot]);

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
      ? podError.error
      : undefined;
    const state = activePodError
      ? { status: 'error', webId: snapshot.webId, podUrl: currentPod?.podUrl, issuer: activeIssuer, error: activePodError } as const
      : snapshotToState(snapshot, currentPod, activeIssuer);

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
      aiClientConfiguration,
      accountClientCredentialsUrl,
      login: async (transaction: WebIdLoginTransaction) => {
        const validated = normalizeXpodLoginTransaction(transaction);
        const oidcIssuer = normalizeXpodOidcIssuer(validated.route.identityProvider.url);
        if (!oidcIssuer) throw new TypeError('Xpod login route has no valid current-origin issuer');
        const redirectUrl = new URL('/auth/callback', window.location.origin);
        redirectUrl.searchParams.set('transaction', validated.id);
        runtime.setIssuer(oidcIssuer);
        setIssuer(oidcIssuer);
        await runtime.session.login({
          oidcIssuer,
          redirectUrl: redirectUrl.toString(),
        });
      },
      logout: async () => {
        await runtime.session.logout();
        runtime.pod.clear();
        clearXpodSelectedStorage();
        clearStoredXpodOidcIssuer();
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setAiClientConfiguration(undefined);
        setAccountClientCredentialsUrl(undefined);
      },
    };
  }, [accountClientCredentialsUrl, aiClientConfiguration, currentPod, exposedFetch, exposedSession, issuer, podError, runtime, selectedStorage, snapshot]);

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

function currentProviderSession(runtime: XpodSolidRuntimeCore): {
  snapshot: SolidSessionSnapshot;
  issuer: string | undefined;
  rejected: boolean;
} {
  const snapshot = runtime.session.getSnapshot();
  const issuer = runtime.getIssuer();
  return isCurrentXpodSessionSnapshot(snapshot, issuer)
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
): Promise<boolean> {
  if (!accountIsLoggedIn || !accountBindingsUrl) {
    return true;
  }

  const bindings = await fetchAccountStorageBindings({
    controls: { account: { bindings: accountBindingsUrl } },
    origin: typeof window === 'undefined' ? undefined : window.location.origin,
  });
  return bindings.some((candidate) => storageBindingKey(candidate) === storageBindingKey(binding));
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
