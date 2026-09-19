import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AccountRoleRepository } from '../../src/identity/drizzle/AccountRoleRepository';
import { executeQuery, executeStatement, getIdentityDatabase } from '../../src/identity/drizzle/db';

async function createDb() {
  const db = getIdentityDatabase(`sqlite::memory:account-role-${Date.now()}-${Math.random()}`);
  await executeStatement(db, sql`
    CREATE TABLE identity_store (
      container TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (container, id)
    )
  `);
  return db;
}

async function insertIdentityStoreRow(
  db: Awaited<ReturnType<typeof createDb>>,
  container: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await executeStatement(db, sql`
    INSERT INTO identity_store (container, id, payload)
    VALUES (${container}, ${id}, ${JSON.stringify(payload)})
  `);
}

describe('AccountRoleRepository', () => {
  const legacyRoleTable = 'identity_' + 'account_role';

  it('does not turn a padded persisted WebID into an authorized identity', async () => {
    const db = await createDb();
    const webId = 'https://ID.example:443/alice/card#me';
    await insertIdentityStoreRow(db, 'account', 'padded', { roles: ['admin'], webId: ` ${webId} ` });
    await insertIdentityStoreRow(db, 'webIdLink', 'padded-link', { accountId: 'padded', webId: ` ${webId} ` });
    const repo = new AccountRoleRepository(db);
    await expect(repo.findByWebId(webId)).resolves.toBeUndefined();
    await expect(repo.findByWebId(` ${webId} `)).resolves.toBeUndefined();
    expect((await repo.findByAccountId('padded'))?.webId).toBeUndefined();
    await insertIdentityStoreRow(db, 'account', 'exact', { roles: ['user'], webId });
    await expect(repo.findByWebId(webId)).resolves.toMatchObject({ accountId: 'exact', webId });
    await expect(repo.findByWebId(new URL(webId).href)).resolves.toBeUndefined();
  });

  it('reads account roles from the identity_store account payload', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-1', {
      roles: [ 'admin', 'auditor' ],
      webId: 'https://example.test/admin/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByAccountId('account-1');

    expect(context).toEqual({
      accountId: 'account-1',
      webId: 'https://example.test/admin/profile/card#me',
      roles: [ 'admin', 'auditor' ],
    });
  });

  it('locates an account by identity_store WebID link records', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-1', { roles: [ 'user' ] });
    await insertIdentityStoreRow(db, 'account', 'account-2', { roles: [ 'admin' ] });
    await insertIdentityStoreRow(db, 'webIdLink', 'link-1', {
      accountId: 'account-2',
      webId: 'https://example.test/admin/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByWebId('https://example.test/admin/profile/card#me');

    expect(context).toEqual({
      accountId: 'account-2',
      webId: 'https://example.test/admin/profile/card#me',
      roles: [ 'admin' ],
    });
  });

  it('merges roles back into the existing account payload instead of a side table', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-1', {
      roles: [ 'user' ],
      webId: 'https://example.test/admin/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    await repo.addRoles('account-1', [ 'admin', 'user', 'auditor' ]);

    const result = await executeQuery<{ payload: string }>(db, sql`
      SELECT payload FROM identity_store WHERE container = 'account' AND id = 'account-1'
    `);
    const payload = JSON.parse(result.rows[0].payload) as Record<string, unknown>;
    expect(payload.roles).toEqual([ 'user', 'admin', 'auditor' ]);

    const tables = await executeQuery<{ name: string }>(db, sql`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `);
    expect(tables.rows.map((row) => row.name)).not.toContain(legacyRoleTable);
  });

  it('returns undefined when webId is not known', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-1', {
      roles: [ 'user' ],
      webId: 'https://example.test/user/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByWebId('https://example.test/missing');

    expect(context).toBeUndefined();
  });

  it('finds accounts by the webId field embedded in the account payload', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-9', {
      roles: [ 'user' ],
      webId: 'https://example.test/embedded/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByWebId('https://example.test/embedded/profile/card#me');

    expect(context).toEqual({
      accountId: 'account-9',
      webId: 'https://example.test/embedded/profile/card#me',
      roles: [ 'user' ],
    });
  });

  it('resolves webIds through the owner → pod chain', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-3', { roles: [] });
    await insertIdentityStoreRow(db, 'pod', 'pod-1', {
      accountId: 'account-3',
      baseUrl: 'https://pods.example.test/alice/',
    });
    await insertIdentityStoreRow(db, 'owner', 'owner-1', {
      podId: 'pod-1',
      webId: 'https://pods.example.test/alice/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const byWebId = await repo.findByWebId('https://pods.example.test/alice/profile/card#me');
    expect(byWebId?.accountId).toBe('account-3');

    const byAccount = await repo.findByAccountId('account-3');
    expect(byAccount?.webId).toBe('https://pods.example.test/alice/profile/card#me');
  });

  it('prefers webIdLink rows over embedded account webId fields', async () => {
    const db = await createDb();
    await insertIdentityStoreRow(db, 'account', 'account-4', {
      roles: [],
      webId: 'https://example.test/old/profile/card#me',
    });
    await insertIdentityStoreRow(db, 'webIdLink', 'link-4', {
      accountId: 'account-4',
      webId: 'https://example.test/new/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByAccountId('account-4');

    expect(context?.webId).toBe('https://example.test/new/profile/card#me');
  });
});
