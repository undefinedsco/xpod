/**
 * Local 模式服务注册
 * 
 * Local 模式有两种配置：
 * - 托管式 (managed): 配置 XPOD_CLOUD_API_ENDPOINT，通过 SubdomainClient 调用 Cloud API
 *   + CLOUDFLARE_TUNNEL_TOKEN 启动隧道
 * - 自管式 (self-hosted): 不配置 CLOUD_API_ENDPOINT，用户自己配置 CSS_BASE_URL
 *   + 可选配置 CLOUDFLARE_TUNNEL_TOKEN 让我们帮启动隧道
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';

import { SubdomainClient } from '../../subdomain/SubdomainClient';
import { CloudflareTunnelProvider } from '../../tunnel/CloudflareTunnelProvider';

/**
 * 注册 Local 模式专属服务
 */
export function registerLocalServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  const config = container.resolve('config');
  
  const { cloudApiEndpoint, nodeId, nodeToken, cloudflareTunnelToken } = config;
  
  // 注册 Tunnel Provider (托管式和自管式都可能用到)
  if (cloudflareTunnelToken) {
    container.register({
      localTunnelProvider: asFunction(() => {
        // Local 模式不需要 API Token，只需要 Tunnel Token 启动 cloudflared
        return new CloudflareTunnelProvider({
          apiToken: '', // 不需要，只用于启动
          accountId: '',
          baseDomain: '',
        });
      }).singleton(),
    });
    console.log('[Local] Tunnel provider registered (CLOUDFLARE_TUNNEL_TOKEN configured)');
  }
  
  // 自管式：没有配置 Cloud API，用户自己管理域名
  if (!cloudApiEndpoint) {
    console.log('[Local] Self-hosted mode (no XPOD_CLOUD_API_ENDPOINT)');
    console.log('[Local] User manages DNS externally via CSS_BASE_URL');
    if (cloudflareTunnelToken) {
      console.log('[Local] Will start cloudflared with provided CLOUDFLARE_TUNNEL_TOKEN');
    }
    return;
  }
  
  // 托管式：需要完整的认证信息
  if (!nodeId || !nodeToken) {
    console.log('[Local] XPOD_CLOUD_API_ENDPOINT is set but missing XPOD_NODE_ID or XPOD_NODE_TOKEN');
    return;
  }

  container.register({
    subdomainClient: asFunction(() => {
      return new SubdomainClient({
        cloudApiEndpoint,
        nodeId,
        nodeToken,
      });
    }).singleton(),
  });

  console.log('[Local] Managed mode, SubdomainClient registered');
  console.log(`[Local] Cloud API endpoint: ${cloudApiEndpoint}`);
  
  if (!cloudflareTunnelToken) {
    console.log('[Local] Warning: CLOUDFLARE_TUNNEL_TOKEN not configured, tunnel will not start');
  }
}
