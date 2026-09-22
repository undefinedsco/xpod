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
import { AutoTunnelProvider, type AutoTunnelCandidate } from '../../tunnel/AutoTunnelProvider';
import { LocalTunnelProvider } from '../../tunnel/LocalTunnelProvider';
import { NgrokTunnelProvider } from '../../tunnel/NgrokTunnelProvider';
import { SakuraFrpTunnelProvider } from '../../tunnel/SakuraFrpTunnelProvider';

const DEFAULT_CLOUD_API_ENDPOINT = 'https://api.undefineds.co';
import { CloudflareDnsProvider } from '../../dns/cloudflare/CloudflareDnsProvider';
import { TencentDnsProvider } from '../../dns/tencent/TencentDnsProvider';
import { SubdomainService } from '../../subdomain/SubdomainService';
import { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';
import { LocalNetworkManager } from '../../edge/LocalNetworkManager';
import { DdnsManager } from '../../edge/DdnsManager';
import type { TunnelProvider, TunnelStatus } from '../../tunnel/TunnelProvider';
import { selectActiveTunnelProfile, type ActiveTunnelProvider, type TunnelProfile } from '../../tunnel/TunnelProfiles';
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
    frpcPath,
    subdomain: subdomainConfig,
  } = config;

  container.register({
    podLookupRepo: asFunction(({ db }: ApiContainerCradle) => {
      return new PodLookupRepository(db);
    }).singleton(),
  });

  // 1. 注册 Tunnel Provider。可记录多个 profile，但只启用 active profile；ngrok 是用户自带隧道，不由 Xpod Cloud 托管数据面。
  const activeTunnel = resolveActiveLocalTunnel({
    config,
    cloudflareTunnelToken,
    sakuraTunnelToken,
    ngrokAuthToken,
    ngrokUrl,
  });
  const activeTunnelProvider = activeTunnel.provider;

  // The settings page stores one credential per profile; the provider-global env key is
  // only the legacy fallback. Without this the profile's own secret never reached the
  // provider and the tunnel could not start even though the profile looked configured.
  const activeCredential = activeTunnel.profile?.credentialEnvKey
    ? readCredential(process.env[activeTunnel.profile.credentialEnvKey])
    : undefined;

  // Every provider the operator has credentials for is a candidate; which one
  // can reach its control plane is a property of the network, so an implicit
  // selection is settled by readiness instead of by list order. An explicitly
  // pinned profile or provider still starts exactly that one - including when it
  // has no credential, because then its own failure is the answer the operator
  // needs rather than a silently absent provider.
  const profileFor = (provider: ActiveTunnelProvider): TunnelProfile | undefined =>
    (config.tunnelProfiles ?? []).find((entry) => entry.provider === provider);
  const profileCredential = (provider: ActiveTunnelProvider): string | undefined => {
    const key = profileFor(provider)?.credentialEnvKey;
    return key ? readCredential(process.env[key]) : undefined;
  };
  const credentialFor = (provider: ActiveTunnelProvider): string | undefined =>
    (activeTunnelProvider === provider ? activeCredential : undefined) ?? profileCredential(provider);

  const candidates: Array<{
    id: string;
    provider: ActiveTunnelProvider;
    configured: boolean;
    create: () => TunnelProvider;
  }> = [
    {
      id: 'ngrok',
      provider: 'ngrok',
      configured: Boolean(credentialFor('ngrok') ?? ngrokAuthToken ?? ngrokUrl),
      create: () => new NgrokTunnelProvider({
        authtoken: credentialFor('ngrok') ?? ngrokAuthToken,
        url: profileFor('ngrok')?.publicUrl ?? ngrokUrl,
        ngrokPath,
      }),
    },
    {
      id: 'cloudflare',
      provider: 'cloudflare',
      configured: Boolean(credentialFor('cloudflare') ?? cloudflareTunnelToken),
      create: () => new LocalTunnelProvider({
        tunnelToken: (credentialFor('cloudflare') ?? cloudflareTunnelToken)!,
        publicUrl: profileFor('cloudflare')?.publicUrl,
      }),
    },
    {
      id: 'sakura_frp',
      provider: 'sakura_frp',
      configured: Boolean(credentialFor('sakura_frp') ?? sakuraTunnelToken),
      create: () => new SakuraFrpTunnelProvider({
        token: (credentialFor('sakura_frp') ?? sakuraTunnelToken)!,
        publicUrl: profileFor('sakura_frp')?.publicUrl,
        frpcPath,
      }),
    },
  ];

  const pinnedProvider = config.tunnelActiveProfileId || config.tunnelProvider || process.env.XPOD_TUNNEL_PROVIDER
    ? activeTunnelProvider
    : undefined;
  const selected = pinnedProvider
    ? candidates.filter((candidate) => candidate.provider === pinnedProvider)
    : candidates.filter((candidate) => candidate.configured);

  if (selected.length === 1) {
    const [only] = selected;
    container.register({
      localTunnelProvider: asFunction(only.create).singleton(),
    });
    console.log(`[Local] Tunnel provider registered (${only.id} configured)`);
  } else if (selected.length > 1) {
    container.register({
      localTunnelProvider: asFunction((): TunnelProvider => new AutoTunnelProvider({
        candidates: selected.map((candidate): AutoTunnelCandidate => ({
          id: candidate.id,
          provider: candidate.create(),
        })),
      })).singleton(),
    });
    console.log(`[Local] Tunnel providers registered (auto: ${selected.map((candidate) => candidate.id).join(', ')})`);
  }

  // 2. 自适应 DNS 管理 (Self-Hosted DNS)
  // 如果配置了 Cloudflare API Token 和 Base Domain，启用本地 DNS 管理
  const apiToken = subdomainConfig?.cloudflareApiToken;

  // 在 Local 模式下，强制使用 CSS_BASE_URL 作为域名来源
  // 简化用户配置心智
  let baseDomain: string | undefined = process.env.XPOD_DNS_DOMAIN?.trim() || undefined;
  if (!baseDomain && process.env.CSS_BASE_URL) {
    try {
      const url = new URL(process.env.CSS_BASE_URL);
      baseDomain = url.hostname;
    } catch {
      console.warn('[Local] Invalid CSS_BASE_URL, cannot derive domain for DNS management');
    }
  }

  // DEBUG: 打印变量状态
  console.log(`[Local] Debug: apiToken=${apiToken ? '***' : 'undefined'}, baseDomain=${baseDomain}, CSS_BASE_URL=${process.env.CSS_BASE_URL}`);

  // The settings page lets an operator pick the DNS provider, so the runtime honours that
  // choice instead of always wiring Cloudflare and ignoring a saved "tencent".
  const dnsProviderId = process.env.XPOD_DNS_PROVIDER?.trim().toLowerCase() || 'cloudflare';
  const tencentDnsToken = process.env.XPOD_TENCENT_DNS_TOKEN?.trim();
  const tencentDnsTokenId = process.env.XPOD_TENCENT_DNS_TOKEN_ID?.trim();
  const dnsCredentialReady = dnsProviderId === 'tencent' ? Boolean(tencentDnsToken) : Boolean(apiToken);

  if (dnsCredentialReady && baseDomain) {
    console.log(`[Local] Self-hosted DNS mode detected (provider: ${dnsProviderId})`);

    container.register({
      // DNS Provider: one axis, the selected implementation.
      dnsProvider: asFunction(() => {
        return dnsProviderId === 'tencent'
          ? new TencentDnsProvider({ tokenId: tencentDnsTokenId, token: tencentDnsToken })
          : new CloudflareDnsProvider({ apiToken: apiToken! });
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

  // 首次托管式：Cloud endpoint 已配置，但 Cloud 尚未下发 Node Token。
  // XPOD_NODE_TOKEN 是 Cloud /provision/nodes 返回的持久凭据，不能要求用户手填。
  if (!nodeToken) {
    const effectiveCloudApiEndpoint = cloudApiEndpoint || DEFAULT_CLOUD_API_ENDPOINT;
    if (effectiveCloudApiEndpoint) {
      console.log('[Local] Managed setup pending (waiting for Cloud-issued XPOD_NODE_TOKEN)');
      console.log(`[Local] Cloud API endpoint: ${effectiveCloudApiEndpoint}`);
      console.log('[Local] LinX/local setup should persist Cloud-issued nodeId/nodeToken/serviceToken before DDNS starts');
      if (activeTunnelProvider !== 'none') {
        console.log(`[Local] Tunnel provider configured for provisioning: ${activeTunnelProvider}`);
      }
      return;
    }

    console.log('[Local] Standalone mode (no XPOD_NODE_TOKEN)');
    console.log('[Local] User manages DNS and IdP externally');
    if (activeTunnelProvider !== 'none') {
      console.log(`[Local] Will start configured tunnel provider: ${activeTunnelProvider}`);
    }
    return;
  }

  // 托管式：有 Node Token，连接 Cloud。Node token 是不透明凭据，不能承载用户名/子域名语义。
  const effectiveCloudApiEndpoint = cloudApiEndpoint || DEFAULT_CLOUD_API_ENDPOINT;
  const effectiveLocalPort = parseInt(process.env.XPOD_MAIN_PORT || process.env.CSS_PORT || '3000', 10);
  const managedSubdomain = nodeId || 'auto';
  const tunnelProviderHint: 'cloudflare' | 'sakura_frp' | 'ngrok' | 'frp' | 'none' = activeTunnelProvider;

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


function resolveActiveLocalTunnel(options: {
  config: ApiContainerConfig;
  cloudflareTunnelToken?: string;
  sakuraTunnelToken?: string;
  ngrokAuthToken?: string;
  ngrokUrl?: string;
}): { provider: ActiveTunnelProvider; profile?: TunnelProfile } {
  const configuredState = selectActiveTunnelProfile(
    options.config.tunnelProfiles ?? [],
    options.config.tunnelActiveProfileId,
  );
  if (configuredState.activeProfile) {
    return {
      provider: configuredState.activeProvider,
      profile: configuredState.activeProfile,
    };
  }
  if (options.config.activeTunnelProfile) {
    return {
      provider: options.config.activeTunnelProfile.provider,
      profile: options.config.activeTunnelProfile,
    };
  }

  return {
    provider: resolveLocalTunnelProvider({
      explicit: options.config.tunnelProvider ?? process.env.XPOD_TUNNEL_PROVIDER,
      cloudflareTunnelToken: options.cloudflareTunnelToken,
      sakuraTunnelToken: options.sakuraTunnelToken,
      ngrokAuthToken: options.ngrokAuthToken,
      ngrokUrl: options.ngrokUrl,
    }),
  };
}

/** A credential only counts when it actually carries a value. */
function readCredential(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveLocalTunnelProvider(options: {
  explicit?: string;
  cloudflareTunnelToken?: string;
  sakuraTunnelToken?: string;
  ngrokAuthToken?: string;
  ngrokUrl?: string;
}): ActiveTunnelProvider {
  const explicit = options.explicit?.trim().toLowerCase();
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
    if (explicit === 'frp') {
      return 'frp';
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
