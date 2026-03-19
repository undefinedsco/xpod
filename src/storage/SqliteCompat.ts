import { createRequire } from 'node:module';

const isBun = typeof (globalThis as any).Bun !== 'undefined';

export type SqliteDriverName =
  | 'auto'
  | 'node:sqlite'
  | 'bun:sqlite';

export interface SqliteOpenOptions {
  driver?: SqliteDriverName;
  readonly?: boolean;
  pragmas?: string[];
}

type NativeDatabase = any;
type NativeStatement = any;

interface SqliteAdapter {
  name: Exclude<SqliteDriverName, 'auto'>;
  openDatabase: (filePath: string, options: SqliteOpenOptions) => NativeDatabase;
  closeDatabase: (db: NativeDatabase) => void;
  prepare: (db: NativeDatabase, sql: string) => NativeStatement;
  exec: (db: NativeDatabase, sql: string) => void;
  pragma: (db: NativeDatabase, pragma: string) => unknown;
  loadExtension: (db: NativeDatabase, filePath: string) => void;
  run: (statement: NativeStatement, ...params: any[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (statement: NativeStatement, ...params: any[]) => unknown;
  all: (statement: NativeStatement, ...params: any[]) => unknown[];
  iterate: (statement: NativeStatement, ...params: any[]) => IterableIterator<unknown>;
}

function getRequire(): NodeRequire {
  if (typeof require === 'function') {
    return require;
  }

  return createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/package.json`);
}

function normalizePragma(pragma: string): string {
  return /^PRAGMA\b/i.test(pragma.trim()) ? pragma : `PRAGMA ${pragma}`;
}

function iterateFromAll(rows: unknown[]): IterableIterator<unknown> {
  return rows[Symbol.iterator]() as IterableIterator<unknown>;
}

function createNodeSqliteAdapter(): SqliteAdapter {
  const sqlite = getRequire()('node:sqlite') as {
    DatabaseSync: new(filePath: string, options?: { open?: boolean; readOnly?: boolean; allowExtension?: boolean }) => any;
  };

  return {
    name: 'node:sqlite',
    openDatabase: (filePath, options) => new sqlite.DatabaseSync(filePath, {
      open: true,
      readOnly: options.readonly ?? false,
      allowExtension: true,
    }),
    closeDatabase: (db) => db.close(),
    prepare: (db, sql) => db.prepare(sql),
    exec: (db, sql) => db.exec(sql),
    pragma: (db, pragma) => {
      const sql = normalizePragma(pragma);
      try {
        return db.prepare(sql).get();
      } catch {
        db.exec(sql);
        return undefined;
      }
    },
    loadExtension: (db, filePath) => {
      db.enableLoadExtension(true);
      try {
        db.loadExtension(filePath);
      } finally {
        db.enableLoadExtension(false);
      }
    },
    run: (statement, ...params) => statement.run(...params),
    get: (statement, ...params) => statement.get(...params),
    all: (statement, ...params) => statement.all(...params),
    iterate: (statement, ...params) => statement.iterate(...params),
  };
}

function createBunSqliteAdapter(): SqliteAdapter {
  const sqlite = getRequire()('bun:sqlite') as {
    Database: new(filePath: string) => any;
  };

  return {
    name: 'bun:sqlite',
    openDatabase: (filePath, _options) => new sqlite.Database(filePath),
    closeDatabase: (db) => db.close(),
    prepare: (db, sql) => {
      if (typeof db.prepare === 'function') {
        return db.prepare(sql);
      }
      return db.query(sql);
    },
    exec: (db, sql) => db.exec(sql),
    pragma: (db, pragma) => {
      const sql = normalizePragma(pragma);
      try {
        return db.query(sql).get();
      } catch {
        db.exec(sql);
        return undefined;
      }
    },
    loadExtension: (db, filePath) => db.loadExtension(filePath),
    run: (statement, ...params) => statement.run(...params),
    get: (statement, ...params) => statement.get(...params),
    all: (statement, ...params) => statement.all(...params),
    iterate: (statement, ...params) => {
      if (typeof statement.iterate === 'function') {
        return statement.iterate(...params);
      }
      return iterateFromAll(statement.all(...params));
    },
  };
}

let adapters = new Map<Exclude<SqliteDriverName, 'auto'>, SqliteAdapter>();

function resolveDriverName(options: SqliteOpenOptions = {}): Exclude<SqliteDriverName, 'auto'> {
  if (options.driver && options.driver !== 'auto') {
    return options.driver;
  }
  return isBun ? 'bun:sqlite' : 'node:sqlite';
}

function getAdapter(options: SqliteOpenOptions = {}): SqliteAdapter {
  const driverName = resolveDriverName(options);
  const existing = adapters.get(driverName);
  if (existing) {
    return existing;
  }

  let adapter: SqliteAdapter;
  switch (driverName) {
    case 'node:sqlite':
      adapter = createNodeSqliteAdapter();
      break;
    case 'bun:sqlite':
      adapter = createBunSqliteAdapter();
      break;
    default:
      throw new Error(`Unsupported SQLite driver: ${driverName}`);
  }

  adapters.set(driverName, adapter);
  return adapter;
}

export class SqliteStatement {
  public constructor(
    private readonly statement: NativeStatement,
    private readonly adapter: SqliteAdapter,
  ) {}

  public run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.adapter.run(this.statement, ...params);
  }

  public get<T = unknown>(...params: any[]): T {
    return this.adapter.get(this.statement, ...params) as T;
  }

  public all<T = unknown>(...params: any[]): T[] {
    return this.adapter.all(this.statement, ...params) as T[];
  }

  public iterate<T = unknown>(...params: any[]): IterableIterator<T> {
    return this.adapter.iterate(this.statement, ...params) as IterableIterator<T>;
  }
}

export class SqliteDatabase {
  private readonly adapter: SqliteAdapter;
  private readonly nativeDatabase: NativeDatabase;

  public constructor(filePath: string, options: SqliteOpenOptions = {}) {
    this.adapter = getAdapter(options);
    this.nativeDatabase = this.adapter.openDatabase(filePath, options);

    for (const pragma of options.pragmas ?? []) {
      this.pragma(pragma);
    }
  }

  public get driverName(): Exclude<SqliteDriverName, 'auto'> {
    return this.adapter.name;
  }

  public getInternalDb(): NativeDatabase {
    return this.nativeDatabase;
  }

  public prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.adapter.prepare(this.nativeDatabase, sql), this.adapter);
  }

  public exec(sql: string): void {
    this.adapter.exec(this.nativeDatabase, sql);
  }

  public pragma(pragma: string): unknown {
    return this.adapter.pragma(this.nativeDatabase, pragma);
  }

  public loadExtension(filePath: string): void {
    this.adapter.loadExtension(this.nativeDatabase, filePath);
  }

  public close(): void {
    this.adapter.closeDatabase(this.nativeDatabase);
  }

  public transaction<TArgs extends any[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      this.exec('BEGIN');
      try {
        const result = fn(...args);
        this.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.exec('ROLLBACK');
        } catch {
        }
        throw error;
      }
    };
  }
}

export function createSqliteDatabase(filePath: string, options: SqliteOpenOptions = {}): SqliteDatabase {
  return new SqliteDatabase(filePath, options);
}

export function createReadonlySqliteDatabase(filePath: string, options: Omit<SqliteOpenOptions, 'readonly'> = {}): SqliteDatabase {
  return new SqliteDatabase(filePath, { ...options, readonly: true });
}

export function resetSqliteAdaptersForTests(): void {
  adapters = new Map();
}

export { isBun };
