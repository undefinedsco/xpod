/**
 * Local 模式服务注册
 *
 * Local 模式有两种配置：
 * - 托管式 (managed): 配置 XPOD_NODE_TOKEN，自动连接 Cloud 获取身份服务和 DDNS
 * - 独立式 (standalone): 不配置 XPOD_NODE_TOKEN，用户自己配置 CSS_BASE_URL 和 IdP
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';

import { SubdomainClient } from '../../subdomain/SubdomainClient';
import { LocalTunnelProvider } from '../../tunnel/LocalTunnelProvider';
import { SakuraFrpTunnelProvider } from '../../tunnel/SakuraFrpTunnelProvider';
import { CloudflareDnsProvider } from '../../dns/cloudflare/CloudflareDnsProvider';
import { SubdomainService } from '../../subdomain/SubdomainService';
import { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';
import { LocalNetworkManager } from '../../edge/LocalNetworkManager';
import { DdnsManager } from '../../edge/DdnsManager';
import type { TunnelProvider, TunnelStatus } from '../../tunnel/TunnelProvider';

/**
 * 注册 Local 模式专属服务
 */
export function registerLocalServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  const config = container.resolve('config') as ApiContainerConfig;

  const {
    cloudApiEndpoint,
    nodeId,
    nodeToken,
    cloudflareTunnelToken,
    sakuraTunnelToken,
    subdomain: subdomainConfig,
  } = config;

  // 1. 注册 Tunnel Provider (优先 Cloudflare，其次 SakuraFRP)
  if (cloudflareTunnelToken) {
    container.register({
      localTunnelProvider: asFunction(() => {
        return new LocalTunnelProvider({
          tunnelToken: cloudflareTunnelToken,
        });
      }).singleton(),
    });
    console.log('[Local] Tunnel provider registered (CLOUDFLARE_TUNNEL_TOKEN configured)');
  } else if (sakuraTunnelToken) {
    container.register({
      localTunnelProvider: asFunction(() => {
        return new SakuraFrpTunnelProvider({
          token: sakuraTunnelToken,
        });
      }).singleton(),
    });
    console.log('[Local] Tunnel provider registered (SAKURA_TUNNEL_TOKEN configured)');
  }

  // 2. 自适应 DNS 管理 (Self-Hosted DNS)
  // 如果配置了 Cloudflare API Token 和 Base Domain，启用本地 DNS 管理
  const apiToken = subdomainConfig?.cloudflareApiToken;

  // 在 Local 模式下，强制使用 CSS_BASE_URL 作为域名来源
  // 简化用户配置心智
  let baseDomain: string | undefined;
  if (process.env.CSS_BASE_URL) {
    try {
      const url = new URL(process.env.CSS_BASE_URL);
      baseDomain = url.hostname;
    } catch {
      console.warn('[Local] Invalid CSS_BASE_URL, cannot derive domain for DNS management');
    }
  }

  // DEBUG: 打印变量状态
  console.log(`[Local] Debug: apiToken=${apiToken ? '***' : 'undefined'}, baseDomain=${baseDomain}, CSS_BASE_URL=${process.env.CSS_BASE_URL}`);

  if (apiToken && baseDomain) {
    console.log('[Local] Self-hosted DNS mode detected (IPv6 Ready)');

    container.register({
      // DNS Provider
      dnsProvider: asFunction(() => {
        return new CloudflareDnsProvider({
          apiToken: apiToken!,
        });
      }).singleton(),

      // DNS Coordinator (DnsMaintainer)
      dnsCoordinator: asFunction(({ dnsProvider }: ApiContainerCradle) => {
        return new EdgeNodeDnsCoordinator({
          provider: dnsProvider!,
          rootDomain: baseDomain,
        });
      }).singleton(),

      // Network Detector
      capabilityDetector: asFunction(() => {
        return new EdgeNodeCapabilityDetector({
          dynamicDetection: { enableNetworkDetection: true },
        });
      }).singleton(),

      // Local Network Manager (Orchestrator)
      localNetworkManager: asFunction(({ capabilityDetector, dnsCoordinator, localTunnelProvider }: ApiContainerCradle) => {
        // Tunnel 应该指向 Gateway 端口 (通常是 3000)，而不是 API Server 端口 (3004)
        const mainPort = parseInt(process.env.XPOD_MAIN_PORT || '3000', 10);
        return new LocalNetworkManager({
          detector: capabilityDetector!,
          dnsCoordinator: dnsCoordinator!,
          tunnelProvider: localTunnelProvider,
          localPort: mainPort,
        });
      }).singleton(),

      // Subdomain Service (Keep for API support)
      subdomainService: asFunction(({ dnsProvider, localTunnelProvider }: ApiContainerCradle) => {
        // 如果没有配置 Tunnel Token，使用一个 Mock Provider
        const tunnelProvider = localTunnelProvider ?? {
          name: 'noop',
          setup: async () => { throw new Error('Tunnel not configured'); },
          start: async () => { throw new Error('Tunnel not configured'); },
          stop: async () => {},
          cleanup: async () => {},
          getStatus: () => ({ running: false, connected: false } as TunnelStatus),
          getEndpoint: () => undefined,
        } as TunnelProvider;

        return new SubdomainService({
          baseDomain: baseDomain!,
          dnsProvider: dnsProvider!,
          tunnelProvider,
        });
      }).singleton(),
    });
    console.log(`[Local] Local DNS maintenance services registered for: ${baseDomain}`);
    // 继续进行后续逻辑，不要 return，因为用户可能既用了自管 DNS 又开启了 Managed Client
  }

  // 独立式：没有配置 Node Token，用户自己管理域名和 IdP
  if (!nodeToken) {
    console.log('[Local] Standalone mode (no XPOD_NODE_TOKEN)');
    console.log('[Local] User manages DNS and IdP externally');
    if (cloudflareTunnelToken) {
      console.log('[Local] Will start cloudflared with provided CLOUDFLARE_TUNNEL_TOKEN');
    }
    return;
  }

  // 托管式：有 Node Token，连接 Cloud
  // Cloud API endpoint 可以从 Token 解析或使用默认值
  const effectiveCloudApiEndpoint = cloudApiEndpoint || 'https://pods.undefineds.co';

  // 从 Node Token 解析用户名作为子域名 (格式: username:secret)
  const subdomain = parseSubdomainFromToken(nodeToken);

  container.register({
    subdomainClient: asFunction(() => {
      return new SubdomainClient({
        cloudApiEndpoint: effectiveCloudApiEndpoint,
        nodeId: nodeId || 'auto', // 可以从 Token 解析
        nodeToken: nodeToken!,
      });
    }).singleton(),

    // 注册网络检测器 (如果尚未注册)
    capabilityDetector: asFunction(() => {
      return new EdgeNodeCapabilityDetector({
        dynamicDetection: { enableNetworkDetection: true },
      });
    }).singleton(),

    // DDNS Manager: 自动分配和更新 DDNS
    ddnsManager: asFunction(({ subdomainClient, capabilityDetector }: ApiContainerCradle) => {
      return new DdnsManager({
        client: subdomainClient!,
        detector: capabilityDetector!,
        subdomain: subdomain || nodeId || 'auto',
        autoAllocate: true,
      });
    }).singleton(),
  });

  console.log('[Local] Managed mode, SubdomainClient and DdnsManager registered');
  console.log(`[Local] Cloud API endpoint: ${effectiveCloudApiEndpoint}`);
  if (subdomain) {
    console.log(`[Local] DDNS subdomain: ${subdomain}`);
  }
  if (config.oidcIssuer) {
    console.log(`[Local] Using Cloud IdP: ${config.oidcIssuer}`);
  }

  if (!cloudflareTunnelToken && !sakuraTunnelToken) {
    console.log('[Local] Note: No tunnel token configured, assuming direct network access');
  }
}

/**
 * 从 Node Token 解析子域名/用户名
 * Token 格式: username:secret 或 base64 编码
 */
function parseSubdomainFromToken(token: string): string | undefined {
  // 尝试直接解析 username:secret 格式
  if (token.includes(':')) {
    const [username] = token.split(':');
    if (username && /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(username)) {
      return username;
    }
  }

  // 尝试 base64 解码
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (decoded.includes(':')) {
      const [username] = decoded.split(':');
      if (username && /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(username)) {
        return username;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}
