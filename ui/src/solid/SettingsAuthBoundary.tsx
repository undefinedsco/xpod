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
  const origin = window.location.origin;
  let originHost = origin;
  try {
    originHost = new URL(origin).host;
  } catch {
    // keep the raw origin when it cannot be parsed
  }

  return (
    <AuthBoundary
      state={boundaryState}
      login={runtime.login}
      restoringLabel="正在恢复登录状态"
      loginView={{
        title: `登录 Xpod ${product === 'Dashboard' ? 'Dashboard' : '设置'}`,
        description: product === 'Dashboard'
          ? '使用 Solid 身份查看 Xpod 状态、运行时、日志、RDF、网络与用量。'
          : '使用 Solid 身份管理模型、Pod、网络与服务设置。',
        defaultIssuer: origin,
        providers: [{
          id: origin,
          label: '当前 Xpod',
          subtitle: originHost,
          badge: { label: '本机', tone: 'primary' },
          actionLabel: '登录',
        }],
      }}
    >
      {children}
    </AuthBoundary>
  );
}
