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
  const configuredIssuer = import.meta.env.VITE_XPOD_OIDC_ISSUER?.trim();
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
        title: `登录 Xpod ${product === 'Dashboard' ? 'Dashboard' : '设置'}`,
        description: product === 'Dashboard'
          ? '使用 Solid 身份查看 Xpod 状态、运行时、日志、RDF、网络与用量。'
          : '使用 Solid 身份管理模型、Pod、网络与服务设置。',
        defaultIssuer: configuredIssuer || window.location.origin,
      }}
    >
      {children}
    </AuthBoundary>
  );
}
