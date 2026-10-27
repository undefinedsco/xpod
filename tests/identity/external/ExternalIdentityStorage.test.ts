import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BaseAccountStore, BaseLoginAccountStorage, MemoryMapStorage, WrappedIndexedStorage, type AccountLoginStorage } from '@solid/community-server';
import { DrizzleIndexedStorage } from '../../../src/identity/drizzle/DrizzleIndexedStorage';
import { closeAllIdentityConnections, executeQuery, executeStatement, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { ExternalIdentityAccountStorage } from '../../../src/identity/external/ExternalIdentityAccountStorage';
import { EXTERNAL_LOGIN_TYPE } from '../../../src/identity/external/ExternalIdentityStorage';
import { SqliteKeyValueStorage } from '../../../src/storage/keyvalue/SqliteKeyValueStorage';
import { LoginMethodGuardStorage } from '../../../src/identity/LoginMethodGuardStorage';

mkdirSync('.test-data/external-login', { recursive: true });
const directory = mkdtempSync(path.resolve('.test-data/external-login/storage-'));
let counter = 0;
const binding = (accountId: string, namespace = 'web-app') => ({ accountId, provider: 'wechat', namespace, subject: 'openid' });
function fixture(mode: string) {
  const database = `sqlite:${path.join(directory, `${++counter}.sqlite`)}`;
  const values = new MemoryMapStorage<any>();
  const indexes = new MemoryMapStorage<any>();
  const kv = mode === 'local-sqlite' ? new SqliteKeyValueStorage<any>({ path: database }) : undefined;
  const raw = () => mode === 'sql' ? new DrizzleIndexedStorage(database) : new WrappedIndexedStorage<any>(kv ?? values, kv ? new SqliteKeyValueStorage<any>({ path: database, namespace: 'indexes' }) : indexes);
  const storage = () => new ExternalIdentityAccountStorage({ storage: raw(), identityDbUrl: database, allowPasswordlessAccounts: mode === 'sql' });
  return { database, raw, storage };
}
async function initialize(storage: ExternalIdentityAccountStorage) {
  const store = new BaseAccountStore(storage);
  await store.handle();
  await storage.defineType('password-test', { accountId: 'id:account', email: 'string' }, true);
  await storage.defineType('pod-test', { accountId: 'id:account', name: 'string' }, false);
  return store;
}
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await closeAllIdentityConnections(); rmSync(directory, { recursive: true, force: true }); });

