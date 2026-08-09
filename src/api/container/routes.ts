/**
 * 路由注册
 *
 * 根据容器中的服务注册 API 路由
 */

import type { AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import type { ApiServer } from '../ApiServer';

import { registerEdgeNodeSignalRoutes } from '../handlers/EdgeNodeSignalHandler';
import { registerReachabilityRoutes } from '../handlers/ReachabilityHandler';
import { registerNodeRoutes } from '../handlers/NodeHandler';
import { registerChatRoutes } from '../handlers/ChatHandler';
import { registerSubdomainRoutes } from '../handlers/SubdomainHandler';
import { registerSubdomainClientRoutes } from '../handlers/SubdomainClientHandler';
import { registerDdnsRoutes } from '../handlers/DdnsHandler';
import { registerChatKitRoutes } from '../handlers/ChatKitHandler';
import { registerChatKitV1Routes } from '../handlers/ChatKitV1Handler';
import { registerInngestRoutes } from '../handlers/InngestHandler';
import { registerRunRoutes } from '../handlers/RunHandler';
import { registerMatrixRoutes } from '../handlers/MatrixHandler';
import { registerCoordinationRoutes } from '../handlers/CoordinationHandler';
import { registerDashboardRoutes } from '../handlers/DashboardHandler';
import { registerSettingsRoutes } from '../handlers/SettingsHandler';
import { readDurableAdminEnvironment, registerAdminRoutes, writeDurableAdminEnvironmentPatch } from '../handlers/AdminHandler';
import { registerAdminDdnsRoutes } from '../handlers/AdminDdnsHandler';
import { registerLinxCapabilitiesRoutes } from '../handlers/LinxCapabilitiesHandler';
import { createLocalSetupProvisionStateWriter, registerProvisionRoutes, registerProvisionStatusRoute } from '../handlers/ProvisionHandler';
import { registerPodManagementRoutes } from '../handlers/PodManagementHandler';
import { DrizzlePodAiConnectionsStatusReader, registerPodSettingsRoutes } from '../handlers/PodSettingsHandler';
import { registerAiConfigRoutes } from '../handlers/AiConfigHandler';
import { DrizzlePodAiConfigStore } from '../ai-config/AiConfigStore';
import { RuntimeAiConfigLifecycleService } from '../ai-config/AiConfigLifecycleService';
import { PodSearchIndexRebuilder } from '../ai-config/PodSearchIndexRebuilder';
import { NetworkEnvironmentConfigurationStore } from '../network/NetworkEnvironmentConfigurationStore';
import {
  createAddressReaders,
  createCertificateCapability,
  createDeploymentNetworkSettingsAuthorizer,
  createDnsStatusReader,
  createPublicAddressReader,
  createTunnelStatusReader,
  registerNetworkSettingsRoutes,
} from '../handlers/NetworkSettingsHandler';
import { registerQuotaRoutes } from '../handlers/QuotaHandler';
import { registerUsageRoutes } from '../handlers/UsageHandler';
import { registerRdfStatsRoutes } from '../handlers/RdfStatsHandler';
import { registerAiGatewayManagementRoutes } from '../handlers/AiGatewayManagementHandler';
import { registerAiClientConfigurationRoutes } from '../handlers/AiClientConfigurationHandler';
import { registerDeviceNotificationRuntime, type DeviceNotificationRuntimeOptions } from '../handlers/DeviceNotificationRuntime';
import { AiClientConfigurationService } from '../service/AiClientConfigurationService';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { UsageRepository } from '../../storage/quota/UsageRepository';
import { DrizzleQuotaService } from '../../quota/DrizzleQuotaService';
import { LocalPodProvisioningService } from '../../provision/LocalPodProvisioningService';
import { verifyServiceAccessToken } from '../../provision/ServiceAccessTokenCodec';
import {
  findEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../edge/EdgeNodeCertificateCapabilityBridge';
import * as path from 'node:path';
import { PACKAGE_ROOT } from '../../runtime';

/**
 * 注册所有 API 路由
 */
export function registerRoutes(container: AwilixContainer<ApiContainerCradle>): void {
  const server = container.resolve('apiServer') as ApiServer;
  const config = container.resolve('config') as ApiContainerConfig;

  // 公共健康检查端点
  registerHealthRoutes(server);

  // 共享路由
  registerSharedRoutes(container, server);

  // 根据 edition 注册专属路由
  if (config.edition === 'cloud') {
    registerCloudRoutes(container, server);
  } else {
    registerLocalRoutes(container, server);
  }
}

/**
 * 健康检查路由
 */
function registerHealthRoutes(server: ApiServer): void {
  server.get('/health', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  }, { public: true });

  server.get('/ready', async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ready' }));
  }, { public: true });

  // Dashboard 静态资源
  const staticDir = path.resolve(PACKAGE_ROOT, 'static/dashboard');
  registerDashboardRoutes(server, { staticDir });
  const settingsStaticDir = path.resolve(PACKAGE_ROOT, 'static/settings');
  registerSettingsRoutes(server, { staticDir: settingsStaticDir });
}

