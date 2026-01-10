import { Supervisor } from '../lib/supervisor';
import { GatewayProxy } from './gateway/Proxy';
import { getFreePort } from './gateway/PortFinder';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import path from 'path';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('config', { alias: 'c', type: 'string', description: 'Path to config file', default: 'config/local.json' })
    .option('port', { alias: 'p', type: 'number', description: 'Gateway port', default: 3000 })
    .option('host', { alias: 'h', type: 'string', description: 'Gateway host', default: 'localhost' })
    .help()
    .parse();

  const gatewayPort = argv.port as number;
  const configPath = argv.config as string;
  
  // 1. Determine Ports with auto-discovery
  // Ensure CSS port search doesn't start exactly on the Gateway port
  const cssStartPort = (gatewayPort === 3000 ? 3002 : 3000);
  const cssPort = await getFreePort(cssStartPort);
  
  const apiStartPort = (gatewayPort === 3001 ? 3003 : 3001);
  const apiPort = await getFreePort(apiStartPort);
  
  // 2. Determine Base URL
  const baseUrl = `http://${argv.host}:${gatewayPort}/`;

  console.log(`[Gateway] Orchestration Plan:`);
  console.log(`  - Gateway: ${baseUrl} (${argv.host}:${gatewayPort})`);
  console.log(`  - CSS:     http://localhost:${cssPort} (Internal)`);
  console.log(`  - API:     http://localhost:${apiPort} (Internal)`);

  const supervisor = new Supervisor();

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