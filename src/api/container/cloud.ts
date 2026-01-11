/**
 * Cloud 模式服务注册
 * 
 * Cloud 模式持有 DNS/Tunnel 密钥，直接操作子域名
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';

import { TencentDnsProvider } from '../../dns/tencent/TencentDnsProvider';
import { CloudflareTunnelProvider } from '../../tunnel/CloudflareTunnelProvider';
import { SubdomainService } from '../../subdomain/SubdomainService';

/**
 * 注册 Cloud 模式专属服务
 */
export function registerCloudServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  const config = container.resolve('config');
  
  // 只有配置了子域名功能才注册
  if (!config.subdomain?.enabled) {
    return;
  }

  const {
    baseDomain,
    tencentDnsSecretId,
    tencentDnsSecretKey,
    cloudflareAccountId,
    cloudflareApiToken,
  } = config.subdomain;

  // 检查必要配置
  if (!tencentDnsSecretId || !tencentDnsSecretKey || !cloudflareAccountId || !cloudflareApiToken) {
    console.warn('[Cloud] Subdomain enabled but missing required credentials, skipping...');
    return;
  }

  container.register({
    // DNS Provider
    dnsProvider: asFunction(() => {
      return new TencentDnsProvider({
        tokenId: tencentDnsSecretId,
        token: tencentDnsSecretKey,
      });
    }).singleton(),

    // Tunnel Provider
    tunnelProvider: asFunction(() => {
      return new CloudflareTunnelProvider({
        accountId: cloudflareAccountId,
        apiToken: cloudflareApiToken,
        baseDomain,
      });
    }).singleton(),

    // Subdomain Service
    subdomainService: asFunction(({ dnsProvider, tunnelProvider }: ApiContainerCradle) => {
      return new SubdomainService({
        baseDomain,
        dnsProvider: dnsProvider!,
        tunnelProvider: tunnelProvider!,
      });
    }).singleton(),
  });
}
