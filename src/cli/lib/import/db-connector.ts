/**
 * Unified database connector for PostgreSQL and SQLite.
 *
 * Provides a common async-iterable interface over query results.
 * Encrypted SQLite is currently unsupported.
 */

import { Client as PgClient } from 'pg';
import type { DbConnection, DbSource, Row } from './types';
import { createReadonlySqliteDatabase } from '../../../storage/SqliteCompat';

/**
 * Connect to a database and return a unified DbConnection.
 */
export async function connectDb(source: DbSource): Promise<DbConnection> {
  switch (source.type) {
    case 'postgres':
      return connectPostgres(source.connectionString);
    case 'sqlite':
      return connectSqlite(source.connectionString);
    default:
      throw new Error(`Unsupported database type: ${source.type}`);
  }
}

// ============================================
// PostgreSQL
// ============================================

async function connectPostgres(connectionString: string): Promise<DbConnection> {
  const client = new PgClient({ connectionString });
  await client.connect();

  return {
    async *query(sql: string): AsyncIterable<Row> {
      const result = await client.query(sql);
      for (const row of result.rows) {
        yield row as Row;
      }
    },
    async close() {
      await client.end();
    },
  };
}

// ============================================
// SQLite
// ============================================

async function connectSqlite(filePath: string): Promise<DbConnection> {
  const db = createReadonlySqliteDatabase(filePath);

  return {
    async *query(sql: string): AsyncIterable<Row> {
      const stmt = db.prepare(sql);
      for (const row of stmt.iterate()) {
        yield row as Row;
      }
    },
    async close() {
      db.close();
      return Promise.resolve();
    },
  };
}

/**
 * Detect database type from a connection string.
 * - Starts with "postgres://" or "postgresql://" → postgres
 * - Otherwise → sqlite (treat as file path)
 */
export function detectDbType(connectionString: string): DbSource['type'] {
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
    return 'postgres';
  }
  return 'sqlite';
}
