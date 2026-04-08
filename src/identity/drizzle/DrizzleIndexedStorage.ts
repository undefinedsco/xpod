import { getLoggerFor } from 'global-logger-factory';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import type {
  CreateTypeObject,
  IndexedQuery,
  IndexedStorage,
  IndexTypeCollection,
  StringKey,
  TypeObject,
  ValueTypeDescription,
} from '@solid/community-server';
import { 
  getIdentityDatabase, 
  IdentityDatabase, 
  executeQuery, 
  executeStatement,
  isDatabaseSqlite 
} from './db';

function serializePayload(value: Record<string, unknown>): string {
  return JSON.stringify(value ?? {});
}

function parsePayload<T>(value: unknown): T {
  if (value == null) {
    return {} as T;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return {} as T;
    }
  }
  return value as T;
}

/**
 * A generic Key-Value storage backed by a single SQL table.
 * Maps `type` (container) and `id` (key) to rows in the table.
 */
export class DrizzleIndexedStorage implements IndexedStorage<any> {
  private readonly logger = getLoggerFor(this);
  private readonly db: IdentityDatabase;
  private readonly tableName: string;
  private readonly definitions: Map<string, Record<string, ValueTypeDescription<string>>> = new Map();
  private readonly createdIndexes: Set<string> = new Set();
  private ready: boolean = false;

  public constructor(connectionString: string, tablePrefix = 'identity_') {
    this.db = getIdentityDatabase(connectionString);
    this.tableName = `${tablePrefix}store`;
  }

  private toJsonSql(payload: string): any {
    return isDatabaseSqlite(this.db) ? sql`${payload}` : sql`${payload}::jsonb`;
  }

  private async ensureTable(): Promise<void> {
    if (this.ready) return;
    
    const jsonType = isDatabaseSqlite(this.db) ? sql.raw('TEXT') : sql.raw('JSONB');
    const tableNameId = sql.identifier([this.tableName]);
    
    await executeStatement(this.db, sql`
      CREATE TABLE IF NOT EXISTS ${tableNameId} (
        container TEXT NOT NULL,
        id TEXT NOT NULL,
        payload ${jsonType} NOT NULL,
        PRIMARY KEY (container, id)
      )
    `);
    this.ready = true;
  }

  public async defineType(type: string, description: any): Promise<void> {
    this.definitions.set(type, description as Record<string, ValueTypeDescription<string>>);
    await this.ensureTable();
  }

  public async createIndex(type: string, key: string): Promise<void> {
    const started = Date.now();
    await this.ensureTable();
    if (key === 'id') {
      return;
    }

    const cacheKey = `${type}:${key}`;
    if (this.createdIndexes.has(cacheKey)) {
      return;
    }

    if (isDatabaseSqlite(this.db)) {
      const jsonPath = this.escapeSqlLiteral(this.toSqliteJsonPath(key));
      await executeStatement(this.db, sql.raw(
        `CREATE INDEX IF NOT EXISTS "${this.buildIndexName(type, key)}" ON "${this.tableName}" (container, json_extract(payload, '${jsonPath}'))`,
      ));
    } else {
      const escapedKey = this.escapeSqlLiteral(key);
      await executeStatement(this.db, sql.raw(
        `CREATE INDEX IF NOT EXISTS "${this.buildIndexName(type, key)}" ON "${this.tableName}" (container, (jsonb_extract_path_text(payload, '${escapedKey}')))` ,
      ));
    }

    this.createdIndexes.add(cacheKey);
    this.logDuration('createIndex', started, { type, key }, 50, 500);
  }

  public async create(type: string, value: any): Promise<any> {
    const started = Date.now();
    await this.ensureTable();
    const id = crypto.randomUUID();
    const payload = serializePayload(value as Record<string, unknown>);
    const tableNameId = sql.identifier([this.tableName]);

    await executeStatement(this.db, sql`
      INSERT INTO ${tableNameId} (container, id, payload)
      VALUES (${type}, ${id}, ${this.toJsonSql(payload)})
    `);
    this.logDuration('create', started, { type, fields: Object.keys(value ?? {}) }, 50, 500);
    return { id, ...(value as Record<string, unknown>) };
  }

  public async has(type: string, id: string): Promise<boolean> {
    const started = Date.now();
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const result = await executeQuery(this.db, sql`SELECT 1 FROM ${tableNameId} WHERE container = ${type} AND id = ${id} LIMIT 1`);
    this.logDuration('has', started, { type, id }, 50, 500);
    return result.rows.length > 0;
  }

  public async get(type: string, id: string): Promise<any | undefined> {
    const started = Date.now();
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const result = await executeQuery(this.db, sql`SELECT payload FROM ${tableNameId} WHERE container = ${type} AND id = ${id} LIMIT 1`);
    this.logDuration('get', started, { type, id }, 50, 500);
    if (result.rows.length === 0) {
      return undefined;
    }
    const payload = parsePayload<Record<string, unknown>>(result.rows[0].payload);
    return { id, ...payload };
  }

