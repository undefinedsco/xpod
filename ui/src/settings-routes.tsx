import { lazy } from 'react';
import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { XpodSettingsLayout } from './layout/XpodSettingsLayout';
import { RouteLoadingBoundary } from './layout/RouteLoadingBoundary';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';

const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const AiConfigPage = lazy(() => import('./pages/settings/AiConfigPage'));
const ModelAssignmentsPanel = lazy(() => import('./pages/settings/ai-config/ModelAssignmentsPanel').then((module) => ({ default: module.ModelAssignmentsPanel })));
const DocumentProcessingPanel = lazy(() => import('./pages/settings/ai-config/DocumentProcessingPanel').then((module) => ({ default: module.DocumentProcessingPanel })));
const SearchIndexingPanel = lazy(() => import('./pages/settings/ai-config/SearchIndexingPanel').then((module) => ({ default: module.SearchIndexingPanel })));
const IndexLifecyclePanel = lazy(() => import('./pages/settings/ai-config/IndexLifecyclePanel').then((module) => ({ default: module.IndexLifecyclePanel })));
const SystemSettingsPage = lazy(() => import('./pages/settings/SystemSettingsPage'));
const PodSettingsSubjectPanel = lazy(() => import('./pages/settings/SystemSettingsSubjectPanel').then((module) => ({ default: module.PodSettingsSubjectPanel })));

function lazyRoute(element: React.ReactNode) {
  return <RouteLoadingBoundary>{element}</RouteLoadingBoundary>;
}

function systemSettingsPage(children: RouteObject[]): RouteObject {
  return {
    element: <XpodSettingsLayout />,
    children: [{
      element: lazyRoute(<SystemSettingsPage />),
      children,
    }],
  };
}

export const aiConnectionsSurfaceRoutes: RouteObject[] = [{
  element: <XpodSettingsLayout />,
  children: [
    { index: true, element: lazyRoute(<ModelsPage />) },
    { path: '*', element: <Navigate to="." replace /> },
  ],
}];

export const aiConfigSurfaceRoutes: RouteObject[] = [{
  element: <XpodSettingsLayout />,
  children: [{
    element: lazyRoute(<AiConfigPage />),
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

export const systemSettingsSurfaceRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="pod" replace /> },
  {
    // Pod 管理由 Account 管理边界准入（设计第二部分 §4.1 / U08）：零 Pod、WebID 过期
    // 时仍必须能进入这里管理机器与创建/绑定 Pod。只有访问 Pod 数据的动作才需要 WebID
    // （identity-access 与各内容态另行判定），不得让"创建 Pod"依赖"已有 Pod"。
    element: <AccountAuthBoundary surface="embedded"><Outlet /></AccountAuthBoundary>,
    children: [
      systemSettingsPage([
        { path: 'pod', element: lazyRoute(<PodSettingsSubjectPanel kind="pod" />) },
      ]),
    ],
  },
  {
    element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>,
    children: [
      systemSettingsPage([
        { path: 'identity-access', element: lazyRoute(<PodSettingsSubjectPanel kind="identity-access" />) },
      ]),
    ],
  },
  systemSettingsPage([
    { path: 'storage', element: lazyRoute(<PodSettingsSubjectPanel kind="storage" />) },
    { path: 'runtime', element: lazyRoute(<PodSettingsSubjectPanel kind="runtime" />) },
    { path: 'cloud', element: lazyRoute(<PodSettingsSubjectPanel kind="cloud" />) },
    { path: 'advanced', element: lazyRoute(<PodSettingsSubjectPanel kind="advanced" />) },
    { path: '*', element: <Navigate to="pod" replace /> },
  ]),
];
