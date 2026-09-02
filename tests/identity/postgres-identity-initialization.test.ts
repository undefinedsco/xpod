import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const poolQuery = vi.fn();
const dbExecute = vi.fn();

vi.mock('../../src/storage/database/PostgresPoolManager', () => ({
  getSharedPool: () => ({ query: poolQuery }),
  releaseSharedPool: vi.fn(),
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({ execute: dbExecute }),
}));

describe('PostgreSQL identity database initialization', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    dbExecute.mockReset();
    dbExecute.mockResolvedValue({ rows: [{ ready: true }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recovers from transient connection timeouts during startup', async () => {
    vi.useFakeTimers();
    poolQuery
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValue({ rows: [] });

    const { executeQuery, getIdentityDatabase } = await import('../../src/identity/drizzle/db');
    const db = getIdentityDatabase(`postgres://identity-retry-${Date.now()}`);
    const execution = executeQuery<{ ready: boolean }>(db, sql`SELECT TRUE AS ready`);
    const assertion = expect(execution).resolves.toEqual({ rows: [{ ready: true }] });

    await vi.runAllTimersAsync();

    await assertion;
    expect(poolQuery).toHaveBeenCalledTimes(8);
    expect(dbExecute).toHaveBeenCalledOnce();

  });

  it('does not retry permanent schema errors', async () => {
    const schemaError = Object.assign(new Error('syntax error at or near "CREATE"'), { code: '42601' });
    poolQuery.mockRejectedValue(schemaError);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { executeQuery, getIdentityDatabase } = await import('../../src/identity/drizzle/db');
    const db = getIdentityDatabase(`postgres://identity-schema-error-${Date.now()}`);

    await expect(executeQuery(db, sql`SELECT TRUE`)).rejects.toBe(schemaError);
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
