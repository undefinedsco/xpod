import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import {
  PlaceholderSettingsSection,
  ServicesHome,
  XpodSettingsLayout,
} from './layout/XpodSettingsLayout';
import { legacyDashboardRedirects } from './layout/settings-navigation';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const SettingsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.SettingsPage })));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

export const dashboardRoutes: RouteObject[] = [
  {
    element: <XpodSettingsLayout />,
    children: [
      { index: true, element: <Navigate to="/models" replace /> },
      {
        path: 'models',
        element: (
          <PlaceholderSettingsSection
            title="Models"
            description="Configure model providers and defaults from the model settings applet."
          />
        ),
      },
      {
        path: 'pod',
        element: (
          <PlaceholderSettingsSection
            title="Pod"
            description="Manage Pod storage, profile, and data access settings from the Pod applet."
          />
        ),
      },
      {
        path: 'network',
        element: (
          <PlaceholderSettingsSection
            title="Network"
            description="Review network endpoints, DNS, and connectivity settings from the Network applet."
          />
        ),
      },
      { path: 'services', element: <ServicesHome /> },
      { path: 'services/logs', element: lazyRoute(<LogsPage />) },
      { path: 'services/rdf', element: lazyRoute(<RdfPage />) },
      { path: 'services/runtime', element: lazyRoute(<SettingsPage />) },
      { path: 'status', element: <Navigate to={legacyDashboardRedirects.status} replace /> },
      { path: 'logs', element: <Navigate to={legacyDashboardRedirects.logs} replace /> },
      { path: 'rdf', element: <Navigate to={legacyDashboardRedirects.rdf} replace /> },
      { path: 'settings', element: <Navigate to={legacyDashboardRedirects.settings} replace /> },
      { path: '*', element: <Navigate to="/models" replace /> },
    ],
  },
];
