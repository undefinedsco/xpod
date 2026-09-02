import { beforeEach, describe, expect, it, vi } from 'vitest';

const executePostgresLockedStatements = vi.fn();
const executeStatement = vi.fn();

vi.mock('../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: () => ({}),
  executeQuery: vi.fn(),
  executeStatement,
  executePostgresLockedStatements,
  isDatabaseSqlite: () => false,
}));

describe('DrizzleIndexedStorage PostgreSQL schema bootstrap', () => {
  beforeEach(() => {
    executePostgresLockedStatements.mockReset();
    executePostgresLockedStatements.mockResolvedValue(undefined);
    executeStatement.mockReset();
  });

  it('serializes table and index DDL with one database-scoped advisory lock', async () => {
    const { DrizzleIndexedStorage } = await import('../../src/identity/drizzle/DrizzleIndexedStorage');
    const storage = new DrizzleIndexedStorage('postgres://identity', 'identity_');

    await storage.defineType('account', {});
    await storage.createIndex('account', 'email');

    expect(executePostgresLockedStatements).toHaveBeenCalledTimes(2);
    const [ tableDb, tableLockKey, tableStatements ] = executePostgresLockedStatements.mock.calls[0];
    const [ indexDb, indexLockKey, indexStatements ] = executePostgresLockedStatements.mock.calls[1];
    expect(tableDb).toBe(indexDb);
    expect(tableLockKey).toBe(indexLockKey);
    expect(tableStatements).toEqual([
      expect.stringContaining('CREATE TABLE IF NOT EXISTS "identity_store"'),
    ]);
    expect(indexStatements).toEqual([
      expect.stringContaining('CREATE INDEX IF NOT EXISTS'),
    ]);
    expect(executeStatement).not.toHaveBeenCalled();
  });
});
