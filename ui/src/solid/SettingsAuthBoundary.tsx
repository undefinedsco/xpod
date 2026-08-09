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
        title: 'Xpod',
        description: product === 'Dashboard'
          ? '使用 Solid 身份查看 Xpod 状态、运行时、日志、RDF、网络与用量。'
          : '使用 Solid 身份管理模型、Pod、网络与服务设置。',
        defaultIssuer: window.location.origin,
        spaceProviders: {
          cloud: {
            id: 'https://id.undefineds.co',
            label: 'Cloud',
            subtitle: 'id.undefineds.co',
          },
          local: {
            id: window.location.origin,
            label: 'Local',
            subtitle: window.location.host,
          },
        },
        providers: [
          {
            id: 'https://id.undefineds.co',
            label: 'undefineds Cloud',
            subtitle: 'id.undefineds.co',
            badge: { label: '云端', tone: 'primary' },
          },
          {
            id: window.location.origin,
            label: '当前 Xpod',
            subtitle: window.location.host,
            badge: { label: '本机', tone: 'neutral' },
          },
        ],
        onAddProvider: (url) => void runtime.login(url),
      }}
    >
      {children}
    </AuthBoundary>
  );
}
