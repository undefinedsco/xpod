import type { App } from '@solid/community-server';
import type { AuthContext } from '../api/auth/AuthContext';
import type { ApiServiceHandle } from '../api/runtime';
import { Supervisor } from '../supervisor/Supervisor';
import type { Logger } from 'global-logger-factory';
import { PACKAGE_ROOT } from './package-root';
import type { RuntimeHost } from './host/types';
import type { RuntimeBootstrapState } from './bootstrap';
import { closeManagedRedisClients } from '../storage/redis/RedisClientLifecycle';
import type {
  ApiRuntimeRunner,
  CssRuntimeRunner,
  GatewayRuntimeHandle,
  GatewayRuntimeRunner,
} from './runner/types';

export interface RuntimeServices {
  cssApp?: App;
  apiService?: ApiServiceHandle;
  gateway?: GatewayRuntimeHandle;
}

interface StartCssRuntimeOptions {
  state: RuntimeBootstrapState;
  host: RuntimeHost;
  runtimeShorthand: Record<string, string | number | boolean>;
  supervisor: Supervisor;
  open: boolean;
  createCssRuntimeConfig: (state: RuntimeBootstrapState, open: boolean) => string;
  cssRunner: CssRuntimeRunner;
}

interface StartApiRuntimeOptions {
  state: RuntimeBootstrapState;
  host: RuntimeHost;
  supervisor: Supervisor;
  authContext?: AuthContext;
  apiRunner: ApiRuntimeRunner;
}

interface StartGatewayRuntimeOptions {
  state: RuntimeBootstrapState;
  host: RuntimeHost;
  supervisor: Supervisor;
  shutdownHandler: () => Promise<void>;
  gatewayRunner: GatewayRuntimeRunner;
}

interface StopRuntimeServicesOptions {
  services: RuntimeServices;
  supervisor: Supervisor;
  logger: Logger;
  host: RuntimeHost;
  state: RuntimeBootstrapState;
  unregisterSocketOrigins: () => Promise<void>;
  closeIdentityConnections: () => Promise<void>;
  restoreRuntimeEnv: () => void;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function createOpenAuthContext(baseUrl: string, override?: AuthContext): AuthContext {
  if (override) {
    return override;
  }

  return {
    type: 'solid',
    webId: new URL('test/profile/card#me', ensureTrailingSlash(baseUrl)).href,
    accountId: 'xpod-open-account',
    displayName: 'Xpod Open Mode',
  };
}

export function registerManagedRuntimeServices(
  supervisor: Supervisor,
  services: RuntimeServices,
): void {
  supervisor.registerManaged('css', async() => {
    if (services.cssApp) {
      await services.cssApp.stop();
    }
  });

  supervisor.registerManaged('api', async() => {
    if (services.apiService) {
      await services.apiService.stop();
    }
  });

  supervisor.registerManaged('gateway', async() => {
    if (services.gateway) {
      await services.gateway.stop();
    }
  });
}

export async function startCssRuntime({
  state,
  host,
  runtimeShorthand,
  supervisor,
  open,
  createCssRuntimeConfig,
  cssRunner,
}: StartCssRuntimeOptions): Promise<App> {
  const cssConfigPath = createCssRuntimeConfig(state, open || state.cssAuthMode === 'allow-all');

  supervisor.setStatus('css', 'starting', { startTime: Date.now() });
  const cssApp = await cssRunner.start({
    configPath: cssConfigPath,
    packageRoot: PACKAGE_ROOT,
    logLevel: state.logLevel,
    shorthand: {
      ...(state.sockets.css ? { socket: state.sockets.css } : { port: state.ports.css! }),
      ...runtimeShorthand,
    },
  });

  if (state.sockets.css) {
    const ready = await host.isConnectionTargetReady({ socketPath: state.sockets.css }, 5_000);
    if (!ready) {
      throw new Error(`Timed out waiting for CSS socket ${state.sockets.css}`);
    }
    supervisor.addLog('css', 'info', `CSS started (unix://${state.sockets.css})`);
  } else {
    await host.waitForPortReady(state.ports.css!, '127.0.0.1');
    supervisor.addLog('css', 'info', `CSS started (http://127.0.0.1:${state.ports.css})`);
  }
  supervisor.setStatus('css', 'running', { startTime: Date.now() });
  return cssApp;
}

export async function startApiRuntime({
  state,
  host,
  supervisor,
  authContext,
  apiRunner,
}: StartApiRuntimeOptions): Promise<ApiServiceHandle> {
  supervisor.setStatus('api', 'starting', { startTime: Date.now() });

  const apiService = await apiRunner.start({
    open: state.apiOpen,
    authContext: createOpenAuthContext(state.baseUrl, authContext),
    runtimeHost: host,
  });

  supervisor.addLog('api', 'info', `API started (${state.transport === 'socket' ? `unix://${state.sockets.api}` : `http://127.0.0.1:${state.ports.api}`})`);
  supervisor.setStatus('api', 'running', { startTime: Date.now() });
  return apiService;
}

export async function startGatewayRuntime({
  state,
  host,
  supervisor,
  shutdownHandler,
  gatewayRunner,
}: StartGatewayRuntimeOptions): Promise<GatewayRuntimeHandle> {
  supervisor.setStatus('gateway', 'starting', { startTime: Date.now() });

  const gateway = await gatewayRunner.start({
    port: state.ports.gateway,
    bindHost: state.bindHost,
    socketPath: state.sockets.gateway,
    shutdownHandler,
    baseUrl: state.baseUrl,
    runtimeHost: host,
    supervisor,
    targets: {
      css: state.transport === 'socket' ? { socketPath: state.sockets.css! } : { url: `http://127.0.0.1:${state.ports.css}` },
      api: state.transport === 'socket' ? { socketPath: state.sockets.api! } : { url: `http://127.0.0.1:${state.ports.api}` },
    },
  });
  supervisor.addLog('xpod', 'info', `Gateway started (${state.transport === 'socket' ? `unix://${state.sockets.gateway}` : state.baseUrl})`);
  supervisor.setStatus('gateway', 'running', { startTime: Date.now() });
  return gateway;
}

export async function stopRuntimeServices({
  services,
  supervisor,
  logger,
  host,
  state,
  unregisterSocketOrigins,
  closeIdentityConnections,
  restoreRuntimeEnv,
}: StopRuntimeServicesOptions): Promise<void> {
  try {
    if (services.gateway) {
      await services.gateway.stop();
      supervisor.setStatus('gateway', 'stopped');
    }
  } catch (error) {
    logger.warn(`Failed to stop gateway: ${String(error)}`);
  }

  try {
    if (services.apiService) {
      await services.apiService.stop();
      supervisor.setStatus('api', 'stopped');
    }
  } catch (error) {
    logger.warn(`Failed to stop api: ${String(error)}`);
  }

  try {
    if (services.cssApp) {
      await services.cssApp.stop();
      supervisor.setStatus('css', 'stopped');
    }
  } catch (error) {
    logger.warn(`Failed to stop css: ${String(error)}`);
  }

  await closeManagedRedisClients();

  if (state.sockets.css) {
    host.cleanupSocketPath(state.sockets.css);
  }
  if (state.sockets.api) {
    host.cleanupSocketPath(state.sockets.api);
  }

  await unregisterSocketOrigins();
  await closeIdentityConnections();
  restoreRuntimeEnv();
}
