#!/usr/bin/env node
/**
 * API Service Entry Point
 *
 * 使用 Awilix 依赖注入，根据 CSS_EDITION 环境变量切换 cloud/local 模式
 * 
 * - cloud: 持有 DNS/Tunnel 密钥，直接操作子域名
 * - local: 通过 Signal 调用 Cloud API
 * 
 * Authentication:
 * - Solid DPoP Token: for browser/frontend users
 * - Client Credentials (client_id + client_secret): for edge nodes and third-party backends
 */

import { createApiContainer, loadConfigFromEnv } from './container';
import { registerRoutes } from './container/routes';

// Simple logger
const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
};

async function main(): Promise<void> {
  // 从环境变量加载配置
  const config = loadConfigFromEnv();
  
  if (!config.databaseUrl) {
    logger.error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
    process.exit(1);
  }

  logger.info(`Starting API Service (edition: ${config.edition})...`);

  // 创建 DI 容器
  const container = createApiContainer(config);

  // 注册路由
  registerRoutes(container);

  // 启动服务器
  const server = container.resolve('apiServer');
  await server.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    await server.stop();
    await container.dispose();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`API Service listening on ${config.host}:${config.port}`);
}

main().catch((error) => {
  logger.error(`Failed to start API Service: ${error}`);
  process.exit(1);
});
