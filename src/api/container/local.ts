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
import { NgrokTunnelProvider } from '../../tunnel/NgrokTunnelProvider';
import { SakuraFrpTunnelProvider } from '../../tunnel/SakuraFrpTunnelProvider';
import { CloudflareDnsProvider } from '../../dns/cloudflare/CloudflareDnsProvider';
import { SubdomainService } from '../../subdomain/SubdomainService';
import { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';
import { LocalNetworkManager } from '../../edge/LocalNetworkManager';
import { DdnsManager } from '../../edge/DdnsManager';
import type { TunnelProvider, TunnelStatus } from '../../tunnel/TunnelProvider';
import { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';

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
    ngrokAuthToken,
    ngrokUrl,
    ngrokPath,
    subdomain: subdomainConfig,
  } = config;

  container.register({
    podLookupRepo: asFunction(({ db }: ApiContainerCradle) => {
      return new PodLookupRepository(db);
    }).singleton(),
  });

  // 1. 注册 Tunnel Provider。只启用一个 provider；ngrok 是用户自带隧道，不由 Xpod Cloud 托管数据面。
  const activeTunnelProvider = resolveLocalTunnelProvider({
    cloudflareTunnelToken,
    sakuraTunnelToken,
    ngrokAuthToken,
    ngrokUrl,
  });

  if (activeTunnelProvider === 'ngrok') {
    container.register({
      localTunnelProvider: asFunction(() => {
        return new NgrokTunnelProvider({
          authtoken: ngrokAuthToken,
          url: ngrokUrl,
          ngrokPath,
        });
      }).singleton(),
    });
    console.log('[Local] Tunnel provider registered (ngrok configured)');
  } else if (activeTunnelProvider === 'cloudflare') {
    container.register({
      localTunnelProvider: asFunction(() => {
        return new LocalTunnelProvider({
          tunnelToken: cloudflareTunnelToken!,
        });
      }).singleton(),
    });
    console.log('[Local] Tunnel provider registered (CLOUDFLARE_TUNNEL_TOKEN configured)');
  } else if (activeTunnelProvider === 'sakura_frp') {
    container.register({
      localTunnelProvider: asFunction(() => {
        return new SakuraFrpTunnelProvider({
          token: sakuraTunnelToken!,
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
      localNetworkManager: asFunction(({ capabilityDetector, dnsCoordinator }: ApiContainerCradle) => {
        return new LocalNetworkManager({
          detector: capabilityDetector!,
          dnsCoordinator: dnsCoordinator!,
        });
      }).singleton(),

      // Subdomain Service (Keep for API support)
      subdomainService: asFunction(({ dnsProvider, localTunnelProvider, nodeRepo }: ApiContainerCradle) => {
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
          edgeNodeRepo: nodeRepo,
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
    if (activeTunnelProvider !== 'none') {
      console.log(`[Local] Will start configured tunnel provider: ${activeTunnelProvider}`);
    }
    return;
  }

  // 托管式：有 Node Token，连接 Cloud。Node token 是不透明凭据，不能承载用户名/子域名语义。
  const effectiveCloudApiEndpoint = cloudApiEndpoint || 'https://pods.undefineds.co';
  const effectiveLocalPort = parseInt(process.env.XPOD_MAIN_PORT || process.env.CSS_PORT || '3000', 10);
  const managedSubdomain = nodeId || 'auto';
  const tunnelProviderHint: 'cloudflare' | 'sakura_frp' | 'ngrok' | 'none' = activeTunnelProvider;

  container.register({
    subdomainClient: asFunction(() => {
      return new SubdomainClient({
        cloudApiEndpoint: effectiveCloudApiEndpoint,
        nodeId: nodeId || 'auto',
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
          subdomain: managedSubdomain,
          localPort: effectiveLocalPort,
          autoAllocate: true,
          tunnelProvider: tunnelProviderHint,
        });
      }).singleton(),
  });

  console.log('[Local] Managed mode, SubdomainClient and DdnsManager registered');
  console.log(`[Local] Cloud API endpoint: ${effectiveCloudApiEndpoint}`);
  console.log(`[Local] DDNS subdomain: ${managedSubdomain}`);
  if (config.oidcIssuer) {
    console.log(`[Local] Using Cloud IdP: ${config.oidcIssuer}`);
  }

  if (activeTunnelProvider === 'none') {
    console.log('[Local] Note: No tunnel provider configured, assuming direct network access');
  }
}


function resolveLocalTunnelProvider(options: {
  cloudflareTunnelToken?: string;
  sakuraTunnelToken?: string;
  ngrokAuthToken?: string;
  ngrokUrl?: string;
}): 'cloudflare' | 'sakura_frp' | 'ngrok' | 'none' {
  const explicit = process.env.XPOD_TUNNEL_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (explicit === 'cloudflare') {
      return options.cloudflareTunnelToken ? 'cloudflare' : 'none';
    }
    if (explicit === 'sakura-frp' || explicit === 'sakura_frp') {
      return options.sakuraTunnelToken ? 'sakura_frp' : 'none';
    }
    if (explicit === 'ngrok') {
      return 'ngrok';
    }
    return 'none';
  }

  if (options.ngrokAuthToken || options.ngrokUrl) {
    return 'ngrok';
  }
  if (options.cloudflareTunnelToken) {
    return 'cloudflare';
  }
  if (options.sakuraTunnelToken) {
    return 'sakura_frp';
  }
  return 'none';
}
