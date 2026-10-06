import { lazy } from 'react';
import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { SubjectWorkspace, AppearancePage, PodSectionPage, WorkspacePage } from './DesktopWorkspaces';
import { XpodProductLayout } from './layout/XpodProductLayout';
import { RouteLoadingBoundary } from './layout/RouteLoadingBoundary';
import { XPOD_DEFAULT_RETURN_PATH, legacyProductRedirects } from './routes/canonical-routes';
import { PodManagementTaskRoute } from './pages/settings/PodDeletionAuthorizationPanel';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';
import { ShellInboxContent, ShellNotificationsContent } from './shell/ShellHeaderControls';

const ModelsPage = lazy(() => import('./pages/settings/ModelsPage'));
const DeviceNetworkPage = lazy(() => import('./pages/device/DevicePages').then(m => ({ default: m.DeviceNetworkPage })));
const DeviceServicesPage = lazy(() => import('./pages/device/DevicePages').then(m => ({ default: m.DeviceServicesPage })));
const DeviceRuntimePage = lazy(() => import('./pages/device/DevicePages').then(m => ({ default: m.DeviceRuntimePage })));
const DeviceLogsPage = lazy(() => import('./pages/device/DevicePages').then(m => ({ default: m.DeviceLogsPage })));
const TasksPage = lazy(() => import('./pages/tasks/TasksPage'));
const loading = (element: React.ReactNode) => <RouteLoadingBoundary>{element}</RouteLoadingBoundary>;
const localRoutes: RouteObject[] = [
  { path: 'device', element: <SubjectWorkspace subject="device" />, children: [
    { index: true, element: <Navigate to="network" replace /> },
    { path: 'network', element: loading(<DeviceNetworkPage />) },
    { path: 'services', element: loading(<DeviceServicesPage />) },
    { path: 'runtime', element: loading(<DeviceRuntimePage />) },
    { path: 'logs', element: loading(<DeviceLogsPage />) },
  ] },
  { path: 'settings', element: <SubjectWorkspace subject="settings" />, children: [
    { index: true, element: <Navigate to="appearance" replace /> },
    { path: 'appearance', element: <AppearancePage /> },
  ] },
];
const webIdRoutes: RouteObject[] = [{
  element: <WebIdAuthBoundary autoStart><Outlet /></WebIdAuthBoundary>, children: [
    { path: 'ai-connections', element: loading(<ModelsPage />) },
    { path: 'pod', element: <SubjectWorkspace subject="pod" />, children: [
      { index: true, element: <Navigate to="models" replace /> },
      ...(['models', 'search', 'apps', 'data'] as const).map(section => ({ path: section, element: <PodSectionPage section={section} /> })),
    ] },
    { path: 'tasks', element: loading(<TasksPage />) },
    { path: 'inbox', element: <WorkspacePage title="收件箱"><ShellInboxContent /></WorkspacePage> },
    { path: 'notifications', element: <WorkspacePage title="通知"><ShellNotificationsContent /></WorkspacePage> },
  ],
}];
/** The host surrounds login gates so device/settings work before WebID sign-in. */
export const xpodShellRoutes: RouteObject[] = [{
  element: <XpodProductLayout product="settings" />,
  children: [
    ...localRoutes, ...webIdRoutes,
    ...Object.entries(legacyProductRedirects).map(([path, to]) => ({ path: path.slice(1), element: path === '/settings/pod' ? <PodManagementTaskRoute to={to} /> : <Navigate to={to} replace /> })),
    { index: true, element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
    { path: '*', element: <Navigate to={XPOD_DEFAULT_RETURN_PATH} replace /> },
  ],
}];
