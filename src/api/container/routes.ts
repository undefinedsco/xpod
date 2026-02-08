/**
 * 路由注册
 *
 * 根据容器中的服务注册 API 路由
 */

import type { AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import type { ApiServer } from '../ApiServer';

import { registerSignalRoutes } from '../handlers/SignalHandler';
import { registerNodeRoutes } from '../handlers/NodeHandler';
import { registerChatRoutes } from '../handlers/ChatHandler';
import { registerApiKeyRoutes } from '../handlers/ApiKeyHandler';
import { registerSubdomainRoutes } from '../handlers/SubdomainHandler';
import { registerSubdomainClientRoutes } from '../handlers/SubdomainClientHandler';
import { registerDevRoutes } from '../handlers/DevHandler';
import { registerWebIdProfileRoutes } from '../handlers/WebIdProfileHandler';
import { registerDdnsRoutes } from '../handlers/DdnsHandler';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';

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

  registerSignalRoutes(server, { repository: nodeRepo });
  registerNodeRoutes(server, { repository: nodeRepo });
  registerApiKeyRoutes(server, { store: apiKeyStore });
  registerChatRoutes(server, { chatService: chatService as any });

  // 开发模式路由 (仅 NODE_ENV=development 时启用)
  registerDevRoutes(server, {
    nodeRepo,
    credentialsStore: apiKeyStore,
  });
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
    if (profileRepo) {
      registerWebIdProfileRoutes(server, { profileRepo: profileRepo as any });
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
      const ddnsDomain = config.subdomain?.ddnsDomain || 'undefineds.xyz';
      registerDdnsRoutes(server, {
        ddnsRepo: ddnsRepo as any,
        dnsProvider: dnsProvider as any,
        defaultDomain: ddnsDomain,
      });
      console.log(`[Cloud] DDNS routes registered (domain: ${ddnsDomain})`);
    }
  } catch {
    console.log('[Cloud] DDNS routes not registered (repo not available)');
  }
}

/**
 * Local 模式专属路由
 */
function registerLocalRoutes(
  container: AwilixContainer<ApiContainerCradle>,
  server: ApiServer,
): void {
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
}
