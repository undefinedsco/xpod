import { AppRunner, type App } from '@solid/community-server';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setGlobalLoggerFactory, getLoggerFor } from 'global-logger-factory';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { closeAllIdentityConnections } from '../identity/drizzle/db';
import type { AuthContext } from '../api/auth/AuthContext';
import { startApiService, type ApiServiceHandle } from '../api/runtime';
import { Supervisor } from '../supervisor/Supervisor';
import { applyEnv, loadEnvFile } from './env-utils';
import { getFreePort } from './port-finder';
import { GatewayProxy } from './Proxy';
import { fetchViaSocket } from './socket-fetch';
import { registerSocketOriginShims } from './socket-shim';
import { removeSocketPath } from './socket-utils';

export interface XpodRuntimeOptions {
  mode?: 'local' | 'cloud';
  open?: boolean;
  authMode?: 'acp' | 'acl' | 'allow-all';
  apiOpen?: boolean;
  authContext?: AuthContext;
  envFile?: string;
  env?: Record<string, string | undefined>;
  shorthand?: Record<string, string | number | boolean>;
  baseUrl?: string;
  bindHost?: string;
  transport?: 'auto' | 'socket' | 'port';
  runtimeRoot?: string;
  rootFilePath?: string;
  sparqlEndpoint?: string;
  identityDbUrl?: string;
  usageDbUrl?: string;
  logLevel?: string;
  gatewayPort?: number;
  cssPort?: number;
  apiPort?: number;
  gatewaySocketPath?: string;
  cssSocketPath?: string;
  apiSocketPath?: string;
  edgeNodesEnabled?: boolean;
  centerRegistrationEnabled?: boolean;
}

export interface XpodRuntimeHandle {
  id: string;
  mode: 'local' | 'cloud';
  transport: 'socket' | 'port';
  baseUrl: string;
  supervisor: Supervisor;
  ports: {
    gateway?: number;
    css?: number;
    api?: number;
  };
  sockets: {
    gateway?: string;
    css?: string;
    api?: string;
  };
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
}

