import type { CommandModule } from 'yargs';
import path from 'path';
import fs from 'fs';
import { getLoggerFor } from 'global-logger-factory';
import { Supervisor } from '../../supervisor';
import {
  createGatewayAdminProxyAuthSecret,
  GatewayProxy,
  getFreePortForWildcard,
  PACKAGE_ROOT,
  loadEnvFile,
  resolveXpodEnvPath,
  validateBaseUrl,
} from '../../runtime';
import {
  buildApiChildEnv,
  buildCssArgs,
  buildCssChildEnv,
  createCssChildRuntimeConfig,
} from '../../runtime/css-process';
import { DEFAULT_LOCAL_OIDC_ISSUER, resolveExternalOidcIssuer } from '../../runtime/oidc-issuer';
import { resolveAuthModeFromEnv } from '../../authorization/AuthMode';
import { loadConfigFromEnv } from '../../api/container';
import { autoProvisionFirstRunLocal } from '../../api/runtime';
import { normalizeDatabaseUrl, resolveDefaultRdfIndexPath } from '../../runtime/database-url';
import { EdgeNodeAgent } from '../../edge/EdgeNodeAgent';
import { jsEntrypointArgs, resolveJsRuntime } from '../../runtime/js-runtime';

interface StartArgs {
  mode?: string;
  config?: string;
  env?: string;
  port?: number;
  host: string;
  foreground?: boolean;
  seedConfig?: string;
}

const isSingleBinaryRuntime = process.env.XPOD_BUN_SINGLE_RUNTIME === '1';

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
      })
      .option('host', {
        type: 'string',
        description: 'Gateway host',
        default: 'localhost',
      })
      .option('foreground', {
        type: 'boolean',
        default: true,
        description: 'Run in the foreground',
      })
      .option('seedConfig', {
        type: 'string',
        description: 'Path to the file that will be used to seed accounts and pods',
      }),
  handler: async (argv) => {
    const envPath = resolveXpodEnvPath(argv.env, process.env);
    if (fs.existsSync(envPath)) {
      for (const [key, value] of Object.entries(loadEnvFile(envPath))) {
        process.env[key] ??= value;
      }
      process.env.XPOD_ENV_FILE = envPath;
    } else if (argv.env || process.env.XPOD_ENV_FILE) {
      console.warn(`Env file not found: ${envPath}`);
    }

    const configuredBaseUrl = process.env.CSS_BASE_URL?.trim();
    const mainPort = resolveMainPort(argv.port, process.env, configuredBaseUrl);
    const initialConfig = loadConfigFromEnv();
    const provisionedConfig = await autoProvisionFirstRunLocal(
      {
        ...initialConfig,
        oidcIssuer: resolveCliOidcIssuer(
          process.env,
          initialConfig.oidcIssuer,
          initialConfig.edition,
        ),
      },
      getLoggerFor('CliStart'),
    );

    let configPath: string;
    if (argv.config) {
      configPath = argv.config;
    } else if (argv.mode) {
      configPath = path.join(PACKAGE_ROOT, `config/${argv.mode}.json`);
    } else {
      configPath = path.join(PACKAGE_ROOT, 'config/local.json');
    }

    const requestedCssPort = resolveServicePort(process.env.CSS_PORT, mainPort + 1, new Set([mainPort]));
    const cssPort = await getFreePortForWildcard(requestedCssPort);
    const requestedApiPort = resolveServicePort(process.env.API_PORT, cssPort + 1, new Set([mainPort, cssPort]));
    const apiPort = await getFreePortForWildcard(requestedApiPort);
    const runtimeRoot = path.join(process.cwd(), '.xpod/runtime/legacy-css');
    const identityDbUrl = resolveChildDatabaseUrl(
      process.env.CSS_IDENTITY_DB_URL ?? process.env.DATABASE_URL ?? 'sqlite:./data/identity.sqlite',
      runtimeRoot,
    );
    process.env.CSS_IDENTITY_DB_URL = identityDbUrl;
    process.env.DATABASE_URL = identityDbUrl;

    const baseUrlInput = resolveCanonicalRuntimeBaseUrl(
      provisionedConfig.publicUrl,
      configuredBaseUrl,
      `http://${argv.host}:${mainPort}/`,
    );
    validateBaseUrl({
      baseUrl: baseUrlInput,
      mainPort,
      explicit: Boolean(configuredBaseUrl),
    });
    const baseUrl = new URL(baseUrlInput).toString();
    const rdfIndexPath = process.env.CSS_RDF_INDEX_PATH || resolveDefaultRdfIndexPath({
      sparqlEndpoint: process.env.CSS_SPARQL_ENDPOINT ?? process.env.SPARQL_ENDPOINT,
      fallbackRoot: runtimeRoot,
      sqliteRelativeRoot: runtimeRoot,
    });
    process.env.CSS_RDF_INDEX_PATH = rdfIndexPath;

    const externalOidcIssuer = resolveCliOidcIssuer(process.env, provisionedConfig.oidcIssuer);
    const authMode = resolveAuthModeFromEnv(process.env);

    console.log('Starting xpod...');
    console.log(`  Gateway: ${baseUrl} (${argv.host}:${mainPort})`);
    console.log(`  CSS (internal): http://localhost:${cssPort}`);
    console.log(`  API (internal): http://localhost:${apiPort}`);
    if (externalOidcIssuer) {
      console.log(`  SP mode: Cloud IdP = ${externalOidcIssuer}`);
    }
    console.log(`  Authorization mode: ${authMode}`);

    const supervisor = new Supervisor();
    const cssRuntimeConfig = createCssChildRuntimeConfig({
      configPath,
      runtimeRoot,
      authMode,
      externalOidcIssuer,
    });
    const managedEdge = resolveManagedEdgeAgentConfig(provisionedConfig, mainPort);
    const cssArgs = buildCssArgs({
      cssBinary: '__internal-css',
      configPath: cssRuntimeConfig.configPath,
      cssModuleRoot: PACKAGE_ROOT,
      cssPort,
      baseUrl,
      externalOidcIssuer,
      seedConfig: argv.seedConfig,
    });

    const childRuntime = resolveJsRuntime();
    const isDevMode = __filename.endsWith('.ts');
    const apiArgs = isSingleBinaryRuntime
      ? ['__internal-api']
      : jsEntrypointArgs(path.resolve(__dirname, '..', '..', 'api', isDevMode ? 'main.ts' : 'main.js'), childRuntime.isBun);

    const gatewayAdminProxyAuthSecret = createGatewayAdminProxyAuthSecret();

    supervisor.register({
      name: 'css',
      command: childRuntime.command,
      args: [
        ...(isSingleBinaryRuntime ? [] : jsEntrypointArgs(path.resolve(__dirname, '..', isDevMode ? 'index.ts' : 'index.js'), childRuntime.isBun)),
        ...cssArgs,
      ],
      cwd: cssRuntimeConfig.cwd,
      env: buildCssChildEnv(baseUrl, cssPort, externalOidcIssuer, authMode, process.env, gatewayAdminProxyAuthSecret),
    });

    supervisor.register({
      name: 'api',
      command: childRuntime.command,
      args: apiArgs,
      env: buildApiChildEnv({
        apiPort,
        mainPort,
        cssPort,
        baseUrl,
        rdfIndexPath,
        authMode,
        externalOidcIssuer,
        gatewayAdminProxyAuthSecret,
      }),
    });

    const proxy = new GatewayProxy(mainPort, supervisor, '0.0.0.0', {
      exitOnStop: true,
      baseUrl,
      internalAdminAuthSecret: gatewayAdminProxyAuthSecret,
    });
    proxy.setTargets({
      css: `http://localhost:${cssPort}`,
      api: `http://localhost:${apiPort}`,
    });

    await supervisor.startAll();
    await proxy.start();
    const edgeAgent = managedEdge ? new EdgeNodeAgent() : undefined;
    if (edgeAgent && managedEdge) {
      await edgeAgent.start({
        signalEndpoint: managedEdge.signalEndpoint,
        nodeId: managedEdge.nodeId,
        nodeToken: managedEdge.nodeToken,
        baseUrl,
        p2p: {
          enabled: true,
          targetBaseUrl: managedEdge.targetBaseUrl,
        },
      });
    }

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\nReceived ${signal}, shutting down...`);
      edgeAgent?.stop();
      await supervisor.stopAll();
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  },
};

export function resolveCliOidcIssuer(
  env: Record<string, string | undefined>,
  provisionedIssuer?: string,
  edition?: string,
): string | undefined {
  return resolveExternalOidcIssuer(env)
    ?? resolveExternalOidcIssuer({ SOLID_OIDC_ISSUER: provisionedIssuer })
    ?? (edition === 'local' ? DEFAULT_LOCAL_OIDC_ISSUER : undefined);
}

export function resolveManagedEdgeAgentConfig(
  config: Pick<ReturnType<typeof loadConfigFromEnv>, 'cloudApiEndpoint' | 'nodeId' | 'nodeToken'>,
  gatewayPort: number,
): {
  signalEndpoint: string
  nodeId: string
  nodeToken: string
  targetBaseUrl: string
} | undefined {
  if (!config.cloudApiEndpoint || !config.nodeId || !config.nodeToken) {
    return undefined;
  }

  return {
    signalEndpoint: new URL('/v1/signal', config.cloudApiEndpoint).toString(),
    nodeId: config.nodeId,
    nodeToken: config.nodeToken,
    targetBaseUrl: `http://127.0.0.1:${gatewayPort}/`,
  };
}

