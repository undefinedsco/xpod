#!/usr/bin/env node
import { Supervisor } from './supervisor';
import { GatewayProxy } from './gateway/Proxy';
import { getFreePort } from './gateway/port-finder';
import { LocalTunnelProvider } from './tunnel/LocalTunnelProvider';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from './logging/ConfigurableLoggerFactory';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import path from 'path';
import fs from 'fs';

// Placeholder for late initialization
let logger = getLoggerFor('Main');

// Load .env file manually
function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    logger.warn(`Env file not found: ${envPath}`);
    return;
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('mode', { alias: 'm', type: 'string', choices: ['local', 'cloud'], description: 'Run mode' })
    .option('config', { alias: 'c', type: 'string', description: 'Path to config file (overrides --mode)' })
    .option('env', { alias: 'e', type: 'string', description: 'Path to .env file' })
    .option('port', { alias: 'p', type: 'number', description: 'Gateway port', default: 3000 })
    .option('host', { type: 'string', description: 'Gateway host', default: 'localhost' })
    .help()
    .parse();

  // Load env file if specified
  if (argv.env) {
    loadEnvFile(argv.env);
  }

  // 初始化全局统一日志工厂
  const loggerFactory = new ConfigurableLoggerFactory(process.env.CSS_LOGGING_LEVEL || 'info', {
    fileName: './logs/xpod-%DATE%.log',
    showLocation: true
  });
  setGlobalLoggerFactory(loggerFactory);
  logger = getLoggerFor('Main');

  // Main port: 命令行参数 > 环境变量 > 默认值 3000
  const mainPort = argv.port !== 3000 
    ? argv.port as number 
    : parseInt(process.env.XPOD_PORT ?? process.env.PORT ?? '3000', 10);

  // Determine config path: --config > --mode > default
  let configPath: string;
  if (argv.config) {
    configPath = argv.config;
  } else if (argv.mode) {
    configPath = `config/${argv.mode}.json`;
  } else {
    configPath = 'config/local.json';
  }
  
  // 1. Determine Ports with auto-discovery
  // Ensure CSS port search doesn't start exactly on the Main port
  const cssStartPort = (mainPort === 3000 ? 3002 : 3000);
  const cssPort = await getFreePort(cssStartPort);

  // API port starts after CSS port to avoid collision
  const apiStartPort = cssPort + 1;
  const apiPort = await getFreePort(apiStartPort);
  
  // 2. Determine Base URL (环境变量优先，否则用本地地址)
  const baseUrl = process.env.CSS_BASE_URL || `http://${argv.host}:${mainPort}/`;

  logger.info('Orchestration Plan:');
  logger.info(`  - Main Entry: ${baseUrl} (${argv.host}:${mainPort})`);
  logger.info(`  - CSS (internal): http://localhost:${cssPort}`);
  logger.info(`  - API (internal): http://localhost:${apiPort}`);

  const supervisor = new Supervisor();

  // Optimized CSS Binary Path
  // Directly call the binary to avoid npx overhead and network risks
  const cssBinary = path.resolve('node_modules/@solid/community-server/bin/server.js');

  // Register CSS (Solid Server)
  supervisor.register({
    name: 'css',
    command: process.execPath, // Keep child runtime aligned with current Node version
    args: [
      cssBinary, // Path to bin/server.js
      '-c', configPath,
      '-m', '.',
      '-p', cssPort.toString(),
      '-b', baseUrl,
    ],
    env: {
      ...process.env,
      CSS_PORT: cssPort.toString(),
      CSS_BASE_URL: baseUrl,
    },
  });

  // Register API Server
  supervisor.register({
    name: 'api',
    command: process.execPath,
    args: ['dist/api/main.js'],
    env: {
      ...process.env,
      API_PORT: apiPort.toString(),
      XPOD_MAIN_PORT: mainPort.toString(),
      CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
      CSS_BASE_URL: baseUrl,
      CSS_TOKEN_ENDPOINT: `${baseUrl}.oidc/token`,
    },
  });

  // Start Gateway Proxy
  const proxy = new GatewayProxy(mainPort, supervisor);
  
  proxy.setTargets({
    css: `http://localhost:${cssPort}`,
    api: `http://localhost:${apiPort}`,
  });
  
  // Start processes
  await supervisor.startAll();
  proxy.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down...`);
    
    await proxy.stop();
    await supervisor.stopAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error(`Failed to start: ${error}`);
  process.exit(1);
});