/**
 * 共享路由 (cloud 和 local 都有)
 */
function registerSharedRoutes(
  container: AwilixContainer<ApiContainerCradle>,
  server: ApiServer,
): void {
  const nodeRepo = container.resolve('nodeRepo') as EdgeNodeRepository;
  const chatService = container.resolve('chatService');
  const chatKitService = container.resolve('chatKitService');
  const chatKitStore = container.resolve('chatKitStore');
  const runExecutionBackend = container.resolve('runExecutionBackend');
  const matrixStore = container.resolve('matrixStore');
  const clientReconcilerCoordinator = container.resolve('clientReconcilerCoordinator');
  const inngestTaskScheduler = container.resolve('inngestTaskScheduler');
  const inngestRuntimeConfig = container.resolve('inngestRuntimeConfig');
  const rdfStorageStatsService = container.resolve('rdfStorageStatsService');
  const rdfEngine = container.resolve('rdfEngine', { allowUnregistered: true });
  const rdfSearchIndexingService = container.resolve('rdfSearchIndexingService', { allowUnregistered: true });
  const gatewayAccessKeyRepository = container.resolve('gatewayAccessKeyRepository');
  const gatewayInternalPodAccess = container.resolve('gatewayInternalPodAccess');
  const aiConnectionInvocationKeyIssuer = container.resolve('aiConnectionInvocationKeyIssuer');
  const providerConnectService = container.resolve('providerConnectService');
  const providerQuotaService = container.resolve('providerQuotaService', { allowUnregistered: true });
  const providerModelsService = container.resolve('providerModelsService', { allowUnregistered: true });
  const providerCustomModelsService = container.resolve('providerCustomModelsService', { allowUnregistered: true });
  const config = container.resolve('config') as ApiContainerConfig;
  const aiClientConfigurationService = resolveAiClientConfigurationService(container, config);
  const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true });
  const dnsProvider = container.resolve('dnsProvider', { allowUnregistered: true });
  const dnsCoordinator = container.resolve('dnsCoordinator', { allowUnregistered: true });
  const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true });
  const cloudTunnelProvider = container.resolve('tunnelProvider', { allowUnregistered: true });
  const tunnelProvider = localTunnelProvider ?? cloudTunnelProvider;
  const edgeCertificateBridge = createDynamicEdgeCertificateBridge(config);
  const certificateCapability = createCertificateCapability(
    container.resolve('certificateManager', { allowUnregistered: true }),
    container.resolve('acmeCertificateManager', { allowUnregistered: true }),
    container.resolve('clusterCertificateManager', { allowUnregistered: true }),
    edgeCertificateBridge,
  );
  const podLookupRepository = container.resolve('podLookupRepo');
  const accountRoleRepository = container.resolve('accountRoleRepo', { allowUnregistered: true });
  if (!podLookupRepository) {
    throw new Error('Pod settings route requires podLookupRepo');
  }

  registerEdgeNodeSignalRoutes(server, {
    repository: nodeRepo,
    dnsCoordinator: container.resolve('dnsCoordinator', { allowUnregistered: true }) as any,
    healthProbeService: container.resolve('healthProbeService', { allowUnregistered: true }) as any,
  });
  registerReachabilityRoutes(server, {
    repository: nodeRepo,
    baseStorageDomain: config.subdomain?.baseStorageDomain,
    apiBaseUrl: config.cloudApiEndpoint ?? process.env.XPOD_CLOUD_API_ENDPOINT ?? process.env.CSS_BASE_URL,
  });
  registerNodeRoutes(server, { repository: nodeRepo });
  const aiGatewayService = container.resolve('aiGatewayService');
  if (aiGatewayService) {
    registerChatRoutes(server, {
      chatService,
      aiGatewayService,
      acceptanceEndpointsEnabled: process.env.XPOD_ACCEPTANCE_ENDPOINTS_ENABLED === 'true',
    });
  }
  registerChatKitRoutes(server, { chatKitService });
  registerChatKitV1Routes(server, { store: chatKitStore });
  registerRunRoutes(server, { runStore: chatKitStore });
  registerMatrixRoutes(server, { store: matrixStore });
  registerCoordinationRoutes(server, { clientReconcilerCoordinator });
  registerInngestRoutes(server, {
    backend: runExecutionBackend,
    taskScheduler: inngestTaskScheduler,
    runtimeConfig: inngestRuntimeConfig,
  });
  registerRdfStatsRoutes(server, {
    rdfStorageStatsService,
  });
  registerAiGatewayManagementRoutes(server, {
    repository: gatewayAccessKeyRepository,
    deployment: config.edition,
    connectService: providerConnectService,
    quotaService: providerQuotaService,
    modelsService: providerModelsService,
    customModelsService: providerCustomModelsService,
    servicePrincipal: gatewayInternalPodAccess,
    aiClientConfiguration: aiClientConfigurationService?.capability(),
    aiConnectionInvocationKeyIssuer,
  });
  registerAiClientConfigurationRoutes(server, {
    service: aiClientConfigurationService,
  });
  const notificationOrigin = config.publicUrl ?? config.solidBaseUrl ?? process.env.CSS_BASE_URL ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  registerDeviceNotificationRuntime(server, {
    origin: notificationOrigin,
    authorizeTopic: createOwnerOnlyNotificationTopicAuthorizer(notificationOrigin),
  });
  registerPodSettingsRoutes(server, {
    podLookupRepository,
    usageRepo: new UsageRepository(container.resolve('db')),
    aiConnectionStatusReader: new DrizzlePodAiConnectionsStatusReader(gatewayInternalPodAccess, config.edition),
  });
  const aiConfigStore = new DrizzlePodAiConfigStore({ internalPodAccess: gatewayInternalPodAccess });
  const ftsRebuildAvailable = Boolean(gatewayInternalPodAccess && rdfEngine?.indexTextSource);
  const vectorRebuildAvailable = Boolean(gatewayInternalPodAccess && rdfSearchIndexingService && chatKitStore.createTrustedContext);
  const rebuildFts = async (owner: { webId: string; podUrl: string }) => {
    const trustedFetch = await gatewayInternalPodAccess!.getTrustedFetch(owner.webId);
    if (!trustedFetch || !rdfEngine?.indexTextSource) throw new Error('fts_rebuild_unavailable');
    const result = await new PodSearchIndexRebuilder({
      trustedFetch,
      indexTextSource: async (source, text) => {
        await rdfEngine.indexTextSource!(source, text);
      },
    }).rebuildText(owner);
    if (result.failed > 0) throw new Error('fts_rebuild_incomplete');
  };
  const rebuildVector = async (owner: { webId: string; podUrl: string }) => {
    const trustedFetch = await gatewayInternalPodAccess!.getTrustedFetch(owner.webId);
    if (!trustedFetch || !rdfSearchIndexingService) throw new Error('vector_rebuild_unavailable');
    const context = await chatKitStore.createTrustedContext({ ...owner, fetch: trustedFetch });
    const result = await new PodSearchIndexRebuilder({
      trustedFetch,
      indexVectorSource: async (source, text) => {
        const indexed = await rdfSearchIndexingService.indexVectorSource({ context, source, text });
        if (indexed.status !== 'indexed') throw new Error(indexed.reason);
      },
    }).rebuildVector(owner);
    if (result.failed > 0) throw new Error('vector_rebuild_incomplete');
  };
  const aiConfigLifecycle = new RuntimeAiConfigLifecycleService({
    executors: {
      ...(ftsRebuildAvailable ? { fts: rebuildFts } : {}),
      ...(vectorRebuildAvailable ? { vector: rebuildVector } : {}),
      ...(ftsRebuildAvailable && vectorRebuildAvailable ? { all: async (owner) => { await rebuildFts(owner); await rebuildVector(owner); } } : {}),
    },
    configurationVersion: async (owner) => (await aiConfigStore.read(owner)).updatedAt,
  });
  registerAiConfigRoutes(server, {
    podLookupRepository,
    store: aiConfigStore,
    lifecycle: aiConfigLifecycle,
    capabilities: () => ({
      textBackends: config.edition === 'cloud' && config.sparqlEndpoint ? ['postgres-fts'] : [],
      vectorBackends: config.edition === 'cloud' && config.sparqlEndpoint ? ['pgvector'] : ['vec'],
      rebuildSupported: aiConfigLifecycle.supportedTargets().length > 0,
      rebuildTargets: aiConfigLifecycle.supportedTargets(),
    }),
  });
  registerNetworkSettingsRoutes(server, {
    endpoint: () => resolveNetworkEndpoint(config),
    ...createAddressReaders({
      endpoint: () => resolveNetworkEndpoint(config),
      port: config.port,
      publicUrls: [
        config.publicUrl,
        config.activeTunnelProfile?.publicUrl,
      ],
    }),
    publicAddresses: createPublicAddressReader({
      configuredUrls: [
        config.publicUrl,
        config.activeTunnelProfile?.publicUrl,
      ],
      ddnsManager,
      tunnelProvider,
    }),
    dnsStatusReader: createDnsStatusReader({ ddnsManager, dnsProvider, dnsCoordinator }),
    tunnelStatusReader: createTunnelStatusReader(tunnelProvider),
    tlsStatusReader: certificateCapability?.tlsStatusReader,
    certificateRenewer: certificateCapability?.certificateRenewer,
    configurationStore: new NetworkEnvironmentConfigurationStore({
      read: readDurableAdminEnvironment,
      write: writeDurableAdminEnvironmentPatch,
    }),
    authorizer: createDeploymentNetworkSettingsAuthorizer({
      deployment: config.edition,
      accountRoleRepository,
    }),
    internalAdminAuthSecret: config.gatewayAdminProxyAuthSecret,
  });

  // Quota & Usage API (Business 对接)
  try {
    const quotaService = new DrizzleQuotaService({ identityDbUrl: config.databaseUrl });
    const usageRepo = new UsageRepository(container.resolve('db'));
    registerQuotaRoutes(server, { quotaService, usageRepo });
    registerUsageRoutes(server, { usageRepo });
    console.log('[Shared] Quota & Usage routes registered');
  } catch (error) {
    console.log(`[Shared] Quota & Usage routes not registered: ${error}`);
  }
}

