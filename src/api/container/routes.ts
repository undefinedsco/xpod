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
import { registerApiKeyRoutes } from '../handlers/ApiKeyHandler';
import { registerSubdomainRoutes } from '../handlers/SubdomainHandler';
import { registerSubdomainClientRoutes } from '../handlers/SubdomainClientHandler';
import { registerWebIdProfileRoutes } from '../handlers/WebIdProfileHandler';
import { registerDdnsRoutes } from '../handlers/DdnsHandler';
import { registerChatKitRoutes } from '../handlers/ChatKitHandler';
import { registerChatKitV1Routes } from '../handlers/ChatKitV1Handler';
import { registerDashboardRoutes } from '../handlers/DashboardHandler';
import { registerAdminRoutes } from '../handlers/AdminHandler';
import { registerAdminDdnsRoutes } from '../handlers/AdminDdnsHandler';
import { registerLinxCapabilitiesRoutes } from '../handlers/LinxCapabilitiesHandler';
import { registerProvisionRoutes, registerProvisionStatusRoute } from '../handlers/ProvisionHandler';
import { registerPodManagementRoutes } from '../handlers/PodManagementHandler';
import { registerQuotaRoutes } from '../handlers/QuotaHandler';
import { registerUsageRoutes } from '../handlers/UsageHandler';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import { UsageRepository } from '../../storage/quota/UsageRepository';
import { DrizzleQuotaService } from '../../quota/DrizzleQuotaService';
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
  const apiKeyStore = container.resolve('apiKeyStore') as DrizzleClientCredentialsStore;
  const chatService = container.resolve('chatService');
  const chatKitService = container.resolve('chatKitService');
  const chatKitStore = container.resolve('chatKitStore');
  const config = container.resolve('config') as ApiContainerConfig;

  registerEdgeNodeSignalRoutes(server, {
    repository: nodeRepo,
    dnsCoordinator: container.resolve('dnsCoordinator', { allowUnregistered: true }) as any,
    healthProbeService: container.resolve('healthProbeService', { allowUnregistered: true }) as any,
  });
  registerNodeRoutes(server, { repository: nodeRepo });
  registerApiKeyRoutes(server, { store: apiKeyStore });
  registerChatRoutes(server, { chatService });
  registerChatKitRoutes(server, { chatKitService });
  registerChatKitV1Routes(server, { store: chatKitStore });

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

  // WebID Profile 托管服务
  try {
    const profileRepo = container.resolve('webIdProfileRepo', { allowUnregistered: true });
    const podLookupRepo = container.resolve('podLookupRepo', { allowUnregistered: true });
    if (profileRepo) {
      registerWebIdProfileRoutes(server, {
        profileRepo: profileRepo as any,
        podLookupRepo: podLookupRepo as any,
      });
      console.log('[Cloud] WebID Profile routes registered');
    }
  } catch {
    console.log('[Cloud] WebID Profile routes not registered (repo not available)');
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
      registerPodManagementRoutes(server, {
        rootDir,
        verifyServiceToken: async (token: string) => token === expectedServiceToken,
      });
      console.log('[Local] Pod provision routes registered (/provision/pods)');
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
      cloudBaseUrl: config.oidcIssuer || config.cloudApiEndpoint,
    });
    console.log('[Local] Provision status route registered (/provision/status)');
  } catch (error) {
    console.log(`[Local] Provision status route not registered: ${error}`);
  }
}
