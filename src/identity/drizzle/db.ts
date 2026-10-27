import { Pool, types } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql';
import * as pgSchema from './schema.pg';
import * as sqliteSchema from './schema.sqlite';
import { getSharedPool, releaseSharedPool } from '../../storage/database/PostgresPoolManager';
import { getSqliteRuntime, type SqliteDatabase } from '../../storage/SqliteRuntime';

// Use 'any' to allow both PostgreSQL and SQLite database instances
// The actual type depends on the connection string at runtime
export type IdentityDatabase = any;
export type IdentitySchema = typeof pgSchema | typeof sqliteSchema;

/**
 * Get the appropriate schema for the given database connection.
 * This provides a unified abstraction layer over PG and SQLite schemas.
 *
 * @example
 * const schema = getSchema(db);
 * await executeIdentityOperation(db, async client =>
 *   client.select().from(schema.usage).where(eq(schema.usage.scopeId, id)));
 */
export function getSchema(db: IdentityDatabase): typeof pgSchema | typeof sqliteSchema {
  return isDatabaseSqlite(db) ? sqliteSchema : pgSchema;
}

/**
 * Standardized query result format across databases.
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
}

interface CachedConnection {
  db: IdentityDatabase;
  schema: IdentitySchema;
  isSqlite: boolean;
  close: () => Promise<void>;
}

const dbCache = new Map<string, CachedConnection>();
const dbInitPromises = new WeakMap<object, Promise<void>>();
const dbPostgresPools = new WeakMap<object, Pool>();
const cloudClusterInitPromises = new WeakMap<object, Promise<void>>();
interface IdentityTransaction { executor: IdentityDatabase; active: boolean }
const transactionContext = new AsyncLocalStorage<Map<object, IdentityTransaction>>();
const sqliteTransactions = new WeakMap<object, Promise<unknown>>();
function serializeSqlite<T>(db: IdentityDatabase, action: () => T | Promise<T>): Promise<T> {
  const previous = sqliteTransactions.get(db) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(action);
  sqliteTransactions.set(db, pending);
  return pending;
}
function currentTransaction(db: IdentityDatabase): IdentityTransaction | undefined {
  const transaction = transactionContext.getStore()?.get(db);
  return transaction?.active ? transaction : undefined;
}

/** Execute ORM operations through the same isolation boundary as raw SQL helpers. */
export async function executeIdentityOperation<T>(
  db: IdentityDatabase,
  action: (executor: IdentityDatabase) => T | PromiseLike<T>,
): Promise<T> {
  await ensureDatabaseReady(db);
  const transaction = currentTransaction(db);
  if (transaction) return action(transaction.executor);
  return isDatabaseSqlite(db) ? serializeSqlite(db, () => Promise.resolve(action(db))) : action(db);
}

/** Use executeIdentityOperation / SQL helpers for all work in this transaction. */
export async function withIdentityTransaction<T>(
  db: IdentityDatabase,
  action: (executor: IdentityDatabase) => Promise<T>,
): Promise<T> {
  const existing = currentTransaction(db);
  if (existing) return action(existing.executor);
  await ensureDatabaseReady(db);
  const run = async () => {
    const client = isDatabaseSqlite(db) ? undefined : await dbPostgresPools.get(db)?.connect();
    if (!isDatabaseSqlite(db) && !client) throw new Error('Identity transaction requires a registered PostgreSQL pool');
    const executor = client ? drizzlePg(client) : db;
    const transaction = { executor, active: true };
    const context = new Map(transactionContext.getStore());
    context.set(db, transaction);
    let began = false;
    try {
      if (client) await client.query('BEGIN');
      else db.run(sql`BEGIN IMMEDIATE`);
      began = true;
      const result = await transactionContext.run(context, () => action(executor));
      if (client) await client.query('COMMIT');
      else db.run(sql`COMMIT`);
      return result;
    } catch (error) {
      if (began) {
        if (client) await client.query('ROLLBACK').catch(() => undefined);
        else db.run(sql`ROLLBACK`);
      }
      throw error;
    } finally { transaction.active = false; client?.release(); }
  };
  if (!isDatabaseSqlite(db)) return run();
  return serializeSqlite(db, run);
}