type DeviceNotificationTopicAuthorizer = NonNullable<DeviceNotificationRuntimeOptions['authorizeTopic']>;

function createOwnerOnlyNotificationTopicAuthorizer(origin: string): DeviceNotificationTopicAuthorizer {
  return async ({ identity, topic }) => {
    // Owner-only fallback until a shared Solid Read permission reader is available for runtime injection.
    // This is not a full WebACL/ACP authorization decision.
    return topic.startsWith(new URL(`/${identity.localPart}/`, origin).toString());
  };
}

function resolveAiClientConfigurationService(
  container: AwilixContainer<ApiContainerCradle>,
  config: ApiContainerConfig,
): AiClientConfigurationService | undefined {
  const injected = container.resolve('aiClientConfigurationService', { allowUnregistered: true });
  if (injected) return injected;
  const capability = config.aiClientConfiguration;
  if (!capability?.enabled || capability.authority !== 'local-filesystem') {
    return undefined;
  }
  return new AiClientConfigurationService({
    homeDir: capability.homeDir,
    backupRoot: capability.backupRoot,
  });
}

function createDynamicEdgeCertificateBridge(config: ApiContainerConfig): unknown {
  const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({
    nodeId: config.nodeId,
    baseUrl: config.solidBaseUrl ?? config.publicUrl,
  });
  if (!bridgeId) {
    return undefined;
  }
  return {
    readCertificateStatus: async () => {
      return await findEdgeNodeCertificateCapabilityBridge(bridgeId)?.readCertificateStatus()
        ?? { supported: false, status: 'unsupported' };
    },
    renewCertificate: async () => {
      const bridge = findEdgeNodeCertificateCapabilityBridge(bridgeId);
      if (!bridge) {
        throw Object.assign(new Error('Certificate runtime is not available.'), {
          statusCode: 503,
          code: 'certificate_renewal_unavailable',
        });
      }
      return await bridge.renewCertificate();
    },
    isAvailable: async () => {
      return Boolean(await findEdgeNodeCertificateCapabilityBridge(bridgeId)?.isAvailable());
    },
  };
}