function findPackageRoot(dir: string): string {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const BASE_PROCESS_ENV = { ...process.env };

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function withDefinedEntries(entries: Array<[string, string | number | boolean | undefined]>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function resolveRuntimeShorthand(
  env: Record<string, string | undefined>,
  options: XpodRuntimeOptions,
  mode: 'local' | 'cloud',
  cssAuthMode: 'acp' | 'acl' | 'allow-all',
  baseUrl: string,
  rootFilePath: string,
  sparqlEndpoint: string,
  identityDbUrl: string,
  usageDbUrl: string,
  logLevel: string,
): Record<string, string | number | boolean> {
  const envValue = (key: string): string | undefined => env[key] ?? BASE_PROCESS_ENV[key];

  return {
    ...withDefinedEntries([
      ['baseStorageDomain', envValue('CSS_BASE_STORAGE_DOMAIN')],
      ['minioAccessKey', envValue('CSS_MINIO_ACCESS_KEY')],
      ['minioSecretKey', envValue('CSS_MINIO_SECRET_KEY')],
      ['minioEndpoint', envValue('CSS_MINIO_ENDPOINT')],
      ['minioBucketName', envValue('CSS_MINIO_BUCKET_NAME')],
      ['redisClient', envValue('CSS_REDIS_CLIENT')],
      ['redisUsername', envValue('CSS_REDIS_USERNAME')],
      ['redisPassword', envValue('CSS_REDIS_PASSWORD')],
      ['emailConfigHost', envValue('CSS_EMAIL_CONFIG_HOST')],
      ['emailConfigPort', envValue('CSS_EMAIL_CONFIG_PORT')],
      ['emailConfigAuthUser', envValue('CSS_EMAIL_CONFIG_AUTH_USER')],
      ['emailConfigAuthPass', envValue('CSS_EMAIL_CONFIG_AUTH_PASS')],
      ['idpUrl', envValue('CSS_IDP_URL') ?? envValue('XPOD_CLOUD_API_ENDPOINT')],
      ['allowedHosts', envValue('CSS_ALLOWED_HOSTS')],
      ['nodeId', envValue('XPOD_NODE_ID')],
      ['nodeToken', envValue('XPOD_NODE_TOKEN')],
      ['serviceToken', envValue('XPOD_SERVICE_TOKEN')],
      ['seedConfig', envValue('CSS_SEED_CONFIG')],
    ]),
    baseUrl,
    rootFilePath,
    sparqlEndpoint,
    identityDbUrl,
    usageDbUrl,
    logLevel,
    authMode: cssAuthMode,
    edition: mode === 'cloud' ? 'server' : 'local',
    edgeNodesEnabled: options.edgeNodesEnabled ?? false,
    centerRegistrationEnabled: options.centerRegistrationEnabled ?? false,
    ...(options.shorthand ?? {}),
  };
}

function normalizeDatabaseUrl(value: string): string {
  if (
    value.startsWith('sqlite:') ||
    value.startsWith('postgres://') ||
    value.startsWith('postgresql://') ||
    value.startsWith('mysql://')
  ) {
    return value;
  }
  return `sqlite:${path.resolve(value)}`;
}

function resolveTransport(options: XpodRuntimeOptions): 'socket' | 'port' {
  if (options.transport === 'socket' || options.transport === 'port') {
    return options.transport;
  }
  return process.platform === 'win32' ? 'port' : 'socket';
}

function createCssRuntimeConfig(configPath: string, runtimeRoot: string, open: boolean): string {
  if (!open) {
    return configPath;
  }

  const runtimeConfigPath = path.join(runtimeRoot, 'css-runtime.config.json');
  fs.writeFileSync(runtimeConfigPath, JSON.stringify({
    '@context': [
      'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
      'https://linkedsoftwaredependencies.org/bundles/npm/asynchronous-handlers/^1.0.0/components/context.jsonld',
    ],
    import: [
      configPath,
      path.join(PACKAGE_ROOT, 'config/runtime-open.json'),
    ],
  }, null, 2));

  return runtimeConfigPath;
}

function createOpenAuthContext(baseUrl: string, override?: AuthContext): AuthContext {
  if (override) {
    return override;
  }

  return {
    type: 'solid',
    webId: new URL('test/profile/card#me', ensureTrailingSlash(baseUrl)).href,
    accountId: 'xpod-open-account',
    displayName: 'Xpod Open Mode',
  };
}

function initLogger(level: string): void {
  const loggerFactory = new ConfigurableLoggerFactory(level, {
    fileName: path.join(process.cwd(), 'logs/xpod-%DATE%.log'),
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}

async function waitForTcpReady(port: number, host = '127.0.0.1', timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for CSS on ${host}:${port}`);
}

export async function startXpodRuntime(options: XpodRuntimeOptions = {}): Promise<XpodRuntimeHandle> {
  const id = randomUUID().slice(0, 8);
  const mode = options.mode ?? 'local';
  const transport = resolveTransport(options);
  const bindHost = options.bindHost ?? '127.0.0.1';
  const runtimeRoot = path.resolve(options.runtimeRoot ?? path.join(process.cwd(), '.test-data', 'xpod-runtime', id));
  const rootFilePath = path.resolve(options.rootFilePath ?? path.join(runtimeRoot, 'data'));
  const sparqlEndpoint = normalizeDatabaseUrl(options.sparqlEndpoint ?? path.join(runtimeRoot, 'quadstore.sqlite'));
  const identityDbUrl = normalizeDatabaseUrl(options.identityDbUrl ?? path.join(runtimeRoot, 'identity.sqlite'));
  const usageDbUrl = normalizeDatabaseUrl(options.usageDbUrl ?? path.join(runtimeRoot, 'usage.sqlite'));
  const cssAuthMode = options.authMode ?? (options.open ? 'allow-all' : 'acp');
  const apiOpen = options.apiOpen ?? options.open ?? false;
  const logLevel = options.logLevel ?? process.env.CSS_LOGGING_LEVEL ?? 'warn';

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(rootFilePath, { recursive: true });

  const socketsRoot = path.join(runtimeRoot, 'sockets');
  if (transport === 'socket') {
    fs.mkdirSync(socketsRoot, { recursive: true });
  }
  const ports = {
    gateway: undefined as number | undefined,
    css: undefined as number | undefined,
    api: undefined as number | undefined,
  };
  const sockets = {
    gateway: undefined as string | undefined,
    css: undefined as string | undefined,
    api: undefined as string | undefined,
  };

  if (transport === 'socket') {
    sockets.gateway = path.resolve(options.gatewaySocketPath ?? path.join(socketsRoot, 'gateway.sock'));
    sockets.css = path.resolve(options.cssSocketPath ?? path.join(socketsRoot, 'css.sock'));
    sockets.api = path.resolve(options.apiSocketPath ?? path.join(socketsRoot, 'api.sock'));
    ports.gateway = options.gatewayPort ?? 0;
    ports.css = options.cssPort ?? 0;
    ports.api = options.apiPort ?? 0;
  } else {
    ports.gateway = options.gatewayPort ?? await getFreePort(5600, bindHost);
    ports.css = options.cssPort ?? await getFreePort((ports.gateway ?? 5600) + 1, bindHost);
    ports.api = options.apiPort ?? await getFreePort((ports.css ?? 5601) + 1, bindHost);
  }

  const baseUrl = ensureTrailingSlash(
    options.baseUrl ?? (transport === 'socket'
      ? 'http://localhost'
      : `http://${bindHost}:${ports.gateway}`),
  );

  initLogger(logLevel);
  const logger = getLoggerFor('XpodRuntime');
  const envFilePath = options.envFile ? path.resolve(options.envFile) : undefined;
  const envFromFile = envFilePath ? loadEnvFile(envFilePath) : {};
  const runtimeEnv = {
    ...envFromFile,
    ...options.env,
    XPOD_ENV_PATH: envFilePath,
    XPOD_EDITION: mode,
    CSS_BASE_URL: baseUrl,
    CSS_TOKEN_ENDPOINT: `${baseUrl}.oidc/token`,
    CSS_ROOT_FILE_PATH: rootFilePath,
    CSS_IDENTITY_DB_URL: identityDbUrl,
    DATABASE_URL: identityDbUrl,
    CSS_PORT: String(ports.css ?? 0),
    API_PORT: String(ports.api ?? 0),
    API_HOST: bindHost,
    API_SOCKET_PATH: sockets.api,
    XPOD_MAIN_PORT: String(ports.gateway ?? 0),
    CORS_ORIGINS: new URL(baseUrl).origin,
    CSS_LOGGING_LEVEL: logLevel,
  };
  const restoreEnv = applyEnv(runtimeEnv);
  let envRestored = false;
  const restoreRuntimeEnv = (): void => {
    if (envRestored) {
      return;
    }
    envRestored = true;
    restoreEnv();
  };
  const runtimeShorthand = resolveRuntimeShorthand(
    runtimeEnv,
    options,
    mode,
    cssAuthMode,
    baseUrl,
    rootFilePath,
    sparqlEndpoint,
    identityDbUrl,
    usageDbUrl,
    logLevel,
  );

  const unregisterSocketShims = transport === 'socket'
    ? registerSocketOriginShims(baseUrl, sockets.gateway!)
    : async(): Promise<void> => undefined;

  const supervisor = new Supervisor({ handleProcessSignals: false });
  let cssApp: App | undefined;
  let apiService: ApiServiceHandle | undefined;
  let gateway: GatewayProxy | undefined;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const stop = async(): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async() => {
      if (stopped) {
        return;
      }
      stopped = true;

      try {
        if (gateway) {
          await gateway.stop();
          supervisor.setStatus('gateway', 'stopped');
        }
      } catch (error) {
        logger.warn(`Failed to stop gateway: ${String(error)}`);
      }

      try {
        if (apiService) {
          await apiService.stop();
          supervisor.setStatus('api', 'stopped');
        }
      } catch (error) {
        logger.warn(`Failed to stop api: ${String(error)}`);
      }

      try {
        if (cssApp) {
          await cssApp.stop();
          supervisor.setStatus('css', 'stopped');
        }
      } catch (error) {
        logger.warn(`Failed to stop css: ${String(error)}`);
      }

      if (sockets.css) {
        removeSocketPath(sockets.css);
      }
      if (sockets.api) {
        removeSocketPath(sockets.api);
      }

      await unregisterSocketShims();
      await closeAllIdentityConnections();
      restoreRuntimeEnv();
    })();

    return stopPromise;
  };

  supervisor.registerManaged('css', async() => {
    if (cssApp) {
      await cssApp.stop();
    }
  });
  supervisor.registerManaged('api', async() => {
    if (apiService) {
      await apiService.stop();
    }
  });
  supervisor.registerManaged('gateway', async() => {
    if (gateway) {
      await gateway.stop();
    }
  });

  try {
    const runner = new AppRunner();
    const configPath = path.join(PACKAGE_ROOT, `config/${mode}.json`);
    const cssConfigPath = createCssRuntimeConfig(
      configPath,
      runtimeRoot,
      options.open || cssAuthMode === 'allow-all',
    );

    supervisor.setStatus('css', 'starting', { startTime: Date.now() });
    cssApp = await runner.create({
      config: cssConfigPath,
      loaderProperties: {
        mainModulePath: PACKAGE_ROOT,
        logLevel: logLevel as any,
      },
      shorthand: {
        ...(sockets.css ? { socket: sockets.css } : { port: ports.css! }),
        ...runtimeShorthand,
      },
    });
    await cssApp.start();
    if (transport === 'port') {
      await waitForTcpReady(ports.css!, '127.0.0.1');
    }
    supervisor.addLog('css', 'info', `CSS started (${transport === 'socket' ? `unix://${sockets.css}` : `http://127.0.0.1:${ports.css}`})`);
    supervisor.setStatus('css', 'running', { startTime: Date.now() });

    supervisor.setStatus('api', 'starting', { startTime: Date.now() });
    apiService = await startApiService({
      open: apiOpen,
      authContext: createOpenAuthContext(baseUrl, options.authContext),
      initializeLogger: false,
    });
    supervisor.addLog('api', 'info', `API started (${transport === 'socket' ? `unix://${sockets.api}` : `http://127.0.0.1:${ports.api}`})`);
    supervisor.setStatus('api', 'running', { startTime: Date.now() });

    supervisor.setStatus('gateway', 'starting', { startTime: Date.now() });
    gateway = new GatewayProxy(ports.gateway, supervisor, bindHost, {
      socketPath: sockets.gateway,
      exitOnStop: false,
      shutdownHandler: stop,
      baseUrl,
    });
    gateway.setTargets({
      css: transport === 'socket' ? { socketPath: sockets.css } : { url: `http://127.0.0.1:${ports.css}` },
      api: transport === 'socket' ? { socketPath: sockets.api } : { url: `http://127.0.0.1:${ports.api}` },
    });
    await gateway.start();
    supervisor.addLog('xpod', 'info', `Gateway started (${transport === 'socket' ? `unix://${sockets.gateway}` : baseUrl})`);
    supervisor.setStatus('gateway', 'running', { startTime: Date.now() });
    restoreRuntimeEnv();

    return {
      id,
      mode,
      transport,
      baseUrl,
      supervisor,
      ports,
      sockets,
      fetch: async(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (transport === 'socket' && sockets.gateway) {
          return fetchViaSocket(sockets.gateway, baseUrl, input, init);
        }
        if (typeof input === 'string' || input instanceof URL) {
          return fetch(new URL(String(input), baseUrl), init);
        }
        return fetch(input, init);
      },
      stop,
    };
  } catch (error) {
    restoreRuntimeEnv();
    await stop();
    throw error;
  }
}
