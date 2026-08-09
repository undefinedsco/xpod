import { LoginFailureView, LoginRestoringView, ConnectSurface } from '@undefineds.co/shared-ui';
import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { persistReturnTo } from '../utils/returnTo';

export function AccountBoundary({
  children,
  redirectToLogin = defaultAccountLoginRedirect,
}: {
  children: ReactNode;
  redirectToLogin?: (url: string) => void;
}) {
  const auth = useAuth();
  const location = useLocation();
  const requiresLogin = !auth.isInitializing && !auth.initError && !auth.isLoggedIn;
  useEffect(() => {
    if (!requiresLogin) return;
    persistReturnTo(`${location.pathname}${location.search}${location.hash}`);
    redirectToLogin('/.account/login/password/');
  }, [location.hash, location.pathname, location.search, redirectToLogin, requiresLogin]);

  if (auth.isInitializing) {
    return <ConnectSurface><LoginRestoringView label="正在恢复 Xpod 账号..." /></ConnectSurface>;
  }

  if (auth.initError) {
    return (
      <ConnectSurface>
        <LoginFailureView
          description={auth.initError}
          primaryLabel="重新检查账号"
          onPrimary={() => void auth.refetchControls()}
        />
      </ConnectSurface>
    );
  }

  if (requiresLogin) return null;

  return <>{children}</>;
}

function defaultAccountLoginRedirect(url: string): void {
  globalThis.location?.assign(url);
}
