import { Pool } from 'pg';
import { getSharedPool, releaseSharedPool } from '../database/PostgresPoolManager';
import { BaseKeyValueStorage, type BaseKeyValueStorageRow } from './BaseKeyValueStorage';

export interface PostgresKeyValueStorageOptions {
  connectionString: string;
  tableName?: string;
  namespace?: string;
  /** 
   * 共享的 pg Pool 实例（避免多个组件创建独立连接池导致死锁）
   * 如果提供，将忽略 connectionString
   */
  pool?: Pool;
}

export class PostgresKeyValueStorage<T = unknown> extends BaseKeyValueStorage<T> {
  private readonly pool: Pool;
  private readonly quotedTableName: string;
  private readonly sharedConnectionString?: string;

  public constructor(options: PostgresKeyValueStorageOptions) {
    super(options);

    if (options.pool) {
      this.pool = options.pool;
      this.sharedConnectionString = undefined;
    } else {
      this.sharedConnectionString = options.connectionString;
      this.pool = getSharedPool({ connectionString: options.connectionString });
    }

    const tableName = options.tableName ?? 'internal_kv';
    this.quotedTableName = formatIdentifier(tableName);
    this.setReady(this.ensureTable());
  }

  protected async closeStorage(): Promise<void> {
    if (!this.sharedConnectionString) {
      return;
    }
    releaseSharedPool({ connectionString: this.sharedConnectionString });
  }

  protected async hasValue(key: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.quotedTableName} WHERE key = $1) AS exists`,
      [ key ],
    );
    return result.rows[0]?.exists ?? false;
  }

  protected async selectValue(key: string): Promise<unknown | undefined> {
    const result = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM ${this.quotedTableName} WHERE key = $1 LIMIT 1`,
      [ key ],
    );
    if ((result.rowCount ?? 0) === 0) {
      return undefined;
    }
    return result.rows[0]?.value;
  }

  protected async upsertValue(key: string, payload: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.quotedTableName} (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [ key, payload ],
    );
  }

  protected async deleteValue(key: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.quotedTableName} WHERE key = $1`,
      [ key ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  protected async selectEntries(prefix: string): Promise<BaseKeyValueStorageRow[]> {
    const query = prefix.length > 0 ?
      `SELECT key, value FROM ${this.quotedTableName} WHERE key LIKE $1` :
      `SELECT key, value FROM ${this.quotedTableName}`;
    const values = prefix.length > 0 ? [ `${prefix}%` ] : [];
    const result = await this.pool.query<BaseKeyValueStorageRow>(query, values);
    return result.rows;
  }

  private async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.quotedTableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}

function formatIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_]+$/u.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Only alphanumeric and underscore are allowed.`);
  }
  return `"${name}"`;
}
