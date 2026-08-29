import { AuthSurface, Button } from '@undefineds.co/shared-ui';
import type { AccountAuthState } from '../context/AuthContextValue';
import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { XpodLoginBrand } from './XpodLoginBrand';
import { getXpodAuthSurfaceHost } from './xpod-auth-surface-host';
import { useXpodAuth } from './useXpodAuth';

export interface AccountAuthBoundaryProps {
  children?: ReactNode;
  accountState?: AccountAuthState;
  retry?: () => void | Promise<void>;
}

export function AccountAuthBoundary({
  children,
  accountState: accountStateOverride,
  retry: retryOverride,
}: AccountAuthBoundaryProps) {
  const account = useAuth();
  const xpod = useXpodAuth();
  const state = accountStateOverride ?? account.accountState;
  const retry = retryOverride ?? account.retry;
  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string>();

  const startLogin = async () => {
    if (loginPending) return;
    setLoginPending(true);
    setLoginError(undefined);
    try {
      await xpod.startLogin();
    } catch (error) {
      console.error('[AccountAuthBoundary] unable to start the composed Xpod login', error);
      setLoginError('无法开始 WebID 登录，请重试。');
    } finally {
      setLoginPending(false);
    }
  };

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'submitting' || loginPending) {
    return (
      <LoginSurface>
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在登录…
        </div>
      </LoginSurface>
    );
  }

  if (state.status === 'initializing') {
    return (
      <LoginSurface>
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          正在加载账号
        </div>
      </LoginSurface>
    );
  }

  if (state.status === 'error') {
    return (
      <LoginSurface>
        <div className="space-y-4 p-6">
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
          <Button className="w-full" type="button" onClick={() => void retry()}>重试</Button>
        </div>
      </LoginSurface>
    );
  }

  return (
    <LoginSurface>
      <div className="flex h-full min-h-0 flex-col justify-end gap-4 px-5 pb-5 pt-4">
        <p className="text-center text-sm leading-6 text-muted-foreground">
          登录一次即可访问 Xpod 账号、WebID 和 Pod。
        </p>
        {loginError ? <p role="alert" className="text-center text-sm text-destructive">{loginError}</p> : null}
        <Button className="w-full" type="button" onClick={() => void startLogin()}>
          使用 WebID 登录
        </Button>
      </div>
    </LoginSurface>
  );
}

function LoginSurface({ children }: { children: ReactNode }) {
  return (
    <AuthSurface
      mode="modal"
      title="登录 Xpod"
      presentation="compact"
      host={getXpodAuthSurfaceHost()}
      lead={<XpodLoginBrand compact showSubtitle />}
    >
      {children}
    </AuthSurface>
  );
}
