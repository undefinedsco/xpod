import { Pool, types } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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

type DrizzleDatabase = ReturnType<typeof drizzle>;

const poolCache = new Map<string, { pool: Pool; db: DrizzleDatabase }>();
const JSON_OIDS = [ 114, 3802 ];

for (const oid of JSON_OIDS) {
  types.setTypeParser(oid, (value) => (value == null ? null : JSON.parse(value)));
}

function getDatabase(connectionString: string): DrizzleDatabase {
  let cached = poolCache.get(connectionString);
  if (!cached) {
    const pool = new Pool({ connectionString });
    const db = drizzle(pool);
    cached = { pool, db };
    poolCache.set(connectionString, cached);
  }
  return cached.db;
}

function tableName(prefix: string, type: string): string {
  return `${prefix}${type}`;
}

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

export class DrizzleIndexedStorage<T extends IndexTypeCollection<T>> implements IndexedStorage<T> {
  private readonly db: DrizzleDatabase;
  private readonly tablePrefix: string;
  private readonly definitions: Map<string, Record<string, ValueTypeDescription<string>>> = new Map();

  public constructor(connectionString: string, tablePrefix = 'identity_') {
    this.db = getDatabase(connectionString);
    this.tablePrefix = tablePrefix;
  }

  public async defineType<TType extends StringKey<T>>(type: TType, description: T[TType]): Promise<void> {
    this.definitions.set(type, description as Record<string, ValueTypeDescription<string>>);
    const name = tableName(this.tablePrefix, type);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.identifier([name])} (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL
      )
    `);
  }

  public async createIndex<TType extends StringKey<T>>(): Promise<void> {
    // Indexes are not required for the current usage.
  }

  public async create<TType extends StringKey<T>>(type: TType, value: CreateTypeObject<T[TType]>): Promise<TypeObject<T[TType]>> {
    const name = tableName(this.tablePrefix, type);
    const id = crypto.randomUUID();
    await this.db.execute(sql`
      INSERT INTO ${sql.identifier([name])} (id, payload)
      VALUES (${id}, ${serializePayload(value as Record<string, unknown>)}::jsonb)
    `);
    return { id, ...(value as Record<string, unknown>) } as TypeObject<T[TType]>;
  }

  public async has<TType extends StringKey<T>>(type: TType, id: string): Promise<boolean> {
    const name = tableName(this.tablePrefix, type);
    const result = await this.db.execute(sql`SELECT 1 FROM ${sql.identifier([name])} WHERE id = ${id} LIMIT 1`);
    return result.rows.length > 0;
  }

  public async get<TType extends StringKey<T>>(type: TType, id: string): Promise<TypeObject<T[TType]> | undefined> {
    const name = tableName(this.tablePrefix, type);
    const result = await this.db.execute(sql`SELECT payload FROM ${sql.identifier([name])} WHERE id = ${id} LIMIT 1`);
    if (result.rows.length === 0) {
      return undefined;
    }
    const payload = parsePayload<Record<string, unknown>>(result.rows[0].payload);
    return { id, ...payload } as TypeObject<T[TType]>;
  }

  public async find<TType extends StringKey<T>>(type: TType, query: IndexedQuery<T, TType>): Promise<TypeObject<T[TType]>[]> {
    const name = tableName(this.tablePrefix, type);
    const result = await this.db.execute(sql`SELECT id, payload FROM ${sql.identifier([name])}`);
    const matches: TypeObject<T[TType]>[] = [];
    for (const row of result.rows) {
      const payload = {
        id: row.id as string,
        ...parsePayload<Record<string, unknown>>(row.payload),
      };
      if (this.matchesQuery(type, payload, query as Record<string, unknown>)) {
        matches.push(payload as TypeObject<T[TType]>);
      }
    }
    return matches;
  }

  public async findIds<TType extends StringKey<T>>(type: TType, query: IndexedQuery<T, TType>): Promise<string[]> {
    const rows = await this.find(type, query);
    return rows.map((row) => row.id as string);
  }

  public async set<TType extends StringKey<T>>(type: TType, value: TypeObject<T[TType]>): Promise<void> {
    const name = tableName(this.tablePrefix, type);
    const { id, ...rest } = value as Record<string, unknown>;
    await this.db.execute(sql`
      UPDATE ${sql.identifier([name])}
      SET payload = ${serializePayload(rest)}::jsonb
      WHERE id = ${id}
    `);
  }

  public async setField<TType extends StringKey<T>, TKey extends StringKey<T[TType]>>(type: TType, id: string, key: TKey, value: any): Promise<void> {
    const current = await this.get(type, id);
    if (!current) {
      return;
    }
    const updated = { ...current, [key]: value } as TypeObject<T[TType]>;
    await this.set(type, updated);
  }

  public async delete<TType extends StringKey<T>>(type: TType, id: string): Promise<void> {
    const name = tableName(this.tablePrefix, type);
    await this.db.execute(sql`DELETE FROM ${sql.identifier([name])} WHERE id = ${id}`);
  }

  public async *entries<TType extends StringKey<T>>(type: TType): AsyncIterableIterator<TypeObject<T[TType]>> {
    const name = tableName(this.tablePrefix, type);
    const result = await this.db.execute(sql`SELECT id, payload FROM ${sql.identifier([name])}`);
    for (const row of result.rows) {
      yield {
        id: row.id as string,
        ...parsePayload<Record<string, unknown>>(row.payload),
      } as TypeObject<T[TType]>;
    }
  }

  private matchesQuery(type: string, value: Record<string, unknown>, query: Record<string, unknown>): boolean {
    for (const [ key, expected ] of Object.entries(query)) {
      if (expected === undefined) {
        continue;
      }
      const actual = value[key];
      if (Array.isArray(expected)) {
        if (!expected.includes(actual as never)) {
          return false;
        }
      } else if (expected && typeof expected === 'object' && expected !== null) {
        return false;
      } else if (actual !== expected) {
        return false;
      }
    }
    return true;
  }
}
