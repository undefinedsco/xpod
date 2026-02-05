#!/usr/bin/env node
import { Supervisor } from './supervisor';
import { GatewayProxy } from './gateway/Proxy';
import { getFreePort } from './gateway/PortFinder';
import { logger } from './util/logger';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import path from 'path';
import fs from 'fs';

// Load .env file manually
function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    console.warn(`[Warning] Env file not found: ${envPath}`);
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

  const gatewayPort = argv.port as number;

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
  // Ensure CSS port search doesn't start exactly on the Gateway port
  const cssStartPort = (gatewayPort === 3000 ? 3002 : 3000);
  const cssPort = await getFreePort(cssStartPort);

  // API port must be different from both gateway and CSS ports
  const apiStartPort = cssPort + 1;
  const apiPort = await getFreePort(apiStartPort);
  
  // 2. Determine Base URL
  const baseUrl = `http://${argv.host}:${gatewayPort}/`;

  logger.log('Orchestration Plan:');
  console.log(`  - xpod:    ${baseUrl} (${argv.host}:${gatewayPort})`);
  console.log(`  - CSS:     http://localhost:${cssPort} (Internal)`);
  console.log(`  - API:     http://localhost:${apiPort} (Internal)`);

  const supervisor = new Supervisor();

  // Handle SIGUSR1 for graceful restart of child processes (triggered by API Server)
  process.on('SIGUSR1', async () => {
    logger.log('Received SIGUSR1, restarting child processes...');
    await supervisor.stopAll();
    // Reset restart counts before restarting
    supervisor.resetRestartCounts();
    await supervisor.startAll();
    logger.log('Child processes restarted');
  });

  // Optimized CSS Binary Path
  // Directly call the binary to avoid npx overhead and network risks
  const cssBinary = path.resolve('node_modules/@solid/community-server/bin/server.js');

  // Register CSS (Solid Server)
  supervisor.register({
    name: 'css',
    command: 'node', // Direct node execution
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
    command: 'node',
    args: ['dist/api/main.js'],
    env: {
      ...process.env,
      API_PORT: apiPort.toString(),
      CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
    },
  });

  // Start Gateway Proxy
  const proxy = new GatewayProxy(gatewayPort, supervisor);
  
  proxy.setTargets({
    css: `http://localhost:${cssPort}`,
    api: `http://localhost:${apiPort}`,
  });
  
  // Start processes
  await supervisor.startAll();
  proxy.start();
}

main().catch(console.error);