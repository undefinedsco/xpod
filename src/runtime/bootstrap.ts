import { setGlobalLoggerFactory } from 'global-logger-factory';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigurableLoggerFactory } from '../logging/ConfigurableLoggerFactory';
import { PACKAGE_ROOT } from './package-root';
import type { RuntimeHost } from './host/types';
import { oidcTokenEndpoint, resolveExternalOidcIssuer } from './oidc-issuer';
import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';
import { loadEnvFile } from './env-utils';
import type { XpodRuntimeOptions, XpodRuntimePorts, XpodRuntimeSockets } from './runtime-types';
import type { AuthMode } from '../authorization/AuthMode';
import { applyAuthModeEnv, resolveAuthModeInput } from '../authorization/AuthMode';
import { extractComponentParameterContext, normalizeComponentParameterKeys } from './component-parameter-keys';
import { rewriteConfigAssetPaths } from './config-asset-paths';

const CSS_CONFIG_BASE = 'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/config/';
const XPOD_CONFIG_BASE = 'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/config/';
const CSS_COMPONENTS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld';
const ASYNC_HANDLERS_CONTEXT = 'https://linkedsoftwaredependencies.org/bundles/npm/asynchronous-handlers/^1.0.0/components/context.jsonld';

export interface RuntimeBootstrapState {
  id: string;
  host: RuntimeHost;
  mode: 'local' | 'cloud';
  transport: 'socket' | 'port';
  bindHost: string;
  runtimeRoot: string;
  rootFilePath: string;
  sparqlEndpoint: string;
  rdfIndexPath: string;
  identityDbUrl: string;
  usageDbUrl: string;
  cssAuthMode: AuthMode;
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

function normalizeWindowsAbsolutePath(filePath: string): string {
  return filePath.replace(/^[\\/]+(?=[A-Za-z]:[\\/])/, '');
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(normalizeWindowsAbsolutePath(filePath));
}

function getWindowsDriveRoot(filePath: string): string | undefined {
  const normalizedPath = normalizeWindowsAbsolutePath(filePath);
  return isWindowsAbsolutePath(normalizedPath) ? path.win32.parse(normalizedPath).root.toLowerCase() : undefined;
}

function arePathsOnDifferentWindowsDrives(firstPath: string, secondPath: string): boolean {
  const firstRoot = getWindowsDriveRoot(firstPath);
  const secondRoot = getWindowsDriveRoot(secondPath);
  return Boolean(firstRoot && secondRoot && firstRoot !== secondRoot);
}

function toWindowsFileUrl(filePath: string): string {
  const normalizedPath = normalizeWindowsAbsolutePath(filePath).replace(/\\/g, '/');
  return new URL(`file:///${normalizedPath}`).href;
}

function toConfigImportSpecifier(fromFilePath: string, toFilePath: string): string {
  const normalizedFromPath = normalizeWindowsAbsolutePath(fromFilePath);
  const normalizedToPath = normalizeWindowsAbsolutePath(toFilePath);
  if (!isWindowsAbsolutePath(normalizedFromPath) && (pathNeedsEscapedFileUrl(normalizedFromPath) || pathNeedsEscapedFileUrl(normalizedToPath))) {
    return pathToFileURL(normalizedToPath).href;
  }

  const useWindowsPaths = isWindowsAbsolutePath(normalizedFromPath) || isWindowsAbsolutePath(normalizedToPath);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  const fromDirectoryPath = pathApi.dirname(useWindowsPaths ? normalizedFromPath : fromFilePath);
  const targetPath = useWindowsPaths ? normalizedToPath : toFilePath;

  if (useWindowsPaths && arePathsOnDifferentWindowsDrives(fromDirectoryPath, targetPath)) {
    return toWindowsFileUrl(targetPath);
  }

  const relativePath = pathApi.relative(fromDirectoryPath, targetPath).replace(/\\/g, '/');
  if (relativePath.startsWith('./') || relativePath.startsWith('../')) {
    return relativePath;
  }
  return `./${relativePath}`;
}

function pathNeedsEscapedFileUrl(filePath: string): boolean {
  return /\s/.test(filePath);
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

function readRuntimeEnvFile(
  envFilePath: string | undefined,
  platform: Pick<RuntimePlatform, 'fileExists' | 'readTextFile'>,
): Record<string, string> {
  return envFilePath ? loadEnvFile(envFilePath, platform) : {};
}

export function cssAuthModeConfigImports(authMode: AuthMode): string[] {
  switch (authMode) {
    case 'acl':
      return [
        'css:config/ldp/authorization/webacl.json',
        'css:config/util/auxiliary/acl.json',
      ];
    case 'allow-all':
      return [
        'css:config/ldp/authorization/allow-all.json',
        'css:config/util/auxiliary/empty.json',
      ];
    case 'acp':
    default:
      return [
        'css:config/ldp/authorization/acp.json',
        'css:config/util/auxiliary/acr.json',
      ];
  }
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
  const rdfIndexPath = platform.resolvePath(options.rdfIndexPath ?? platform.joinPath(runtimeRoot, 'rdf-index.sqlite'));
  const identityDbUrl = normalizeDatabaseUrl(options.identityDbUrl ?? platform.joinPath(runtimeRoot, 'identity.sqlite'), platform);
  const usageDbUrl = normalizeDatabaseUrl(options.usageDbUrl ?? platform.joinPath(runtimeRoot, 'usage.sqlite'), platform);
  const envFilePath = options.envFile ? platform.resolvePath(options.envFile) : undefined;
  const authModeEnv = {
    ...platform.baseEnv,
    ...readRuntimeEnvFile(envFilePath, platform),
    ...options.env,
  };
  const cssAuthMode = options.open ? 'allow-all' : resolveAuthModeInput(options.authMode, authModeEnv);
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
    rdfIndexPath,
    identityDbUrl,
    usageDbUrl,
    cssAuthMode,
    apiOpen,
    logLevel,
    baseUrl,
    envFilePath,
    ports,
    sockets,
  };
}

export function buildRuntimeEnv(
  state: RuntimeBootstrapState,
  options: XpodRuntimeOptions,
  envFromFile: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const mergedEnv = {
    ...envFromFile,
    ...options.env,
  };
  const externalOidcIssuer = resolveExternalOidcIssuer(mergedEnv);

  const runtimeEnv = {
    ...mergedEnv,
    XPOD_ENV_PATH: state.envFilePath,
    XPOD_EDITION: state.mode,
    CSS_BASE_URL: state.baseUrl,
    CSS_TOKEN_ENDPOINT: externalOidcIssuer
      ? oidcTokenEndpoint(externalOidcIssuer)
      : `${state.baseUrl}.oidc/token`,
    CSS_ROOT_FILE_PATH: state.rootFilePath,
    CSS_RDF_INDEX_PATH: state.rdfIndexPath,
    CSS_SPARQL_ENDPOINT: state.sparqlEndpoint,
    SPARQL_ENDPOINT: state.sparqlEndpoint,
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

  return applyAuthModeEnv(runtimeEnv, state.cssAuthMode);
}

export function buildRuntimeShorthand(
  runtimeEnv: Record<string, string | undefined>,
  options: XpodRuntimeOptions,
  state: RuntimeBootstrapState,
  baseEnv: Record<string, string | undefined> = nodeRuntimePlatform.baseEnv,
): Record<string, string | number | boolean> {
  const envValue = (key: string): string | undefined => runtimeEnv[key] ?? baseEnv[key];
  const externalOidcIssuer = resolveExternalOidcIssuer({
    oidcIssuer: envValue('oidcIssuer'),
  });

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
      ['emailConfigHost', envValue('CSS_EMAIL_CONFIG_HOST') ?? ''],
      ['emailConfigPort', envValue('CSS_EMAIL_CONFIG_PORT') ?? '587'],
      ['emailConfigAuthUser', envValue('CSS_EMAIL_CONFIG_AUTH_USER') ?? ''],
      ['emailConfigAuthPass', envValue('CSS_EMAIL_CONFIG_AUTH_PASS') ?? ''],
      ['oidcIssuer', externalOidcIssuer],
      ['allowedHosts', envValue('CSS_ALLOWED_HOSTS')],
      ['edgeNodeAgentEnabled', envValue('XPOD_EDGE_NODE_AGENT_ENABLED')],
      ['signalEndpoint', envValue('XPOD_SIGNAL_ENDPOINT')],
      ['nodeId', envValue('XPOD_NODE_ID')],
      ['nodeToken', envValue('XPOD_NODE_TOKEN')],
      ['p2pEnabled', envValue('XPOD_P2P_ENABLED')],
      ['p2pTargetBaseUrl', envValue('XPOD_P2P_TARGET_BASE_URL')],
      ['p2pLabel', envValue('XPOD_P2P_LABEL')],
      ['p2pAcceptIntervalMs', envValue('XPOD_P2P_ACCEPT_INTERVAL_MS')],
      ['p2pConnectTimeoutMs', envValue('XPOD_P2P_CONNECT_TIMEOUT_MS')],
      ['serviceToken', envValue('XPOD_SERVICE_TOKEN')],
    ]),
    baseUrl: state.baseUrl,
    rootFilePath: state.rootFilePath,
    sparqlEndpoint: state.sparqlEndpoint,
    rdfIndexPath: state.rdfIndexPath,
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
  _open?: boolean,
  platform: Pick<RuntimePlatform, 'dirname' | 'ensureDir' | 'joinPath' | 'readTextFile' | 'writeTextFile'> = nodeRuntimePlatform,
): string {
  const configPath = normalizeWindowsAbsolutePath(platform.joinPath(PACKAGE_ROOT, `config/${state.mode}.json`));
  const runtimeRoot = normalizeWindowsAbsolutePath(state.runtimeRoot);
  const runtimeConfigPath = arePathsOnDifferentWindowsDrives(runtimeRoot, configPath)
    ? (() => {
      const runtimeConfigDir = normalizeWindowsAbsolutePath(platform.joinPath(
        platform.dirname(configPath),
        '..',
        '.xpod-runtime',
        state.id,
      ));
      platform.ensureDir(runtimeConfigDir);
      return normalizeWindowsAbsolutePath(platform.joinPath(runtimeConfigDir, 'css-runtime.config.json'));
    })()
    : normalizeWindowsAbsolutePath(platform.joinPath(runtimeRoot, 'css-runtime.config.json'));
  const runtimeConfigDir = platform.dirname(runtimeConfigPath);
  const runtimeConfigImportPath = rewriteConfigForFileUrlImportsIfNeeded(
    configPath,
    platform.joinPath(runtimeConfigDir, 'config'),
    platform,
  );
  platform.writeTextFile(runtimeConfigPath, JSON.stringify({
    '@context': [
      CSS_COMPONENTS_CONTEXT,
      ASYNC_HANDLERS_CONTEXT,
    ],
    import: [
      toConfigImportSpecifier(runtimeConfigPath, runtimeConfigImportPath),
      ...cssAuthModeConfigImports(state.cssAuthMode),
    ],
  }, null, 2));

  return runtimeConfigPath;
}

