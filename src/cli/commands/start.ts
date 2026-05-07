import type { CommandModule } from 'yargs';
import path from 'path';
import fs from 'fs';
import { Supervisor } from '../../supervisor';
import { GatewayProxy, getFreePort, PACKAGE_ROOT } from '../../runtime';

interface StartArgs {
  mode?: string;
  config?: string;
  env?: string;
  port: number;
  host: string;
}

const childJsRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  ? (process.env.XPOD_NODE_BINARY ?? 'node')
  : process.execPath;

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
      configPath = path.join(PACKAGE_ROOT, `config/${argv.mode}.json`);
    } else {
      configPath = path.join(PACKAGE_ROOT, 'config/local.json');
    }

    const cssPort = await getFreePort(mainPort + 1, argv.host);
    const apiPort = await getFreePort(cssPort + 1, argv.host);

    const baseUrl = process.env.CSS_BASE_URL || `http://${argv.host}:${mainPort}/`;

    // SP 模式：全部通过环境变量配置（.env.local 或 --env 参数）
    // XPOD_SERVICE_TOKEN, XPOD_NODE_ID, XPOD_NODE_TOKEN, XPOD_CLOUD_API_ENDPOINT, CSS_OIDC_ISSUER
    const oidcIssuer = process.env.CSS_OIDC_ISSUER;

    console.log('Starting xpod...');
    console.log(`  Gateway: ${baseUrl} (${argv.host}:${mainPort})`);
    console.log(`  CSS (internal): http://localhost:${cssPort}`);
    console.log(`  API (internal): http://localhost:${apiPort}`);
    if (oidcIssuer) {
      console.log(`  SP mode: Cloud IdP = ${oidcIssuer}`);
    }

    const supervisor = new Supervisor();
    const cssBinary = require.resolve('@solid/community-server/bin/server.js');
    const cssArgs = [cssBinary, '-c', configPath, '-m', PACKAGE_ROOT, '-p', cssPort.toString(), '-b', baseUrl];
    if (oidcIssuer) {
      cssArgs.push('--oidcIssuer', oidcIssuer);
    }

    supervisor.register({
      name: 'css',
      command: childJsRuntime,
      args: cssArgs,
      env: {
        ...process.env as Record<string, string>,
        CSS_PORT: cssPort.toString(),
        CSS_BASE_URL: baseUrl,
      },
    });

    const isDevMode = __filename.endsWith('.ts');
    const apiArgs = isDevMode
      ? [
          '-r',
          require.resolve('ts-node/register/transpile-only'),
          path.resolve(__dirname, '..', '..', 'api', 'main.ts'),
        ]
      : [path.resolve(__dirname, '..', '..', 'api', 'main.js')];

    supervisor.register({
      name: 'api',
      command: childJsRuntime,
      args: apiArgs,
      env: {
        ...process.env as Record<string, string>,
        API_PORT: apiPort.toString(),
        XPOD_MAIN_PORT: mainPort.toString(),
        CSS_INTERNAL_URL: `http://localhost:${cssPort}`,
        CSS_BASE_URL: baseUrl,
        CSS_TOKEN_ENDPOINT: oidcIssuer
          ? `${oidcIssuer.replace(/\/$/, '')}/.oidc/token`
          : `${baseUrl}.oidc/token`,
      },
    });

    const proxy = new GatewayProxy(mainPort, supervisor, '0.0.0.0', {
      exitOnStop: true,
      baseUrl,
    });
    proxy.setTargets({
      css: `http://localhost:${cssPort}`,
      api: `http://localhost:${apiPort}`,
    });

    await supervisor.startAll();
    await proxy.start();

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await supervisor.stopAll();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  },
};
