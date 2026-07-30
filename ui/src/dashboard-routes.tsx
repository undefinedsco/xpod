import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import {
  PlaceholderSettingsSection,
  ServicesHome,
  XpodSettingsLayout,
} from './layout/XpodSettingsLayout';
import { legacyDashboardRedirects } from './layout/settings-navigation';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const SettingsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.SettingsPage })));
const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const PodPage = lazy(() => import('./pages/settings/PodPage'));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

function guardedRoute(element: React.ReactNode) {
  return <SettingsAuthBoundary>{element}</SettingsAuthBoundary>;
}

export const dashboardRoutes: RouteObject[] = [
  {
    element: <XpodSettingsLayout />,
    children: [
      { index: true, element: <Navigate to="/models" replace /> },
      {
        path: 'models',
        element: guardedRoute(lazyRoute(<ModelsPage />)),
      },
      {
        path: 'pod',
        element: guardedRoute(lazyRoute(<PodPage />)),
      },
      {
        path: 'network',
        element: guardedRoute(
          <PlaceholderSettingsSection
            title="Network"
            description="Review network endpoints, DNS, and connectivity settings from the Network applet."
          />,
        ),
      },
      { path: 'services', element: guardedRoute(<ServicesHome />) },
      { path: 'services/logs', element: guardedRoute(lazyRoute(<LogsPage />)) },
      { path: 'services/rdf', element: guardedRoute(lazyRoute(<RdfPage />)) },
      { path: 'services/runtime', element: guardedRoute(lazyRoute(<SettingsPage />)) },
      { path: 'status', element: <Navigate to={legacyDashboardRedirects.status} replace /> },
      { path: 'logs', element: <Navigate to={legacyDashboardRedirects.logs} replace /> },
      { path: 'rdf', element: <Navigate to={legacyDashboardRedirects.rdf} replace /> },
      { path: 'settings', element: <Navigate to={legacyDashboardRedirects.settings} replace /> },
      { path: '*', element: <Navigate to="/models" replace /> },
    ],
  },
];
