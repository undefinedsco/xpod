import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import {
  aiConfigSurfaceRoutes,
  aiConnectionsSurfaceRoutes,
  systemSettingsSurfaceRoutes,
} from './settings-routes';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';

/**
 * One route tree for every desktop rail destination.
 *
 * The server still exposes the historical dashboard/settings entry documents,
 * but both documents mount this route tree. Rail navigation can therefore keep
 * the same React tree, Account session, and WebID session alive.
 */
export const xpodShellRoutes: RouteObject[] = [
  { path: 'status', element: <AccountAuthBoundary><Outlet /></AccountAuthBoundary>, children: statusSurfaceRoutes },
  { path: 'network', children: networkSurfaceRoutes },
  { path: 'ai-connections', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConnectionsSurfaceRoutes },
  { path: 'ai-config', element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: aiConfigSurfaceRoutes },
  { path: 'settings', children: systemSettingsSurfaceRoutes },

  // Keep the older embedded route trees reachable for bookmarks while all
  // canonical rail links point at the product-level routes above.
  { path: 'dashboard', element: <AccountAuthBoundary><Outlet /></AccountAuthBoundary>, children: dashboardRoutes },

  { index: true, element: <Navigate to="/status/overview" replace /> },
  { path: '*', element: <Navigate to="/status/overview" replace /> },
];
