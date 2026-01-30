import Database from 'better-sqlite3';
import type {
  Finalizable,
  Initializable,
  KeyValueStorage,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';

export interface SqliteKeyValueStorageOptions {
  /** Path to SQLite database file (can be prefixed with sqlite:) */
  path: string;
  tableName?: string;
  namespace?: string;
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z0-9_]+$/u.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Only alphanumeric and underscore are allowed.`);
  }
}

function parseSqlitePath(path: string): string {
  // Handle sqlite: prefix (e.g., "sqlite:./data/identity.sqlite")
  if (path.startsWith('sqlite:')) {
    return path.slice(7);
  }
  return path;
}

/**
 * SQLite-backed KeyValueStorage for local deployments.
 * Stores internal CSS data (OIDC tokens, migration status, etc.) in SQLite.
 */
export class SqliteKeyValueStorage<T = unknown> implements
  KeyValueStorage<string, T>,
  Initializable,
  Finalizable {
  protected readonly logger = getLoggerFor(this);
  private db: Database.Database | null = null;
  private readonly path: string;
  private readonly tableName: string;
  private readonly namespace: string;

  public constructor(options: SqliteKeyValueStorageOptions) {
    this.path = parseSqlitePath(options.path);
    this.tableName = options.tableName ?? 'internal_kv';
    this.namespace = options.namespace ?? '';
    assertIdentifier(this.tableName);
  }

  public async initialize(): Promise<void> {
    if (this.db) return;

    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.logger.info(`SqliteKeyValueStorage initialized: ${this.path}`);
  }

  public async finalize(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) {
      // Lazy initialization
      this.db = new Database(this.path);
      this.db.pragma('journal_mode = WAL');

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      this.logger.info(`SqliteKeyValueStorage initialized: ${this.path}`);
    }
    return this.db;
  }

  public async has(key: string): Promise<boolean> {
    const storageKey = this.toStorageKey(key);
    const stmt = this.getDb().prepare(
      `SELECT 1 FROM ${this.tableName} WHERE key = ? LIMIT 1`
    );
    const result = stmt.get(storageKey);
    return result !== undefined;
  }

  public async get(key: string): Promise<T | undefined> {
    const storageKey = this.toStorageKey(key);
    const stmt = this.getDb().prepare(
      `SELECT value FROM ${this.tableName} WHERE key = ? LIMIT 1`
    );
    const result = stmt.get(storageKey) as { value: string } | undefined;
    if (!result) {
      return undefined;
    }
    return this.parseValue(result.value);
  }

  public async set(key: string, value: T): Promise<this> {
    const storageKey = this.toStorageKey(key);

    let payload: string;
    try {
      payload = this.validateAndSerialize(value, key);
    } catch (error: unknown) {
      this.logger.error(`Failed to serialize value for key "${key}": ${error}`);
      throw error;
    }

    const stmt = this.getDb().prepare(`
      INSERT INTO ${this.tableName} (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    stmt.run(storageKey, payload);
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    const storageKey = this.toStorageKey(key);
    const stmt = this.getDb().prepare(
      `DELETE FROM ${this.tableName} WHERE key = ?`
    );
    const result = stmt.run(storageKey);
    return result.changes > 0;
  }

  public async *entries(): AsyncIterableIterator<[string, T]> {
    const prefix = this.namespace;
    const query = prefix.length > 0
      ? `SELECT key, value FROM ${this.tableName} WHERE key LIKE ?`
      : `SELECT key, value FROM ${this.tableName}`;

    const stmt = this.getDb().prepare(query);
    const rows = prefix.length > 0
      ? stmt.all(`${prefix}%`) as { key: string; value: string }[]
      : stmt.all() as { key: string; value: string }[];

    for (const row of rows) {
      if (!row.key.startsWith(prefix)) {
        continue;
      }
      const logicalKey = row.key.slice(prefix.length);
      const value = this.parseValue(row.value);
      if (typeof value === 'undefined') {
        continue;
      }
      yield [logicalKey, value];
    }
  }

  protected toStorageKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  protected validateAndSerialize(value: T, key: string): string {
    try {
      const payload = JSON.stringify(value ?? null);

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

  protected parseValue(raw: string): T | undefined {
    try {
      const parsed = JSON.parse(raw);

      // Handle CSS internal storage format: {"key": "...", "payload": ...}
      if (parsed && typeof parsed === 'object' && 'key' in parsed && 'payload' in parsed) {
        return parsed.payload as T;
      }

      return parsed as T;
    } catch (error: unknown) {
      this.logger.error(`Failed to parse stored value: ${error}. Raw value: ${raw}`);
      return undefined;
    }
  }
}
