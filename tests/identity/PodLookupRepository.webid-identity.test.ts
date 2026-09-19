import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PodLookupRepository } from '../../src/identity/drizzle/PodLookupRepository';
import { closeAllIdentityConnections, executeStatement, getIdentityDatabase } from '../../src/identity/drizzle/db';

afterAll(async () => { await closeAllIdentityConnections(); });

describe('Pod lookup preserves complete WebID identity strings', () => {
  it.each(['different-owner', 'exact-owner', 'no-owner'])(
    'does not let an account index override a single Pod explicit identity: %s', async (mode) => {
      const db = getIdentityDatabase(`sqlite::memory:webid-index-${crypto.randomUUID()}`);
      await executeStatement(db, sql`CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
      const webId = 'https://ID.example:443/alice/card#me';
      const owner = mode === 'different-owner' ? new URL(webId).href : webId;
      const pod = { baseUrl: 'https://storage.example/alice/',
        ...(mode === 'no-owner' ? {} : { '**owner**': { owner: { webId: owner } } }) };
      await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${'accounts/data/account'},${JSON.stringify({ '**pod**': { pod } })})`);
      await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`},${JSON.stringify(['account'])})`);
      const repo = new PodLookupRepository(db);
      const expected = mode === 'exact-owner' ? ['pod'] : [];
      expect((await repo.findAllByWebId(webId)).map((entry) => entry.podId)).toEqual(expected);
      expect((await repo.findByWebIds([webId])).map((entry) => entry.podId)).toEqual(expected);
    },
  );

  it.each(['identity-store', 'legacy-kv'])('matches only the original identity in %s', async (source) => {
    const db = getIdentityDatabase(`sqlite::memory:webid-exact-${crypto.randomUUID()}`);
    await executeStatement(db, sql`CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
    await executeStatement(db, sql`CREATE TABLE identity_store (container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(container,id))`);
    const webIds = [
      'https://id.example/alice/profile/card#me',
      'https://ID.example/alice/profile/card#me',
      'https://id.example:443/alice/profile/card#me',
      'https://id.example/alice/profile/card?version=1#me',
      'https://id.example/alice/profile/card#other',
    ];
    for (const [index, webId] of webIds.entries()) {
      const podId = `pod-${index}`;
      const accountId = `account-${index}`;
      const baseUrl = `https://storage.example/${index}/`;
      if (source === 'identity-store') {
        for (const [container, id, payload] of [
          ['pod', podId, { accountId, baseUrl }],
          ['owner', `owner-${index}`, { podId, webId }],
        ] as const) {
          await executeStatement(db, sql`INSERT INTO identity_store VALUES (${container}, ${id}, ${JSON.stringify(payload)})`);
        }
      } else {
        const payload = { '**pod**': { [podId]: { baseUrl, '**owner**': { owner: { webId } } } } };
        await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${`accounts/data/${accountId}`},${JSON.stringify(payload)})`);
        await executeStatement(db, sql`INSERT INTO internal_kv (key,value) VALUES (${`accounts/index/webIdLink/webId/${encodeURIComponent(webId)}`},${JSON.stringify([accountId])})`);
      }
    }
    const repo = new PodLookupRepository(db);
    for (const [index, webId] of webIds.entries()) {
      expect((await repo.findAllByWebId(webId)).map((pod) => pod.podId)).toEqual([`pod-${index}`]);
      expect((await repo.findByWebIds([webId])).map((pod) => pod.podId)).toEqual([`pod-${index}`]);
      expect((await repo.findByWebId(webId))?.webId).toBe(webId);
    }
    await expect(repo.findAllByWebId(` ${webIds[0]} `)).resolves.toEqual([]);
    await expect(repo.findByWebIds([` ${webIds[0]} `])).resolves.toEqual([]);
  });
});
