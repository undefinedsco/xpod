import type { SqliteDatabase, SqliteOpenOptions, SqliteRunResult, SqliteRuntime, SqliteStatement } from '../types';
import { ensureParentDirectory, shouldEnsureParentDirectory, tagDrizzleDatabase, wrapBetterSqliteError } from '../shared';

export function createBetterSqlite3Runtime(): SqliteRuntime {
  let BetterSqlite3: any;

  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch (error) {
    throw wrapBetterSqliteError(error);
  }

  const { drizzle } = require('drizzle-orm/better-sqlite3') as typeof import('drizzle-orm/better-sqlite3');

  return {
    kind: 'node-better-sqlite3',
    openDatabase: (path: string, options?: SqliteOpenOptions): SqliteDatabase => {
      try {
        if (shouldEnsureParentDirectory(path, options)) {
          ensureParentDirectory(path);
        }

        const nativeDb = options?.readonly ? new BetterSqlite3(path, { readonly: true }) : new BetterSqlite3(path);
        return {
          kind: 'node-better-sqlite3',
          native: nativeDb,
          exec: (sql: string): unknown => nativeDb.exec(sql),
          pragma: (pragma: string): unknown => nativeDb.pragma(pragma),
          prepare<TResult = unknown>(sql: string): SqliteStatement<TResult> {
            const stmt = nativeDb.prepare(sql);
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
              iterate: (...params: unknown[]): IterableIterator<TResult> => stmt.iterate(...params) as IterableIterator<TResult>,
            };
          },
          loadExtension: (extensionPath: string): void => nativeDb.loadExtension(extensionPath),
          transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
            return nativeDb.transaction(fn);
          },
          close: (): void => nativeDb.close(),
        };
      } catch (error) {
        throw wrapBetterSqliteError(error);
      }
    },
    createDrizzleDatabase: (database: SqliteDatabase): any => tagDrizzleDatabase(
      drizzle(database.native as any),
      'node-better-sqlite3',
    ),
  };
}
