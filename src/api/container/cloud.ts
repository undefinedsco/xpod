/**
 * Cloud 模式服务注册
 *
 * Cloud 模式持有 DNS/Tunnel 密钥，直接操作子域名
 * 提供身份服务 (IdP) 和可选的托管存储 (SP)
 */

import { asFunction, type AwilixContainer } from 'awilix';
import type { ApiContainerCradle, ApiContainerConfig } from './types';

import { TencentDnsProvider } from '../../dns/tencent/TencentDnsProvider';
import { CloudflareTunnelProvider } from '../../tunnel/CloudflareTunnelProvider';
import { SubdomainService } from '../../subdomain/SubdomainService';
import { WebIdProfileRepository } from '../../identity/drizzle/WebIdProfileRepository';
import { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import { getLoggerFor } from 'global-logger-factory';

const logger = getLoggerFor('CloudServices');

/**
 * 注册 Cloud 模式专属服务
 */
export function registerCloudServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  const config = container.resolve('config') as ApiContainerConfig;
  const db = container.resolve('db');

  // 获取 baseUrl 用于 WebID Profile
  const baseUrl = process.env.CSS_BASE_URL || `http://localhost:${process.env.CSS_PORT || 3000}`;

  // 注册 WebID Profile Repository (始终注册，用于身份服务)
  container.register({
    webIdProfileRepo: asFunction(() => {
      return new WebIdProfileRepository(db, { baseUrl });
    }).singleton(),
  });
  logger.info('WebID Profile repository registered');

  // 注册 DDNS Repository (始终注册，用于 DDNS 服务)
  container.register({
    ddnsRepo: asFunction(() => {
      return new DdnsRepository(db);
    }).singleton(),
  });
  logger.info('DDNS repository registered');

  // 只有配置了子域名功能才注册 DNS/Tunnel 服务
  if (!config.subdomain?.enabled) {
    logger.info('Subdomain service disabled');
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
  if (!baseDomain) {
    logger.warn('Subdomain enabled but missing baseDomain, skipping DNS/Tunnel services');
    return;
  }

  // DNS Provider (腾讯云或 Cloudflare)
  if (tencentDnsSecretId && tencentDnsSecretKey) {
    container.register({
      dnsProvider: asFunction(() => {
        return new TencentDnsProvider({
          tokenId: tencentDnsSecretId,
          token: tencentDnsSecretKey,
        });
      }).singleton(),
    });
    logger.info('Tencent DNS provider registered');
  }

  // Tunnel Provider (Cloudflare)
  if (cloudflareAccountId && cloudflareApiToken) {
    container.register({
      tunnelProvider: asFunction(() => {
        return new CloudflareTunnelProvider({
          accountId: cloudflareAccountId,
          apiToken: cloudflareApiToken,
          baseDomain: baseDomain!,
        });
      }).singleton(),
    });
    logger.info('Cloudflare Tunnel provider registered');
  }

  // Subdomain Service (需要 DNS 和 Tunnel Provider)
  try {
    const dnsProvider = container.resolve('dnsProvider', { allowUnregistered: true });
    const tunnelProvider = container.resolve('tunnelProvider', { allowUnregistered: true });

    if (dnsProvider && tunnelProvider) {
      const nodeRepo = container.resolve('nodeRepo');
      container.register({
        subdomainService: asFunction(() => {
          return new SubdomainService({
            baseDomain: baseDomain!,
            dnsProvider: dnsProvider as any,
            tunnelProvider: tunnelProvider as any,
            edgeNodeRepo: nodeRepo,
          });
        }).singleton(),
      });
      logger.info(`Subdomain service registered for domain: ${baseDomain}`);
    }
  } catch {
    logger.warn('Subdomain service not registered (missing DNS or Tunnel provider)');
  }
}
