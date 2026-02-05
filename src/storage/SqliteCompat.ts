/**
 * SQLite Compatibility Layer
 *
 * Unifies better-sqlite3 and bun:sqlite APIs for cross-runtime support
 */

import type { SQL } from 'drizzle-orm/sql';

// Runtime detection
const isBun = typeof (globalThis as any).Bun !== 'undefined';

// Database instance type (unified)
export type SqliteDatabase = any;

// Statement type (unified)
export type SqliteStatement = any;

interface SqliteDeps {
  openDatabase: (path: string) => SqliteDatabase;
  closeDatabase: (db: SqliteDatabase) => void;
  prepare: (db: SqliteDatabase, sql: string) => SqliteStatement;
  exec: (db: SqliteDatabase, sql: string) => void;
  pragma: (db: SqliteDatabase, pragma: string) => any;
  loadExtension: (db: SqliteDatabase, path: string) => void;
  run: (stmt: SqliteStatement, ...params: any[]) => { changes: number; lastInsertRowid: number };
  get: (stmt: SqliteStatement, ...params: any[]) => any;
  all: (stmt: SqliteStatement, ...params: any[]) => any[];
  transaction: <T>(db: SqliteDatabase, fn: () => T) => T;
}

let deps: SqliteDeps | undefined;

async function loadDeps(): Promise<SqliteDeps> {
  if (deps) return deps;

  if (isBun) {
    // Bun runtime with custom SQLite (supports extensions)
    const { Database } = await import('bun:sqlite');

    deps = {
      openDatabase: (path: string) => new Database(path),
      closeDatabase: (db: SqliteDatabase) => db.close(),
      prepare: (db: SqliteDatabase, sql: string) => db.prepare(sql),
      exec: (db: SqliteDatabase, sql: string) => db.exec(sql),
      pragma: (db: SqliteDatabase, pragma: string) => db.query(`PRAGMA ${pragma}`).get(),
      loadExtension: (db: SqliteDatabase, path: string) => db.loadExtension(path),
      run: (stmt: SqliteStatement, ...params: any[]) => {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (stmt: SqliteStatement, ...params: any[]) => stmt.get(...params),
      all: (stmt: SqliteStatement, ...params: any[]) => stmt.all(...params),
      transaction: <T>(db: SqliteDatabase, fn: () => T) => db.transaction(fn)(),
    };
  } else {
    // Node runtime with better-sqlite3
    const BetterSQLite3 = await import('better-sqlite3');
    const Database = BetterSQLite3.default;

    deps = {
      openDatabase: (path: string) => new Database(path),
      closeDatabase: (db: SqliteDatabase) => db.close(),
      prepare: (db: SqliteDatabase, sql: string) => db.prepare(sql),
      exec: (db: SqliteDatabase, sql: string) => db.exec(sql),
      pragma: (db: SqliteDatabase, pragma: string) => db.pragma(pragma),
      loadExtension: (db: SqliteDatabase, path: string) => db.loadExtension(path),
      run: (stmt: SqliteStatement, ...params: any[]) => stmt.run(...params),
      get: (stmt: SqliteStatement, ...params: any[]) => stmt.get(...params),
      all: (stmt: SqliteStatement, ...params: any[]) => stmt.all(...params),
      transaction: <T>(db: SqliteDatabase, fn: () => T) => db.transaction(fn)(),
    };
  }

  return deps;
}

/**
 * Unified SQLite Database class
 */
export class UnifiedDatabase {
  private db: SqliteDatabase | null = null;
  private deps: SqliteDeps | null = null;
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  async open(): Promise<void> {
    this.deps = await loadDeps();
    this.db = this.deps.openDatabase(this.path);
  }

  /**
   * Get the internal native database instance
   * This is needed for Drizzle ORM which expects the native instance
   */
  getInternalDb(): SqliteDatabase {
    if (!this.db) throw new Error('Database not open');
    return this.db;
  }

  close(): void {
    if (this.db && this.deps) {
      this.deps.closeDatabase(this.db);
      this.db = null;
    }
  }

  prepare(sql: string): UnifiedStatement {
    if (!this.db || !this.deps) throw new Error('Database not open');
    const stmt = this.deps.prepare(this.db, sql);
    return new UnifiedStatement(stmt, this.deps);
  }

  exec(sql: string): void {
    if (!this.db || !this.deps) throw new Error('Database not open');
    this.deps.exec(this.db, sql);
  }

  pragma(pragma: string): any {
    if (!this.db || !this.deps) throw new Error('Database not open');
    return this.deps.pragma(this.db, pragma);
  }

  loadExtension(path: string): void {
    if (!this.db || !this.deps) throw new Error('Database not open');
    this.deps.loadExtension(this.db, path);
  }

  transaction<T>(fn: () => T): T {
    if (!this.db || !this.deps) throw new Error('Database not open');
    return this.deps.transaction(this.db, fn);
  }

  get isOpen(): boolean {
    return this.db !== null;
  }
}

/**
 * Unified Statement class
 */
export class UnifiedStatement {
  constructor(
    private stmt: SqliteStatement,
    private deps: SqliteDeps
  ) {}

  run(...params: any[]): { changes: number; lastInsertRowid: number } {
    return this.deps.run(this.stmt, ...params);
  }

  get(...params: any[]): any {
    return this.deps.get(this.stmt, ...params);
  }

  all(...params: any[]): any[] {
    return this.deps.all(this.stmt, ...params);
  }
}

// Re-export for convenience
export { isBun };
