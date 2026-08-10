import { SolidAuthBoundary } from '@undefineds.co/extension-sdk/react';
import type { WebIdAuthState } from '@undefineds.co/solid-sdk';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { createXpodLoginController } from '../auth/XpodLoginController';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';

export function XpodPodReadinessBoundary({ children }: { children: ReactNode }) {
  const runtime = useXpodSolidRuntime();
  const controller = useMemo(() => createXpodLoginController({ runtime }), [runtime]);
  const state = runtimeState(runtime.state);
  const statePodUrl = runtime.state.status === 'authenticated' ? runtime.state.podUrl : undefined;
  const podReady = state.status === 'authenticated'
    && runtime.currentPod !== undefined
    && runtime.currentPod.webId === state.webId
    && (statePodUrl === undefined || sameUrl(runtime.currentPod.podUrl, statePodUrl))
    && selectedBindingMatches(runtime.currentPod, runtime.selectedStorage);

  if (podReady) {
    return <>{children}</>;
  }

  if (state.status === 'authenticated' && runtime.currentPod === undefined) {
    return <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground">Preparing Pod</div>;
  }

  const reconnectState = state.status === 'authenticated' ? { status: 'anonymous' as const } : state;

  return (
    <SolidAuthBoundary
      state={reconnectState}
      routes={controller.routes}
      onLogin={(routeId) => {
        if (routeId === controller.routes[0]?.id) void controller.startLogin();
      }}
      onRetry={(routeId) => {
        if (routeId === controller.routes[0]?.id) void controller.retryLogin();
      }}
      onCancel={controller.cancelLogin}
      copy={{
        route: {
          title: 'Xpod',
          description: 'Continue with the current Xpod identity and Pod.',
          restoringLabel: 'Restoring Xpod session…',
          failureTitle: 'Could not connect to Xpod',
        },
      }}
    >
      {children}
    </SolidAuthBoundary>
  );
}

function selectedBindingMatches(
  currentPod: { webId: string; podUrl: string },
  selectedStorage?: { webId: string; storageUrl: string },
): boolean {
  const binding = selectedStorage ?? {
    webId: currentPod.webId,
    storageUrl: currentPod.podUrl,
  };
  return binding.webId === currentPod.webId && sameUrl(binding.storageUrl, currentPod.podUrl);
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

/** @deprecated Use XpodPodReadinessBoundary in Pod-backed routes. */
export function SettingsAuthBoundary({
  children,
}: {
  children: ReactNode;
  product?: 'Dashboard' | 'Settings';
}) {
  return <XpodPodReadinessBoundary>{children}</XpodPodReadinessBoundary>;
}

function runtimeState(state: ReturnType<typeof useXpodSolidRuntime>['state']): WebIdAuthState {
  switch (state.status) {
    case 'loading':
      return { status: 'restoring' };
    case 'anonymous':
      return { status: 'anonymous' };
    case 'expired':
      return { status: 'expired' };
    case 'authenticated':
      return { status: 'authenticated', webId: state.webId };
    case 'error':
      return { status: 'error', message: state.error.message, retryRouteId: 'xpod-current-origin' };
  }
}
