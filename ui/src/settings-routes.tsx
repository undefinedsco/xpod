import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';

const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const PodPage = lazy(() => import('./pages/settings/PodPage'));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const ServicesPage = lazy(() => import('./pages/settings/ServicesPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage').then((module) => ({ default: module.SettingsPage })));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

function guardedRoute(element: React.ReactNode) {
  return <SettingsAuthBoundary>{element}</SettingsAuthBoundary>;
}

export const settingsRoutes: RouteObject[] = [
  {
    element: <XpodSettingsLayout />,
    children: [
      { index: true, element: <Navigate to="/models" replace /> },
      { path: 'models', element: guardedRoute(lazyRoute(<ModelsPage />)) },
      { path: 'pod', element: guardedRoute(lazyRoute(<PodPage />)) },
      { path: 'network', element: guardedRoute(lazyRoute(<NetworkPage />)) },
      {
        path: 'services',
        element: guardedRoute(lazyRoute(<ServicesPage />)),
        children: [
          { index: true, element: lazyRoute(<SettingsPage />) },
          { path: 'configuration', element: lazyRoute(<SettingsPage />) },
        ],
      },
      { path: '*', element: <Navigate to="/models" replace /> },
    ],
  },
];
