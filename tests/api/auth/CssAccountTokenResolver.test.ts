import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeStatement, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { CssAccountTokenResolver } from '../../../src/api/auth/CssAccountTokenResolver';

const future = new Date(Date.now() + 60_000).toISOString();

describe('CssAccountTokenResolver', () => {
  it('resolves local account cookies from either internal_kv namespace', async () => {
    const db = getIdentityDatabase(`sqlite::memory:css-account-token-${randomUUID()}`);
    executeStatement(db, sql`
      CREATE TABLE internal_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    executeStatement(db, sql`
      INSERT INTO internal_kv (key, value)
      VALUES ('/.internal/accounts/cookies/local-token', ${JSON.stringify({ expires: future, payload: 'account-local' })})
    `);

    const resolver = new CssAccountTokenResolver({ db });

    await expect(resolver.resolveAccountId('local-token')).resolves.toBe('account-local');
  });

  it('resolves cloud account cookies from the Redis-backed storage namespace', async () => {
    const redis = {
      get: vi.fn(async (key: string) => key === 'accounts/cookies/redis-token'
        ? { expires: future, payload: 'account-redis' }
        : undefined),
    };
    const resolver = new CssAccountTokenResolver({ redisStorage: redis });

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
    const resolver = new CssAccountTokenResolver({ redisStorage: redis });

    await expect(resolver.resolveAccountId('invalid-token')).resolves.toBeUndefined();
  });

  it('fails closed when Redis is unavailable after a local miss', async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    const resolver = new CssAccountTokenResolver({ redisStorage: redis });

    await expect(resolver.resolveAccountId('unavailable-token')).rejects.toThrow('connection refused');
  });
});
