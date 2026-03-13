export type SqliteRuntimeKind = 'node-better-sqlite3' | 'node-sqlite' | 'bun-sqlite';

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
