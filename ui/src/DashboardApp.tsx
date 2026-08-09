import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import { canonicalProductPathname, surfaceForPathname } from './routes/canonical-routes';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import { AuthProvider } from './context/AuthContext';
import './index.css';

function DashboardRoutes({ routes }: { routes: typeof dashboardRoutes }) {
  return useRoutes(routes);
}

export function DashboardApp() {
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
    <AuthProvider>
      <XpodSolidRuntimeProvider>
        <BrowserRouter basename={surface.basename}>
          <DashboardRoutes routes={routes} />
        </BrowserRouter>
      </XpodSolidRuntimeProvider>
    </AuthProvider>
  );
}
