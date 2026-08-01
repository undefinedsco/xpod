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
    '/dashboard/models': '/settings/models',
    '/dashboard/pod': '/settings/pod',
    '/dashboard/services': '/settings/services',
    '/dashboard/settings': '/settings/services',
  } as const;
  for (const [from, to] of Object.entries(movedRoutes)) {
    const redirect: RouteHandler = async (req, res) => {
      const source = new URL(req.url ?? from, 'http://localhost');
      res.statusCode = 302;
      res.setHeader('Location', `${to}${source.search}`);
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
}
