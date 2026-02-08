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

import { createApiContainer, loadConfigFromEnv } from './container';
import { registerRoutes } from './container/routes';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';

async function main(): Promise<void> {
  // 从环境变量加载配置
  const config = loadConfigFromEnv();

  // 初始化全局统一日志工厂
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: './logs/xpod-%DATE%.log',
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);

  const logger = getLoggerFor('Main');

  if (!config.databaseUrl) {
    logger.error('CSS_IDENTITY_DB_URL or DATABASE_URL environment variable is required');
    process.exit(1);
  }

  logger.info(`Starting API Service (edition: ${config.edition})...`);

  // 创建 DI 容器
  const container = createApiContainer(config);

  // 注册路由
  registerRoutes(container);

  // Start background maintenance (IPv6 DDNS / Tunnel Control)
  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true }) as any;
    if (localNetworkManager) {
      localNetworkManager.start();
    }
  } catch (error) {
    logger.error(`Failed to initialize LocalNetworkManager: ${error}`);
  }

  // Start DDNS Manager (托管式 Local 模式)
  try {
    const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true }) as any;
    if (ddnsManager) {
      await ddnsManager.start();
      logger.info('DDNS Manager started');
    }
  } catch (error) {
    logger.error(`Failed to initialize DdnsManager: ${error}`);
  }

  // Start Cloudflare Tunnel (独立式 Local 模式，没有 LocalNetworkManager 时直接启动)
  try {
    const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true });
    const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;

    // 只有当没有 LocalNetworkManager（它会自动管理 Tunnel）且有 Tunnel Provider 时才手动启动
    if (!localNetworkManager && localTunnelProvider) {
      logger.info('Starting Cloudflare Tunnel (standalone mode)...');
      await localTunnelProvider.start();
      logger.info('Cloudflare Tunnel started');
    }
  } catch (error) {
    logger.error(`Failed to start Cloudflare Tunnel: ${error}`);
  }

  // Start the HTTP server
  const server = container.resolve('apiServer') as any;
  await server.start();
  logger.info(`API Service active on ${config.host}:${config.port}`);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Stopping API Service (${signal})...`);

    try {
      const ddnsManager = container.resolve('ddnsManager', { allowUnregistered: true }) as any;
      ddnsManager?.stop();
    } catch {}

    try {
      const localNetworkManager = container.resolve('localNetworkManager', { allowUnregistered: true });
      await localNetworkManager?.stop();
    } catch {}

    try {
      const localTunnelProvider = container.resolve('localTunnelProvider', { allowUnregistered: true }) as any;
      await localTunnelProvider?.stop();
    } catch {}

    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(`Failed to start API Service: ${error}`);
  process.exit(1);
});
