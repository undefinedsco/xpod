import { setGlobalLoggerFactory } from 'global-logger-factory';
import path from 'node:path';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { PACKAGE_ROOT } from './package-root';
import type { RuntimeHost } from './host/types';
import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';
import type { XpodRuntimeOptions, XpodRuntimePorts, XpodRuntimeSockets } from './runtime-types';

export interface RuntimeBootstrapState {
  id: string;
  host: RuntimeHost;
  mode: 'local' | 'cloud';
  transport: 'socket' | 'port';
  bindHost: string;
  runtimeRoot: string;
  rootFilePath: string;
  sparqlEndpoint: string;
  identityDbUrl: string;
  usageDbUrl: string;
  cssAuthMode: 'acp' | 'acl' | 'allow-all';
  apiOpen: boolean;
  logLevel: string;
  baseUrl: string;
  envFilePath?: string;
  ports: XpodRuntimePorts;
  sockets: XpodRuntimeSockets;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function toConfigImportSpecifier(fromFilePath: string, toFilePath: string): string {
  const useWindowsPaths = /^[A-Za-z]:[\\/]/.test(fromFilePath) || /^[A-Za-z]:[\\/]/.test(toFilePath);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  const fromDirectoryPath = pathApi.dirname(fromFilePath);

  if (useWindowsPaths) {
    const fromRoot = path.win32.parse(fromDirectoryPath).root.toLowerCase();
    const toRoot = path.win32.parse(toFilePath).root.toLowerCase();
    if (fromRoot && toRoot && fromRoot !== toRoot) {
      return new URL(`file:///${toFilePath.replace(/\\/g, '/')}`).href;
    }
  }

  const relativePath = pathApi.relative(fromDirectoryPath, toFilePath).replace(/\\/g, '/');
  if (relativePath.startsWith('./') || relativePath.startsWith('../')) {
    return relativePath;
  }
  return `./${relativePath}`;
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

function normalizeDatabaseUrl(
  value: string,
  platform: Pick<RuntimePlatform, 'resolvePath'> = nodeRuntimePlatform,
): string {
  if (
    value.startsWith('sqlite:') ||
    value.startsWith('postgres://') ||
    value.startsWith('postgresql://') ||
    value.startsWith('mysql://')
  ) {
    return value;
  }
  return `sqlite:${platform.resolvePath(value)}`;
}

export async function resolveRuntimeBootstrap(
  id: string,
  options: XpodRuntimeOptions,
  host: RuntimeHost,
  platform: RuntimePlatform = nodeRuntimePlatform,
): Promise<RuntimeBootstrapState> {
  const mode = options.mode ?? 'local';
  const transport = host.resolveTransport(options.transport);
  const bindHost = options.bindHost ?? '127.0.0.1';
  const runtimeRoot = platform.resolvePath(options.runtimeRoot ?? platform.joinPath(platform.cwd(), '.test-data', 'xpod-runtime', id));
  const rootFilePath = platform.resolvePath(options.rootFilePath ?? platform.joinPath(runtimeRoot, 'data'));
  const sparqlEndpoint = normalizeDatabaseUrl(options.sparqlEndpoint ?? platform.joinPath(runtimeRoot, 'quadstore.sqlite'), platform);
  const identityDbUrl = normalizeDatabaseUrl(options.identityDbUrl ?? platform.joinPath(runtimeRoot, 'identity.sqlite'), platform);
  const usageDbUrl = normalizeDatabaseUrl(options.usageDbUrl ?? platform.joinPath(runtimeRoot, 'usage.sqlite'), platform);
  const cssAuthMode = options.authMode ?? (options.open ? 'allow-all' : 'acp');
  const apiOpen = options.apiOpen ?? options.open ?? false;
  const logLevel = options.logLevel ?? platform.getEnv('CSS_LOGGING_LEVEL') ?? 'warn';

  platform.ensureDir(runtimeRoot);
  platform.ensureDir(rootFilePath);

  const socketsRoot = platform.joinPath(runtimeRoot, 'sockets');
  if (transport === 'socket') {
    platform.ensureDir(socketsRoot);
  }
  const ports: XpodRuntimePorts = transport === 'port'
    ? await host.allocatePorts({
      gatewayPort: options.gatewayPort,
      cssPort: options.cssPort,
      apiPort: options.apiPort,
      basePort: 5600,
    })
    : {};
  const sockets: XpodRuntimeSockets = {};

  if (transport === 'socket') {
    sockets.gateway = platform.resolvePath(options.gatewaySocketPath ?? platform.joinPath(socketsRoot, 'gateway.sock'));
    sockets.css = platform.resolvePath(options.cssSocketPath ?? platform.joinPath(socketsRoot, 'css.sock'));
    sockets.api = platform.resolvePath(options.apiSocketPath ?? platform.joinPath(socketsRoot, 'api.sock'));
  }

  const baseUrl = ensureTrailingSlash(
    options.baseUrl ?? (transport === 'socket'
      ? 'http://localhost'
      : `http://${bindHost}:${ports.gateway}`),
  );

  return {
    id,
    host,
    mode,
    transport,
    bindHost,
    runtimeRoot,
    rootFilePath,
    sparqlEndpoint,
    identityDbUrl,
    usageDbUrl,
    cssAuthMode,
    apiOpen,
    logLevel,
    baseUrl,
    envFilePath: options.envFile ? platform.resolvePath(options.envFile) : undefined,
    ports,
    sockets,
  };
}

export function buildRuntimeEnv(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
  envFromFile: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...envFromFile,
    ...options.env,
    XPOD_ENV_PATH: state.envFilePath,
    XPOD_EDITION: state.mode,
    CSS_BASE_URL: state.baseUrl,
    CSS_TOKEN_ENDPOINT: `${state.baseUrl}.oidc/token`,
    CSS_ROOT_FILE_PATH: state.rootFilePath,
    CSS_IDENTITY_DB_URL: state.identityDbUrl,
    DATABASE_URL: state.identityDbUrl,
    CSS_PORT: state.ports.css !== undefined ? String(state.ports.css) : undefined,
    API_PORT: state.ports.api !== undefined ? String(state.ports.api) : undefined,
    API_HOST: state.bindHost,
    API_SOCKET_PATH: state.sockets.api,
    XPOD_MAIN_PORT: state.ports.gateway !== undefined ? String(state.ports.gateway) : undefined,
    CORS_ORIGINS: new URL(state.baseUrl).origin,
    CSS_LOGGING_LEVEL: state.logLevel,
  };
}

export function buildRuntimeShorthand(
  runtimeEnv: Record<string, string | undefined>,
  options: XpodRuntimeOptions,
  state: RuntimeBootstrapState,
  baseEnv: Record<string, string | undefined> = nodeRuntimePlatform.baseEnv,
): Record<string, string | number | boolean> {
  const envValue = (key: string): string | undefined => runtimeEnv[key] ?? baseEnv[key];

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
    ]),
    baseUrl: state.baseUrl,
    rootFilePath: state.rootFilePath,
    sparqlEndpoint: state.sparqlEndpoint,
    identityDbUrl: state.identityDbUrl,
    usageDbUrl: state.usageDbUrl,
    logLevel: state.logLevel,
    authMode: state.cssAuthMode,
    edition: state.mode === 'cloud' ? 'server' : 'local',
    edgeNodesEnabled: options.edgeNodesEnabled ?? false,
    centerRegistrationEnabled: options.centerRegistrationEnabled ?? false,
    ...(options.shorthand ?? {}),
  };
}

