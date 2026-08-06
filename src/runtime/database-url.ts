import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';

const SUPPORTED_DATABASE_URL_PATTERNS = [
  /^sqlite:/i,
  /^postgres:\/\//i,
  /^postgresql:\/\//i,
  /^mysql:\/\//i,
];

const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z\d+.-]*):/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export function normalizeDatabaseUrl(
  value: string,
  platform: Pick<RuntimePlatform, 'resolvePath'> = nodeRuntimePlatform,
): string {
  if (value.trim().length === 0) {
    throw new Error('Database URL must not be empty');
  }

  if (SUPPORTED_DATABASE_URL_PATTERNS.some((pattern) => pattern.test(value))) {
    return value;
  }

  const scheme = URI_SCHEME_PATTERN.exec(value)?.[1];
  if (scheme && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new Error(`Unsupported database URL scheme: ${scheme}`);
  }

  return `sqlite:${platform.resolvePath(value)}`;
}
