import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { AccountWorkspaceBoundary } from './auth/AccountAuthBoundary';
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
  { path: 'status', element: <AccountWorkspaceBoundary><Outlet /></AccountWorkspaceBoundary>, children: statusSurfaceRoutes },
  { path: 'network', children: networkSurfaceRoutes },
  { path: 'ai-connections', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConnectionsSurfaceRoutes },
  { path: 'ai-config', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConfigSurfaceRoutes },
  { path: 'settings', children: systemSettingsSurfaceRoutes },

  // Keep the older embedded route trees reachable for bookmarks while all
  // canonical rail links point at the product-level routes above.
  { path: 'dashboard', element: <AccountWorkspaceBoundary><Outlet /></AccountWorkspaceBoundary>, children: dashboardRoutes },

  // Opening the product starts the WebID workspace, not the Account-protected
  // one: `/status` and `/dashboard` ask for an Account only once visited.
  { index: true, element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
  { path: '*', element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
];