  public async find(type: string, query: any): Promise<any[]> {
    const started = Date.now();
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const normalizedQuery = (query ?? {}) as Record<string, unknown>;
    const pushdown = this.canPushDownQuery(normalizedQuery);
    const result = pushdown
      ? await executeQuery(this.db, sql`SELECT id, payload FROM ${tableNameId} WHERE ${this.buildWhereClause(type, normalizedQuery)}`)
      : await executeQuery(this.db, sql`SELECT id, payload FROM ${tableNameId} WHERE container = ${type}`);
    const matches: any[] = [];
    for (const row of result.rows) {
      const payload = {
        id: row.id as string,
        ...parsePayload<Record<string, unknown>>(row.payload),
      };
      if (this.matchesQuery(type, payload, normalizedQuery)) {
        matches.push(payload);
      }
    }
    this.logDuration('find', started, {
      type,
      keys: Object.keys(normalizedQuery),
      pushdown,
      matched: matches.length,
    }, 50, 500);
    return matches;
  }

  public async findIds(type: string, query: any): Promise<string[]> {
    const rows = await this.find(type, query);
    return rows.map((row) => row.id as string);
  }

  public async set(type: string, value: any): Promise<void> {
    const started = Date.now();
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const { id, ...rest } = value as Record<string, unknown>;
    const payload = serializePayload(rest);
    
    await executeStatement(this.db, sql`
      UPDATE ${tableNameId}
      SET payload = ${this.toJsonSql(payload)}
      WHERE container = ${type} AND id = ${id}
    `);
    this.logDuration('set', started, { type, id, fields: Object.keys(rest) }, 50, 500);
  }

  public async setField(type: string, id: string, key: string, value: any): Promise<void> {
    const current = await this.get(type, id);
    if (!current) {
      return;
    }
    const updated = { ...current, [key]: value };
    await this.set(type, updated);
  }

  public async delete(type: string, id: string): Promise<void> {
    const started = Date.now();
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    await executeStatement(this.db, sql`DELETE FROM ${tableNameId} WHERE container = ${type} AND id = ${id}`);
    this.logDuration('delete', started, { type, id }, 50, 500);
  }

  public async *entries(type: string): AsyncIterableIterator<any> {
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const result = await executeQuery(this.db, sql`SELECT id, payload FROM ${tableNameId} WHERE container = ${type}`);
    for (const row of result.rows) {
      yield {
        id: row.id as string,
        ...parsePayload<Record<string, unknown>>(row.payload),
      };
    }
  }

  private matchesQuery(type: string, payload: any, query: any): boolean {
    // Basic in-memory implementation of query matching
    // This mirrors MemoryIndexedStorage behavior for compatibility
    for (const key of Object.keys(query)) {
      if (payload[key] !== query[key]) {
        return false;
      }
    }
    return true;
  }

  private canPushDownQuery(query: Record<string, unknown>): boolean {
    return Object.values(query).every((value) => this.isSupportedQueryValue(value));
  }

  private isSupportedQueryValue(value: unknown): value is string | number | boolean {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }

  private buildWhereClause(type: string, query: Record<string, unknown>): any {
    const clauses = [sql`container = ${type}`];

    for (const [key, value] of Object.entries(query)) {
      if (key === 'id') {
        clauses.push(sql`id = ${String(value)}`);
        continue;
      }

      if (isDatabaseSqlite(this.db)) {
        const jsonPath = this.toSqliteJsonPath(key);
        const wrappedValue = JSON.stringify({ value });
        clauses.push(sql`json_extract(payload, ${jsonPath}) = json_extract(${wrappedValue}, '$.value')`);
        continue;
      }

      clauses.push(sql`jsonb_extract_path_text(payload, ${key}) = ${String(value)}`);
    }

    return sql.join(clauses, sql` AND `);
  }

  private buildIndexName(type: string, key: string): string {
    const rawName = `${this.tableName}_${type}_${key}_idx`;
    const normalized = rawName.replace(/[^a-zA-Z0-9_]/g, '_');
    if (normalized.length <= 63) {
      return normalized;
    }

    return `${normalized.slice(0, 54)}_${crypto.createHash('sha1').update(rawName).digest('hex').slice(0, 8)}`;
  }

  private toSqliteJsonPath(key: string): string {
    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `$."${escaped}"`;
  }

  private escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private logDuration(
    operation: string,
    started: number,
    details: Record<string, unknown>,
    slowThresholdMs = 100,
    warnThresholdMs = 1000,
  ): void {
    const elapsedMs = Date.now() - started;
    if (elapsedMs < slowThresholdMs) {
      return;
    }

    const detailText = Object.entries(details)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
      .join(' ');
    const message = `[timing] DrizzleIndexedStorage.${operation} ${detailText} took=${elapsedMs}ms`;

    if (elapsedMs >= warnThresholdMs) {
      this.logger.warn(message);
      return;
    }

    this.logger.info(message);
  }
}
