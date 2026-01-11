/**
 * API Container 入口
 * 
 * 使用 Awilix 进行依赖注入，根据 edition 注册不同服务
 */

import { createContainer, asValue, InjectionMode, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import { registerCommonServices } from './common';
import { registerCloudServices } from './cloud';
import { registerLocalServices } from './local';

export type { ApiContainerCradle, ApiContainerConfig } from './types';

/**
 * 创建 API 容器
 */
export function createApiContainer(config: ApiContainerConfig): AwilixContainer<ApiContainerCradle> {
  const container = createContainer<ApiContainerCradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  // 注册配置
  container.register({
    config: asValue(config),
  });

  // 注册共享服务
  registerCommonServices(container);

  // 根据 edition 注册专属服务
  if (config.edition === 'cloud') {
    registerCloudServices(container);
  } else {
    registerLocalServices(container);
  }

  return container;
}

/**
 * 从环境变量读取配置
 */
export function loadConfigFromEnv(): ApiContainerConfig {
  const edition = (process.env.CSS_EDITION ?? 'local') as 'cloud' | 'local';
  
  return {
    edition,
    port: parseInt(process.env.API_PORT ?? '3001', 10),
    host: process.env.API_HOST ?? '0.0.0.0',
    databaseUrl: process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL ?? '',
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) ?? ['*'],
    encryptionKey: process.env.XPOD_ENCRYPTION_KEY ?? 'default-dev-key-change-me',
    cssTokenEndpoint: process.env.CSS_TOKEN_ENDPOINT ?? 'http://localhost:3000/.oidc/token',
    
    // 子域名配置 (cloud 模式)
    subdomain: {
      enabled: process.env.XPOD_SUBDOMAIN_ENABLED === 'true',
      baseDomain: process.env.XPOD_SUBDOMAIN_BASE_DOMAIN ?? 'pods.undefieds.co',
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      tencentDnsSecretId: process.env.TENCENT_DNS_SECRET_ID,
      tencentDnsSecretKey: process.env.TENCENT_DNS_SECRET_KEY,
    },
    
    // Signal 端点 (local 模式)
    signalEndpoint: process.env.XPOD_SIGNAL_ENDPOINT,
    
    // Local 托管式：子域名客户端配置
    cloudApiEndpoint: process.env.XPOD_CLOUD_API_ENDPOINT,
    nodeId: process.env.XPOD_NODE_ID,
    nodeToken: process.env.XPOD_NODE_TOKEN,
    
    // Local 托管式/自管式：Cloudflare Tunnel Token
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
  };
}
