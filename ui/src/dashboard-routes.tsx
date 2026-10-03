import { lazy } from 'react';
import { Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';
import { XpodDashboardLayout } from './layout/XpodDashboardLayout';
import { RouteLoadingBoundary } from './layout/RouteLoadingBoundary';

const LogsPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.LogsPage })));
const RdfPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.RdfPage })));
const StatusPage = lazy(() => import('./pages/admin').then((module) => ({ default: module.StatusPage })));
const UsagePage = lazy(() => import('./pages/admin').then((module) => ({ default: module.UsagePage })));
const NetworkPage = lazy(() => import('./pages/settings/NetworkPage'));
const StatusWorkspace = lazy(() => import('./pages/status/StatusWorkspace'));
const ServiceStatusPanel = lazy(() => import('./pages/status/StatusSubjectPanel').then((module) => ({ default: module.ServiceStatusPanel })));
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
  // §3.1 的用量深链
  { path: 'usage/overview', element: lazyRoute(<UsagePage kind="overview" />) },
  { path: 'usage/storage', element: lazyRoute(<UsagePage kind="storage" />) },
  { path: 'usage/bandwidth', element: lazyRoute(<UsagePage kind="bandwidth" />) },
  { path: 'usage/ai', element: lazyRoute(<UsagePage kind="ai" />) },
  { path: 'usage/index-storage', element: lazyRoute(<UsagePage kind="index-storage" />) },
  { path: 'index', element: lazyRoute(<IndexSubjectPanel kind="overview" />) },
  { path: 'index/rdf', element: lazyRoute(<RdfPage />) },
  { path: 'index/fts', element: lazyRoute(<IndexSubjectPanel kind="fts" />) },
  { path: 'index/vector', element: lazyRoute(<IndexSubjectPanel kind="vector" />) },
  { path: 'index/retrieval-points', element: lazyRoute(<IndexSubjectPanel kind="retrieval-points" />) },
  { path: 'index/cache', element: lazyRoute(<IndexSubjectPanel kind="cache" />) },
  { path: 'index/slow-queries', element: lazyRoute(<IndexSubjectPanel kind="slow-queries" />) },
  { path: 'index/benchmark', element: lazyRoute(<IndexSubjectPanel kind="benchmark" />) },
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
    children: [{
      element: <AccountAuthBoundary surface="embedded"><Outlet /></AccountAuthBoundary>,
      children: [
        { index: true, element: <Navigate to="overview" replace /> },
        statusWorkspaceRoute(statusContentRoutes),
        { path: 'runtime', element: <Navigate to="overview" replace /> },
        { path: 'rdf', element: <Navigate to="index/rdf" replace /> },
        { path: 'network/*', element: lazyRoute(<NetworkPage />) },
        { path: 'status', element: <Navigate to="overview" replace /> },
        { path: '*', element: <Navigate to="../overview" replace /> },
      ],
    }],
  },
];

export const statusSurfaceRoutes: RouteObject[] = [
  {
    // `/status` is the local service surface: every panel here reads
    // loopback-only runtime evidence. The shell route owns its admission
    // (`LocalServiceSurfaceBoundary`), so no Account gate belongs in this tree -
    // an anonymous visitor must still see service state, logs, and index
    // evidence. The legacy `/dashboard` tree keeps its own Account boundary.
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
    // §3.1 的目标路径：/network/overview 与 index 渲染同一页面
    { path: 'overview', element: lazyRoute(<NetworkPage />) },
    { path: '*', element: lazyRoute(<NetworkPage />) },
  ],
}];
