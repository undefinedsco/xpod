/**
 * SQLite test utilities for proper database isolation.
 *
 * - Unit tests: Use in-memory databases for speed and isolation
 * - Integration tests: Use WAL mode + busy_timeout for concurrent access
 *
 * All test data files are stored in .test-data/ for easy cleanup.
 * Run `yarn clean:test` to remove all test artifacts.
 */
import path from 'node:path';
import fs from 'node:fs';
import { getSqliteRuntime, type SqliteDatabase } from '../../src/storage/SqliteRuntime';

/**
 * Root directory for all test data files.
 * Located at project root: .test-data/
 */
export const TEST_DATA_DIR = path.join(__dirname, '../../.test-data');

/**
 * Ensure the test data directory exists.
 */
export function ensureTestDataDir(): string {
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }
  return TEST_DATA_DIR;
}

/**
 * Get a path within the test data directory.
 *
 * @param subpath - Relative path within .test-data/
 * @returns Absolute path to the test data file/directory
 */
export function getTestDataPath(...subpath: string[]): string {
  ensureTestDataDir();
  const fullPath = path.join(TEST_DATA_DIR, ...subpath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return fullPath;
}

/**
 * Create a unique test directory within .test-data/.
 *
 * @param prefix - Prefix for the directory name
 * @returns Absolute path to the created directory
 */
export function createTestDir(prefix = 'test'): string {
  ensureTestDataDir();
  const uniqueId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const dirPath = path.join(TEST_DATA_DIR, uniqueId);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Get a unique SQLite database path within .test-data/.
 *
 * @param name - Base name for the database file
 * @returns Absolute path to the SQLite database file
 */
export function getTestDbPath(name = 'test'): string {
  ensureTestDataDir();
  const uniqueId = `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  return path.join(TEST_DATA_DIR, `${uniqueId}.sqlite`);
}

/**
 * Get a SQLite connection URL for testing.
 *
 * @param name - Base name for the database
 * @returns sqlite: prefixed URL for use with Drizzle/SQLUp
 */
export function getTestDbUrl(name = 'test'): string {
  return `sqlite:${getTestDbPath(name)}`;
}

/**
 * SQLite PRAGMA configuration for integration tests.
 * These settings help prevent SQLITE_BUSY errors during concurrent access.
 */
export const SQLITE_INTEGRATION_PRAGMAS = {
  /** Write-Ahead Logging mode allows concurrent reads during writes */
  journal_mode: 'WAL',
  /** Wait up to 5 seconds before throwing SQLITE_BUSY */
  busy_timeout: 5000,
  /** Synchronous mode for WAL (NORMAL is safe and faster than FULL) */
  synchronous: 'NORMAL',
};

/**
 * Apply integration test pragmas to a SQLite database instance.
 *
 * @param db - The SQLite database instance
 */
export function applyIntegrationPragmas(db: SqliteDatabase): void {
  db.pragma(`journal_mode = ${SQLITE_INTEGRATION_PRAGMAS.journal_mode}`);
  db.pragma(`busy_timeout = ${SQLITE_INTEGRATION_PRAGMAS.busy_timeout}`);
  db.pragma(`synchronous = ${SQLITE_INTEGRATION_PRAGMAS.synchronous}`);
}

/**
 * Generate a unique in-memory database URL for test isolation.
 * Each call returns a unique URL so tests don't share state.
 *
 * @param prefix - Optional prefix for the database name
 * @returns A unique sqlite::memory: URL
 */
export function createMemoryDbUrl(prefix = 'test'): string {
  const uniqueId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  return `sqlite::memory:${uniqueId}`;
}

/**
 * Generate a unique in-memory connection string for Drizzle/identity database.
 * Uses :memory: format compatible with the current SQLite runtime.
 *
 * @param prefix - Optional prefix for identification
 * @returns A sqlite::memory: connection string
 */
export function createMemoryIdentityDbUrl(prefix = 'identity'): string {
  // Keep each test isolated with a unique named in-memory database
  const uniqueId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  return `sqlite::memory:${uniqueId}`;
}

/**
 * Create an isolated in-memory SQLite database for unit tests.
 *
 * @returns A new in-memory Database instance
 */
export function createMemoryDatabase(): SqliteDatabase {
  const sqliteRuntime = getSqliteRuntime();
  return sqliteRuntime.openDatabase(':memory:');
}

/**
 * Create a SQLite database with integration test pragmas applied.
 *
 * @param filename - The database file path
 * @returns A Database instance with WAL mode and busy_timeout configured
 */
export function createIntegrationDatabase(filename: string): SqliteDatabase {
  const sqliteRuntime = getSqliteRuntime();
  const db = sqliteRuntime.openDatabase(filename);
  applyIntegrationPragmas(db);
  return db;
}

export function cleanupSqliteFiles(filename: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const target = `${filename}${suffix}`;
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}
