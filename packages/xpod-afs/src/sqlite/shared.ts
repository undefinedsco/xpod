import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteOpenOptions, SqliteRuntimeKind } from './types';

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
