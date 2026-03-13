import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SqliteDatabase, SqliteOpenOptions, SqliteRunResult, SqliteRuntime, SqliteStatement } from '../types';
import { ensureParentDirectory, shouldEnsureParentDirectory, tagDrizzleDatabase } from '../shared';

interface NodeSqliteStatementSync {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  setReturnArrays(enabled: boolean): NodeSqliteStatementSync;
}

interface NodeSqliteDatabaseSync {
  exec(sql: string): unknown;
  prepare(sql: string): NodeSqliteStatementSync;
  enableLoadExtension(enabled: boolean): void;
  loadExtension(path: string): void;
  close(): void;
}

type TransactionBehavior = 'deferred' | 'immediate' | 'exclusive';

interface BetterSqlite3CompatibleStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  raw(): {
    get(...params: unknown[]): unknown[] | undefined;
    all(...params: unknown[]): unknown[][];
  };
}

interface BetterSqlite3CompatibleTransaction<TArgs extends unknown[], TResult> {
  (...args: TArgs): TResult;
  deferred: (...args: TArgs) => TResult;
  immediate: (...args: TArgs) => TResult;
  exclusive: (...args: TArgs) => TResult;
}

interface BetterSqlite3CompatibleDatabase {
  prepare(sql: string): BetterSqlite3CompatibleStatement;
  exec(sql: string): unknown;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): BetterSqlite3CompatibleTransaction<TArgs, TResult>;
}

class NodeSqliteStatementAdapter implements BetterSqlite3CompatibleStatement {
  public constructor(private readonly statement: NodeSqliteStatementSync) {}

  public run(...params: unknown[]): SqliteRunResult {
    return this.statement.run(...params);
  }

  public get(...params: unknown[]): unknown {
    return this.statement.get(...params);
  }

  public all(...params: unknown[]): unknown[] {
    return this.statement.all(...params);
  }

  public raw(): {
    get(...params: unknown[]): unknown[] | undefined;
    all(...params: unknown[]): unknown[][];
  } {
    return {
      get: (...params: unknown[]): unknown[] | undefined => {
        this.statement.setReturnArrays(true);
        try {
          return this.statement.get(...params) as unknown[] | undefined;
        } finally {
          this.statement.setReturnArrays(false);
        }
      },
      all: (...params: unknown[]): unknown[][] => {
        this.statement.setReturnArrays(true);
        try {
          return this.statement.all(...params) as unknown[][];
        } finally {
          this.statement.setReturnArrays(false);
        }
      },
    };
  }
}

class NodeSqliteDatabaseAdapter implements BetterSqlite3CompatibleDatabase {
  public constructor(private readonly database: NodeSqliteDatabaseSync) {}

  public prepare(sql: string): BetterSqlite3CompatibleStatement {
    return new NodeSqliteStatementAdapter(this.database.prepare(sql));
  }

  public exec(sql: string): unknown {
    return this.database.exec(sql);
  }

  public transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): BetterSqlite3CompatibleTransaction<TArgs, TResult> {
    const runWithBehavior = (behavior: TransactionBehavior) => (...args: TArgs): TResult => {
      const beginSql = behavior === 'deferred'
        ? 'BEGIN DEFERRED'
        : behavior === 'immediate'
          ? 'BEGIN IMMEDIATE'
          : 'BEGIN EXCLUSIVE';
      this.database.exec(beginSql);
      try {
        const result = fn(...args);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
        }
        throw error;
      }
    };

    const transaction = runWithBehavior('deferred') as BetterSqlite3CompatibleTransaction<TArgs, TResult>;
    transaction.deferred = runWithBehavior('deferred');
    transaction.immediate = runWithBehavior('immediate');
    transaction.exclusive = runWithBehavior('exclusive');
    return transaction;
  }
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
          const adapter = new NodeSqliteDatabaseAdapter(nativeDb);
          return adapter.transaction(fn);
        },
        close: (): void => nativeDb.close(),
      };
    },
    createDrizzleDatabase: (database: SqliteDatabase): any => tagDrizzleDatabase(
      drizzle(new NodeSqliteDatabaseAdapter(database.native as NodeSqliteDatabaseSync) as any),
      'node-sqlite',
    ),
  };
}
