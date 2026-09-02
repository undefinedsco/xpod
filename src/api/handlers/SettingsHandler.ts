import type { ApiServer } from '../ApiServer';
import { registerStaticSpaRoutes } from './StaticSpaHandler';

export interface SettingsHandlerOptions {
  staticDir: string;
}

export function registerSettingsRoutes(server: ApiServer, options: SettingsHandlerOptions): void {
  for (const [prefix, label] of [
    ['/settings', 'Settings'],
    ['/ai-connections', 'AI Connections'],
    ['/ai-config', 'AI Config'],
  ] as const) {
    registerStaticSpaRoutes(server, {
      prefix,
      staticDir: options.staticDir,
      entryFiles: ['settings.html', 'index.html'],
      label,
      serveExactRoot: true,
    });
  }
}
