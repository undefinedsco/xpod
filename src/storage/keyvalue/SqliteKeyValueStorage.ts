import { sql } from 'drizzle-orm';
import { executeQuery, executeStatement, executeStatementWithCount, getIdentityDatabase, type IdentityDatabase } from '../../identity/drizzle/db';
import { BaseKeyValueStorage, type BaseKeyValueStorageRow } from './BaseKeyValueStorage';

export interface SqliteKeyValueStorageOptions {
  /** Path to SQLite database file (can be prefixed with sqlite:) */
  path: string;
  tableName?: string;
  namespace?: string;
}

/** SQLite CSS internals share the identity connection, including its transaction boundary. */
export class SqliteKeyValueStorage<T = unknown> extends BaseKeyValueStorage<T> {
  private readonly db: IdentityDatabase;

  public constructor(options: SqliteKeyValueStorageOptions) {
    super(options);
    this.db = getIdentityDatabase(options.path.startsWith('sqlite:') ? options.path : `sqlite:${options.path}`);
    this.setReady(this.ensureDatabase());
  }

  protected async closeStorage(): Promise<void> {
    // The identity database registry owns this shared connection's lifecycle.
  }

  protected async hasValue(key: string): Promise<boolean> {
    return (await executeQuery(this.db, sql`SELECT 1 FROM ${sql.identifier(this.tableName)} WHERE key = ${key} LIMIT 1`)).rows.length > 0;
  }

  protected async selectValue(key: string): Promise<unknown | undefined> {
    return (await executeQuery(this.db, sql`SELECT value FROM ${sql.identifier(this.tableName)} WHERE key = ${key} LIMIT 1`)).rows[0]?.value;
  }

  protected async upsertValue(key: string, payload: string): Promise<void> {
    await executeStatement(this.db, sql`INSERT INTO ${sql.identifier(this.tableName)} (key, value, updated_at)
      VALUES (${key}, ${payload}, datetime('now'))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`);
  }

  protected async deleteValue(key: string): Promise<boolean> {
    return (await executeStatementWithCount(this.db, sql`DELETE FROM ${sql.identifier(this.tableName)} WHERE key = ${key}`) ?? 0) > 0;
  }

  protected async selectEntries(prefix: string): Promise<BaseKeyValueStorageRow[]> {
    return (await executeQuery<BaseKeyValueStorageRow>(this.db, sql`SELECT key, value FROM ${sql.identifier(this.tableName)}
      ${prefix.length ? sql`WHERE key LIKE ${`${prefix}%`}` : sql``}`)).rows;
  }

  private async ensureDatabase(): Promise<void> {
    await executeStatement(this.db, sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(this.tableName)} (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }
}