/**
 * Cloud 模式专属路由
 */
function registerCloudRoutes(
  container: AwilixContainer<ApiContainerCradle>,
  server: ApiServer,
): void {
  // 子域名管理 API (需要 SubdomainService)
  try {
    const subdomainService = container.resolve('subdomainService') as ApiContainerCradle['subdomainService'];
    if (subdomainService) {
      registerSubdomainRoutes(server, { subdomainService });
      console.log('[Cloud] Subdomain routes registered');
    }
  } catch {
    console.log('[Cloud] Subdomain routes not registered (service not available)');
  }

  // DDNS 服务
  try {
    const ddnsRepo = container.resolve('ddnsRepo', { allowUnregistered: true });
    const dnsProvider = container.resolve('dnsProvider', { allowUnregistered: true });
    const config = container.resolve('config') as ApiContainerConfig;

    if (ddnsRepo) {
      const baseStorageDomain = config.subdomain?.baseStorageDomain;
      if (baseStorageDomain) {
        registerDdnsRoutes(server, {
          ddnsRepo: ddnsRepo as any,
          dnsProvider: dnsProvider as any,
          defaultDomain: baseStorageDomain,
        });
        console.log(`[Cloud] DDNS routes registered (domain: ${baseStorageDomain})`);
      } else {
        console.log('[Cloud] DDNS routes not registered (no CSS_BASE_STORAGE_DOMAIN)');
      }
    }
  } catch {
    console.log('[Cloud] DDNS routes not registered (repo not available)');
  }

  // SP Provision API (SP 注册)
  try {
    const nodeRepo = container.resolve('nodeRepo') as EdgeNodeRepository;
    const config = container.resolve('config') as ApiContainerConfig;
    const baseUrl = process.env.CSS_BASE_URL || 'http://localhost:3000/';
    const baseStorageDomain = config.subdomain?.baseStorageDomain;
    const ddnsRepo = container.resolve('ddnsRepo', { allowUnregistered: true }) as any;
    const dnsProvider = container.resolve('dnsProvider', { allowUnregistered: true }) as any;
    const tunnelProvider = container.resolve('tunnelProvider', { allowUnregistered: true }) as any;
    registerProvisionRoutes(server, {
      repository: nodeRepo,
      ddnsRepo,
      dnsProvider,
      tunnelProvider,
      baseUrl,
      baseStorageDomain,
    });
    console.log(`[Cloud] Provision routes registered${baseStorageDomain ? ` (baseStorageDomain: ${baseStorageDomain})` : ''}`);
  } catch {
    console.log('[Cloud] Provision routes not registered (dependencies not available)');
  }
}

