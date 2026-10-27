import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { BaseAccountStore } from '@solid/community-server';
import { ExternalIdentityAccountStorage } from '../../../src/identity/external/ExternalIdentityAccountStorage';
import { DrizzleIndexedStorage } from '../../../src/identity/drizzle/DrizzleIndexedStorage';
import { closeAllIdentityConnections, executeQuery, executeStatement, getIdentityDatabase, withIdentityTransaction } from '../../../src/identity/drizzle/db';
import { ServiceTokenRepository } from '../../../src/identity/drizzle/ServiceTokenRepository';
import { EXTERNAL_LOGIN_TYPE } from '../../../src/identity/external/ExternalIdentityStorage';

// The full integration runner supplies an isolated test PostgreSQL, never the developer identity DB.
describe.skipIf(!process.env.XPOD_FULL_PG_URL)('external identities on PostgreSQL', () => {
  const schema = `external_identity_${randomUUID().replace(/-/gu, '')}`;
  let client: Client, connection: string, storage: ExternalIdentityAccountStorage, other: ExternalIdentityAccountStorage;
  let store: BaseAccountStore;
  const binding = (accountId: string, subject: string) => ({ accountId, provider: 'wechat', namespace: 'app', subject });
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.XPOD_FULL_PG_URL });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.XPOD_FULL_PG_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    connection = url.href;
    const make = () => new ExternalIdentityAccountStorage({ storage: new DrizzleIndexedStorage(connection), identityDbUrl: connection, allowPasswordlessAccounts: true });
    storage = make(); other = make();
    store = new BaseAccountStore(storage);
    await store.handle();
    await new BaseAccountStore(other).handle();
    for (const accountStorage of [storage, other]) await accountStorage.defineType('password-test', { accountId: 'id:account' }, true);
  });
  afterAll(async () => {
    await closeAllIdentityConnections();
    if (client) {
      try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await client.end(); }
    }
  });

  it('uses real timestamps and a unique identity constraint without a JSON binding copy', async () => {
    const accountId = await store.create();
    const row = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'one'));
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBe(row.createdAt);
    await expect(other.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'one'))).rejects.toThrow('ALREADY_BOUND');
    const db = getIdentityDatabase(connection);
    expect((await executeQuery(db, sql`SELECT id FROM identity_store WHERE container = 'external-login'`)).rows).toEqual([]);
    expect((await executeQuery(db, sql`SELECT to_regclass('identity_external_login_index') AS name`)).rows[0].name).toBeNull();
  });

  it('rolls back account creation on a binding conflict using the same SQL connection', async () => {
    const accountId = await store.create();
    await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'rollback'));
    const before = await storage.findIds('account', {});
    await expect(storage.withTransaction(async () => {
      const created = await store.create();
      await storage.create(EXTERNAL_LOGIN_TYPE, binding(created, 'rollback'));
    })).rejects.toThrow('ALREADY_BOUND');
    expect(await storage.findIds('account', {})).toEqual(before);
  });

  it('includes repository ORM writes in the transaction without affecting another request', async () => {
    const db = getIdentityDatabase(connection), repository = new ServiceTokenRepository(db);
    await repository.listTokens();
    let token = '', enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const transaction = withIdentityTransaction(db, async () => {
      token = (await repository.createToken({ serviceType: 'business', serviceId: 'rollback', scopes: [] })).token;
      enter();
      await released;
      throw new Error('rollback');
    });
    const rejected = expect(transaction).rejects.toThrow('rollback');
    await entered;
    try {
      expect(await repository.verifyToken(token)).toBeUndefined();
      const independent = await repository.createToken({ serviceType: 'business', serviceId: 'independent', scopes: [] });
      release();
      await rejected;
      expect(await repository.verifyToken(token)).toBeUndefined();
      expect(await repository.verifyToken(independent.token)).toMatchObject({ id: independent.id });
    } finally { release(); await rejected; }
  });

  it('protects the last login method across simultaneous transactions and independent instances', async () => {
    const accountId = await store.create();
    const row = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'concurrent'));
    const password = await storage.create('password-test', { accountId });
    const results = await Promise.allSettled([storage.delete(EXTERNAL_LOGIN_TYPE, row.id), other.delete('password-test', password.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await storage.find(EXTERNAL_LOGIN_TYPE, { accountId })).length + (await storage.find('password-test', { accountId })).length).toBe(1);
  });

  it('migrates a legacy JSON binding and lookup index atomically while preserving its ID', async () => {
    // Use a separate schema so this test exercises the first migration, not a completed v1.
    const legacySchema = `${schema}_legacy`;
    await client.query(`CREATE SCHEMA "${legacySchema}"`);
    try {
      const url = new URL(connection);
      url.searchParams.set('options', `-c search_path=${legacySchema}`);
      const legacyConnection = url.href, raw = new DrizzleIndexedStorage(legacyConnection);
      await raw.defineType('account', {});
      const account = await raw.create('account', {});
      const row = await raw.create(EXTERNAL_LOGIN_TYPE, binding(account.id, 'migrated'));
      const db = getIdentityDatabase(legacyConnection);
      const { createHash } = await import('node:crypto');
      const key = createHash('sha256').update(JSON.stringify(['wechat', 'app', 'migrated'])).digest('hex');
      await executeStatement(db, sql`CREATE TABLE identity_external_login_index (subject TEXT PRIMARY KEY, login_id TEXT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0)`);
      await executeStatement(db, sql`INSERT INTO identity_external_login_index VALUES (${key}, ${row.id}, 0)`);
      const adapter = new ExternalIdentityAccountStorage({ storage: new DrizzleIndexedStorage(legacyConnection), identityDbUrl: legacyConnection, allowPasswordlessAccounts: true });
      await new BaseAccountStore(adapter).handle();
      expect(await adapter.get(EXTERNAL_LOGIN_TYPE, row.id)).toMatchObject({ ...row, createdAt: expect.any(Number) });
      expect(await raw.find(EXTERNAL_LOGIN_TYPE, {})).toEqual([]);
    } finally { await client.query(`DROP SCHEMA "${legacySchema}" CASCADE`); }
  });
});
