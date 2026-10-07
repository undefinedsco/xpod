import { lazy, Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { getXpodAuthSurfaceHost } from './auth/xpod-auth-surface-host';
import type { XpodShellAppProps } from './XpodShellApp';

const DesktopWorkspace = lazy(() => import('./XpodShellApp').then(module => ({ default: module.XpodShellApp })));
const DesktopCallback = lazy(() => import('./DesktopOidcCallback'));
const WebDesktopEntry = lazy(() => import('./pages/WebDesktopEntry'));
const DeletionTask = lazy(() => import('./pages/settings/PodDeletionAuthorizationPanel').then(module => ({ default: module.PodDeletionAuthorizationPanel })));

/** The preload bridge, never viewport or hostname, declares the desktop host. */
export function XpodProductEntry({ callback = false, ...props }: XpodShellAppProps & { callback?: boolean } = {}) {
  const desktop = getXpodAuthSurfaceHost() === 'window';
  const deletionTask = location.pathname === '/settings/pod'
    && new URLSearchParams(location.search).has('deletionAuthorization');
  return <Suspense fallback={<main role="status">正在打开 Xpod…</main>}>
    {desktop
      ? callback ? <DesktopCallback /> : <DesktopWorkspace {...props} />
      : deletionTask
        ? <BrowserRouter><DeletionTask /></BrowserRouter>
        : <WebDesktopEntry />}
  </Suspense>;
}
