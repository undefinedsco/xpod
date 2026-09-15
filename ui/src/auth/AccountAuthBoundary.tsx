import { DesktopLoginReturnAction } from './DesktopLoginReturnAction';
import { Button } from '@undefineds.co/shared-ui';
import type { AccountAuthState } from '../context/AuthContextValue';
import { Loader2 } from 'lucide-react';
import { type ReactNode } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { AccountEntryLinks, XpodAccountCredentials } from './XpodAccountCredentials';
import { XpodAccountPageSurface } from './XpodAuthSurface';
import { WebAccountLayout } from './WebAccountLayout';
import { useXpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';

export function AccountWorkspaceBoundary({ children }: { children: ReactNode }) {
  const runtime = useXpodSolidRuntimeContext();
  // WebID authentication preserves navigation, never Account authorization.
  // The workspace's inner Account boundary protects the service content.
  return runtime.state.status === 'authenticated'
    ? <>{children}</>
    : <AccountAuthBoundary>{children}</AccountAuthBoundary>;
}

export interface AccountAuthBoundaryProps {
  children?: ReactNode;
  accountState?: AccountAuthState;
  retry?: () => void | Promise<void>;
  surface?: 'page' | 'embedded';
}

export function AccountAuthBoundary({
  children,
  accountState: accountStateOverride,
  retry: retryOverride,
  surface = 'page',
}: AccountAuthBoundaryProps) {
  const account = useAuth();
  const state = accountStateOverride ?? account.accountState;
  const retry = retryOverride ?? account.retry;

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'submitting') {
    return (
      <LoginSurface surface={surface}>
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在登录…
        </div>
      </LoginSurface>
    );
  }

  if (state.status === 'initializing') {
    return (
      <LoginSurface surface={surface}>
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在加载账号
        </div>
      </LoginSurface>
    );
  }

  if (state.status === 'error') {
    return (
      <LoginSurface surface={surface}>
        <div className="space-y-4 p-6">
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
          <Button className="w-full" type="button" onClick={() => void retry()}>重试</Button>
          <DesktopLoginReturnAction />
        </div>
      </LoginSurface>
    );
  }

  return surface === 'embedded'
    ? <LoginSurface surface={surface}>
      <XpodAccountCredentials surface="embedded" />
      <div className="mt-6 space-y-3 border-t pt-5"><AccountEntryLinks /></div>
    </LoginSurface>
    : <XpodAccountCredentials surface="page" />;
}

function LoginSurface({ children, surface }: { children: ReactNode; surface: 'page' | 'embedded' }) {
  if (surface === 'embedded') {
    return <WebAccountLayout title="登录 Xpod" presentation="compact">{children}</WebAccountLayout>;
  }
  return (
    <XpodAccountPageSurface title="登录 Xpod" presentation="compact">
      {children}
    </XpodAccountPageSurface>
  );
}
