import { ensureSupportedBun } from '../runtime/compat/ensureSupportedBun';
import { asValue, type AwilixContainer } from 'awilix';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { resolveLogFilePattern } from '../logging/log-file';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig, type ApiContainerCradle } from './container';
import { registerRoutes } from './container/routes';
import { BackgroundServiceSupervisor } from './background-service-supervisor';
import type { AuthContext } from './auth/AuthContext';
import { OpenAuthMiddleware } from './middleware/OpenAuthMiddleware';
import type { AccountRoleRepository } from '../identity/drizzle/AccountRoleRepository';
import type { RuntimeHost } from '../runtime/host/types';
import { EmbeddedInngestService, type EmbeddedInngestRuntimeConfig } from './runs/EmbeddedInngestService';
import { autoProvisionFirstRunLocal } from '../provision/first-run-registration';

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

/** One source of truth for the Cloud identity: the local edition's default issuer. */
export { autoProvisionFirstRunLocal } from '../provision/first-run-registration';
export { OFFICIAL_CLOUD_IDENTITY_ORIGIN } from '../runtime/oidc-issuer';

function initApiLogger(): void {
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: resolveLogFilePattern(),
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}

/**
 * Move the API's legacy owner keys into the task layer before anything serves traffic.
 *
 * A failure here is reported and left for the next boot: the legacy table stays readable, and the
 * migration is idempotent, so a half-done run is repeatable rather than a data loss.
 */
async function migrateLegacyPodKeys(
  container: AwilixContainer<ApiContainerCradle>,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  const migrate = container.resolve('legacyPodKeyMigration', { allowUnregistered: true });
  if (!migrate) {
    return;
  }
  try {
    const result = await migrate();
    if (result.migrated > 0 || result.failed > 0) {
      logger.info(`Legacy Pod keys migrated into the task layer: ${JSON.stringify(result)}`);
    }
  } catch (error) {
    logger.warn(`Legacy Pod key migration failed: ${String(error)}`);
  }
}

async function registerPrimaryServiceToken(
  container: AwilixContainer<ApiContainerCradle>,
  config: ApiContainerConfig,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  try {
    const serviceToken = config.serviceToken;
    if (!serviceToken || config.edition !== 'cloud') {
      return;
    }

    const serviceTokenRepo = container.resolve('serviceTokenRepo') as any;
    const serviceType = 'cloud';
    const serviceId = process.env.XPOD_NODE_ID || 'cloud-1';

    await serviceTokenRepo.registerToken(serviceToken, {
      serviceType,
      serviceId,
      scopes: ['quota:write', 'usage:read', 'account:manage', 'network:read', 'network:write'],
    });

    logger.info(`Registered service token for ${serviceType}:${serviceId}`);
  } catch (error) {
    logger.error(`Failed to register service token: ${error}`);
  }
}

async function reconcileLocalOwnerRoles(
  container: AwilixContainer<ApiContainerCradle>,
  config: ApiContainerConfig,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  if (config.edition !== 'local') {
    return;
  }
  try {
    const accountRoleRepo = container.resolve('accountRoleRepo', { allowUnregistered: true }) as AccountRoleRepository | undefined;
    if (!accountRoleRepo) {
      return;
    }
    const accounts = await accountRoleRepo.listAccounts();
    for (const account of accounts) {
      if (!account.roles.includes('owner')) {
        await accountRoleRepo.addRoles(account.accountId, ['owner']);
        logger.info(`Granted owner role to local account ${account.accountId}`);
      }
    }
  } catch (error) {
    logger.error(`Failed to reconcile local owner roles: ${error}`);
  }
}

/**
 * Port a managed tunnel forwards to.
 *
 * It must be the Gateway's ingress listener rather than the gateway port itself:
 * a tunnel terminating on the gateway port reaches the Gateway from loopback and
 * would let forwarded remote requests inherit local trust. Falls back to the
 * historical gateway port only when no ingress listener was provisioned.
 */
/**
 * The port a remote tunnel forwards to: the Gateway's tunnel entry.
 *
 * The runtime records the listener it actually bound in `XPOD_GATEWAY_INGRESS_PORT`, and the
 * Gateway's own port is only the fallback for an embedding that started no tunnel entry. The
 * gate is structural - anything arriving on that listener is remote whatever it claims - so a
 * tunnel pointed at the Gateway port by mistake still has the forwarding-header check behind
 * it rather than inheriting local trust.
 */
export function resolveTunnelIngressPort(env: NodeJS.ProcessEnv = process.env): number {
  for (const value of [env.XPOD_GATEWAY_INGRESS_PORT, env.XPOD_MAIN_PORT, env.XPOD_PORT, env.PORT]) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 3000;
}

