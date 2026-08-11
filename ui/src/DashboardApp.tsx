import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import { canonicalProductPathname, surfaceForPathname } from './routes/canonical-routes';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import './index.css';

function DashboardRoutes({ routes }: { routes: typeof dashboardRoutes }) {
  return useRoutes(routes);
}

export function DashboardApp({ runtime }: { runtime?: XpodSolidRuntimeCore } = {}) {
  const currentPathname = globalThis.location?.pathname ?? '/dashboard';
  const pathname = canonicalProductPathname(currentPathname);
  if (pathname !== currentPathname) globalThis.history?.replaceState(null, '', `${pathname}${globalThis.location?.search ?? ''}${globalThis.location?.hash ?? ''}`);
  const surface = surfaceForPathname(pathname);
  const routes = surface.basename === '/status'
    ? statusSurfaceRoutes
    : surface.basename === '/network'
      ? networkSurfaceRoutes
      : dashboardRoutes;
  return (
    <XpodAuthProvider runtime={runtime}>
      <BrowserRouter basename={surface.basename}>
        <DashboardRoutes routes={routes} />
      </BrowserRouter>
    </XpodAuthProvider>
  );
}
