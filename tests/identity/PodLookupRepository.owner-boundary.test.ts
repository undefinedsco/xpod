import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { closeAllIdentityConnections, executeStatement, getIdentityDatabase } from '../../src/identity/drizzle/db';

const identities = [
  'https://id.example/alice/card#me',
  'https://ID.example/alice/card#me',
  'https://other.example/alice/card#me',
  'http://id.example/alice/card#me',
  'https://id.example:443/alice/card#me',
  'https://id.example:8443/alice/card#me',
  'https://id.example/other/card#me',
  'https://id.example/alice/card?version=1#me',
  'https://id.example/alice/card#other',
];

afterAll(async () => { await closeAllIdentityConnections(); });

async function database() {
  const db = getIdentityDatabase(`sqlite::memory:pod-owner-${crypto.randomUUID()}`);
  await executeStatement(db, sql`CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
  await executeStatement(db, sql`CREATE TABLE identity_store (container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(container,id))`);
  return db;
}

type Backend = 'identity-store' | 'legacy-kv';
async function insertAccount(
  db: Awaited<ReturnType<typeof database>>,
  backend: Backend,
  pods: Array<{ id: string; webId?: string; owner?: string }>,
  links: string[],
) {
  const podMap: Record<string, unknown> = {};
  for (const pod of pods) {
    const payload = { accountId: 'account', baseUrl: `https://storage.example/${pod.id}/`,
      ...(pod.webId ? { webId: pod.webId } : {}) };
    if (backend === 'identity-store') {
      await executeStatement(db, sql`INSERT INTO identity_store VALUES ('pod',${pod.id},${JSON.stringify(payload)})`);
      if (pod.owner) {
        await executeStatement(db, sql`INSERT INTO identity_store VALUES ('owner',${`owner-${pod.id}`},${JSON.stringify({ podId: pod.id, webId: pod.owner })})`);
      }
    } else {
      podMap[pod.id] = { ...payload, ...(pod.owner ? { '**owner**': { owner: { webId: pod.owner } } } : {}) };
    }
  }
  const linkMap: Record<string, unknown> = {};
  for (const [index, webId] of links.entries()) {
    const payload = { accountId: 'account', webId };
    linkMap[`link-${index}`] = payload;
    if (backend === 'identity-store') {
      await executeStatement(db, sql`INSERT INTO identity_store VALUES ('webIdLink',${`link-${index}`},${JSON.stringify(payload)})`);
    }
    // A link index also identifies only the account; it cannot create ownership.
    await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`},${JSON.stringify(['account'])})`);
  }
  if (backend === 'legacy-kv') {
    await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES ('accounts/data/account',${JSON.stringify({ '**pod**': podMap, '**webIdLink**': linkMap })})`);
  }
}

describe.each(['identity-store', 'legacy-kv'] as const)('explicit Pod ownership in %s', (backend) => {
  it.each([
    [1, 'single'], [1, 'multiple'], [2, 'single'], [2, 'multiple'],
  ] as const)('keeps %s ownerless Pod(s) manageable without inheriting %s account links', async (podCount, linkCount) => {
    const db = await database();
    const links = linkCount === 'single' ? [identities[0]] : identities;
    const pods = Array.from({ length: podCount }, (_, index) => ({ id: `pod-${index}` }));
    await insertAccount(db, backend, pods, links);
    const repo = new PodLookupRepository(db);
    for (const webId of identities) {
      await expect(repo.findByWebId(webId)).resolves.toBeUndefined();
      await expect(repo.findAllByWebId(webId)).resolves.toEqual([]);
    }
    await expect(repo.findByWebIds(identities)).resolves.toEqual([]);
    const managed = await repo.listByAccountId('account');
    expect(managed.map(pod => pod.podId).sort()).toEqual(pods.map(pod => pod.id));
    for (const pod of managed) {
      expect(pod.webId).toBeUndefined();
      expect(pod.webIds).toBeUndefined();
      expect((await repo.findById(pod.podId))?.podId).toBe(pod.podId);
      expect((await repo.findByResourceIdentifier(`${pod.baseUrl}data.ttl`))?.podId).toBe(pod.podId);
    }
  });

  it.each(['owner', 'webId'] as const)('uses only raw explicit %s bindings among all account links', async (binding) => {
    const db = await database();
    const pods = identities.map((webId, index) => ({ id: `pod-${index}`, [binding]: webId }));
    await insertAccount(db, backend, pods, identities);
    const repo = new PodLookupRepository(db);
    for (const [index, webId] of identities.entries()) {
      expect((await repo.findAllByWebId(webId)).map(pod => pod.podId)).toEqual([`pod-${index}`]);
      expect((await repo.findByWebIds([webId])).map(pod => pod.podId)).toEqual([`pod-${index}`]);
      expect((await repo.findByWebId(webId))?.webId).toBe(webId);
    }
  });
});

describe('canonical Pod records shadow legacy duplicates', () => {
  it.each(['different-account-and-base', 'same-account-and-base', 'canonical-ownerless', 'canonical-invalid-owner'] as const)(
    'does not revive a legacy owner with %s', async (mode) => {
      const db = await database();
      const legacyWebId = identities[0];
      const currentWebId = identities[1];
      const currentAccount = mode === 'different-account-and-base' ? 'current-account' : 'account';
      const legacyBase = 'https://storage.example/legacy/';
      const currentBase = mode === 'different-account-and-base' ? 'https://current.example/pod/' : legacyBase;
      const legacy = { '**pod**': { shared: {
        baseUrl: legacyBase, storage: 'https://legacy-storage.example/pod/', nodeId: 'old-node',
        '**owner**': { owner: { webId: legacyWebId } },
      } } };
      await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES ('accounts/data/account',${JSON.stringify(legacy)})`);
      await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${`accounts/index/webIdLink/webId/${encodeURIComponent(legacyWebId)}`},${JSON.stringify(['account'])})`);
      await executeStatement(db, sql`INSERT INTO identity_store VALUES ('pod','shared',${JSON.stringify({ accountId: currentAccount, baseUrl: currentBase })})`);
      if (mode !== 'canonical-ownerless') {
        await executeStatement(db, sql`INSERT INTO identity_store VALUES ('owner','current-owner',${JSON.stringify({ podId: 'shared', webId: mode === 'canonical-invalid-owner' ? 42 : currentWebId })})`);
      }
      const repo = new PodLookupRepository(db);
      await expect(repo.findByWebId(legacyWebId)).resolves.toBeUndefined();
      await expect(repo.findAllByWebId(legacyWebId)).resolves.toEqual([]);
      await expect(repo.findByWebIds([legacyWebId])).resolves.toEqual([]);
      const canonical = await repo.findById('shared');
      expect(canonical).toMatchObject({ accountId: currentAccount, baseUrl: currentBase });
      expect(canonical?.storageUrl).toBeUndefined();
      expect(canonical?.nodeId).toBeUndefined();
      expect(canonical?.webIds).toBeUndefined();
      if (mode === 'canonical-ownerless' || mode === 'canonical-invalid-owner') {
        expect(canonical?.webId).toBeUndefined();
        await expect(repo.findByWebIds([legacyWebId, currentWebId])).resolves.toEqual([]);
      } else {
        expect(canonical?.webId).toBe(currentWebId);
        expect(await repo.findAllByWebId(currentWebId)).toEqual([canonical]);
        expect(await repo.findByWebIds([legacyWebId, currentWebId])).toEqual([canonical]);
      }
      expect(await repo.listByAccountId(currentAccount)).toEqual([canonical]);
      await expect(repo.findByResourceIdentifier('https://legacy-storage.example/pod/file')).resolves.toBeUndefined();
      expect(await repo.findByResourceIdentifier(`${currentBase}file`)).toEqual(canonical);
      if (currentAccount !== 'account') {
        await expect(repo.listByAccountId('account')).resolves.toEqual([]);
      }
    },
  );

  it('retains multiple explicit owners within the canonical Pod record', async () => {
    const db = await database();
    await insertAccount(db, 'identity-store', [{ id: 'shared', owner: identities[0] }], []);
    await executeStatement(db, sql`INSERT INTO identity_store VALUES ('owner','second-owner',${JSON.stringify({ podId: 'shared', webId: identities[1] })})`);
    const repo = new PodLookupRepository(db);
    for (const webId of identities.slice(0, 2)) {
      expect((await repo.findByWebId(webId))?.webId).toBe(webId);
      expect((await repo.findByWebId(webId))?.webIds).toEqual(identities.slice(0, 2));
    }
  });
});


it.each(['{', JSON.stringify({ accountId: 'account' }), JSON.stringify({ baseUrl: 'https://current.example/pod/' })])(
  'does not resurrect a legacy Pod behind an invalid canonical record: %s', async (payload) => {
    const db = await database();
    await insertAccount(db, 'legacy-kv', [{ id: 'shared', owner: identities[0] }], [identities[0]]);
    await executeStatement(db, sql`INSERT INTO identity_store VALUES ('pod','shared',${payload})`);
    const repo = new PodLookupRepository(db);
    await expect(repo.findById('shared')).resolves.toBeUndefined();
    await expect(repo.findAllByWebId(identities[0])).resolves.toEqual([]);
    await expect(repo.findByWebIds([identities[0]])).resolves.toEqual([]);
    await expect(repo.listByAccountId('account')).resolves.toEqual([]);
    await expect(repo.listAllPods()).resolves.toEqual([]);
    await expect(repo.findByResourceIdentifier('https://storage.example/shared/file')).resolves.toBeUndefined();
  },
);

// A canonical read error must never make an old KV owner authoritative again.
describe('canonical read failures', () => {
  const legacyRow = {
    key: 'accounts/data/account',
    value: JSON.stringify({ '**pod**': { pod: {
      baseUrl: 'https://storage.example/pod/', webId: identities[0],
    } } }),
  };
  it.each([
    Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('permission denied for table identity_store'), { code: '42501' }),
    Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
    new Error('malformed canonical query'),
    Object.assign(new Error('relation "unrelated" does not exist'), { code: '42P01' }),
  ])('propagates canonical failure instead of using legacy ownership: %s', async (failure) => {
    let query = 0;
    const db = { execute: async () => {
      query++;
      if (query === 1) return { rows: [legacyRow] };
      if (query === 2) return { rows: [] };
      throw failure;
    } };
    await expect(new PodLookupRepository(db).findByWebId(identities[0])).rejects.toBe(failure);
  });

  it.each([
    Object.assign(new Error('relation "identity_store" does not exist'), { code: '42P01' }),
    { cause: Object.assign(new Error('relation "identity_store" does not exist'), { code: '42P01' }) },
  ])('supports legacy-only storage when the canonical table is absent', async (failure) => {
    let query = 0;
    const db = { execute: async () => {
      query++;
      if (query === 1) return { rows: [legacyRow] };
      if (query === 2) return { rows: [] };
      throw failure;
    } };
    expect((await new PodLookupRepository(db).findByWebId(identities[0]))?.webId).toBe(identities[0]);
  });
});
