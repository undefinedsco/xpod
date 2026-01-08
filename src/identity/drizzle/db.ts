import { Pool, types } from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleSqlite, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm/sql';
import Database from 'better-sqlite3';
import * as pgSchema from './schema.pg';
import * as sqliteSchema from './schema.sqlite';
import path from 'node:path';
import fs from 'node:fs';

// Use 'any' to allow both PostgreSQL and SQLite database instances
// The actual type depends on the connection string at runtime
export type IdentityDatabase = any;
export type IdentitySchema = typeof pgSchema | typeof sqliteSchema;

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

const JSON_OIDS = [114, 3802];

for (const oid of JSON_OIDS) {
  types.setTypeParser(oid, (value) => (value == null ? null : JSON.parse(value)));
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
    if (!isMemory) {
      const directory = path.dirname(filename);
      if (directory && !fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }
    }
    const sqlite = new Database(isMemory ? ':memory:' : filename);

    // Apply pragmas for better concurrency (prevents SQLITE_BUSY errors)
    // WAL mode allows concurrent reads during writes
    // busy_timeout waits up to 5 seconds before throwing SQLITE_BUSY
    if (!isMemory) {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
      sqlite.pragma('synchronous = NORMAL');
    }

    const db = drizzleSqlite(sqlite);

    // Create tables if they don't exist
    ensureSqliteTables(sqlite);

    dbCache.set(connectionString, {
      db,
      schema: sqliteSchema,
      isSqlite: true,
      close: async () => { sqlite.close(); },
    });
    return db;
  }

  // PostgreSQL
  const pool = new Pool({ connectionString });
  const db = drizzlePg(pool);
  dbCache.set(connectionString, {
    db,
    schema: pgSchema,
    isSqlite: false,
    close: async () => pool.end(),
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
  // SQLite drizzle has `all` method, PostgreSQL drizzle has `execute` method
  return typeof db.all === 'function' && typeof db.execute !== 'function';
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
  if (isDatabaseSqlite(db)) {
    // SQLite: db.run() for statements
    db.run(query);
    return;
  }
  // PostgreSQL: db.execute() works for statements too
  await db.execute(query);
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
function ensureSqliteTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS identity_account_usage (
      account_id TEXT PRIMARY KEY,
      storage_bytes INTEGER NOT NULL DEFAULT 0,
      ingress_bytes INTEGER NOT NULL DEFAULT 0,
      egress_bytes INTEGER NOT NULL DEFAULT 0,
      storage_limit_bytes INTEGER,
      bandwidth_limit_bps INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS identity_pod_usage (
      pod_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      storage_bytes INTEGER NOT NULL DEFAULT 0,
      ingress_bytes INTEGER NOT NULL DEFAULT 0,
      egress_bytes INTEGER NOT NULL DEFAULT 0,
      storage_limit_bytes INTEGER,
      bandwidth_limit_bps INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS identity_edge_node (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      owner_account_id TEXT,
      token_hash TEXT NOT NULL,
      node_type TEXT DEFAULT 'edge',
      subdomain TEXT UNIQUE,
      access_mode TEXT,
      public_ip TEXT,
      public_port INTEGER,
      internal_ip TEXT,
      internal_port INTEGER,
      capabilities TEXT,
      metadata TEXT,
      connectivity_status TEXT DEFAULT 'unknown',
      last_connectivity_check INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS identity_edge_node_pod (
      node_id TEXT NOT NULL REFERENCES identity_edge_node(id) ON DELETE CASCADE,
      base_url TEXT NOT NULL
    );
  `);
}
