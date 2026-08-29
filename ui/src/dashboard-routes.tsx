import { lazy } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { XpodDashboardLayout } from './layout/XpodDashboardLayout';
import { RouteLoadingBoundary } from './layout/RouteLoadingBoundary';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const StatusPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.StatusPage })));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const StatusWorkspace = lazy(() => import('./pages/status/StatusWorkspace'));
const ServiceStatusPanel = lazy(() => import('./pages/status/StatusSubjectPanel').then((module) => ({ default: module.ServiceStatusPanel })));
const UsageStatusPanel = lazy(() => import('./pages/status/UsageStatusPanel'));
const UsagePage = lazy(() => import('./pages/dashboard/UsagePage'));
const IndexSubjectPanel = lazy(() => import('./pages/status/IndexSubjectPanel'));

function lazyRoute(element: React.ReactNode) {
  return <RouteLoadingBoundary>{element}</RouteLoadingBoundary>;
}

const statusContentRoutes: RouteObject[] = [
  { path: 'overview', element: lazyRoute(<StatusPage />) },
  { path: 'services/gateway', element: lazyRoute(<ServiceStatusPanel serviceId="gateway" title="Gateway" />) },
  { path: 'services/solid-server', element: lazyRoute(<ServiceStatusPanel serviceId="css" title="Solid Server" />) },
  { path: 'services/api-server', element: lazyRoute(<ServiceStatusPanel serviceId="api" title="API Server" />) },
  { path: 'logs', element: lazyRoute(<LogsPage />) },
  { path: 'index', element: lazyRoute(<IndexSubjectPanel kind="overview" />) },
  { path: 'index/rdf', element: lazyRoute(<RdfPage />) },
  { path: 'index/fts', element: lazyRoute(<IndexSubjectPanel kind="fts" />) },
  { path: 'index/vector', element: lazyRoute(<IndexSubjectPanel kind="vector" />) },
  { path: 'index/retrieval-points', element: lazyRoute(<IndexSubjectPanel kind="retrieval-points" />) },
  { path: 'index/cache', element: lazyRoute(<IndexSubjectPanel kind="cache" />) },
  { path: 'index/slow-queries', element: lazyRoute(<IndexSubjectPanel kind="slow-queries" />) },
  { path: 'index/benchmark', element: lazyRoute(<IndexSubjectPanel kind="benchmark" />) },
  { path: 'usage', element: lazyRoute(<UsagePage embedded />) },
  { path: 'usage/storage', element: lazyRoute(<UsageStatusPanel kind="storage" />) },
  { path: 'usage/bandwidth', element: lazyRoute(<UsageStatusPanel kind="bandwidth" />) },
  { path: 'usage/ai', element: lazyRoute(<UsageStatusPanel kind="ai" />) },
  { path: 'usage/index-storage', element: lazyRoute(<UsageStatusPanel kind="index-storage" />) },
];

function statusWorkspaceRoute(children: RouteObject[]): RouteObject {
  return {
    element: lazyRoute(<StatusWorkspace />),
    children,
  };
}

export const dashboardRoutes: RouteObject[] = [
  {
    element: <XpodDashboardLayout />,
    children: [
      { index: true, element: <Navigate to="overview" replace /> },
      statusWorkspaceRoute(statusContentRoutes),
      { path: 'runtime', element: <Navigate to="overview" replace /> },
      { path: 'rdf', element: <Navigate to="index/rdf" replace /> },
      { path: 'network/*', element: lazyRoute(<NetworkPage />) },
      { path: 'status', element: <Navigate to="overview" replace /> },
      { path: '*', element: <Navigate to="../overview" replace /> },
    ],
  },
];

export const statusSurfaceRoutes: RouteObject[] = [
  {
    element: <XpodDashboardLayout />,
    children: [statusWorkspaceRoute([
      { index: true, element: <Navigate to="overview" replace /> },
      ...statusContentRoutes,
      { path: '*', element: <Navigate to="overview" replace /> },
    ])],
  },
];

export const networkSurfaceRoutes: RouteObject[] = [{
  element: <XpodDashboardLayout />,
  children: [
    { index: true, element: lazyRoute(<NetworkPage />) },
    { path: '*', element: lazyRoute(<NetworkPage />) },
  ],
}];
