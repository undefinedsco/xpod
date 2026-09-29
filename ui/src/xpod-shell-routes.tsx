import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { AccountWorkspaceBoundary, LocalServiceSurfaceBoundary } from './auth/AccountAuthBoundary';
import { XPOD_DEFAULT_RETURN_PATH } from './routes/canonical-routes';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';

/**
 * One route tree for every desktop rail destination.
 *
 * The server still exposes the historical dashboard/settings entry documents,
 * but both documents mount this route tree. Rail navigation can therefore keep
 * the same React tree, Account session, and WebID session alive.
 */
export const xpodShellRoutes: RouteObject[] = [
  // `/status` is the local service/diagnostics surface. Its panels read
  // loopback-only runtime evidence (`/service/status`, `/api/admin/*`), so an
  // anonymous visitor keeps the whole surface instead of being asked to sign in.
  // The desktop tray's explicit `?account=open` entry still reaches the Account
  // surface through LocalServiceSurfaceBoundary.
  { path: 'status', element: <LocalServiceSurfaceBoundary><Outlet /></LocalServiceSurfaceBoundary>, children: statusSurfaceRoutes },
  { path: 'network', children: networkSurfaceRoutes },
  { path: 'ai-connections', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConnectionsSurfaceRoutes },
  { path: 'ai-config', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConfigSurfaceRoutes },
  { path: 'settings', children: systemSettingsSurfaceRoutes },

  // Keep the older embedded route trees reachable for bookmarks while all
  // canonical rail links point at the product-level routes above.
  { path: 'dashboard', element: <AccountWorkspaceBoundary><Outlet /></AccountWorkspaceBoundary>, children: dashboardRoutes },

  // Opening the product starts the WebID workspace, not the Account-protected
  // one: the legacy `/dashboard` tree asks for an Account only once visited,
  // while `/status` stays a local surface.
  { index: true, element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
  { path: '*', element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
];
