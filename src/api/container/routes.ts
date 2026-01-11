/**
 * 路由注册
 * 
 * 根据容器中的服务注册 API 路由
 */

import type { AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';
import type { ApiServer } from '../ApiServer';

import { registerSignalRoutes } from '../handlers/SignalHandler';
import { registerNodeRoutes } from '../handlers/NodeHandler';
import { registerChatRoutes } from '../handlers/ChatHandler';
import { registerApiKeyRoutes } from '../handlers/ApiKeyHandler';
import { registerSubdomainRoutes } from '../handlers/SubdomainHandler';
import { registerSubdomainClientRoutes } from '../handlers/SubdomainClientHandler';
import { registerChatKitRoutes } from '../handlers/ChatKitHandler';

/**
 * 注册所有 API 路由
 */
export function registerRoutes(container: AwilixContainer<ApiContainerCradle>): void {
  const server = container.resolve('apiServer');
  const config = container.resolve('config');
  
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
  const nodeRepo = container.resolve('nodeRepo');
  const apiKeyStore = container.resolve('apiKeyStore');
  const chatService = container.resolve('chatService');
  const chatKitService = container.resolve('chatKitService');
  
  registerSignalRoutes(server, { repository: nodeRepo });
  registerNodeRoutes(server, { repository: nodeRepo });
  registerApiKeyRoutes(server, { store: apiKeyStore });
  registerChatRoutes(server, { chatService });
  registerChatKitRoutes(server, { chatKitService });
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
    const subdomainService = container.resolve('subdomainService');
    if (subdomainService) {
      registerSubdomainRoutes(server, { subdomainService });
      console.log('[Cloud] Subdomain routes registered');
    }
  } catch {
    // SubdomainService 未注册，跳过
    console.log('[Cloud] Subdomain routes not registered (service not available)');
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
    const subdomainClient = container.resolve('subdomainClient');
    if (subdomainClient) {
      registerSubdomainClientRoutes(server, { subdomainClient });
      console.log('[Local] Subdomain client routes registered');
    }
  } catch {
    // SubdomainClient 未注册，跳过
    console.log('[Local] Subdomain client routes not registered (client not available)');
  }
}
