import { asValue, type AwilixContainer } from 'awilix';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig, type ApiContainerCradle } from './container';
import { registerRoutes } from './container/routes';
import type { AuthContext } from './auth/AuthContext';
import { OpenAuthMiddleware } from './middleware/OpenAuthMiddleware';
import type { RuntimeHost } from '../runtime/host/types';
import { EmbeddedInngestService, type EmbeddedInngestRuntimeConfig } from './runs/EmbeddedInngestService';

export interface StartApiServiceOptions {
  config?: ApiContainerConfig;
  open?: boolean;
  authContext?: AuthContext;
  initializeLogger?: boolean;
  runtimeHost?: RuntimeHost;
}

export interface ApiServiceHandle {
  config: ApiContainerConfig;
  container: AwilixContainer<ApiContainerCradle>;
  inngestRuntimeConfig?: EmbeddedInngestRuntimeConfig;
  stop: () => Promise<void>;
}

function initApiLogger(): void {
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: './logs/xpod-%DATE%.log',
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}

async function registerPrimaryServiceToken(
  container: AwilixContainer<ApiContainerCradle>,
  config: ApiContainerConfig,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  try {
    const serviceToken = process.env.XPOD_SERVICE_TOKEN;
    if (!serviceToken || config.edition !== 'cloud') {
      return;
    }

    const serviceTokenRepo = container.resolve('serviceTokenRepo') as any;
    const serviceType = 'cloud';
    const serviceId = process.env.XPOD_NODE_ID || 'cloud-1';

    await serviceTokenRepo.registerToken(serviceToken, {
      serviceType,
      serviceId,
      scopes: ['quota:write', 'usage:read', 'account:manage'],
    });

    logger.info(`Registered service token for ${serviceType}:${serviceId}`);
  } catch (error) {
    logger.error(`Failed to register service token: ${error}`);
  }
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
    const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;

    if (localTunnelProvider) {
      logger.info('Starting local tunnel provider...');
      const localPort = Number.parseInt(
        process.env.XPOD_MAIN_PORT ?? process.env.CSS_PORT ?? process.env.PORT ?? '3000',
        10,
      );
      const config = await localTunnelProvider.setup({
        subdomain: 'local',
        localPort: Number.isFinite(localPort) && localPort > 0 ? localPort : 3000,
        localProtocol: 'http',
      });
      await localTunnelProvider.start(config);
      logger.info('Local tunnel provider started');
    }
  } catch (error) {
    logger.error(`Failed to start local tunnel provider: ${error}`);
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

function resolveApiBaseUrl(config: ApiContainerConfig): string {
  if (process.env.XPOD_API_BASE_URL) {
    return process.env.XPOD_API_BASE_URL;
  }
  if (process.env.CSS_BASE_URL) {
    return process.env.CSS_BASE_URL;
  }
  if (config.socketPath) {
    return 'http://localhost/';
  }
  return `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
}

async function startEmbeddedInngestService(
  config: ApiContainerConfig,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<{ service: EmbeddedInngestService; runtimeConfig: EmbeddedInngestRuntimeConfig }> {
  const service = new EmbeddedInngestService({
    edition: config.edition,
    apiBaseUrl: resolveApiBaseUrl(config),
    databaseUrl: config.databaseUrl,
    redisUrl: config.redisUrl,
    enabled: config.inngest?.enabled,
    mode: config.inngest?.mode,
    host: config.inngest?.host,
    port: config.inngest?.port,
    baseUrl: config.inngest?.baseUrl,
    eventKey: config.inngest?.eventKey,
    signingKey: config.inngest?.signingKey,
    binaryPath: config.inngest?.binaryPath,
    sqliteDir: config.inngest?.sqliteDir,
  });
  const runtimeConfig = await service.start();
  if (runtimeConfig.enabled) {
    logger.info(`Inngest runtime configured: ${runtimeConfig.baseUrl}`);
  } else {
    logger.info('Inngest runtime disabled');
  }
  return { service, runtimeConfig };
}

export async function startApiService(options: StartApiServiceOptions = {}): Promise<ApiServiceHandle> {
  if (options.initializeLogger !== false) {
    initApiLogger();
  }

  const baseConfig = options.config ?? loadConfigFromEnv();
  const config = {
    ...baseConfig,
    runtimeHost: options.runtimeHost ?? baseConfig.runtimeHost,
  };
  const logger = getLoggerFor('ApiRuntime');

  if (!config.databaseUrl) {
    throw new Error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
  }

  logger.info(`Starting API Service (edition: ${config.edition})...`);

  const embeddedInngest = await startEmbeddedInngestService(config, logger);
  const container = createApiContainer({
    ...config,
    inngestRuntimeConfig: embeddedInngest.runtimeConfig,
  });

  if (options.open) {
    container.register({
      authMiddleware: asValue(new OpenAuthMiddleware({ context: options.authContext })),
    });
  }

  registerRoutes(container);
  await registerPrimaryServiceToken(container, config, logger);
  await startBackgroundServices(container, logger);

  const server = container.resolve('apiServer');
  await server.start();
  logger.info(`API Service active on ${config.socketPath ? `unix://${config.socketPath}` : `${config.host}:${config.port}`}`);

  return {
    config,
    container,
    inngestRuntimeConfig: embeddedInngest.runtimeConfig,
    stop: async(): Promise<void> => {
      logger.info('Stopping API Service...');
      await stopBackgroundServices(container);
      await server.stop();
      await embeddedInngest.service.stop();
    },
  };
}
