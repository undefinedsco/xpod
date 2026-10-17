import { createSqliteRuntime, resolveDefaultSqliteRuntimeKind, isBunRuntime } from './factory';
import type { SqliteRuntime } from './types';
export type {
  SqliteDatabase,
  SqliteOpenOptions,
  SqliteRunResult,
  SqliteRuntimeKind,
  SqliteStatement,
} from './types';
export type { SqliteRuntime } from './types';

let runtime: SqliteRuntime | undefined;

export function getSqliteRuntime(): SqliteRuntime {
  if (runtime) {
    return runtime;
  }

  runtime = createSqliteRuntime();
  return runtime;
}

export { createSqliteRuntime, isBunRuntime, resolveDefaultSqliteRuntimeKind };