/** Transaction-scoped cross-worker lock; SQLite's immediate transaction serializes writers. */
export async function lockIdentityAccount(db: IdentityDatabase, key: string): Promise<void> {
  if (!currentTransaction(db)) throw new Error('Identity lock requires a transaction');
  if (!isDatabaseSqlite(db)) await executeQuery(db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

const JSON_OIDS = [114, 3802];
const POSTGRES_INITIALIZATION_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

type SqliteDdlExecutor = Pick<SqliteDatabase, 'exec'>;

for (const oid of JSON_OIDS) {
  // Explicitly return raw string to avoid "Type Conflict" with CSS
  // and to satisfy PgQuintStore's parseVector expecting a string.
  types.setTypeParser(oid, (value) => value);
}

/**
 * Returns true if the connection string is a SQLite URL.
 */
export function isSqliteUrl(connectionString: string): boolean {
  return connectionString.startsWith('sqlite:');
}

/**
 * Get or create a Drizzle database connection with the appropriate schema.
 * Supports both PostgreSQL and SQLite.
 */
export function getIdentityDatabase(connectionString: string): IdentityDatabase {
  const cached = dbCache.get(connectionString);
  if (cached) {
    return cached.db;
  }

  if (isSqliteUrl(connectionString)) {
    const filename = connectionString.replace('sqlite:', '');
    const isMemory = filename === ':memory:' || filename.startsWith(':memory:');
    const sqliteRuntime = getSqliteRuntime();
    const sqlite = sqliteRuntime.openDatabase(isMemory ? ':memory:' : filename);

    if (!isMemory) {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.pragma('synchronous = NORMAL');
    }

    const db = sqliteRuntime.createDrizzleDatabase(sqlite);

    ensureSqliteTables(sqlite);

    dbInitPromises.set(db as object, Promise.resolve());
    dbCache.set(connectionString, {
      db,
      schema: sqliteSchema,
      isSqlite: true,
      close: async () => { sqlite.close(); },
    });
    return db;
  }

  // PostgreSQL: use shared pool to avoid connection exhaustion and deadlocks
  const pool = getSharedPool({ connectionString });
  const db = drizzlePg(pool);
  dbPostgresPools.set(db as object, pool);
  const initPromise = initializePostgresDatabase(pool);
  dbInitPromises.set(db as object, initPromise);
  initPromise.catch((err) => {
    console.error(`[IdentityDB] PG migration failed: ${err}`);
  });
  dbCache.set(connectionString, {
    db,
    schema: pgSchema,
    isSqlite: false,
    close: async () => { 
      // Release reference to shared pool instead of ending it
      releaseSharedPool({ connectionString }); 
    },
  });
  return db;
}

async function initializePostgresDatabase(pool: Pool): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ensurePostgresTables(pool);
      await migratePgColumns(pool);
      return;
    } catch (error) {
      const retryDelay = POSTGRES_INITIALIZATION_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isTransientPostgresInitializationError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

function isTransientPostgresInitializationError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  if ([ 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P01', '57P03' ].includes(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /connection terminated|connection timeout|connect timeout|timed out|socket hang up/i.test(message);
}

/**
 * Get the schema for a given connection string.
 */
export function getIdentitySchema(connectionString: string): IdentitySchema {
  const cached = dbCache.get(connectionString);
  if (cached) {
    return cached.schema;
  }
  // Initialize connection to populate cache
  getIdentityDatabase(connectionString);
  return dbCache.get(connectionString)!.schema;
}

/**
 * Safely get a Drizzle database connection, returning undefined on error.
 * Use this when the identity database is optional (e.g., for usage tracking).
 */
export function tryGetIdentityDatabase(connectionString: string): IdentityDatabase | undefined {
  try {
    return getIdentityDatabase(connectionString);
  } catch {
    return undefined;
  }
}

export async function closeAllIdentityConnections(): Promise<void> {
  await Promise.all([...dbCache.values()].map(({ close }) => close()));
  dbCache.clear();
}

/**
 * Check if a database connection is SQLite.
 * SQLite drizzle has `all()` method but no `execute()` method.
 * PostgreSQL drizzle has `execute()` method but no `all()` method.
 */
export function isDatabaseSqlite(db: IdentityDatabase): boolean {
  if ((db as any)?.$xpodSqliteRuntime) {
    return true;
  }
  return typeof db.all === 'function' && typeof db.execute !== 'function';
}

async function ensureDatabaseReady(db: IdentityDatabase): Promise<void> {
  const initPromise = dbInitPromises.get(db as object);
  if (initPromise) {
    await initPromise;
  }
}

/**
 * Execute a SQL query uniformly across PostgreSQL and SQLite.
 * Returns a standardized result with rows array.
 *
 * @example
 * const result = await executeQuery(db, sql`SELECT * FROM users WHERE id = ${userId}`);
 * if (result.rows.length > 0) { ... }
 */
export async function executeQuery<T = Record<string, unknown>>(
  db: IdentityDatabase,
  query: SQL,
): Promise<QueryResult<T>> {
  return executeIdentityOperation(db, async executor => isDatabaseSqlite(db)
    ? { rows: executor.all(query) as T[] }
    : executor.execute(query));
}

/**
 * Execute a SQL statement that doesn't return rows (INSERT, UPDATE, DELETE).
 * Works uniformly across PostgreSQL and SQLite.
 */
export async function executeStatement(
  db: IdentityDatabase,
  query: SQL,
): Promise<void> {
  await executeIdentityOperation(db, async executor => {
    if (isDatabaseSqlite(db)) executor.run(query);
    else await executor.execute(query);
  });
}

/**
 * Execute a statement and report how many rows it changed.
 *
 * Optimistic concurrency (compare-and-swap) has to tell an applied write from a rejected one,
 * which `executeStatement` throws away. Returns `undefined` when the driver reports no count,
 * in which case callers must verify the stored value themselves instead of assuming success.
 */
export async function executeStatementWithCount(
  db: IdentityDatabase,
  query: SQL,
): Promise<number | undefined> {
  return executeIdentityOperation(db, async executor => {
    const result = isDatabaseSqlite(db) ? executor.run(query) : await executor.execute(query);
    const count = isDatabaseSqlite(db) ? result?.changes : result?.rowCount;
    return typeof count === 'number' ? count : undefined;
  });
}

export async function executePostgresLockedStatements(
  db: IdentityDatabase,
  lockKey: number,
  statements: string[],
): Promise<void> {
  await ensureDatabaseReady(db);
  if (isDatabaseSqlite(db)) {
    await withIdentityTransaction(db, async () => {
      for (const statement of statements) db.run(sql.raw(statement));
    });
    return;
  }

  const pool = dbPostgresPools.get(db as object);
  if (!pool) {
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ lockKey ]);
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Creates the per-owner interface-key table.
 *
 * The table holds the owner's Pod credential, which the runtime needs *before* it can read
 * anything inside that Pod, so it is created on first use rather than by a Pod-side migration.
 */
export async function ensurePodInterfaceKeyTable(db: IdentityDatabase): Promise<void> {
  await executeIdentityOperation(db, async executor => {
    if (isDatabaseSqlite(db)) {
      executor.run(sql`
        CREATE TABLE IF NOT EXISTS identity_pod_interface_key (
          owner_web_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          sealed_secret TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `);
      return;
    }
    await executor.execute(sql`
      CREATE TABLE IF NOT EXISTS identity_pod_interface_key (
        owner_web_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        sealed_secret TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });
}

export async function ensureCloudClusterTables(db: IdentityDatabase): Promise<void> {
  await ensureDatabaseReady(db);

  if (db && typeof db === 'object' && !currentTransaction(db)) {
    const cached = cloudClusterInitPromises.get(db as object);
    if (cached) {
      await cached;
      return;
    }

    const initPromise = doEnsureCloudClusterTables(db).catch((error) => {
      cloudClusterInitPromises.delete(db as object);
      throw error;
    });
    cloudClusterInitPromises.set(db as object, initPromise);
    await initPromise;
    return;
  }

  await doEnsureCloudClusterTables(db);
}

async function doEnsureCloudClusterTables(db: IdentityDatabase): Promise<void> {
  await executeIdentityOperation(db, async executor => {

    if (isDatabaseSqlite(db)) {
      executor.run(sql`
        CREATE TABLE IF NOT EXISTS cluster_ddns_record (
          subdomain TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          ip_address TEXT,
          ipv6_address TEXT,
          record_type TEXT DEFAULT 'A',
          node_id TEXT,
          username TEXT,
          status TEXT DEFAULT 'active',
          banned_reason TEXT,
          ttl INTEGER DEFAULT 60,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `);
      executor.run(sql`
        CREATE TABLE IF NOT EXISTS cluster_service_token (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          service_type TEXT NOT NULL,
          service_id TEXT NOT NULL,
          scopes TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          expires_at INTEGER
        )
      `);
      executor.run(sql`
        CREATE TABLE IF NOT EXISTS cluster_node (
          id TEXT PRIMARY KEY,
          display_name TEXT,
          token_hash TEXT NOT NULL,
          node_type TEXT DEFAULT 'edge',
          subdomain TEXT UNIQUE,
          access_mode TEXT,
          ipv4 TEXT,
          public_port INTEGER,
          public_url TEXT,
          service_token_hash TEXT,
          provision_code_hash TEXT,
          internal_ip TEXT,
          internal_port INTEGER,
          hostname TEXT,
          ipv6 TEXT,
          version TEXT,
          capabilities TEXT,
          metadata TEXT,
          pod_base_urls TEXT,
          connectivity_status TEXT DEFAULT 'unknown',
          last_connectivity_check INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          last_seen INTEGER
        )
      `);
      executor.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_domain ON cluster_ddns_record(domain)`);
      executor.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_node ON cluster_ddns_record(node_id)`);
      executor.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain)`);
      executor.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_access_mode ON cluster_node(access_mode)`);
      executor.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_connectivity_status ON cluster_node(connectivity_status)`);
      return;
    }

    await executor.execute(sql`
      CREATE TABLE IF NOT EXISTS cluster_ddns_record (
        subdomain TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        ip_address TEXT,
        ipv6_address TEXT,
        record_type TEXT DEFAULT 'A',
        node_id TEXT,
        username TEXT,
        status TEXT DEFAULT 'active',
        banned_reason TEXT,
        ttl INTEGER DEFAULT 60,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await executor.execute(sql`
      CREATE TABLE IF NOT EXISTS cluster_service_token (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        service_type TEXT NOT NULL,
        service_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await executor.execute(sql`
      CREATE TABLE IF NOT EXISTS cluster_node (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        token_hash TEXT NOT NULL,
        node_type TEXT DEFAULT 'edge',
        subdomain TEXT UNIQUE,
        access_mode TEXT,
        ipv4 TEXT,
        public_port BIGINT,
        public_url TEXT,
        service_token_hash TEXT,
        provision_code_hash TEXT,
        internal_ip TEXT,
        internal_port BIGINT,
        hostname TEXT,
        ipv6 TEXT,
        version TEXT,
        capabilities JSONB,
        metadata JSONB,
        pod_base_urls TEXT,
        connectivity_status TEXT DEFAULT 'unknown',
        last_connectivity_check TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ
      )
    `);
    await executor.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_domain ON cluster_ddns_record(domain)`);
    await executor.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_node ON cluster_ddns_record(node_id)`);
    await executor.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain)`);
    await executor.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_access_mode ON cluster_node(access_mode)`);
    await executor.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_connectivity_status ON cluster_node(connectivity_status)`);
  });
}

/**
 * Convert a Date to a value suitable for the database.
 * SQLite uses Unix timestamps (seconds), PostgreSQL uses Date objects.
 */
export function toDbTimestamp(db: IdentityDatabase, date: Date): number | Date {
  return isDatabaseSqlite(db) ? Math.floor(date.getTime() / 1000) : date;
}

/**
 * Parse a timestamp value from database result to Date.
 * Handles both Unix timestamps (SQLite) and Date objects (PostgreSQL).
 */
export function fromDbTimestamp(value: unknown): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number') {
    return new Date(value * 1000);
  }
  if (typeof value === 'string') {
    return new Date(value);
  }
  return undefined;
}

function jsonFieldPath(field: string): string {
  return `$."${field.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `payload` JSON 字段提取表达式，按方言生成（SQLite json_extract / PG ->>）。
 * alias 用于 join 场景下限定来源表。
 */
export function jsonFieldExtract(db: IdentityDatabase, field: string, alias?: string): SQL {
  const target = alias ? sql`${sql.identifier(alias)}.payload` : sql`payload`;
  if (isDatabaseSqlite(db)) {
    return sql`json_extract(${target}, ${jsonFieldPath(field)})`;
  }
  return sql`${target} ->> ${field}`;
}

/**
 * `payload` 字段等于标量值的方言条件。
 */
export function jsonFieldEquals(db: IdentityDatabase, field: string, value: string, alias?: string): SQL {
  return sql`${jsonFieldExtract(db, field, alias)} = ${value}`;
}

/**
 * `payload` 字段落在值集合内的方言条件。values 为空时调用方应跳过查询。
 */
export function jsonFieldIn(db: IdentityDatabase, field: string, values: string[], alias?: string): SQL {
  const list = sql.join(values.map((value) => sql`${value}`), sql`, `);
  return sql`${jsonFieldExtract(db, field, alias)} IN (${list})`;
}

/**
 * 反向前缀匹配：`value LIKE payload->field || '%'`。
 * 用于"资源 URL 以存储的 baseUrl 为前缀"的下推预筛；存储值中的 LIKE 元字符只会多匹配，
 * 调用方需在 JS 侧用 startsWith 复核，不会漏匹配。
 */
export function jsonFieldIsPrefixOf(db: IdentityDatabase, field: string, value: string, alias?: string): SQL {
  return sql`${value} LIKE (${jsonFieldExtract(db, field, alias)}) || '%'`;
}

/**
 * Ensure SQLite tables exist (simple DDL for local/dev mode).
 */
function ensureSqliteTables(sqlite: SqliteDdlExecutor): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS identity_usage (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      storage_bytes INTEGER NOT NULL DEFAULT 0,
      ingress_bytes INTEGER NOT NULL DEFAULT 0,
      egress_bytes INTEGER NOT NULL DEFAULT 0,
      storage_limit_bytes INTEGER,
      bandwidth_limit_bps INTEGER,
      compute_seconds INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      compute_limit_seconds INTEGER,
      token_limit_monthly INTEGER,
      period_start INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (scope_type, scope_id)
    );

  `);

  // Migrate existing tables: add new columns if missing
  migrateSqliteColumns(sqlite);
}

/**
 * Add columns that may be missing from older databases.
 * SQLite ALTER TABLE ADD COLUMN is idempotent-safe via try/catch.
 */
function migrateSqliteColumns(sqlite: SqliteDdlExecutor): void {
  const addColumn = (table: string, column: string, type: string): void => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists — ignore
    }
  };

  // Usage table: compute/token columns
  addColumn('identity_usage', 'compute_seconds', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('identity_usage', 'tokens_used', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('identity_usage', 'compute_limit_seconds', 'INTEGER');
  addColumn('identity_usage', 'token_limit_monthly', 'INTEGER');
  addColumn('identity_usage', 'period_start', 'INTEGER');
}

/**
 * Add columns that may be missing from older PostgreSQL databases.
 * Uses IF NOT EXISTS via information_schema check + ALTER TABLE.
 */
async function migratePgColumns(pool: { query: (sql: string) => Promise<any> }): Promise<void> {
  const addColumn = async (table: string, column: string, type: string): Promise<void> => {
    try {
      await pool.query(
        `DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = '${column}'
          ) THEN
            ALTER TABLE ${table} ADD COLUMN ${column} ${type};
          END IF;
        END $$;`,
      );
    } catch {
      // Ignore errors (table might not exist yet)
    }
  };

  // Usage table: compute/token columns
  await addColumn('identity_usage', 'compute_seconds', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('identity_usage', 'tokens_used', 'BIGINT NOT NULL DEFAULT 0');
  await addColumn('identity_usage', 'compute_limit_seconds', 'BIGINT');
  await addColumn('identity_usage', 'token_limit_monthly', 'BIGINT');
  await addColumn('identity_usage', 'period_start', 'TIMESTAMP WITH TIME ZONE');

}


async function ensurePostgresTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identity_usage (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      storage_bytes BIGINT NOT NULL DEFAULT 0,
      ingress_bytes BIGINT NOT NULL DEFAULT 0,
      egress_bytes BIGINT NOT NULL DEFAULT 0,
      storage_limit_bytes BIGINT,
      bandwidth_limit_bps BIGINT,
      compute_seconds BIGINT NOT NULL DEFAULT 0,
      tokens_used BIGINT NOT NULL DEFAULT 0,
      compute_limit_seconds BIGINT,
      token_limit_monthly BIGINT,
      period_start TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scope_type, scope_id)
    );

  `);
}
