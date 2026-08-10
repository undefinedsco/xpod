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

  if (state.status === 'authenticated' && runtime.currentPod) {
    return <>{children}</>;
  }

  if (state.status === 'authenticated') {
    return <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground">Preparing Pod</div>;
  }

  return (
    <SolidAuthBoundary
      state={state}
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
