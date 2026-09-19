import { afterAll, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import {
  closeAllIdentityConnections,
  executeStatement,
  getIdentityDatabase,
  type IdentityDatabase,
} from '../../src/identity/drizzle/db';

const webId = 'https://id.example/alice/profile/card#me';

async function createDatabase(): Promise<IdentityDatabase> {
  const db = getIdentityDatabase(`sqlite::memory:pod-lookup-legacy-${crypto.randomUUID()}`);
  await executeStatement(db, sql`
    CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)
  `);
  await executeStatement(db, sql`
    CREATE TABLE identity_store (
      container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (container, id)
    )
  `);
  return db;
}

async function insertIdentity(db: IdentityDatabase, container: string, id: string, payload: Record<string, unknown>): Promise<void> {
  await executeStatement(db, sql`
    INSERT INTO identity_store (container, id, payload) VALUES (${container}, ${id}, ${JSON.stringify(payload)})
  `);
}

async function insertLegacyAccount(db: IdentityDatabase, key: string, pods: Record<string, unknown>): Promise<void> {
  // Deliberately no accounts/index row: historical account data remains readable.
  await executeStatement(db, sql`
    INSERT INTO internal_kv (key, value) VALUES (${key}, ${JSON.stringify({ '**pod**': pods })})
  `);
}

afterAll(async () => { await closeAllIdentityConnections(); });

describe('PodLookupRepository historical storage compatibility', () => {
  it.each(['findAllByWebId', 'findByWebIds'] as const)(
    '%s includes unindexed legacy Pods even when identity_store already matches the WebID',
    async (method) => {
      const db = await createDatabase();
      await insertIdentity(db, 'pod', 'pod-a', { accountId: 'account-a', baseUrl: 'https://cloud.example/alice/' });
      await insertIdentity(db, 'owner', 'owner-a', { podId: 'pod-a', webId });
      await insertLegacyAccount(db, 'accounts/data/account-b', {
        'pod-b': { baseUrl: 'https://local.example/alice/', '**owner**': { 'owner-b': { webId } } },
      });
      const repo = new PodLookupRepository(db);
      const all = await repo.listAllPods();
      expect(all.map((pod) => pod.podId).sort()).toEqual(['pod-a', 'pod-b']);
      expect(all.every((pod) => pod.webId === webId)).toBe(true);

      const matches = method === 'findAllByWebId'
        ? await repo.findAllByWebId(webId)
        : await repo.findByWebIds([webId]);
      expect(matches.map((pod) => pod.podId).sort()).toEqual(['pod-a', 'pod-b']);
      expect(matches.every((pod) => pod.webId === webId)).toBe(true);
    },
  );

  it('keeps successful identity_store lookups targeted instead of scanning its whole table', async () => {
    const db = await createDatabase();
    await insertIdentity(db, 'pod', 'pod-indexed', { accountId: 'account-indexed', baseUrl: 'https://cloud.example/alice/' });
    await insertIdentity(db, 'owner', 'owner-indexed', { podId: 'pod-indexed', webId });
    const repo = new PodLookupRepository(db);
    const scan = vi.spyOn(repo as unknown as { getPodsFromIndexedStore(): Promise<unknown[]> }, 'getPodsFromIndexedStore');
    try {
      expect((await repo.findById('pod-indexed'))?.podId).toBe('pod-indexed');
      expect((await repo.listByAccountId('account-indexed')).map((pod) => pod.podId)).toEqual(['pod-indexed']);
      expect((await repo.findAllByWebId(webId)).map((pod) => pod.podId)).toEqual(['pod-indexed']);
      expect((await repo.findByWebIds([webId])).map((pod) => pod.podId)).toEqual(['pod-indexed']);
      expect(scan).not.toHaveBeenCalled();
    } finally { scan.mockRestore(); }
  });

  it.each(['account', 'webId', 'resource', 'id'] as const)(
    'keeps the container index searchable for actual %s lookup SQL', async (lookup) => {
      const db = await createDatabase();
      await insertIdentity(db, 'pod', 'pod-indexed', {
        accountId: 'account-indexed', baseUrl: 'https://cloud.example/alice/', webId,
      });
      await insertIdentity(db, 'owner', 'owner-indexed', { podId: 'pod-indexed', webId });
      // Malformed canonical data must remain safe without hiding container from the planner.
      await executeStatement(db, sql`INSERT INTO identity_store VALUES ('pod', 'malformed', '{')`);
      const dialect = new SQLiteSyncDialect();
      const all = db.all.bind(db);
      const plans: string[] = [];
      const spy = vi.spyOn(db, 'all').mockImplementation((query: SQL) => {
        if (dialect.sqlToQuery(query).sql.includes('FROM "identity_store"')) {
          const rows = all(sql`EXPLAIN QUERY PLAN ${query}`) as Array<{ detail: string }>;
          plans.push(...rows.map((row) => row.detail));
        }
        return all(query);
      });
      try {
        const repo = new PodLookupRepository(db);
        const result = lookup === 'account' ? await repo.listByAccountId('account-indexed')
          : lookup === 'webId' ? await repo.findAllByWebId(webId)
          : lookup === 'resource' ? [await repo.findByResourceIdentifier('https://cloud.example/alice/file')]
          : [await repo.findById('pod-indexed')];
        expect(result.map((pod) => pod?.podId)).toEqual(['pod-indexed']);
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.every((plan) => /SEARCH identity_store .*container=\?/u.test(plan)), plans.join('\n')).toBe(true);
      } finally { spy.mockRestore(); }
    },
  );

  it('listByAccountId retains accounts/data/<id>.json records visible to listAllPods', async () => {
    const db = await createDatabase();
    await insertLegacyAccount(db, 'accounts/data/account-legacy.json', {
      'pod-legacy': { baseUrl: 'https://legacy.example/alice/', '**owner**': { 'owner-legacy': { webId } } },
    });
    await insertLegacyAccount(db, 'accounts/data/account-other', {
      'pod-other': { baseUrl: 'https://legacy.example/bob/' },
    });
    const repo = new PodLookupRepository(db);
    const expected = (await repo.listAllPods()).filter((pod) => pod.accountId === 'account-legacy');
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ podId: 'pod-legacy', accountId: 'account-legacy', webId });
    await expect(repo.listByAccountId('account-legacy')).resolves.toEqual(expected);
  });

  it('findById uses the complete canonical record without reviving legacy ownership', async () => {
    const db = await createDatabase();
    const otherWebId = 'https://id.example/alice/profile/card#secondary';
    await insertIdentity(db, 'pod', 'pod-shared', {
      accountId: 'account-shared', baseUrl: 'https://indexed.example/alice/',
      storageUrl: 'https://indexed-storage.example/alice/', nodeId: 'indexed-node',
    });
    await insertIdentity(db, 'owner', 'owner-indexed', { podId: 'pod-shared', webId: otherWebId });
    await insertLegacyAccount(db, 'accounts/data/account-shared', {
      'pod-shared': {
        baseUrl: 'https://legacy.example/alice/', storageUrl: 'https://legacy-storage.example/alice/',
        nodeId: 'legacy-node', '**owner**': { 'owner-legacy': { webId } },
      },
    });
    const repo = new PodLookupRepository(db);
    const all = await repo.listAllPods();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      podId: 'pod-shared', baseUrl: 'https://indexed.example/alice/',
      storageUrl: 'https://indexed-storage.example/alice/', nodeId: 'indexed-node',
      webId: otherWebId,
    });
    await expect(repo.findById('pod-shared')).resolves.toEqual(all[0]);
    await expect(repo.findByWebId(webId)).resolves.toBeUndefined();
    expect(all[0].webIds).toBeUndefined();
  });
});
