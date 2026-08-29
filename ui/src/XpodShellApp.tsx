import { Toaster } from '@undefineds.co/shared-ui';
import { useEffect, useState } from 'react';
import { BrowserRouter, useLocation, useRoutes } from 'react-router-dom';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import { canonicalProductPathname } from './routes/canonical-routes';
import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import { XpodThemeRoot } from './theme/XpodThemeRoot';
import { xpodShellRoutes } from './xpod-shell-routes';

export interface XpodShellAppProps {
  runtime?: XpodSolidRuntimeCore;
  initialPathname?: string;
}

function XpodShellRoutes() {
  const location = useLocation();
  const routes = useRoutes(xpodShellRoutes);

  useEffect(() => {
    document.title = location.pathname.startsWith('/status')
      ? 'Xpod Dashboard'
      : 'Xpod Settings';
  }, [location.pathname]);

  useEffect(() => {
    globalThis.xpodDesktop?.setWindowMode?.('workspace');
  }, []);

  return routes;
}

export function XpodShellApp({ runtime, initialPathname }: XpodShellAppProps = {}) {
  // The callback document may hand the shell its post-login destination.
  // Apply that hand-off exactly once: after BrowserRouter takes ownership,
  // rail navigation must never be overwritten by the original callback path.
  const [initialLocation] = useState(() => initializeProductLocation(initialPathname));

  return (
    <XpodThemeRoot>
      <XpodAuthProvider runtime={runtime}>
        <BrowserRouter key={initialLocation}>
          <XpodShellRoutes />
          <Toaster />
        </BrowserRouter>
      </XpodAuthProvider>
    </XpodThemeRoot>
  );
}

function initializeProductLocation(initialPathname?: string): string {
  const requestedPathname = canonicalProductPathname(
    initialPathname ?? globalThis.location?.pathname ?? '/status/overview',
  );
  const target = `${requestedPathname}${globalThis.location?.search ?? ''}${globalThis.location?.hash ?? ''}`;
  const current = `${globalThis.location?.pathname ?? ''}${globalThis.location?.search ?? ''}${globalThis.location?.hash ?? ''}`;
  if (current !== target) globalThis.history?.replaceState(null, '', target);
  return target;
}
