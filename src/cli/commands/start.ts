import type { CommandModule } from 'yargs';
import path from 'path';
import fs from 'fs';
import { getLoggerFor } from 'global-logger-factory';
import { Supervisor } from '../../supervisor';
import {
  createGatewayAdminProxyAuthSecret,
  GatewayProxy,
  getEphemeralLoopbackPort,
  getFreePortForWildcard,
  initRuntimeLogger,
  requireFreePortForWildcard,
  resolveStableLoopbackPort,
  PACKAGE_ROOT,
  loadEnvFile,
  resolveXpodEnvPath,
  validateBaseUrl,
} from '../../runtime';
import { resolveSakuraAssignedLocalPort } from '../../tunnel/SakuraFrpTunnelProvider';
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
      // The settings API persists to XPOD_ENV_PATH (falling back to `<cwd>/.env.local`).
      // Without this, a deployment started with `-e custom.env` saved its configuration
      // into a file the runtime never reads.
      process.env.XPOD_ENV_PATH ??= envPath;
    } else if (argv.env || process.env.XPOD_ENV_FILE) {
      console.warn(`Env file not found: ${envPath}`);
    }

    // The managed-node heartbeat, provisioning and failover loops all run in
    // this process, so the CLI has to install the same logger factory as its
    // child services. Without it `getLoggerFor` stays a void logger and every
    // heartbeat outcome is silently dropped, leaving only "the node is not
    // connected" on the cloud side with nothing local to explain why.
    initRuntimeLogger(process.env.CSS_LOGGING_LEVEL || 'info');

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
    // Remote forwarding (managed tunnels, P2P data plane) terminates on this machine, so
    // its origin is a dedicated ingress port instead of the gateway port: the Gateway
    // never treats requests accepted there as local. An explicit override is honoured;
    // otherwise the OS assigns a loopback port, because neighbouring ports may already
    // belong to another service this deployment planned.
    // The port is a fact of whichever tunnel forwards to us: an explicit override pins it,
    // and the SakuraFrp console's own 本地端口 is read back from the provider, so the
    // operator never types the same number twice. Only an unmanaged ingress is ephemeral.
    // A pinned port is taken as-is: silently moving it would leave the tunnel pointing at a
    // port nobody listens on.
    const ingressPort = await resolveIngressPort(provisionedConfig, mainPort);
    // Published so the API can tell the operator which address a tunnel must forward to.
    process.env.XPOD_GATEWAY_INGRESS_PORT = String(ingressPort);
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
    const managedEdge = resolveManagedEdgeAgentConfig(provisionedConfig, mainPort, ingressPort, process.env);
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
        ingressPort,
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
      ingressPort,
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
          enabled: managedEdge.p2pEnabled,
          targetBaseUrl: managedEdge.targetBaseUrl,
          lanBaseUrl: managedEdge.lanBaseUrl,
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

/**
 * Where remote-forwarded traffic lands on this machine.
 *
 * Order: explicit `XPOD_GATEWAY_INGRESS_PORT` → the active SakuraFrp tunnel's assigned local
 * port → an OS-assigned loopback port. The first two are strict, because a tunnel that
 * forwards to a specific port cannot follow us somewhere else.
 */
export async function resolveIngressPort(
  config: {
    tunnelProfiles?: Array<{ id: string; provider: string; credentialEnvKey?: string; credentialConfigured?: boolean }>;
    tunnelActiveProfileId?: string;
  },
  mainPort: number,
): Promise<number> {
  const explicit = process.env.XPOD_GATEWAY_INGRESS_PORT?.trim();
  if (explicit) {
    return await requireFreePortForWildcard(Number.parseInt(explicit, 10));
  }
  const active = config.tunnelProfiles?.find((profile) => profile.id === config.tunnelActiveProfileId)
    ?? config.tunnelProfiles?.find((profile) => profile.provider === 'sakura_frp');
  if (active?.provider === 'sakura_frp') {
    const credential = active.credentialEnvKey
      ? process.env[active.credentialEnvKey] ?? process.env.SAKURA_TUNNEL_TOKEN
      : process.env.SAKURA_TUNNEL_TOKEN;
    const assigned = await resolveSakuraAssignedLocalPort(credential);
    if (assigned && assigned !== mainPort) {
      return await requireFreePortForWildcard(assigned);
    }
  }
  // The operator copies this address into a provider console, so it has to survive
  // restarts instead of being a fresh OS-assigned port every time.
  const stateFile = path.join(process.cwd(), '.xpod', 'runtime', 'ingress-port');
  const stable = await resolveStableLoopbackPort(stateFile, mainPort);
  if (stable.changed) {
    getLoggerFor('XpodStart').warn(
      `The ingress port changed to ${stable.port}; update the tunnel console if it still forwards to the previous port`,
    );
  }
  return stable.port;
}

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
  ingressPort?: number,
  runtimeEnv: Record<string, string | undefined> = {},
): {
  signalEndpoint: string
  nodeId: string
  nodeToken: string
  targetBaseUrl: string
  lanBaseUrl: string
  p2pEnabled: boolean
} | undefined {
  if (!config.cloudApiEndpoint || !config.nodeId || !config.nodeToken) {
    return undefined;
  }

  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/`;
  // The settings page owns these two decisions; the managed node identity only supplies
  // the signal endpoint they run against.
  const declaredSignalService = runtimeEnv.XPOD_P2P_SIGNAL_SERVICE?.trim();
  const p2pDisabled = runtimeEnv.XPOD_P2P_ENABLED?.trim().toLowerCase() === 'false';
  return {
    signalEndpoint: declaredSignalService
      || new URL('/v1/signal', config.cloudApiEndpoint).toString(),
    nodeId: config.nodeId,
    nodeToken: config.nodeToken,
    // Forwarded peer traffic enters through the ingress listener, which never counts
    // as local. LAN clients keep addressing the gateway listener, which they can reach.
    targetBaseUrl: ingressPort === undefined ? gatewayBaseUrl : `http://127.0.0.1:${ingressPort}/`,
    lanBaseUrl: gatewayBaseUrl,
    // Peer-to-peer transport is off by default unless the deployment asked for it; an
    // explicit false must actually stop it.
    p2pEnabled: !p2pDisabled && runtimeEnv.XPOD_P2P_ENABLED?.trim().toLowerCase() === 'true',
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
  // A Cloud-issued URL is the canonical Solid identity origin. CSS_BASE_URL is
  // the canonical origin only for deployments that have no managed identity.
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
