import { initializeBunSqlite } from './sqlite/backends/BunSqliteInitialization';
import { createSqliteRuntime, resolveDefaultSqliteRuntimeKind, isBunRuntime } from './sqlite/factory';
import type { SqliteRuntime } from './sqlite/types';
export type {
  SqliteDatabase,
  SqliteOpenOptions,
  SqliteRunResult,
  SqliteRuntimeKind,
  SqliteStatement,
} from './sqlite/types';
export type { SqliteRuntime } from './sqlite/types';

let runtime: SqliteRuntime | undefined;

export function getSqliteRuntime(): SqliteRuntime {
  if (runtime) {
    if (runtime.kind === 'bun-sqlite') initializeBunSqlite();
    return runtime;
  }

  runtime = createSqliteRuntime();
  return runtime;
}

export { createSqliteRuntime, isBunRuntime, resolveDefaultSqliteRuntimeKind };
