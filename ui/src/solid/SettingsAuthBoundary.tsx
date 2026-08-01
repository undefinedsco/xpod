import { AuthBoundary } from '@undefineds.co/extension-sdk/react';
import type { ReactNode } from 'react';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';

export function SettingsAuthBoundary({
  children,
  product = 'Settings',
}: {
  children: ReactNode;
  product?: 'Dashboard' | 'Settings';
}) {
  const runtime = useXpodSolidRuntime();
  const boundaryState =
    runtime.state.status === 'loading'
      ? { status: 'loading' as const }
      : runtime.state.status === 'authenticated'
        ? { status: 'authenticated' as const }
        : runtime.state.status === 'error'
          ? { status: 'error' as const, message: runtime.state.error.message }
          : { status: 'anonymous' as const };

  return (
    <AuthBoundary
      state={boundaryState}
      login={runtime.login}
      loginView={{
        title: `Connect Xpod ${product}`,
        description: product === 'Dashboard'
          ? 'Use your Solid identity to inspect Xpod status, runtime, logs, RDF, network, and usage.'
          : 'Use your Solid identity to manage model, Pod, network, and service settings.',
        defaultIssuer: window.location.origin,
      }}
    >
      {children}
    </AuthBoundary>
  );
}