/**
 * 后台服务由 supervisor 接管（审计 N18）。
 *
 * 此前每个服务只 start 一次，失败只写日志：开机时断网、provider 抖动的隧道会一直躺着，
 * 跑着跑着死掉的也没人发现。现在启动失败按退避重试，起来之后按间隔复查存活。
 */
const backgroundSupervisors: BackgroundServiceSupervisor[] = [];

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
      const supervisor = new BackgroundServiceSupervisor({
        name: 'ddns',
        start: async () => {
          await ddnsManager.start();
        },
        stop: async () => {
          ddnsManager.stop?.();
        },
        logger,
      });
      backgroundSupervisors.push(supervisor);
      supervisor.start();
    }
  } catch (error) {
    logger.error(`Failed to initialize DdnsManager: ${error}`);
  }

  try {
    const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;

    if (localTunnelProvider) {
      logger.info('Starting local tunnel provider...');
      const supervisor = new BackgroundServiceSupervisor({
        name: `tunnel:${String(localTunnelProvider.name ?? 'local')}`,
        start: async () => {
          const config = await localTunnelProvider.setup({
            subdomain: 'local',
            localPort: resolveTunnelIngressPort(),
            localProtocol: 'http',
          });
          await localTunnelProvider.start(config);
        },
        stop: async () => {
          await localTunnelProvider.stop?.();
        },
        // 隧道进程退出后 provider 自己知道状态，supervisor 据此重启。
        isRunning: () => Boolean(localTunnelProvider.getStatus?.().running),
        logger,
      });
      backgroundSupervisors.push(supervisor);
      supervisor.start();
    }
  } catch (error) {
    logger.error(`Failed to start local tunnel provider: ${error}`);
  }
}

async function stopBackgroundServices(container: AwilixContainer<ApiContainerCradle>): Promise<void> {
  // 先停监督器：否则一次关停会被自己排的重试撤销（ddns/tunnel 的 stop 由它们负责调用）。
  while (backgroundSupervisors.length > 0) {
    const supervisor = backgroundSupervisors.pop();
    await supervisor?.stop();
  }

  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true });
    await localNetworkManager?.stop();
  } catch {
    // ignore shutdown errors
  }

  // The tunnel provider's stop is owned by its supervisor above; stopping it twice would kill
  // the same process twice and make the shutdown path look like it did more than it did.
}

async function stopApiRuntimeServices(container: AwilixContainer<ApiContainerCradle>): Promise<void> {
  try {
    const runExecutionBackend = container.resolve('runExecutionBackend', { allowUnregistered: true });
    await runExecutionBackend?.close?.();
  } catch {
    // ignore shutdown errors
  }

  try {
    const rdfEngine = container.resolve('rdfEngine', { allowUnregistered: true });
    await rdfEngine?.close?.();
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
    // Unix-socket transport cannot name a TCP callback address; the service
    // derives a private loopback bridge and signs it with the Gateway marker.
    socketPath: config.socketPath,
    gatewayAdminProxyAuthSecret: config.gatewayAdminProxyAuthSecret,
    runtimeHost: config.runtimeHost,
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
  ensureSupportedBun();
  if (options.initializeLogger !== false) {
    initApiLogger();
  }

  const baseConfig = options.config ?? loadConfigFromEnv();
  let config: ApiContainerConfig = {
    ...baseConfig,
    runtimeHost: options.runtimeHost ?? baseConfig.runtimeHost,
  };
  const logger = getLoggerFor('ApiRuntime');

  if (!config.databaseUrl) {
    throw new Error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
  }

  logger.info(`Starting API Service (edition: ${config.edition})...`);
  config = await autoProvisionFirstRunLocal(config, logger);

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

  let server: ApiContainerCradle['apiServer'];
  let backgroundServicesStarted = false;
  try {
    registerRoutes(container);
    server = container.resolve('apiServer');
    await container.resolve('rdfEngine', { allowUnregistered: true })?.open?.();
    await migrateLegacyPodKeys(container, logger);
    await registerPrimaryServiceToken(container, config, logger);
    await reconcileLocalOwnerRoles(container, config, logger);
    await startBackgroundServices(container, logger);
    backgroundServicesStarted = true;
    await server.start();
  } catch (error) {
    if (backgroundServicesStarted) {
      await stopBackgroundServices(container);
    }
    await stopApiRuntimeServices(container);
    await embeddedInngest.service.stop().catch(() => undefined);
    throw error;
  }
  logger.info(`API Service active on ${config.socketPath ? `unix://${config.socketPath}` : `${config.host}:${config.port}`}`);

  return {
    config,
    container,
    inngestRuntimeConfig: embeddedInngest.runtimeConfig,
    stop: async(): Promise<void> => {
      logger.info('Stopping API Service...');
      await stopBackgroundServices(container);
      await server.stop();
      await stopApiRuntimeServices(container);
      await embeddedInngest.service.stop();
    },
  };
}
