import { Pool, types } from 'pg';
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
 * await db.select().from(schema.usage).where(eq(schema.usage.scopeId, id));
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
const cloudClusterInitPromises = new WeakMap<object, Promise<void>>();

const JSON_OIDS = [114, 3802];

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
  const initPromise = (async(): Promise<void> => {
    await ensurePostgresTables(pool);
    await migratePgColumns(pool);
  })();
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
  await ensureDatabaseReady(db);
  if (isDatabaseSqlite(db)) {
    // SQLite: db.all() returns array directly
    const rows = db.all(query) as T[];
    return { rows };
  }
  // PostgreSQL: db.execute() returns { rows: [...] }
  return db.execute(query) as Promise<QueryResult<T>>;
}

/**
 * Execute a SQL statement that doesn't return rows (INSERT, UPDATE, DELETE).
 * Works uniformly across PostgreSQL and SQLite.
 */
export async function executeStatement(
  db: IdentityDatabase,
  query: SQL,
): Promise<void> {
  await ensureDatabaseReady(db);
  if (isDatabaseSqlite(db)) {
    // SQLite: db.run() for statements
    db.run(query);
    return;
  }
  // PostgreSQL: db.execute() works for statements too
  await db.execute(query);
}

export async function ensureCloudClusterTables(db: IdentityDatabase): Promise<void> {
  await ensureDatabaseReady(db);

  if (db && typeof db === 'object') {
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

  if (isDatabaseSqlite(db)) {
    db.run(sql`
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
    db.run(sql`
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
    db.run(sql`
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
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_domain ON cluster_ddns_record(domain)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_node ON cluster_ddns_record(node_id)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_access_mode ON cluster_node(access_mode)`);
    db.run(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_connectivity_status ON cluster_node(connectivity_status)`);
    return;
  }

  await db.execute(sql`
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
  await db.execute(sql`
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
  await db.execute(sql`
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
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_domain ON cluster_ddns_record(domain)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_ddns_record_node ON cluster_ddns_record(node_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_subdomain ON cluster_node(subdomain)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_access_mode ON cluster_node(access_mode)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cluster_node_connectivity_status ON cluster_node(connectivity_status)`);
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

  await migratePostgresColumns(pool);
}

async function migratePostgresColumns(pool: Pool): Promise<void> {
  void pool;
}
