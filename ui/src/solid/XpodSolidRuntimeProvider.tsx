import { SolidRuntimeProvider, type OpenPodRuntime } from '@undefineds.co/solid-sdk';
import { type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getXpodSolidRuntimeValue,
  initializedRuntimes,
  normalizeXpodOidcIssuer,
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
  const [podError, setPodError] = useState<{ webId: string; error: Error }>();

  useEffect(() => {
    return runtime.session.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setIssuer(runtime.getIssuer());
      if (nextSnapshot.status !== 'authenticated') {
        setCurrentPod(undefined);
        setPodError(undefined);
        runtime.pod.clear();
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
      login: async (issuer: string) => {
        const oidcIssuer = normalizeXpodOidcIssuer(issuer);
        if (!oidcIssuer) {
          return;
        }
        runtime.setIssuer(oidcIssuer);
        setIssuer(oidcIssuer);
        await runtime.session.login({
          oidcIssuer,
          redirectUrl: window.location.href,
        });
      },
      logout: async () => {
        runtime.pod.clear();
        setCurrentPod(undefined);
        await runtime.session.logout();
      },
    };
  }, [currentPod, issuer, podError, runtime, snapshot]);

  return (
    <SolidRuntimeProvider value={{ session: runtime.session, pod: runtime.pod, currentPod }}>
      <XpodSolidRuntimeContext.Provider value={xpodRuntime}>
        {children}
      </XpodSolidRuntimeContext.Provider>
    </SolidRuntimeProvider>
  );
}
