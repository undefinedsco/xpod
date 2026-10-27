import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BaseAccountStore, WrappedIndexedStorage } from '@solid/community-server';
import { ExternalIdentityAccountStorage } from '../../../src/identity/external/ExternalIdentityAccountStorage';
import { EXTERNAL_LOGIN_TYPE } from '../../../src/identity/external/ExternalIdentityStorage';
import { SqliteKeyValueStorage } from '../../../src/storage/keyvalue/SqliteKeyValueStorage';
import { closeAllIdentityConnections } from '../../../src/identity/drizzle/db';

mkdirSync('.test-data/external-login', { recursive: true });
const directory = mkdtempSync(path.resolve('.test-data/external-login/expiration-'));
let sequence = 0;
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await closeAllIdentityConnections();
  rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const database = `sqlite:${path.join(directory, `${++sequence}.sqlite`)}`;
  const source = new WrappedIndexedStorage<any>(new SqliteKeyValueStorage({ path: database }),
    new SqliteKeyValueStorage({ path: database, namespace: 'index/' }));
  const storage = new ExternalIdentityAccountStorage({ storage: source, identityDbUrl: database });
  const store = new BaseAccountStore(storage);
  await store.handle();
  await storage.defineType('password-test', { accountId: 'id:account' }, true);
  const timers: Array<() => Promise<void>> = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => unknown, delay: number, ...args: any[]) => {
    if (delay !== 1800_000) return Reflect.apply(original, globalThis, [callback, delay, ...args]);
    timers.push(async () => { await callback(...args); });
    return { unref() {} };
  }) as typeof setTimeout);
  const accountId = await store.create();
  expect(timers).toHaveLength(1);
  return { source, storage, accountId, expire: timers[0] };
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const binding = (accountId: string) => ({ accountId, provider: 'wechat', namespace: 'app', subject: 'subject' });

it('removes an expired account that still has no login methods', async () => {
  const { storage, accountId, expire } = await fixture();
  await expire();
  expect(await storage.has('account', accountId)).toBe(false);
});

it.each(['external', 'password'])('waits for a pending first %s binding before checking expiration', async method => {
  const { storage, accountId, expire } = await fixture();
  const bound = latch(), release = latch();
  const pending = storage.withAccountTransaction(accountId, async () => {
    await storage.create(method === 'external' ? EXTERNAL_LOGIN_TYPE : 'password-test',
      method === 'external' ? binding(accountId) : { accountId });
    bound.resolve();
    await release.promise;
  });
  await bound.promise;
  const expired = expire();
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { release.resolve(); await Promise.all([pending, expired]); }
  expect(await storage.has('account', accountId)).toBe(true);
  expect(await storage.find(method === 'external' ? EXTERNAL_LOGIN_TYPE : 'password-test', { accountId })).toHaveLength(1);
});

it('serializes expiration with the first binding instead of deleting a successfully bound account', async () => {
  const { source, storage, accountId, expire } = await fixture();
  const read = latch(), release = latch();
  const original = source.get.bind(source);
  let pause = true;
  vi.spyOn(source, 'get').mockImplementation(async (type, id) => {
    const row = await original(type, id);
    if (pause && type === 'account' && id === accountId) {
      pause = false;
      read.resolve();
      await release.promise;
    }
    return row;
  });
  const expired = expire();
  await read.promise;
  let completed = false;
  const pending = storage.create(EXTERNAL_LOGIN_TYPE, binding(accountId)).then(
    value => { completed = true; return { value }; },
    error => { completed = true; return { error }; },
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(completed).toBe(false);
  } finally { release.resolve(); await expired; await pending; }
  expect(await pending).toMatchObject({ error: { message: 'ACCOUNT_LOGIN_REQUIRED' } });
  expect(await storage.has('account', accountId)).toBe(false);
  expect(await storage.find(EXTERNAL_LOGIN_TYPE, { accountId })).toHaveLength(0);
});
