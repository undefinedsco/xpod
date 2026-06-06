/**
 * 路由注册
 *
 * 根据容器中的服务注册 API 路由
 */

import type { AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import type { ApiServer } from '../ApiServer';

import { registerEdgeNodeSignalRoutes } from '../handlers/EdgeNodeSignalHandler';
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
import { registerDashboardRoutes } from '../handlers/DashboardHandler';
import { registerAdminRoutes } from '../handlers/AdminHandler';
import { registerAdminDdnsRoutes } from '../handlers/AdminDdnsHandler';
import { registerLinxCapabilitiesRoutes } from '../handlers/LinxCapabilitiesHandler';
import { createLocalSetupProvisionStateWriter, registerProvisionRoutes, registerProvisionStatusRoute } from '../handlers/ProvisionHandler';
import { registerPodManagementRoutes } from '../handlers/PodManagementHandler';
import { registerQuotaRoutes } from '../handlers/QuotaHandler';
import { registerUsageRoutes } from '../handlers/UsageHandler';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { UsageRepository } from '../../storage/quota/UsageRepository';
import { DrizzleQuotaService } from '../../quota/DrizzleQuotaService';
import { LocalPodProvisioningService } from '../../provision/LocalPodProvisioningService';
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
  const inngestTaskScheduler = container.resolve('inngestTaskScheduler');
  const inngestRuntimeConfig = container.resolve('inngestRuntimeConfig');
  const config = container.resolve('config') as ApiContainerConfig;

  registerEdgeNodeSignalRoutes(server, {
    repository: nodeRepo,
    dnsCoordinator: container.resolve('dnsCoordinator', { allowUnregistered: true }) as any,
    healthProbeService: container.resolve('healthProbeService', { allowUnregistered: true }) as any,
  });
  registerNodeRoutes(server, { repository: nodeRepo });
  registerChatRoutes(server, { chatService });
  registerChatKitRoutes(server, { chatKitService });
  registerChatKitV1Routes(server, { store: chatKitStore });
  registerRunRoutes(server, { runStore: chatKitStore });
  registerMatrixRoutes(server, { store: matrixStore });
  registerInngestRoutes(server, {
    backend: runExecutionBackend,
    taskScheduler: inngestTaskScheduler,
    runtimeConfig: inngestRuntimeConfig,
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
  registerLinxCapabilitiesRoutes(server);

  // Admin API (配置管理、重启)
  registerAdminRoutes(server);

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
    // rootDir: CSS 数据目录，默认 ./data
    const rootDir = process.env.CSS_ROOT_FILE_PATH || './data';
    // serviceToken 验证：从 SP 配置中读取
    const expectedServiceToken = process.env.XPOD_SERVICE_TOKEN;

    if (expectedServiceToken) {
      const config = container.resolve('config') as ApiContainerConfig;
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
        verifyServiceToken: async (token: string) => token === expectedServiceToken,
        provisioningService,
        podLookupRepository: container.resolve('podLookupRepo', { allowUnregistered: true }),
        storageProviderBaseUrl: baseUrl,
      });
      console.log(`[Local] Pod provision routes registered (/provision/pods, /provision/webids, ${provisioningService ? 'css-compatible' : 'directory-only'})`);
    } else {
      console.log('[Local] Pod provision routes not registered (XPOD_SERVICE_TOKEN not configured)');
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
      serviceToken: process.env.XPOD_SERVICE_TOKEN,
      publicUrl: process.env.CSS_BASE_URL,
      spDomain: process.env.XPOD_SP_DOMAIN,
      localPort: readPositiveInteger(process.env.CSS_PORT ?? process.env.XPOD_PORT ?? process.env.PORT),
      tunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN ?? process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN,
      cloudBaseUrl: config.oidcIssuer || config.cloudApiEndpoint,
      provisionCode: process.env.XPOD_PROVISION_CODE,
      persistState: createLocalSetupProvisionStateWriter(
        process.env.XPOD_LOCAL_SETUP_PATH,
        process.env.XPOD_PROVIDER_ID,
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
