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
});
