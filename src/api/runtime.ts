import { asValue, type AwilixContainer } from 'awilix';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig, type ApiContainerCradle } from './container';
import { registerRoutes } from './container/routes';
import type { AuthContext } from './auth/AuthContext';
import { OpenAuthMiddleware } from './middleware/OpenAuthMiddleware';

export interface StartApiServiceOptions {
  config?: ApiContainerConfig;
  open?: boolean;
  authContext?: AuthContext;
  initializeLogger?: boolean;
}

export interface ApiServiceHandle {
  config: ApiContainerConfig;
  container: AwilixContainer<ApiContainerCradle>;
  stop: () => Promise<void>;
}

function initApiLogger(): void {
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: './logs/xpod-%DATE%.log',
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}

async function startBackgroundServices(
  container: AwilixContainer<ApiContainerCradle>,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true }) as any;
    if (localNetworkManager) {
      localNetworkManager.start();
    }
  } catch (error) {
    logger.error(`Failed to initialize LocalNetworkManager: ${error}`);
  }

  try {
    const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true }) as any;
    if (ddnsManager) {
      await ddnsManager.start();
      logger.info('DDNS Manager started');
    }
  } catch (error) {
    logger.error(`Failed to initialize DdnsManager: ${error}`);
  }

  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true });
    const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;

    if (!localNetworkManager && localTunnelProvider) {
      logger.info('Starting Cloudflare Tunnel (standalone mode)...');
      await localTunnelProvider.start();
      logger.info('Cloudflare Tunnel started');
    }
  } catch (error) {
    logger.error(`Failed to start Cloudflare Tunnel: ${error}`);
  }
}

async function stopBackgroundServices(container: AwilixContainer<ApiContainerCradle>): Promise<void> {
  try {
    const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true }) as any;
    ddnsManager?.stop();
  } catch {
    // ignore shutdown errors
  }

  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true });
    await localNetworkManager?.stop();
  } catch {
    // ignore shutdown errors
  }

  try {
    const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;
    await localTunnelProvider?.stop();
  } catch {
    // ignore shutdown errors
  }
}

export async function startApiService(options: StartApiServiceOptions = {}): Promise<ApiServiceHandle> {
  if (options.initializeLogger !== false) {
    initApiLogger();
  }

  const config = options.config ?? loadConfigFromEnv();
  const logger = getLoggerFor('ApiRuntime');

  if (!config.databaseUrl) {
    throw new Error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
  }

  logger.info(`Starting API Service (edition: ${config.edition})...`);

  const container = createApiContainer(config);

  if (options.open) {
    container.register({
      authMiddleware: asValue(new OpenAuthMiddleware({ context: options.authContext })),
    });
  }

  registerRoutes(container);
  await startBackgroundServices(container, logger);

  const server = container.resolve('apiServer');
  await server.start();
  logger.info(`API Service active on ${config.socketPath ? `unix://${config.socketPath}` : `${config.host}:${config.port}`}`);

  return {
    config,
    container,
    stop: async(): Promise<void> => {
      logger.info('Stopping API Service...');
      await stopBackgroundServices(container);
      await server.stop();
    },
  };
}
