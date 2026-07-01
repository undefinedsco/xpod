import { asValue, type AwilixContainer } from 'awilix';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig, type ApiContainerCradle } from './container';
import { registerRoutes } from './container/routes';
import type { AuthContext } from './auth/AuthContext';
import { OpenAuthMiddleware } from './middleware/OpenAuthMiddleware';
import type { RuntimeHost } from '../runtime/host/types';
import { EmbeddedInngestService, type EmbeddedInngestRuntimeConfig } from './runs/EmbeddedInngestService';
import { resolveLocalSetupPath, resolveLocalSetupProviderId, upsertLocalProvisionState } from '../provision/LocalProvisionState';

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

interface ProvisionNodeResponse {
  nodeId?: unknown;
  nodeToken?: unknown;
  serviceToken?: unknown;
  provisionCode?: unknown;
  publicUrl?: unknown;
  spDomain?: unknown;
}

const OFFICIAL_CLOUD_API_ORIGIN = 'https://api.undefineds.co';
const OFFICIAL_CLOUD_IDENTITY_ORIGIN = 'https://id.undefineds.co';

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function initApiLogger(): void {
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: './logs/xpod-%DATE%.log',
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}

async function autoProvisionFirstRunLocal(
  config: ApiContainerConfig,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<ApiContainerConfig> {
  if (
    config.edition !== 'local'
    || process.env.XPOD_LOCAL_AUTO_PROVISION === 'false'
    || (config.nodeToken && config.serviceToken)
  ) {
    return config;
  }

  const cloudApiEndpoint = config.cloudApiEndpoint || OFFICIAL_CLOUD_API_ORIGIN;
  const nodeId = config.nodeId;
  const explicitPublicUrl = normalizeUrl(process.env.XPOD_PUBLIC_URL ?? config.publicUrl);
  const fallbackLocalUrl = normalizeUrl(process.env.CSS_BASE_URL ?? resolveApiBaseUrl(config));
  if (!nodeId) {
    return config;
  }

  const requestBody: Record<string, unknown> = {
    nodeId,
    serviceToken: config.serviceToken,
    domainMode: config.spDomain || !explicitPublicUrl ? 'managed' : 'self-managed',
    spDomain: config.spDomain,
  };
  if (explicitPublicUrl) {
    requestBody.publicUrl = explicitPublicUrl;
  }
  const localPort = readPositiveInteger(process.env.CSS_PORT ?? process.env.XPOD_PORT ?? process.env.PORT);
  if (localPort) {
    requestBody.localPort = localPort;
  }
  const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN;
  if (tunnelToken) {
    requestBody.tunnelToken = tunnelToken;
    requestBody.tunnelMode = 'client';
  }

  try {
    const endpoint = new URL('/provision/nodes', ensureTrailingSlash(cloudApiEndpoint)).toString();
    const timeoutMs = readPositiveInteger(process.env.XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS) ?? 5_000;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.warn(`First-run Local Cloud registration failed: ${detail || `HTTP ${response.status}`}`);
      return config;
    }

    const payload = await response.json().catch(() => undefined) as ProvisionNodeResponse | undefined;
    if (
      !payload
      || typeof payload.nodeId !== 'string'
      || typeof payload.nodeToken !== 'string'
      || typeof payload.serviceToken !== 'string'
      || typeof payload.provisionCode !== 'string'
    ) {
      logger.warn('First-run Local Cloud registration returned an incomplete response.');
      return config;
    }

    const nodeIdIssued = payload.nodeId;
    const nodeTokenIssued = payload.nodeToken;
    const serviceTokenIssued = payload.serviceToken;
    const provisionCodeIssued = payload.provisionCode;
    const cloudIdentityUrl = resolveCloudIdentityUrl(config);
    const nextConfig: ApiContainerConfig = {
      ...config,
      cloudApiEndpoint,
      nodeId: nodeIdIssued,
      nodeToken: nodeTokenIssued,
      serviceToken: serviceTokenIssued,
      provisionCode: provisionCodeIssued,
      publicUrl: typeof payload.publicUrl === 'string' ? payload.publicUrl : explicitPublicUrl ?? fallbackLocalUrl,
      spDomain: typeof payload.spDomain === 'string' ? payload.spDomain : config.spDomain,
      oidcIssuer: config.oidcIssuer ?? cloudIdentityUrl,
      localSetupPath: config.localSetupPath ?? resolveLocalSetupPath(process.env.XPOD_LOCAL_SETUP_PATH),
      localSetupProviderId: config.localSetupProviderId ?? resolveLocalSetupProviderId(process.env.XPOD_PROVIDER_ID),
    };

    process.env.XPOD_NODE_ID = nodeIdIssued;
    process.env.XPOD_NODE_TOKEN = nodeTokenIssued;
    process.env.XPOD_SERVICE_TOKEN = serviceTokenIssued;
    process.env.XPOD_PROVISION_CODE = provisionCodeIssued;
    if (nextConfig.spDomain) {
      process.env.XPOD_SP_DOMAIN = nextConfig.spDomain;
    }
    if (nextConfig.oidcIssuer) {
      process.env.XPOD_PROVISION_URL = `${nextConfig.oidcIssuer.replace(/\/+$/u, '')}/.account/?provisionCode=${encodeURIComponent(provisionCodeIssued)}`;
    }

    upsertLocalProvisionState(nextConfig.localSetupPath!, nextConfig.localSetupProviderId!, {
      nodeId: nodeIdIssued,
      nodeToken: nodeTokenIssued,
      serviceToken: serviceTokenIssued,
      provisionCode: provisionCodeIssued,
      publicUrl: nextConfig.publicUrl,
      spDomain: nextConfig.spDomain,
      cloudUrl: nextConfig.cloudApiEndpoint,
      cloudBaseUrl: nextConfig.oidcIssuer,
    });

    logger.info(`First-run Local Cloud registration completed for ${nodeIdIssued}`);
    return nextConfig;
  } catch (error) {
    logger.warn(`First-run Local Cloud registration failed: ${error}`);
    return config;
  }
}

function resolveCloudIdentityUrl(config: ApiContainerConfig): string | undefined {
  if (config.oidcIssuer) {
    return config.oidcIssuer;
  }

  try {
    const endpoint = new URL(config.cloudApiEndpoint ?? OFFICIAL_CLOUD_API_ORIGIN);
    const official = new URL(OFFICIAL_CLOUD_API_ORIGIN);
    return endpoint.hostname === official.hostname ? OFFICIAL_CLOUD_IDENTITY_ORIGIN : undefined;
  } catch {
    return undefined;
  }
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value.trim()).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim();
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
