import { AuthSurface, Button } from '@undefineds.co/shared-ui';
import type { AccountAuthState } from '../context/AuthContextValue';
import { Loader2 } from 'lucide-react';
import { type ReactNode } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { XpodLoginBrand } from './XpodLoginBrand';
import { getXpodAuthSurfaceHost } from './xpod-auth-surface-host';

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
  const state = accountStateOverride ?? account.accountState;
  const retry = retryOverride ?? account.retry;
  const startLogin = () => {
    window.location.assign(accountLoginUrl(account.idpIndex));
  };

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'submitting') {
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
          使用 Xpod 账号登录 Dashboard。
        </p>
        <Button className="w-full" type="button" onClick={startLogin}>
          登录
        </Button>
      </div>
    </LoginSurface>
  );
}

export function accountLoginUrl(idpIndex: string, origin = window.location.origin): string {
  return new URL('login/password/', new URL(idpIndex, origin)).href;
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
