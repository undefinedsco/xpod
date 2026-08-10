/**
 * Dashboard 静态资源处理器
 *
 * Serve /dashboard/ 路径下的运维 UI 静态资源
 */

import type { ApiServer } from '../ApiServer';
import { registerStaticSpaRoutes } from './StaticSpaHandler';
import type { RouteHandler } from '../ApiServer';
import { resolveXpodAliasTarget, type XpodProductAlias } from '../../shared/xpod-route-policy';

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
  registerAlias(server, '/status');
  registerAlias(server, '/network');

  const movedRoutes = {
    '/dashboard/models': '/settings/models',
    '/dashboard/pod': '/settings/pod',
    '/dashboard/services': '/settings/services',
    '/dashboard/settings': '/settings/services',
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
}

function registerAlias(server: ApiServer, alias: XpodProductAlias): void {
  const redirect: RouteHandler = async (req, res) => {
    res.statusCode = 302;
    res.setHeader('Location', resolveXpodAliasTarget(alias, req.url ?? alias));
    res.end();
  };
  server.get(alias, redirect, { public: true });
  server.route('HEAD', alias, redirect, { public: true });
}
