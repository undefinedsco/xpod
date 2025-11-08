import { Pool } from 'pg';
import type {
  Finalizable,
  Initializable,
  KeyValueStorage,
} from '@solid/community-server';
import { getLoggerFor } from '@solid/community-server';

export interface PostgresKeyValueStorageOptions {
  connectionString: string;
  tableName?: string;
  namespace?: string;
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z0-9_]+$/u.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Only alphanumeric and underscore are allowed.`);
  }
}

export class PostgresKeyValueStorage<T = unknown> implements
  KeyValueStorage<string, T>,
  Initializable,
  Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly quotedTableName: string;
  private readonly namespace: string;
  private readonly ready: Promise<void>;

  public constructor(options: PostgresKeyValueStorageOptions) {
    this.pool = new Pool({ connectionString: options.connectionString });
    this.tableName = options.tableName ?? 'internal_kv';
    this.namespace = options.namespace ?? '';
    assertIdentifier(this.tableName);
    this.quotedTableName = this.formatIdentifier(this.tableName);
    this.ready = this.ensureTable();
  }

  public async initialize(): Promise<void> {
    await this.ready;
  }

  public async finalize(): Promise<void> {
    await this.pool.end().catch((error: unknown) => {
      this.logger.warn(`Failed to close Postgres pool: ${error}`);
    });
  }


  public async has(key: string): Promise<boolean> {
    await this.ready;
    const storageKey = this.toStorageKey(key);
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.quotedTableName} WHERE key = $1) AS exists`,
      [ storageKey ],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async get(key: string): Promise<T | undefined> {
    await this.ready;
    const storageKey = this.toStorageKey(key);
    const result = await this.pool.query<{ value: any }>(
      `SELECT value FROM ${this.quotedTableName} WHERE key = $1 LIMIT 1`,
      [ storageKey ],
    );
    if ((result.rowCount ?? 0) === 0) {
      return undefined;
    }
    // JSONB column returns object, TEXT column returns string
    return this.parseValue(result.rows[0].value);
  }

  public async set(key: string, value: T): Promise<this> {
    await this.ready;
    const storageKey = this.toStorageKey(key);
    
    let payload: string;
    try {
      payload = this.validateAndSerialize(value, key);
    } catch (error: unknown) {
      this.logger.error(`Failed to serialize value for key "${key}": ${error}`);
      throw error;
    }
    
    await this.pool.query(
      `INSERT INTO ${this.quotedTableName} (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [ storageKey, payload ],
    );
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    await this.ready;
    const storageKey = this.toStorageKey(key);
    const result = await this.pool.query(
      `DELETE FROM ${this.quotedTableName} WHERE key = $1`,
      [ storageKey ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async *entries(): AsyncIterableIterator<[ string, T ]> {
    await this.ready;
    const prefix = this.namespace;
    const query = prefix.length > 0 ?
      `SELECT key, value FROM ${this.quotedTableName} WHERE key LIKE $1` :
      `SELECT key, value FROM ${this.quotedTableName}`;
    const values = prefix.length > 0 ? [ `${prefix}%` ] : [];
    const result = await this.pool.query<{ key: string; value: any }>(query, values);
    for (const row of result.rows) {
      if (!row.key.startsWith(prefix)) {
        continue;
      }
      const logicalKey = row.key.slice(prefix.length);
      const value = this.parseValue(row.value);
      if (typeof value === 'undefined') {
        continue;
      }
      yield [ logicalKey, value ];
    }
  }

  protected async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.quotedTableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  protected toStorageKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  protected formatIdentifier(name: string): string {
    return `"${name}"`;
  }

  protected validateAndSerialize(value: T, key: string): string {
    try {
      const payload = JSON.stringify(value ?? null);
      
      // Basic validation
      if (payload === 'undefined') {
        throw new Error(`Cannot serialize undefined value`);
      }
      
      // Validate JSON can be parsed back
      JSON.parse(payload);
      
      return payload;
    } catch (error: unknown) {
      this.logger.error(`JSON serialization failed for key "${key}": ${error}`);
      throw new Error(`JSON serialization failed for key "${key}": ${error}`);
    }
  }

  protected parseValue(raw: any): T | undefined {
    try {
      // JSONB column returns object, TEXT column returns string
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      
      // Handle CSS internal storage format: {"key": "...", "payload": ...}
      if (parsed && typeof parsed === 'object' && 'key' in parsed && 'payload' in parsed) {
        return parsed.payload as T;
      }
      
      return parsed as T;
    } catch (error: unknown) {
      this.logger.error(`Failed to parse stored value: ${error}. Raw value: ${JSON.stringify(raw)}`);
      return undefined;
    }
  }

}
