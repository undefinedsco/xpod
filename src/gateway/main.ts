import { Supervisor } from './Supervisor';
import { GatewayProxy } from './Proxy';
import { loadConfig } from './ConfigLoader';
import { getFreePort } from './PortFinder';

async function main() {
  const config = await loadConfig();
  
  // 1. Determine Ports with auto-discovery
  // We use different start ranges to avoid collision
  const cssPort = await getFreePort(config.css.port || 3000);
  const apiPort = await getFreePort(config.api.port || 3001);
  
  // 2. Determine Base URL
  const baseUrl = config.baseUrl || `http://${config.host}:${config.port}/`;

  console.log(`[Gateway] Orchestration Plan:`);
  console.log(`  - Gateway: ${baseUrl} (${config.host}:${config.port})`);
  console.log(`  - CSS:     http://localhost:${cssPort} (Internal)`);
  console.log(`  - API:     http://localhost:${apiPort} (Internal)`);

  const supervisor = new Supervisor();

  // Register CSS (Solid Server)
  if (config.css.enabled) {
    const cssArgs = ['dist/index.js'];
    if (config.css.config) {
      cssArgs.push('-c', config.css.config);
    }

    supervisor.register({
      name: 'css',
      command: 'node',
      args: cssArgs,
      env: {
        CSS_PORT: cssPort.toString(),
        CSS_BASE_URL: baseUrl,
        CSS_TRUST_PROXY: 'true',
        // Also forward internal API URL to CSS if needed? Not usually.
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