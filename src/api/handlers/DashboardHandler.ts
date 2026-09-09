/**
 * Dashboard 静态资源处理器
 *
 * Serve /dashboard/ 路径下的运维 UI 静态资源
 */

import type { ApiServer } from '../ApiServer';
import { registerStaticSpaRoutes } from './StaticSpaHandler';
import type { RouteHandler } from '../ApiServer';

export interface DashboardHandlerOptions {
  /** 静态资源目录路径 */
  staticDir: string;
}

/**
 * 注册 Dashboard 路由
 */
export function registerDashboardRoutes(
  server: ApiServer,
  options: DashboardHandlerOptions,
): void {
  const movedRoutes = {
    '/dashboard/models': '/ai-connections',
    '/dashboard/pod': '/settings/pod',
    '/dashboard/services': '/status/overview',
    '/dashboard/settings': '/settings/pod',
  } as const;
  for (const [from, to] of Object.entries(movedRoutes)) {
    const redirect: RouteHandler = async (req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${to}${new URL(req.url ?? from, 'http://localhost').search}`);
      res.end();
    };
    server.get(from, redirect, { public: true });
    server.route('HEAD', from, redirect, { public: true });
  }
  registerStaticSpaRoutes(server, {
    prefix: '/dashboard',
    staticDir: options.staticDir,
    entryFiles: ['dashboard.html', 'index.html'],
    label: 'Dashboard',
  });
  registerStaticSpaRoutes(server, {
    prefix: '/status',
    staticDir: options.staticDir,
    entryFiles: ['dashboard.html', 'index.html'],
    label: 'Status',
  });
  registerStaticSpaRoutes(server, {
    prefix: '/network',
    staticDir: options.staticDir,
    entryFiles: ['dashboard.html', 'index.html'],
    label: 'Network',
    serveExactRoot: true,
  });
}
