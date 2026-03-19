#!/usr/bin/env node
/**
 * API Service Entry Point
 *
 * 使用 Awilix 依赖注入，根据 XPOD_EDITION 环境变量切换 cloud/local 模式
 *
 * - cloud: 持有 DNS/Tunnel 密钥，直接操作子域名，提供身份服务
 * - local: 连接 Cloud 获取身份服务和 DDNS，或独立运行
 *
 * Authentication:
 * - Solid DPoP Token: for browser/frontend users
 * - Client Credentials (Basic Auth with client_id:client_secret): for edge nodes and third-party backends
 */

import { getLoggerFor } from 'global-logger-factory';
import { startApiService } from './runtime';

async function main(): Promise<void> {
  const logger = getLoggerFor('Main');
  const service = await startApiService();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Stopping API Service (${signal})...`);
    await service.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(`Failed to start API Service: ${error}`);
  process.exit(1);
});