function rewriteConfigForFileUrlImportsIfNeeded(
  configPath: string,
  outputDir: string,
  platform: Pick<RuntimePlatform, 'dirname' | 'ensureDir' | 'joinPath' | 'readTextFile' | 'writeTextFile'>,
  rewritten = new Map<string, string>(),
): string {
  const normalizedConfigPath = normalizeWindowsAbsolutePath(configPath);
  const componentContext = readPackageComponentContext(normalizedConfigPath, platform);
  if (
    isWindowsAbsolutePath(normalizedConfigPath) ||
    (!pathNeedsEscapedFileUrl(normalizedConfigPath) && !componentContext)
  ) {
    return normalizedConfigPath;
  }

  const existing = rewritten.get(normalizedConfigPath);
  if (existing) {
    return existing;
  }

  platform.ensureDir(outputDir);
  const outputPath = normalizeWindowsAbsolutePath(platform.joinPath(outputDir, path.posix.basename(normalizedConfigPath)));
  rewritten.set(normalizedConfigPath, outputPath);

  const parsed = JSON.parse(platform.readTextFile(normalizedConfigPath)) as Record<string, unknown>;
  preserveConfigBase(parsed, normalizedConfigPath);
  normalizeComponentParameterKeys(parsed, componentContext);
  rewriteConfigAssetPaths(parsed, normalizedConfigPath, resolveConfigAssetPath);
  parsed.import = rewriteConfigImports(
    normalizedConfigPath,
    parsed.import,
    outputDir,
    platform,
    rewritten,
  );
  platform.writeTextFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return outputPath;
}