export function createCssRuntimeConfig(
  state: RuntimeBootstrapState,
  open: boolean,
  platform: Pick<RuntimePlatform, 'joinPath' | 'writeTextFile'> = nodeRuntimePlatform,
): string {
  const configPath = platform.joinPath(PACKAGE_ROOT, `config/${state.mode}.json`);
  if (!open) {
    return configPath;
  }

  const runtimeConfigPath = platform.joinPath(state.runtimeRoot, 'css-runtime.config.json');
  const openConfigPath = platform.joinPath(PACKAGE_ROOT, 'config/runtime-open.json');
  platform.writeTextFile(runtimeConfigPath, JSON.stringify({
    '@context': [
      'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
      'https://linkedsoftwaredependencies.org/bundles/npm/asynchronous-handlers/^1.0.0/components/context.jsonld',
    ],
    import: [
      toConfigImportSpecifier(runtimeConfigPath, configPath),
      toConfigImportSpecifier(runtimeConfigPath, openConfigPath),
    ],
  }, null, 2));

  return runtimeConfigPath;
}

export function initRuntimeLogger(
  level: string,
  platform: Pick<RuntimePlatform, 'cwd' | 'joinPath'> = nodeRuntimePlatform,
): void {
  const loggerFactory = new ConfigurableLoggerFactory(level, {
    fileName: platform.joinPath(platform.cwd(), 'logs/xpod-%DATE%.log'),
    showLocation: true,
  });
  setGlobalLoggerFactory(loggerFactory);
}
