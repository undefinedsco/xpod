import { getSqliteRuntime, type SqliteDatabase } from '../SqliteRuntime';
import { BaseKeyValueStorage, type BaseKeyValueStorageRow } from './BaseKeyValueStorage';

export interface SqliteKeyValueStorageOptions {
  /** Path to SQLite database file (can be prefixed with sqlite:) */
  path: string;
  tableName?: string;
  namespace?: string;
}

function parseSqlitePath(path: string): string {
  if (path.startsWith('sqlite:')) {
    return path.slice(7);
  }
  return path;
}

/**
 * SQLite-backed KeyValueStorage for local deployments.
 * Stores internal CSS data (OIDC tokens, migration status, etc.) in SQLite.
 */
export class SqliteKeyValueStorage<T = unknown> extends BaseKeyValueStorage<T> {
  private db: SqliteDatabase | null = null;
  private readonly path: string;
  private readonly sqliteRuntime = getSqliteRuntime();

  public constructor(options: SqliteKeyValueStorageOptions) {
    super(options);
    this.path = parseSqlitePath(options.path);
    this.setReady(this.ensureDatabase());
  }

  protected async closeStorage(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  protected async hasValue(key: string): Promise<boolean> {
    const stmt = this.getDb().prepare(
      `SELECT 1 FROM ${this.tableName} WHERE key = ? LIMIT 1`,
    );
    return stmt.get(key) !== undefined;
  }

  protected async selectValue(key: string): Promise<unknown | undefined> {
    const stmt = this.getDb().prepare(
      `SELECT value FROM ${this.tableName} WHERE key = ? LIMIT 1`,
    );
    const result = stmt.get(key) as { value: unknown } | undefined;
    return result?.value;
  }

  protected async upsertValue(key: string, payload: string): Promise<void> {
    const stmt = this.getDb().prepare(`
      INSERT INTO ${this.tableName} (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    stmt.run(key, payload);
  }

  protected async deleteValue(key: string): Promise<boolean> {
    const stmt = this.getDb().prepare(
      `DELETE FROM ${this.tableName} WHERE key = ?`,
    );
    const result = stmt.run(key);
    return result.changes > 0;
  }

  protected async selectEntries(prefix: string): Promise<BaseKeyValueStorageRow[]> {
    const query = prefix.length > 0
      ? `SELECT key, value FROM ${this.tableName} WHERE key LIKE ?`
      : `SELECT key, value FROM ${this.tableName}`;

    const stmt = this.getDb().prepare(query);
    const rows = prefix.length > 0
      ? stmt.all(`${prefix}%`) as BaseKeyValueStorageRow[]
      : stmt.all() as BaseKeyValueStorageRow[];
    return rows;
  }

  private async ensureDatabase(): Promise<void> {
    if (this.db) return;
    this.db = this.createDatabase();
  }

  private getDb(): SqliteDatabase {
    if (!this.db) {
      this.db = this.createDatabase();
    }
    return this.db;
  }

  private createDatabase(): SqliteDatabase {
    const db = this.sqliteRuntime.openDatabase(this.path);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.logger.info(`SqliteKeyValueStorage initialized: ${this.path}`);
    return db;
  }
}
