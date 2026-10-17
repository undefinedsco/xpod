import { createBunSqliteRuntime } from './backends/BunSqliteRuntime';
import { createNodeSqliteRuntime } from './backends/NodeSqliteRuntime';
import type { SqliteRuntime, SqliteRuntimeKind } from './types';

export function isBunRuntime(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}

function parseConfiguredSqliteRuntimeKind(value: string | undefined): SqliteRuntimeKind | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'node-sqlite' || value === 'bun-sqlite') {
    return value;
  }

  throw new Error(`Unsupported XPOD_SQLITE_RUNTIME: ${value}`);
}

export function resolveDefaultSqliteRuntimeKind(): SqliteRuntimeKind {
  return parseConfiguredSqliteRuntimeKind(process.env.XPOD_SQLITE_RUNTIME)
    ?? (isBunRuntime() ? 'bun-sqlite' : 'node-sqlite');
}

export function createSqliteRuntime(kind: SqliteRuntimeKind = resolveDefaultSqliteRuntimeKind()): SqliteRuntime {
  switch (kind) {
    case 'bun-sqlite':
      return createBunSqliteRuntime();
    case 'node-sqlite':
      return createNodeSqliteRuntime();
    default: {
      const exhaustiveKind: never = kind;
      throw new Error(`Unsupported sqlite runtime kind: ${String(exhaustiveKind)}`);
    }
  }
}
