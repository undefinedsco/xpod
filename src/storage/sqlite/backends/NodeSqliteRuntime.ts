import type { SqliteDatabase, SqliteOpenOptions, SqliteRunResult, SqliteRuntime, SqliteStatement } from '../types';
import { ensureParentDirectory, shouldEnsureParentDirectory, tagDrizzleDatabase } from '../shared';
import { drizzleNodeSqlite } from '../../NodeSqliteDrizzle';

interface NodeSqliteStatementSync {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface NodeSqliteDatabaseSync {
  exec(sql: string): unknown;
  prepare(sql: string): NodeSqliteStatementSync;
  enableLoadExtension(enabled: boolean): void;
  loadExtension(path: string): void;
  close(): void;
}

export function createNodeSqliteRuntime(): SqliteRuntime {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new(path: string, options?: Record<string, unknown>) => NodeSqliteDatabaseSync };

  return {
    kind: 'node-sqlite',
    openDatabase: (path: string, options?: SqliteOpenOptions): SqliteDatabase => {
      if (shouldEnsureParentDirectory(path, options)) {
        ensureParentDirectory(path);
      }

      const nativeDb = new DatabaseSync(path, {
        readOnly: options?.readonly === true,
        allowExtension: true,
      });
      nativeDb.enableLoadExtension(true);

      return {
        kind: 'node-sqlite',
        native: nativeDb,
        exec: (sql: string): unknown => nativeDb.exec(sql),
        pragma: (pragma: string): unknown => nativeDb.prepare(`PRAGMA ${pragma}`).all(),
        prepare<TResult = unknown>(sql: string): SqliteStatement<TResult> {
          const stmt = nativeDb.prepare(sql);
          return {
            run: (...params: unknown[]): SqliteRunResult => stmt.run(...params),
            get: (...params: unknown[]): TResult | undefined => stmt.get(...params) as TResult | undefined,
            all: (...params: unknown[]): TResult[] => stmt.all(...params) as TResult[],
            iterate: (...params: unknown[]): IterableIterator<TResult> => stmt.iterate(...params) as IterableIterator<TResult>,
          };
        },
        loadExtension: (extensionPath: string): void => nativeDb.loadExtension(extensionPath),
        transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
          return (...args: TArgs): TResult => {
            nativeDb.exec('BEGIN DEFERRED');
            try {
              const result = fn(...args);
              nativeDb.exec('COMMIT');
              return result;
            } catch (error) {
              try {
                nativeDb.exec('ROLLBACK');
              } catch {
              }
              throw error;
            }
          };
        },
        close: (): void => nativeDb.close(),
      };
    },
    createDrizzleDatabase: (database: SqliteDatabase): any => tagDrizzleDatabase(
      drizzleNodeSqlite(database.native as NodeSqliteDatabaseSync),
      'node-sqlite',
    ),
  };
}
