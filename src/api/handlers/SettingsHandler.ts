import type { ApiServer } from '../ApiServer';
import { registerStaticSpaRoutes } from './StaticSpaHandler';
import type { RouteHandler } from '../ApiServer';
import { resolveXpodAliasTarget } from '../../shared/xpod-route-policy';

export interface SettingsHandlerOptions {
  staticDir: string;
}

export function registerSettingsRoutes(server: ApiServer, options: SettingsHandlerOptions): void {
  for (const alias of ['/ai-config', '/ai-connections'] as const) {
    const redirect: RouteHandler = async (request, response) => {
      response.statusCode = 302;
      response.setHeader('Location', resolveXpodAliasTarget(alias, request.url ?? alias));
      response.end();
    };
    server.get(alias, redirect, { public: true });
    server.route('HEAD', alias, redirect, { public: true });
  }

  registerStaticSpaRoutes(server, {
    prefix: '/settings',
    staticDir: options.staticDir,
    entryFiles: ['settings.html', 'index.html'],
    label: 'Settings',
  });
}