describe.each(['sql', 'css', 'local-sqlite'])('external identity adapter with %s accounts', mode => {
  it('stores one binding fact with server timestamps, scopes apps, and implements CSS queries', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage);
    const accountId = await store.create();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const first = await storage.create(EXTERNAL_LOGIN_TYPE, { ...binding(accountId), createdAt: 1, updatedAt: 2 });
    expect(first).toMatchObject({ accountId, createdAt: 1_800_000_000, updatedAt: 1_800_000_000 });
    const second = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'mini-app'));
    expect(second.id).not.toBe(first.id);
    expect(await storage.findIds(EXTERNAL_LOGIN_TYPE, { accountId: { id: accountId } })).toHaveLength(2);
    expect(await storage.find(EXTERNAL_LOGIN_TYPE, { namespace: 'other' })).toEqual([]);
    expect(await storage.has(EXTERNAL_LOGIN_TYPE, first.id)).toBe(true);
    const entries = [];
    for await (const row of storage.entries(EXTERNAL_LOGIN_TYPE)) entries.push(row);
    expect(entries).toHaveLength(2);
    if (mode === 'sql') expect(await f.raw().find(EXTERNAL_LOGIN_TYPE, {})).toEqual([]);
    const persisted = await executeQuery(getIdentityDatabase(f.database), sql`SELECT * FROM identity_external_identities`);
    expect(persisted.rows).toHaveLength(2);
  });

  it('protects identity keys and updates modification time only for changed metadata', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage), accountId = await store.create();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const row = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    clock.mockReturnValue(1_800_000_010_000);
    await storage.set(EXTERNAL_LOGIN_TYPE, row);
    expect(await storage.get(EXTERNAL_LOGIN_TYPE, row.id)).toEqual(row);
    await storage.setField(EXTERNAL_LOGIN_TYPE, row.id, 'unionId', 'union');
    expect(await storage.get(EXTERNAL_LOGIN_TYPE, row.id)).toMatchObject({ createdAt: row.createdAt, updatedAt: row.updatedAt + 10, unionId: 'union' });
    await expect(storage.set(EXTERNAL_LOGIN_TYPE, { ...row, subject: 'different' })).rejects.toThrow('IMMUTABLE');
    await expect(storage.setField(EXTERNAL_LOGIN_TYPE, row.id, 'createdAt', 0)).rejects.toThrow('IMMUTABLE');
    await expect(storage.set(EXTERNAL_LOGIN_TYPE, { ...row, id: 'missing' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('enforces uniqueness and rolls back a newly created account when binding fails', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage), accountId = await store.create();
    await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    await expect(storage.withTransaction(async () => {
      const other = await store.create();
      await storage.create(EXTERNAL_LOGIN_TYPE, binding(other));
    })).rejects.toThrow('ALREADY_BOUND');
    const accounts = [];
    for await (const row of storage.entries('account')) accounts.push(row);
    expect(accounts).toHaveLength(1);
    expect(await storage.find(EXTERNAL_LOGIN_TYPE, {})).toHaveLength(1);
  });

  it('serializes password and external identity deletions across independent storage instances', async () => {
    const f = fixture(mode), storage = f.storage(), other = f.storage();
    const store = await initialize(storage);
    await initialize(other);
    const accountId = await store.create();
    const row = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    const password = await storage.create('password-test', { accountId, email: 'test@example.test' });
    const results = await Promise.allSettled([storage.delete(EXTERNAL_LOGIN_TYPE, row.id), other.delete('password-test', password.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await storage.find(EXTERNAL_LOGIN_TYPE, { accountId })).length + (await storage.find('password-test', { accountId })).length).toBe(1);
  });

  it('cleans bindings when the entire account is deleted and rejects binding to a missing account', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage), accountId = await store.create();
    await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    await storage.delete('account', accountId);
    expect(await storage.find(EXTERNAL_LOGIN_TYPE, { accountId })).toEqual([]);
    await expect(storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId))).rejects.toThrow('ACCOUNT_LOGIN_REQUIRED');
  });

  it('rolls back an incomplete multi-identity unlink and preserves the local login count', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage), accountId = await store.create();
    const first = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    const second = await storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId, 'mini-app'));
    await expect(storage.withTransaction(async () => {
      await storage.delete(EXTERNAL_LOGIN_TYPE, first.id);
      await storage.delete(EXTERNAL_LOGIN_TYPE, second.id);
    })).rejects.toThrow('at least 1');
    expect(await storage.find(EXTERNAL_LOGIN_TYPE, { accountId })).toHaveLength(2);
    await storage.delete(EXTERNAL_LOGIN_TYPE, first.id);
    await expect(storage.delete(EXTERNAL_LOGIN_TYPE, second.id)).rejects.toThrow('at least 1');
  });

  it('preserves each deployment policy for accounts with no login methods', async () => {
    const f = fixture(mode), storage = f.storage();
    const store = await initialize(storage), accountId = await store.create();
    const action = storage.create('pod-test', { accountId, name: 'pod' });
    if (mode === 'sql') await expect(action).resolves.toMatchObject({ accountId });
    else await expect(action).rejects.toThrow('at least 1');
  });

  it('migrates legacy bindings once, preserves IDs, and removes the old lookup index', async () => {
    const f = fixture(mode), source = f.raw();
    const legacy = mode === 'sql' ? new LoginMethodGuardStorage(source) : new BaseLoginAccountStorage<any>(source);
    const oldStore = new BaseAccountStore(legacy as unknown as AccountLoginStorage<Record<string, never>>);
    await oldStore.handle();
    await legacy.defineType(EXTERNAL_LOGIN_TYPE, { accountId: 'id:account', provider: 'string', namespace: 'string', subject: 'string', unionId: 'string?' }, true);
    const accountId = await oldStore.create();
    const row = await legacy.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    const db = getIdentityDatabase(f.database);
    await executeStatement(db, sql`CREATE TABLE identity_external_login_index (subject TEXT PRIMARY KEY, login_id TEXT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0)`);
    const digest = createHash('sha256').update(JSON.stringify(['wechat', 'web-app', 'openid'])).digest('hex');
    await executeStatement(db, sql`INSERT INTO identity_external_login_index (subject, login_id, lease_until) VALUES (${digest}, ${row.id}, 0)`);
    const storage = f.storage();
    await initialize(storage);
    const migrated = await storage.get(EXTERNAL_LOGIN_TYPE, row.id);
    expect(migrated).toMatchObject({ ...row, createdAt: expect.any(Number), updatedAt: expect.any(Number) });
    expect(migrated.createdAt).toBe(migrated.updatedAt);
    const restarted = f.storage();
    await initialize(restarted);
    expect(await restarted.get(EXTERNAL_LOGIN_TYPE, row.id)).toEqual(migrated);
    expect((await executeQuery(db, sql`SELECT name FROM sqlite_master WHERE name = 'identity_external_login_index'`)).rows).toEqual([]);
    if (mode === 'sql') expect(await f.raw().find(EXTERNAL_LOGIN_TYPE, {})).toEqual([]);
  });

  it('rejects a legacy binding with no valid index instead of silently reassigning it', async () => {
    const f = fixture(mode), source = f.raw();
    const legacy = mode === 'sql' ? new LoginMethodGuardStorage(source) : new BaseLoginAccountStorage<any>(source);
    const oldStore = new BaseAccountStore(legacy as unknown as AccountLoginStorage<Record<string, never>>);
    await oldStore.handle();
    await legacy.defineType(EXTERNAL_LOGIN_TYPE, { accountId: 'id:account', provider: 'string', namespace: 'string', subject: 'string' }, true);
    const accountId = await oldStore.create();
    const original = await legacy.create(EXTERNAL_LOGIN_TYPE, binding(accountId));
    const storage = f.storage();
    await initialize(storage);
    await expect(storage.get(EXTERNAL_LOGIN_TYPE, original.id)).rejects.toThrow('MIGRATION_INVALID_BINDING');
    expect((await executeQuery(getIdentityDatabase(f.database), sql`SELECT id FROM identity_external_identities`)).rows).toEqual([]);
  });
});
