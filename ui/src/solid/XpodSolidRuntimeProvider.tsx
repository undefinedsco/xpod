import { SolidRuntimeProvider, type OpenPodRuntime, type StorageBinding } from '@undefineds.co/solid-sdk';
import { type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import type { WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  getXpodSolidRuntimeValue,
  initializedRuntimes,
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
  const [snapshot, setSnapshot] = useState(() => runtime.session.getSnapshot());
  const [issuer, setIssuer] = useState(() => runtime.getIssuer());
  const [currentPod, setCurrentPod] = useState<OpenPodRuntime<SolidDatabase>>();
  const [selectedStorage, setSelectedStorage] = useState<StorageBinding>();
  const [podError, setPodError] = useState<{ webId: string; error: Error }>();
  const [aiClientConfiguration, setAiClientConfiguration] =
    useState<Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>>();
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    return runtime.session.subscribe((nextSnapshot) => {
      const previousSnapshot = snapshotRef.current;
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setIssuer(runtime.getIssuer());
      if (nextSnapshot.status !== 'authenticated') {
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
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
    });
  }, [runtime]);

  useEffect(() => {
    if (initializedRuntimes.has(runtime)) {
      return;
    }
    initializedRuntimes.add(runtime);
    void runtime.session.initialize({ restorePreviousSession: true }).then((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setIssuer(runtime.getIssuer());
    });
  }, [runtime]);

  useEffect(() => {
    if (snapshot.status !== 'authenticated') {
      return;
    }

    let cancelled = false;
    void runtime.pod.open({ webId: snapshot.webId, fetch: runtime.session.fetch }).then(
      (opened) => {
        if (!cancelled) {
          setCurrentPod(opened);
          setSelectedStorage({ webId: opened.webId, storageUrl: opened.podUrl });
          setPodError(undefined);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setPodError({
            webId: snapshot.webId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [runtime, snapshot]);

  const authenticatedWebId = snapshot.status === 'authenticated' ? snapshot.webId : undefined;

  useEffect(() => {
    if (!authenticatedWebId) return;
    let cancelled = false;
    void discoverAiClientConfigurationCapability(runtime.session.fetch).then((capability) => {
      if (!cancelled && runtime.session.getSnapshot().status === 'authenticated' &&
        runtime.session.getSnapshot().webId === authenticatedWebId) {
        setAiClientConfiguration(capability);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [authenticatedWebId, runtime]);

  const xpodRuntime = useMemo<XpodSolidRuntimeValue>(() => {
    const activeIssuer = issuer ?? runtime.getIssuer();
    const activePodError = snapshot.status === 'authenticated' && podError?.webId === snapshot.webId
      ? podError.error
      : undefined;
    const state = activePodError
      ? { status: 'error', webId: snapshot.webId, podUrl: currentPod?.podUrl, issuer: activeIssuer, error: activePodError } as const
      : snapshotToState(snapshot, currentPod, activeIssuer);

    return {
      session: runtime.session,
      pod: runtime.pod,
      fetch: runtime.session.fetch,
      state: state.status === 'error' ? { ...state, error: safeAuthError(state.error) } : state,
      webId: state.webId,
      podUrl: state.podUrl,
      issuer: state.issuer,
      currentPod,
      selectedStorage,
      aiClientConfiguration,
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
        runtime.pod.clear();
        setCurrentPod(undefined);
        setSelectedStorage(undefined);
        setAiClientConfiguration(undefined);
        await runtime.session.logout();
      },
    };
  }, [aiClientConfiguration, currentPod, issuer, podError, runtime, selectedStorage, snapshot]);

  return (
    <SolidRuntimeProvider value={{ session: runtime.session, pod: runtime.pod, currentPod }}>
      <XpodSolidRuntimeContext.Provider value={xpodRuntime}>
        {children}
      </XpodSolidRuntimeContext.Provider>
    </SolidRuntimeProvider>
  );
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
