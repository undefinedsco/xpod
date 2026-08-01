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

function guardedRoute(element: React.ReactNode) {
  return <SettingsAuthBoundary>{element}</SettingsAuthBoundary>;
}

export const dashboardRoutes: RouteObject[] = [
  {
    element: <XpodDashboardLayout />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      {
        path: 'overview',
        element: guardedRoute(lazyRoute(<ServicesPage />)),
        children: [{ index: true, element: lazyRoute(<StatusPage />) }],
      },
      {
        path: 'runtime',
        element: guardedRoute(lazyRoute(<ServicesPage />)),
        children: [{ index: true, element: lazyRoute(<StatusPage />) }],
      },
      { path: 'logs', element: guardedRoute(lazyRoute(<LogsPage />)) },
      { path: 'rdf', element: guardedRoute(lazyRoute(<RdfPage />)) },
      {
        path: 'network',
        element: guardedRoute(lazyRoute(<NetworkPage />)),
      },
      {
        path: 'usage',
        element: guardedRoute(lazyRoute(<PodPage />)),
      },
      { path: 'status', element: <Navigate to="/overview" replace /> },
      { path: '*', element: <Navigate to="/overview" replace /> },
    ],
  },
];
