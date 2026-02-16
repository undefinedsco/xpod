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

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function resolveCssTokenEndpoint(): string {
  if (process.env.CSS_TOKEN_ENDPOINT) {
    return process.env.CSS_TOKEN_ENDPOINT;
  }

  if (process.env.CSS_BASE_URL) {
    return `${ensureTrailingSlash(process.env.CSS_BASE_URL)}.oidc/token`;
  }

  return 'http://localhost:3000/.oidc/token';
}

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
  const edition = (process.env.XPOD_EDITION ?? 'local') as 'cloud' | 'local';

  // Port auto-increment: API_PORT = CSS_PORT + 1 if not explicitly set
  const cssPort = parseInt(process.env.CSS_PORT ?? '3000', 10);
  const apiPort = process.env.API_PORT
    ? parseInt(process.env.API_PORT, 10)
    : cssPort + 1;

  return {
    edition,
    port: apiPort,
    host: process.env.API_HOST ?? '0.0.0.0',
    databaseUrl: process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL ?? '',
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) ?? ['*'],
    encryptionKey: process.env.XPOD_ENCRYPTION_KEY ?? 'default-dev-key-change-me',
    cssTokenEndpoint: resolveCssTokenEndpoint(),

    // 子域名配置 (cloud 模式)
    subdomain: {
      enabled: process.env.XPOD_SUBDOMAIN_ENABLED === 'true',
      baseDomain: ((): string | undefined => {
        if (!process.env.CSS_BASE_URL) return undefined;
        try {
          return new URL(process.env.CSS_BASE_URL).hostname;
        } catch {
          return undefined;
        }
      })(),
      ddnsDomain: process.env.XPOD_DDNS_DOMAIN || 'undefineds.xyz',
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      tencentDnsSecretId: process.env.TENCENT_DNS_SECRET_ID,
      tencentDnsSecretKey: process.env.TENCENT_DNS_SECRET_KEY,
    },

    // Local 托管式：连接 Cloud
    cloudApiEndpoint: process.env.XPOD_CLOUD_API_ENDPOINT,
    nodeId: process.env.XPOD_NODE_ID,
    nodeToken: process.env.XPOD_NODE_TOKEN,

    // OIDC Issuer (Local 托管式使用 Cloud IdP)
    // 如果配置了 XPOD_NODE_TOKEN，默认使用 Cloud IdP
    oidcIssuer: process.env.XPOD_OIDC_ISSUER ?? process.env.CSS_OIDC_ISSUER ?? (
      process.env.XPOD_NODE_TOKEN
        ? (process.env.XPOD_CLOUD_API_ENDPOINT ?? 'https://id.undefineds.co')
        : undefined
    ),

    // 隧道配置
    cloudflareTunnelToken: process.env.CLOUDFLARE_TUNNEL_TOKEN,
    // Prefer SAKURA_TUNNEL_TOKEN; keep SAKURA_TOKEN for backward compatibility.
    sakuraTunnelToken: process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN,

    // Edge 节点管理 (cloud 模式)
    edgeNodesEnabled: process.env.XPOD_EDGE_NODES_ENABLED === 'true',
  };
}
