import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { WebIdAuthBoundary } from './solid/SettingsAuthBoundary';

const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const AiConfigPage = lazy(() => import('./pages/settings/AiConfigPage'));
const ModelAssignmentsPanel = lazy(() => import('./pages/settings/ai-config/ModelAssignmentsPanel').then((module) => ({ default: module.ModelAssignmentsPanel })));
const DocumentProcessingPanel = lazy(() => import('./pages/settings/ai-config/DocumentProcessingPanel').then((module) => ({ default: module.DocumentProcessingPanel })));
const SearchIndexingPanel = lazy(() => import('./pages/settings/ai-config/SearchIndexingPanel').then((module) => ({ default: module.SearchIndexingPanel })));
const IndexLifecyclePanel = lazy(() => import('./pages/settings/ai-config/IndexLifecyclePanel').then((module) => ({ default: module.IndexLifecyclePanel })));
const PodPage = lazy(() => import('./pages/settings/PodPage'));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const ServicesPage = lazy(() => import('./pages/settings/ServicesPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const SystemSettingsPage = lazy(() => import('./pages/settings/SystemSettingsPage'));
const PodSettingsSubjectPanel = lazy(() => import('./pages/settings/SystemSettingsSubjectPanel').then((module) => ({ default: module.PodSettingsSubjectPanel })));

function lazyRoute(element: React.ReactNode) {
  return <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading settings...</div>}>{element}</Suspense>;
}

function webIdRoute(element: React.ReactNode) {
  return <WebIdAuthBoundary>{element}</WebIdAuthBoundary>;
}

export const settingsRoutes: RouteObject[] = [
  {
    element: <XpodSettingsLayout />,
    children: [
      { index: true, element: <Navigate to="models" replace /> },
      { path: 'models', element: webIdRoute(lazyRoute(<ModelsPage />)) },
      {
        path: 'ai-config',
        element: webIdRoute(lazyRoute(<AiConfigPage />)),
        children: [
          { index: true, element: <Navigate to="model-assignments" replace /> },
          { path: 'model-assignments', element: lazyRoute(<ModelAssignmentsPanel />) },
          { path: 'document-processing', element: lazyRoute(<DocumentProcessingPanel />) },
          { path: 'search-indexing', element: lazyRoute(<SearchIndexingPanel />) },
          { path: 'index-lifecycle', element: lazyRoute(<IndexLifecyclePanel />) },
        ],
      },
      { path: 'pod', element: webIdRoute(lazyRoute(<PodPage view="settings" />)) },
      {
        path: 'network',
        element: lazyRoute(<NetworkPage />),
      },
      {
        path: 'services',
        element: lazyRoute(<ServicesPage product="settings" />),
        children: [
          { index: true, element: lazyRoute(<SettingsPage />) },
          { path: 'configuration', element: lazyRoute(<SettingsPage />) },
        ],
      },
      {
        path: 'system',
        element: lazyRoute(<SystemSettingsPage />),
        children: [
          { index: true, element: <Navigate to="pod" replace /> },
          { path: 'pod', element: webIdRoute(lazyRoute(<PodSettingsSubjectPanel kind="pod" />)) },
          { path: 'identity-access', element: webIdRoute(lazyRoute(<PodSettingsSubjectPanel kind="identity-access" />)) },
          { path: 'storage', element: lazyRoute(<PodSettingsSubjectPanel kind="storage" />) },
          { path: 'runtime', element: lazyRoute(<PodSettingsSubjectPanel kind="runtime" />) },
          { path: 'cloud', element: lazyRoute(<PodSettingsSubjectPanel kind="cloud" />) },
          { path: 'advanced', element: lazyRoute(<PodSettingsSubjectPanel kind="advanced" />) },
        ],
      },
      { path: '*', element: <Navigate to="../models" replace /> },
    ],
  },
];

export const aiConnectionsSurfaceRoutes: RouteObject[] = [{
  element: <XpodSettingsLayout />,
  children: [
    { index: true, element: webIdRoute(lazyRoute(<ModelsPage />)) },
    { path: '*', element: <Navigate to="." replace /> },
  ],
}];

export const aiConfigSurfaceRoutes: RouteObject[] = [{
  element: <XpodSettingsLayout />,
  children: [{
    element: webIdRoute(lazyRoute(<AiConfigPage />)),
    children: [
      { index: true, element: <Navigate to="model-assignments" replace /> },
      { path: 'model-assignments', element: lazyRoute(<ModelAssignmentsPanel />) },
      { path: 'document-processing', element: lazyRoute(<DocumentProcessingPanel />) },
      { path: 'search-indexing', element: lazyRoute(<SearchIndexingPanel />) },
      { path: 'index-lifecycle', element: lazyRoute(<IndexLifecyclePanel />) },
      { path: '*', element: <Navigate to="model-assignments" replace /> },
    ],
  }],
}];

export const systemSettingsSurfaceRoutes: RouteObject[] = [{
  element: <XpodSettingsLayout />,
  children: [{
    element: lazyRoute(<SystemSettingsPage />),
    children: [
      { index: true, element: <Navigate to="pod" replace /> },
      { path: 'pod', element: webIdRoute(lazyRoute(<PodSettingsSubjectPanel kind="pod" />)) },
      { path: 'identity-access', element: webIdRoute(lazyRoute(<PodSettingsSubjectPanel kind="identity-access" />)) },
      { path: 'storage', element: lazyRoute(<PodSettingsSubjectPanel kind="storage" />) },
      { path: 'runtime', element: lazyRoute(<PodSettingsSubjectPanel kind="runtime" />) },
      { path: 'cloud', element: lazyRoute(<PodSettingsSubjectPanel kind="cloud" />) },
      { path: 'advanced', element: lazyRoute(<PodSettingsSubjectPanel kind="advanced" />) },
      { path: '*', element: <Navigate to="pod" replace /> },
    ],
  }],
}];
