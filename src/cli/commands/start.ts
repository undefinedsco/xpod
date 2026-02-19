import type { CommandModule } from 'yargs';
import path from 'path';
import fs from 'fs';
import { Supervisor } from '../../supervisor';
import { GatewayProxy, getFreePort } from '../../runtime';

interface StartArgs {
  mode?: string;
  config?: string;
  env?: string;
  port: number;
  host: string;
}

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    console.warn(`Env file not found: ${envPath}`);
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export const startCommand: CommandModule<object, StartArgs> = {
  command: 'start',
  describe: 'Start xpod services',
  builder: (yargs) =>
    yargs
      .option('mode', {
        alias: 'm',
        type: 'string',
        choices: ['local', 'cloud'],
        description: 'Run mode',
      })
      .option('config', {
        alias: 'c',
        type: 'string',
        description: 'Path to config file (overrides --mode)',
      })
      .option('env', {
        alias: 'e',
        type: 'string',
        description: 'Path to .env file',
      })
      .option('port', {
        alias: 'p',
        type: 'number',
        description: 'Gateway port',
        default: 3000,
      })
      .option('host', {
        type: 'string',
        description: 'Gateway host',
        default: 'localhost',
      }),
  handler: async (argv) => {
    if (argv.env) {
      loadEnvFile(argv.env);
    }

    const mainPort =
      argv.port !== 3000
        ? argv.port
        : parseInt(process.env.XPOD_PORT ?? process.env.PORT ?? '3000', 10);

    let configPath: string;
    if (argv.config) {
      configPath = argv.config;
    } else if (argv.mode) {
      configPath = `config/${argv.mode}.json`;
    } else {
      configPath = 'config/local.json';
    }

    const cssStartPort = mainPort === 3000 ? 3002 : 3000;
    const cssPort = await getFreePort(cssStartPort);
    const apiPort = await getFreePort(cssPort + 1);

    const baseUrl = process.env.CSS_BASE_URL || `http://${argv.host}:${mainPort}/`;

    console.log('Starting xpod...');
    console.log(`  Gateway: ${baseUrl} (${argv.host}:${mainPort})`);
    console.log(`  CSS (internal): http://localhost:${cssPort}`);
    console.log(`  API (internal): http://localhost:${apiPort}`);

    const supervisor = new Supervisor();
    const cssBinary = path.resolve('node_modules/@solid/community-server/bin/server.js');

    supervisor.register({
      name: 'css',
      command: process.execPath,
      args: [cssBinary, '-c', configPath, '-m', '.', '-p', cssPort.toString(), '-b', baseUrl],
      env: {
        ...process.env as Record<string, string>,
        CSS_PORT: cssPort.toString(),
        CSS_BASE_URL: baseUrl,
      },
    });

    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: ['dist/api/main.js'],
      env: {
        ...process.env as Record<string, string>,
        API_PORT: apiPort.toString(),
        XPOD_MAIN_PORT: mainPort.toString(),
        CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
        CSS_BASE_URL: baseUrl,
        CSS_TOKEN_ENDPOINT: `${baseUrl}.oidc/token`,
      },
    });

    const proxy = new GatewayProxy(mainPort, supervisor);
    proxy.setTargets({
      css: `http://localhost:${cssPort}`,
      api: `http://localhost:${apiPort}`,
    });

    await supervisor.startAll();
    proxy.start();

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await supervisor.stopAll();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  },
};
