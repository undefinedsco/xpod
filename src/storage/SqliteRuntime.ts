import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteRuntimeKind = 'node-better-sqlite3' | 'bun-sqlite';

export interface SqliteOpenOptions {
  readonly?: boolean;
}

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement<TResult = unknown> {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): TResult | undefined;
  all(...params: unknown[]): TResult[];
  iterate(...params: unknown[]): IterableIterator<TResult>;
}

export interface SqliteDatabase {
  readonly kind: SqliteRuntimeKind;
  readonly native: unknown;
  exec(sql: string): unknown;
  pragma(pragma: string): unknown;
  prepare<TResult = unknown>(sql: string): SqliteStatement<TResult>;
  loadExtension(path: string): void;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
  close(): void;
}

export interface SqliteRuntime {
  readonly kind: SqliteRuntimeKind;
  openDatabase(path: string, options?: SqliteOpenOptions): SqliteDatabase;
  createDrizzleDatabase(database: SqliteDatabase): any;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}

function wrapBetterSqliteError(error: unknown): Error {
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

function shouldEnsureParentDirectory(path: string, options?: SqliteOpenOptions): boolean {
  return !options?.readonly && path !== ':memory:' && !path.startsWith(':memory:');
}

function ensureParentDirectory(path: string): void {
  const directory = dirname(path);
  if (directory && directory !== '.' && !existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

function createBunSqliteRuntime(): SqliteRuntime {
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
    createDrizzleDatabase: (database: SqliteDatabase): any => {
      const db = drizzle(database.native as any);
      Object.defineProperty(db, '$xpodSqliteRuntime', {
        value: 'bun-sqlite',
        enumerable: false,
        configurable: true,
      });
      return db;
    },
  };
}

function createNodeSqliteRuntime(): SqliteRuntime {
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
    createDrizzleDatabase: (database: SqliteDatabase): any => {
      const db = drizzle(database.native as any);
      Object.defineProperty(db, '$xpodSqliteRuntime', {
        value: 'node-better-sqlite3',
        enumerable: false,
        configurable: true,
      });
      return db;
    },
  };
}

let runtime: SqliteRuntime | undefined;

export function getSqliteRuntime(): SqliteRuntime {
  if (runtime) {
    return runtime;
  }

  runtime = isBunRuntime() ? createBunSqliteRuntime() : createNodeSqliteRuntime();
  return runtime;
}
