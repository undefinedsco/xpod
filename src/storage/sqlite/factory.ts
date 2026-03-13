import { createBetterSqlite3Runtime } from './backends/BetterSqlite3Runtime';
import { createBunSqliteRuntime } from './backends/BunSqliteRuntime';
import type { SqliteRuntime, SqliteRuntimeKind } from './types';

export function isBunRuntime(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}

export function resolveDefaultSqliteRuntimeKind(): SqliteRuntimeKind {
  return isBunRuntime() ? 'bun-sqlite' : 'node-better-sqlite3';
}

export function createSqliteRuntime(kind: SqliteRuntimeKind = resolveDefaultSqliteRuntimeKind()): SqliteRuntime {
  switch (kind) {
    case 'bun-sqlite':
      return createBunSqliteRuntime();
    case 'node-better-sqlite3':
      return createBetterSqlite3Runtime();
    default: {
      const exhaustiveKind: never = kind;
      throw new Error(`Unsupported sqlite runtime kind: ${String(exhaustiveKind)}`);
    }
  }
}
