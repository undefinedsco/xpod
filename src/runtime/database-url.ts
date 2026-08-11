import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';

const SUPPORTED_DATABASE_URL_PREFIXES = [
  'sqlite:',
  'postgres://',
  'postgresql://',
  'mysql://',
];

const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z\d+.-]*):/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

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
