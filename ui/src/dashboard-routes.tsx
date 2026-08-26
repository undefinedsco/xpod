import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { XpodDashboardLayout } from './layout/XpodDashboardLayout';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const StatusPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.StatusPage })));
const PodPage = lazy(() => import('./pages/settings/PodPage'));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const ServicesPage = lazy(() => import('./pages/settings/ServicesPage'));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

export const dashboardRoutes: RouteObject[] = [
  {
    element: <SettingsAuthBoundary product="Dashboard"><XpodDashboardLayout /></SettingsAuthBoundary>,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      {
        path: 'overview',
        element: lazyRoute(<ServicesPage product="dashboard" />),
        children: [{ index: true, element: lazyRoute(<StatusPage />) }],
      },
      {
        path: 'runtime',
        element: lazyRoute(<ServicesPage product="dashboard" />),
        children: [{ index: true, element: lazyRoute(<StatusPage />) }],
      },
      { path: 'logs', element: lazyRoute(<LogsPage />) },
      { path: 'rdf', element: lazyRoute(<RdfPage />) },
      {
        path: 'network',
        element: lazyRoute(<NetworkPage />),
      },
      {
        path: 'usage',
        element: lazyRoute(<PodPage view="usage" />),
      },
      { path: 'status', element: <Navigate to="/overview" replace /> },
      { path: '*', element: <Navigate to="/overview" replace /> },
    ],
  },
];
