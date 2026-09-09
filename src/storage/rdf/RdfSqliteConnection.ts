import type { SqliteDatabase, SqliteRuntime } from '../SqliteRuntime';

/**
 * Open the SQLite file shared by Local facts, FTS, VEC, and the QLever reader.
 * WAL lets the long-lived native reader coexist with short authority writes;
 * busy_timeout bounds transient writer contention instead of failing at once.
 */
export function openRdfSqliteDatabase(sqliteRuntime: SqliteRuntime, path: string): SqliteDatabase {
  const db = sqliteRuntime.openDatabase(path);
  if (!isInMemorySqlitePath(path)) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
  }
  return db;
}

function isInMemorySqlitePath(path: string): boolean {
  return path === ':memory:' || path.startsWith(':memory:');
}
