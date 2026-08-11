import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeStatement, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { CssAccountTokenResolver } from '../../../src/api/auth/CssAccountTokenResolver';

const future = new Date(Date.now() + 60_000).toISOString();

function existingAccountStorage(...accountIds: string[]) {
  return {
    has: vi.fn(async (type: string, id: string) => type === 'account' && accountIds.includes(id)),
  };
}

describe('CssAccountTokenResolver', () => {
  it('resolves local account cookies from either internal_kv namespace', async () => {
    const db = getIdentityDatabase(`sqlite::memory:css-account-token-${randomUUID()}`);
    await executeStatement(db, sql`
      CREATE TABLE internal_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await executeStatement(db, sql`
      INSERT INTO internal_kv (key, value)
      VALUES ('/.internal/accounts/cookies/local-token', ${JSON.stringify({ expires: future, payload: 'account-local' })})
    `);

    const resolver = new CssAccountTokenResolver({ db, accountStorage: existingAccountStorage('account-local') });

    await expect(resolver.resolveAccountId('local-token')).resolves.toBe('account-local');
  });

  it('resolves cloud account cookies from the Redis-backed storage namespace', async () => {
    const redis = {
      get: vi.fn(async (key: string) => key === 'accounts/cookies/redis-token'
        ? { expires: future, payload: 'account-redis' }
        : undefined),
    };
    const resolver = new CssAccountTokenResolver({
      redisStorage: redis,
      accountStorage: existingAccountStorage('account-redis'),
    });

    await expect(resolver.resolveAccountId('redis-token')).resolves.toBe('account-redis');
    expect(redis.get).toHaveBeenCalledWith('accounts/cookies/redis-token');
  });

  it.each([
    ['missing', undefined],
    ['malformed', '{"payload":42}'],
    ['missing expiry', JSON.stringify({ payload: 'account-without-expiry' })],
    ['expired', JSON.stringify({ expires: new Date(Date.now() - 1_000).toISOString(), payload: 'account-expired' })],
  ])('rejects %s cookies', async (_label, value) => {
    const redis = { get: vi.fn(async () => value) };
    const resolver = new CssAccountTokenResolver({ redisStorage: redis, accountStorage: existingAccountStorage() });

    await expect(resolver.resolveAccountId('invalid-token')).resolves.toBeUndefined();
  });

  it('fails closed when Redis is unavailable after a local miss', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const resolver = new CssAccountTokenResolver({ redisStorage: redis, accountStorage: existingAccountStorage() });

    await expect(resolver.resolveAccountId('unavailable-token')).rejects.toThrow('connection refused');
  });

  it('rejects a cookie whose mapped Account has been deleted', async () => {
    const redis = {
      get: vi.fn(async () => ({ expires: future, payload: 'deleted-account' })),
    };
    const accountStorage = existingAccountStorage();
    const resolver = new CssAccountTokenResolver({ redisStorage: redis, accountStorage });

    await expect(resolver.resolveAccountId('stale-token')).resolves.toBeUndefined();
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'deleted-account');
  });

  it('fails closed when Account existence storage is unavailable', async () => {
    const redis = {
      get: vi.fn(async () => ({ expires: future, payload: 'account-storage-error' })),
    };
    const accountStorage = {
      has: vi.fn(async () => {
        throw new Error('identity storage unavailable');
      }),
    };
    const resolver = new CssAccountTokenResolver({ redisStorage: redis, accountStorage });

    await expect(resolver.resolveAccountId('storage-error-token')).rejects.toThrow('identity storage unavailable');
  });
});
