import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteOpenOptions, SqliteRuntimeKind } from './types';

export function wrapBetterSqliteError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }

  if (!/NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(error.message)) {
    return error;
  }

  return new Error([
    `Failed to load better-sqlite3 under Node ${process.version} (ABI ${process.versions.modules}).`,
    'This usually means native modules were installed with a different Node.js major version.',
    'Suggested fix:',
    '  1. nvm use 22',
    '  2. yarn install --force --ignore-engines',
    '',
    `Original error: ${error.message}`,
  ].join('\n'));
}

export function shouldEnsureParentDirectory(path: string, options?: SqliteOpenOptions): boolean {
  return !options?.readonly && path !== ':memory:' && !path.startsWith(':memory:');
}

export function ensureParentDirectory(path: string): void {
  const directory = dirname(path);
  if (directory && directory !== '.' && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

export function tagDrizzleDatabase(database: any, kind: SqliteRuntimeKind): any {
  Object.defineProperty(database, '$xpodSqliteRuntime', {
    value: kind,
    enumerable: false,
    configurable: true,
  });
  return database;
}