function readPackageComponentContext(
  configPath: string,
  platform: Pick<RuntimePlatform, 'readTextFile'>,
): ReturnType<typeof extractComponentParameterContext> {
  const normalizedConfigPath = normalizeWindowsAbsolutePath(configPath);
  const useWindowsPaths = isWindowsAbsolutePath(normalizedConfigPath);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  const contextPath = normalizeWindowsAbsolutePath(pathApi.join(
    resolveConfigAssetBase(normalizedConfigPath),
    'dist',
    'components',
    'context.jsonld',
  ));
  try {
    return extractComponentParameterContext(JSON.parse(platform.readTextFile(contextPath)));
  } catch {
    return undefined;
  }
}

function resolveConfigAssetPath(sourceConfigPath: string, assetPath: string): string {
  const normalizedSourcePath = normalizeWindowsAbsolutePath(sourceConfigPath);
  const useWindowsPaths = isWindowsAbsolutePath(normalizedSourcePath);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  return normalizeWindowsAbsolutePath(pathApi.resolve(resolveConfigAssetBase(normalizedSourcePath), assetPath));
}

function resolveConfigAssetBase(sourceConfigPath: string): string {
  const normalized = normalizeWindowsAbsolutePath(sourceConfigPath);
  const useWindowsPaths = isWindowsAbsolutePath(normalized);
  const pathApi = useWindowsPaths ? path.win32 : path.posix;
  const normalizedForSearch = normalized.replace(/\\/g, '/');
  const markerIndex = normalizedForSearch.lastIndexOf('/config/');
  if (markerIndex >= 0) {
    const packageRoot = normalizedForSearch.slice(0, markerIndex);
    return useWindowsPaths ? packageRoot.replace(/\//g, '\\') : packageRoot;
  }
  return pathApi.dirname(normalized);
}

function preserveConfigBase(parsed: Record<string, unknown>, configPath: string): void {
  const context = parsed['@context'];
  const contexts = Array.isArray(context)
    ? [...context]
    : context === undefined
      ? []
      : [context];
  const withoutExistingBase = contexts.filter((entry) => (
    !entry || typeof entry !== 'object' || !('@base' in entry)
  ));
  withoutExistingBase.push({ '@base': resolveConfigBase(configPath) });
  parsed['@context'] = withoutExistingBase;
  delete parsed['@base'];
}

function resolveConfigBase(configPath: string): string {
  const normalized = normalizeWindowsAbsolutePath(configPath).replace(/\\/g, '/');
  if (normalized.includes('/node_modules/@solid/community-server/config/')) {
    return CSS_CONFIG_BASE;
  }
  if (normalized.includes('/node_modules/@undefineds.co/xpod/config/')) {
    return XPOD_CONFIG_BASE;
  }
  return pathToFileURL(path.posix.dirname(normalized) + '/').href;
}

function rewriteConfigImports(
  sourceConfigPath: string,
  imports: unknown,
  outputDir: string,
  platform: Pick<RuntimePlatform, 'dirname' | 'ensureDir' | 'joinPath' | 'readTextFile' | 'writeTextFile'>,
  rewritten: Map<string, string>,
): unknown {
  if (typeof imports === 'string') {
    return rewriteConfigImport(sourceConfigPath, imports, outputDir, platform, rewritten);
  }

  if (Array.isArray(imports)) {
    return imports.map((value) => typeof value === 'string'
      ? rewriteConfigImport(sourceConfigPath, value, outputDir, platform, rewritten)
      : value);
  }

  return imports;
}

function rewriteConfigImport(
  sourceConfigPath: string,
  importValue: string,
  outputDir: string,
  platform: Pick<RuntimePlatform, 'dirname' | 'ensureDir' | 'joinPath' | 'readTextFile' | 'writeTextFile'>,
  rewritten: Map<string, string>,
): string {
  if (!importValue.startsWith('./') && !importValue.startsWith('../')) {
    return importValue;
  }

  const targetPath = normalizeWindowsAbsolutePath(
    path.posix.resolve(platform.dirname(sourceConfigPath), importValue),
  );
  const rewrittenTargetPath = rewriteConfigForFileUrlImportsIfNeeded(targetPath, outputDir, platform, rewritten);
  return pathToFileURL(rewrittenTargetPath).href;
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
