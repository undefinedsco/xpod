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
  private readonly db: IdentityDatabase;
  private readonly tableName: string;
  private readonly definitions: Map<string, Record<string, ValueTypeDescription<string>>> = new Map();
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

  public async createIndex(): Promise<void> {
    // Indexes are not required for the current usage.
  }

  public async create(type: string, value: any): Promise<any> {
    await this.ensureTable();
    const id = crypto.randomUUID();
    const payload = serializePayload(value as Record<string, unknown>);
    const tableNameId = sql.identifier([this.tableName]);

    await executeStatement(this.db, sql`
      INSERT INTO ${tableNameId} (container, id, payload)
      VALUES (${type}, ${id}, ${this.toJsonSql(payload)})
    `);
    return { id, ...(value as Record<string, unknown>) };
  }

  public async has(type: string, id: string): Promise<boolean> {
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const result = await executeQuery(this.db, sql`SELECT 1 FROM ${tableNameId} WHERE container = ${type} AND id = ${id} LIMIT 1`);
    return result.rows.length > 0;
  }

  public async get(type: string, id: string): Promise<any | undefined> {
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const result = await executeQuery(this.db, sql`SELECT payload FROM ${tableNameId} WHERE container = ${type} AND id = ${id} LIMIT 1`);
    if (result.rows.length === 0) {
      return undefined;
    }
    const payload = parsePayload<Record<string, unknown>>(result.rows[0].payload);
    return { id, ...payload };
  }

  public async find(type: string, query: any): Promise<any[]> {
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    // Note: This fetches all rows for the container and filters in memory. 
    // For high volume types, this should be optimized with JSON path queries if possible.
    const result = await executeQuery(this.db, sql`SELECT id, payload FROM ${tableNameId} WHERE container = ${type}`);
    const matches: any[] = [];
    for (const row of result.rows) {
      const payload = {
        id: row.id as string,
        ...parsePayload<Record<string, unknown>>(row.payload),
      };
      if (this.matchesQuery(type, payload, query as Record<string, unknown>)) {
        matches.push(payload);
      }
    }
    return matches;
  }

  public async findIds(type: string, query: any): Promise<string[]> {
    const rows = await this.find(type, query);
    return rows.map((row) => row.id as string);
  }

  public async set(type: string, value: any): Promise<void> {
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    const { id, ...rest } = value as Record<string, unknown>;
    const payload = serializePayload(rest);
    
    await executeStatement(this.db, sql`
      UPDATE ${tableNameId}
      SET payload = ${this.toJsonSql(payload)}
      WHERE container = ${type} AND id = ${id}
    `);
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
    await this.ensureTable();
    const tableNameId = sql.identifier([this.tableName]);
    await executeStatement(this.db, sql`DELETE FROM ${tableNameId} WHERE container = ${type} AND id = ${id}`);
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
}
