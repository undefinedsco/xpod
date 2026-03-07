/**
 * Business Token 自动注册
 *
 * 如果配置了 XPOD_BUSINESS_TOKEN 环境变量，
 * 启动时自动注册到 service_token 表，赋予完整的 Business 权限。
 */

import type { AwilixContainer } from 'awilix';
import type { ApiContainerCradle } from './types';
import type { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';

const BUSINESS_SCOPES = ['quota:write', 'usage:read', 'account:manage'];

export function registerBusinessToken(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  const token = process.env.XPOD_BUSINESS_TOKEN;
  if (!token) {
    return;
  }

  // Defer registration to avoid blocking startup
  setImmediate(async () => {
    try {
      const repo = container.resolve('serviceTokenRepo') as ServiceTokenRepository;
      await repo.registerToken(token, {
        serviceType: 'business',
        serviceId: 'business-default',
        scopes: BUSINESS_SCOPES,
      });
      console.log('[Business] Service token registered (XPOD_BUSINESS_TOKEN)');
    } catch (error) {
      console.error(`[Business] Failed to register service token: ${error}`);
    }
  });
}
