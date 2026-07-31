import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import {
  XpodSettingsLayout,
} from './layout/XpodSettingsLayout';
import { legacyDashboardRedirects } from './layout/settings-navigation';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const SettingsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.SettingsPage })));
const StatusPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.StatusPage })));
const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const PodPage = lazy(() => import('./pages/settings/PodPage'));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const ServicesPage = lazy(() => import('./pages/settings/ServicesPage'));

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
        element: guardedRoute(lazyRoute(<NetworkPage />)),
      },
      {
        path: 'services',
        element: guardedRoute(lazyRoute(<ServicesPage />)),
        children: [
          { index: true, element: lazyRoute(<StatusPage />) },
          { path: 'runtime', element: lazyRoute(<StatusPage />) },
          { path: 'logs', element: lazyRoute(<LogsPage />) },
          { path: 'rdf', element: lazyRoute(<RdfPage />) },
          { path: 'configuration', element: lazyRoute(<SettingsPage />) },
        ],
      },
      { path: 'status', element: <Navigate to={legacyDashboardRedirects.status} replace /> },
      { path: 'logs', element: <Navigate to={legacyDashboardRedirects.logs} replace /> },
      { path: 'rdf', element: <Navigate to={legacyDashboardRedirects.rdf} replace /> },
      { path: 'settings', element: <Navigate to={legacyDashboardRedirects.settings} replace /> },
      { path: '*', element: <Navigate to="/models" replace /> },
    ],
  },
];
