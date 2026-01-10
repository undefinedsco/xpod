import { Supervisor } from './Supervisor';
import { GatewayProxy } from './Proxy';
import { loadConfig } from './ConfigLoader';
import { getFreePort } from './PortFinder';

async function main() {
  const config = await loadConfig();

  // 1. Determine Ports with auto-discovery
  // Internal ports start after the gateway port to avoid collision
  const gatewayPort = config.port;
  const cssPort = await getFreePort(config.css.port || gatewayPort + 100);
  const apiPort = await getFreePort(config.api.port || cssPort + 1);

  // 2. Determine Base URL
  const baseUrl = config.baseUrl || process.env.CSS_BASE_URL || `http://${config.host}:${gatewayPort}/`;

  console.log(`[Gateway] Orchestration Plan:`);
  console.log(`  - Gateway: ${baseUrl} (${config.host}:${config.port})`);
  console.log(`  - CSS:     http://localhost:${cssPort} (Internal)`);
  console.log(`  - API:     http://localhost:${apiPort} (Internal)`);

  const supervisor = new Supervisor();

  // Register CSS (Solid Server)
  if (config.css.enabled) {
    // Use community-solid-server CLI with config files
    // Default to local config if not specified
    const cssConfig = config.css.config || 'config/main.local.json config/extensions.local.json';
    const cssArgs = ['-c', ...cssConfig.split(' '), '-m', '.', '-p', cssPort.toString(), '-b', baseUrl];

    supervisor.register({
      name: 'css',
      command: 'npx',
      args: ['community-solid-server', ...cssArgs],
      env: {
        CSS_TRUST_PROXY: 'true',
      },
    });
  }

  // Register API Server
  if (config.api.enabled) {
    supervisor.register({
      name: 'api',
      command: 'node',
      args: ['dist/api/main.js'],
      env: {
        API_PORT: apiPort.toString(),
        CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
        // Propagate Encryption Keys etc. if they are in process.env
      },
    });
  }

  // Start Gateway Proxy
  const proxy = new GatewayProxy(config.port, supervisor);
  
  proxy.setTargets({
    css: config.css.enabled ? `http://localhost:${cssPort}` : undefined,
    api: config.api.enabled ? `http://localhost:${apiPort}` : undefined,
  });
  
  // Start processes
  await supervisor.startAll();
  proxy.start();

  // Handle Shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Gateway] Received ${signal}, shutting down...`);
    await supervisor.stopAll();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(console.error);