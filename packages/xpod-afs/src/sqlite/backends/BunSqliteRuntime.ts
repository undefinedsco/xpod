import type { SqliteDatabase, SqliteOpenOptions, SqliteRunResult, SqliteRuntime, SqliteStatement } from '../types';
import { ensureParentDirectory, shouldEnsureParentDirectory, tagDrizzleDatabase } from '../shared';

export function createBunSqliteRuntime(): SqliteRuntime {
  const { Database } = require('bun:sqlite') as { Database: any };
  const { drizzle } = require('drizzle-orm/bun-sqlite') as { drizzle: (database: any) => any };

  return {
    kind: 'bun-sqlite',
    openDatabase: (path: string, options?: SqliteOpenOptions): SqliteDatabase => {
      if (shouldEnsureParentDirectory(path, options)) {
        ensureParentDirectory(path);
      }

      const BunDatabase = Database as any;
      const nativeDb = options?.readonly ? new BunDatabase(path, { readonly: true }) : new BunDatabase(path);

      return {
        kind: 'bun-sqlite',
        native: nativeDb,
        exec: (sql: string): unknown => nativeDb.exec(sql),
        pragma: (pragma: string): unknown => nativeDb.query(`PRAGMA ${pragma}`).get(),
        prepare<TResult = unknown>(sql: string): SqliteStatement<TResult> {
          const stmt = nativeDb.query(sql);
          return {
            run: (...params: unknown[]): SqliteRunResult => {
              const result = stmt.run(...params);
              return {
                changes: Number(result?.changes ?? 0),
                lastInsertRowid: result?.lastInsertRowid ?? 0,
              };
            },
            get: (...params: unknown[]): TResult | undefined => stmt.get(...params) as TResult | undefined,
            all: (...params: unknown[]): TResult[] => stmt.all(...params) as TResult[],
            *iterate(...params: unknown[]): IterableIterator<TResult> {
              for (const row of stmt.all(...params) as TResult[]) {
                yield row;
              }
            },
          };
        },
        loadExtension: (extensionPath: string): void => nativeDb.loadExtension(extensionPath),
        transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
          return nativeDb.transaction(fn);
        },
        close: (): void => nativeDb.close(),
      };
    },
    createDrizzleDatabase: (database: SqliteDatabase): any => tagDrizzleDatabase(
      drizzle(database.native as any),
      'bun-sqlite',
    ),
  };
}
