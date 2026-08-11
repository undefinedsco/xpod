import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { WebIdAuthBoundary } from './solid/SettingsAuthBoundary';

const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const PodPage = lazy(() => import('./pages/settings/PodPage'));
const ServicesPage = lazy(() => import('./pages/settings/ServicesPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage').then((module) => ({ default: module.SettingsPage })));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

function podRoute(element: React.ReactNode) {
  return <WebIdAuthBoundary>{element}</WebIdAuthBoundary>;
}

export const settingsRoutes: RouteObject[] = [
  {
    element: <XpodSettingsLayout />,
    children: [
      { index: true, element: <Navigate to="models" replace /> },
      { path: 'models', element: podRoute(lazyRoute(<ModelsPage />)) },
      { path: 'pod', element: podRoute(lazyRoute(<PodPage view="settings" />)) },
      {
        path: 'network',
        element: lazyRoute(<ServicesPage product="settings" />),
        children: [{ index: true, element: lazyRoute(<SettingsPage />) }],
      },
      {
        path: 'services',
        element: lazyRoute(<ServicesPage product="settings" />),
        children: [
          { index: true, element: lazyRoute(<SettingsPage />) },
          { path: 'configuration', element: lazyRoute(<SettingsPage />) },
        ],
      },
      { path: '*', element: <Navigate to="../models" replace /> },
    ],
  },
];