export function resolveChildDatabaseUrl(value: string, childCwd: string): string {
  const trimmed = value.trim();
  if (/^sqlite:/iu.test(trimmed)) {
    const databasePath = trimmed.slice(trimmed.indexOf(':') + 1);
    return `sqlite:${path.isAbsolute(databasePath) ? databasePath : path.resolve(childCwd, databasePath)}`;
  }
  return normalizeDatabaseUrl(trimmed);
}

export function resolveCanonicalRuntimeBaseUrl(
  provisionedPublicUrl: string | undefined,
  configuredBaseUrl: string | undefined,
  localFallbackUrl: string,
): string {
  return provisionedPublicUrl?.trim() || configuredBaseUrl?.trim() || localFallbackUrl;
}

export function resolveMainPort(
  cliPort: number | undefined,
  env: NodeJS.ProcessEnv,
  configuredBaseUrl?: string,
): number {
  const explicitPort = validPort(cliPort) ?? validPort(Number(env.XPOD_PORT ?? env.PORT));
  if (explicitPort !== undefined) {
    return explicitPort;
  }
  if (configuredBaseUrl) {
    const parsed = new URL(configuredBaseUrl);
    return validPort(Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))) ?? 3000;
  }
  return 3000;
}

export function resolveServicePort(
  configured: string | undefined,
  fallback: number,
  reserved: ReadonlySet<number>,
): number {
  const requested = validPort(Number(configured)) ?? fallback;
  return reserved.has(requested) ? nextAvailableCandidate(fallback, reserved) : requested;
}

function nextAvailableCandidate(start: number, reserved: ReadonlySet<number>): number {
  let candidate = start;
  while (reserved.has(candidate) && candidate < 65_535) {
    candidate += 1;
  }
  return candidate;
}

function validPort(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value > 0 && value <= 65_535
    ? value
    : undefined;
}