/**
 * Local 模式专属路由
 */
function registerLocalRoutes(
  container: AwilixContainer<ApiContainerCradle>,
  server: ApiServer,
): void {
  const config = container.resolve('config') as ApiContainerConfig;
  registerLinxCapabilitiesRoutes(server);

  // Admin API (配置管理、重启)
  registerAdminRoutes(server, {
    internalAdminAuthSecret: config.gatewayAdminProxyAuthSecret,
  });
  // DDNS status (托管式 Local 模式)
  try {
    const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true }) as any;
    registerAdminDdnsRoutes(server, { ddnsManager });
  } catch {
    // ignore
  }

  // 子域名客户端 API (通过 SubdomainClient 调用 Cloud)
  try {
    const subdomainClient = container.resolve('subdomainClient') as ApiContainerCradle['subdomainClient'];
    if (subdomainClient) {
      registerSubdomainClientRoutes(server, { subdomainClient });
      console.log('[Local] Subdomain client routes registered');
    }
  } catch {
    console.log('[Local] Subdomain client routes not registered (client not available)');
  }

  // Pod Provision API (SP 端，供 Cloud 回调创建 Pod)
  try {
    const config = container.resolve('config') as ApiContainerConfig;
    // rootDir: CSS 数据目录，默认 ./data
    const rootDir = process.env.CSS_ROOT_FILE_PATH || './data';
    // serviceToken 验证：从 SP 配置中读取
    const expectedServiceToken = config.serviceToken;

    if (expectedServiceToken) {
      const baseUrl = process.env.CSS_BASE_URL || 'http://localhost:3000/';
      const sparqlEndpoint = process.env.CSS_SPARQL_ENDPOINT || process.env.SPARQL_ENDPOINT;
      const identityDbUrl = process.env.CSS_IDENTITY_DB_URL || process.env.DATABASE_URL;
      const provisioningService = sparqlEndpoint && identityDbUrl
        ? new LocalPodProvisioningService({
          baseUrl,
          rootDir,
          sparqlEndpoint,
          identityDbUrl,
          rdfIndexPath: config.rdfIndexPath,
          oidcIssuer: process.env.oidcIssuer ?? config.oidcIssuer,
          authMode: config.authMode,
        })
        : undefined;

      registerPodManagementRoutes(server, {
        rootDir,
        verifyServiceToken: async (token: string) => (
          token === expectedServiceToken
          || verifyServiceAccessToken(token, { serviceToken: expectedServiceToken }).valid
        ),
        provisioningService,
        podLookupRepository: container.resolve('podLookupRepo', { allowUnregistered: true }),
        storageProviderBaseUrl: baseUrl,
      });
      console.log(`[Local] Pod provision routes registered (/provision/pods, /provision/webids, ${provisioningService ? 'css-compatible' : 'directory-only'})`);
    } else {
      console.log('[Local] Pod provision routes not registered (serviceToken not configured)');
    }
  } catch (error) {
    console.log(`[Local] Pod provision routes not registered: ${error}`);
  }

  // SP 状态查询 (供 Linx 查询 SP 配置状态)
  try {
    const config = container.resolve('config') as ApiContainerConfig;
    registerProvisionStatusRoute(server, {
      cloudUrl: config.cloudApiEndpoint,
      nodeId: config.nodeId,
      nodeToken: config.nodeToken,
      serviceToken: config.serviceToken,
      publicUrl: process.env.XPOD_PUBLIC_URL ?? config.publicUrl ?? process.env.CSS_BASE_URL,
      spDomain: process.env.XPOD_SP_DOMAIN ?? config.spDomain,
      localPort: readPositiveInteger(process.env.CSS_PORT ?? process.env.XPOD_PORT ?? process.env.PORT),
      tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN ?? process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN,
      cloudBaseUrl: config.oidcIssuer || config.cloudApiEndpoint,
      provisionCode: process.env.XPOD_PROVISION_CODE ?? config.provisionCode,
      persistState: createLocalSetupProvisionStateWriter(
        config.localSetupPath,
        config.localSetupProviderId,
      ),
    });
    console.log('[Local] Provision status route registered (/provision/status)');
  } catch (error) {
    console.log(`[Local] Provision status route not registered: ${error}`);
  }
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveNetworkEndpoint(config: ApiContainerConfig): string {
  const configured = config.publicUrl
    ?? config.activeTunnelProfile?.publicUrl
    ?? config.solidBaseUrl
    ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/`;
  try {
    return new URL(configured).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return `http://127.0.0.1:${config.port}/`;
  }
}
