import type { ApiServer } from '../ApiServer';
import { registerStaticSpaRoutes } from './StaticSpaHandler';

export interface SettingsHandlerOptions {
  staticDir: string;
}

export function registerSettingsRoutes(server: ApiServer, options: SettingsHandlerOptions): void {
  registerStaticSpaRoutes(server, {
    prefix: '/settings',
    staticDir: options.staticDir,
    entryFiles: ['settings.html', 'index.html'],
    label: 'Settings',
  });
}
