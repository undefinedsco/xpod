import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';
import { fileURLToPath } from 'node:url';

const SUPPORTED_DATABASE_URL_PREFIXES = [
  'sqlite:',
  'postgres://',
  'postgresql://',
  'mysql://',
];

const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z\d+.-]*):/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const SQLITE_URL_PREFIX_PATTERN = /^sqlite:/iu;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;

export function normalizeDatabaseUrl(
  value: string,
  platform: Pick<RuntimePlatform, 'resolvePath'> = nodeRuntimePlatform,
): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Database URL must not be empty');
  }

  const lowerCaseValue = trimmed.toLowerCase();
  const supportedPrefix = SUPPORTED_DATABASE_URL_PREFIXES.find((prefix) => lowerCaseValue.startsWith(prefix));
  if (supportedPrefix) {
    return `${supportedPrefix}${trimmed.slice(supportedPrefix.length)}`;
  }

  const scheme = URI_SCHEME_PATTERN.exec(trimmed)?.[1];
  if (scheme && !WINDOWS_DRIVE_PATH_PATTERN.test(trimmed)) {
    throw new Error(`Unsupported database URL scheme: ${scheme}`);
  }

  return `sqlite:${platform.resolvePath(trimmed)}`;
}

export function resolveDefaultRdfIndexPath(options: {
  sparqlEndpoint?: string
  fallbackRoot: string
  sqliteRelativeRoot?: string
  platform?: Pick<RuntimePlatform, 'dirname' | 'joinPath' | 'resolvePath'>
}): string {
  const platform = options.platform ?? nodeRuntimePlatform;
  const sqliteDatabasePath = options.sparqlEndpoint
    ? sqliteDatabaseFilePath(options.sparqlEndpoint, platform, options.sqliteRelativeRoot)
    : undefined;

  if (sqliteDatabasePath) {
    return platform.joinPath(platform.dirname(sqliteDatabasePath), 'rdf-index.sqlite');
  }

  return platform.resolvePath(platform.joinPath(options.fallbackRoot, 'rdf-index.sqlite'));
}

export function sqliteDatabaseFilePath(
  databaseUrl: string,
  platform: Pick<RuntimePlatform, 'joinPath' | 'resolvePath'> = nodeRuntimePlatform,
  relativeRoot?: string,
): string | undefined {
  const trimmed = databaseUrl.trim();
  if (!SQLITE_URL_PREFIX_PATTERN.test(trimmed)) {
    return undefined;
  }

  const databasePath = trimmed.slice(trimmed.indexOf(':') + 1).trim();
  if (databasePath.length === 0 || databasePath === ':memory:') {
    return undefined;
  }

  if (databasePath.startsWith('file:')) {
    return platform.resolvePath(fileURLToPath(databasePath));
  }

  if (isAbsoluteDatabasePath(databasePath) || !relativeRoot) {
    return platform.resolvePath(databasePath);
  }

  return platform.resolvePath(platform.joinPath(relativeRoot, databasePath));
}

function isAbsoluteDatabasePath(databasePath: string): boolean {
  return databasePath.startsWith('/') ||
    databasePath.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(databasePath);
}
