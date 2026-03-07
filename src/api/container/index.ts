/**
 * API Container 入口
 *
 * 使用 Awilix 进行依赖注入，根据 edition 注册不同服务
 */

import { createContainer, asValue, InjectionMode, type AwilixContainer } from 'awilix';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApiContainerCradle, ApiContainerConfig } from './types';
import { registerCommonServices } from './common';
import { registerCloudServices } from './cloud';
import { registerLocalServices } from './local';
import { registerBusinessToken } from './business-token';

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

  // 注册 Business Token (如果配置了 XPOD_BUSINESS_TOKEN)
  registerBusinessToken(container);

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
    socketPath: process.env.API_SOCKET_PATH,
    databaseUrl: process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL ?? '',
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) ?? ['*'],
    cssTokenEndpoint: resolveCssTokenEndpoint(),

    // 子域名配置 (cloud 模式)
    subdomain: {
      baseStorageDomain: process.env.CSS_BASE_STORAGE_DOMAIN,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
      tencentDnsSecretId: process.env.TENCENT_DNS_SECRET_ID,
      tencentDnsSecretKey: process.env.TENCENT_DNS_SECRET_KEY,
    },

    // Local 托管式：连接 Cloud
    cloudApiEndpoint: process.env.XPOD_CLOUD_API_ENDPOINT,
    nodeId: loadOrGenerateDeviceId(process.env.XPOD_NODE_ID),
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

/**
 * 获取设备首个非内部网卡的 MAC 地址。
 * 返回小写冒号分隔格式，如 "aa:bb:cc:dd:ee:ff"。
 * 容器/虚拟机中可能拿不到稳定 MAC，此时返回 undefined。
 */
function getFirstMacAddress(): string | undefined {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac.toLowerCase();
      }
    }
  }
  return undefined;
}

/**
 * 读取或生成设备 ID（持久化到 data/.device-id）。
 *
 * 优先级：
 *   1. 环境变量 XPOD_NODE_ID
 *   2. 已持久化的 data/.device-id
 *   3. 基于 MAC 地址的 SHA-256 哈希（截取前 32 位 hex）
 *   4. 随机 UUID（容器/虚拟机无稳定 MAC 时兜底）
 *
 * 生成后写入 data/.device-id，后续启动直接读取，保证同一设备 ID 稳定。
 */
function loadOrGenerateDeviceId(envNodeId?: string): string | undefined {
  if (envNodeId) {
    return envNodeId;
  }

  const rootDir = process.env.CSS_ROOT_FILE_PATH || './data';
  const deviceIdPath = path.join(rootDir, '.device-id');

  // 尝试从文件读取
  try {
    if (fs.existsSync(deviceIdPath)) {
      const content = fs.readFileSync(deviceIdPath, 'utf-8').trim();
      if (content) {
        return content;
      }
    }
  } catch {
    // 读取失败，继续生成
  }

  // 优先用 MAC 哈希，拿不到则 UUID 兜底
  const mac = getFirstMacAddress();
  const deviceId = mac
    ? createHash('sha256').update(mac).digest('hex').slice(0, 32)
    : randomUUID();

  try {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
    fs.writeFileSync(deviceIdPath, deviceId, 'utf-8');
  } catch {
    // 写入失败不阻塞启动
  }

  return deviceId;
}
