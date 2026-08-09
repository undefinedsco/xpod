import { BrowserRouter, useRoutes } from 'react-router-dom';
import { Toaster } from '@undefineds.co/shared-ui';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  settingsRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { canonicalProductPathname, surfaceForPathname } from './routes/canonical-routes';
import type { RouteObject } from 'react-router-dom';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import { AuthProvider } from './context/AuthContext';
import './index.css';

function SettingsRoutes({ routes }: { routes: RouteObject[] }) {
  return useRoutes(routes);
}

export function SettingsApp() {
  const currentPathname = globalThis.location?.pathname ?? '/settings';
  const pathname = canonicalProductPathname(currentPathname);
  if (pathname !== currentPathname) globalThis.history?.replaceState(null, '', `${pathname}${globalThis.location?.search ?? ''}${globalThis.location?.hash ?? ''}`);
  const surface = surfaceForPathname(pathname);
  const routes = surface.basename === '/ai-connections'
    ? aiConnectionsSurfaceRoutes
    : surface.basename === '/ai-config'
      ? aiConfigSurfaceRoutes
      : surface.basename === '/settings'
        ? systemSettingsSurfaceRoutes
        : settingsRoutes;
  return (
    <AuthProvider>
      <XpodSolidRuntimeProvider>
        <BrowserRouter basename={surface.basename}>
          <SettingsRoutes routes={routes} />
        </BrowserRouter>
        <Toaster />
      </XpodSolidRuntimeProvider>
    </AuthProvider>
  );
}
