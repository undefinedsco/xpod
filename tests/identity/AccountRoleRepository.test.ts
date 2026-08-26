import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AccountRoleRepository } from '../../src/identity/drizzle/AccountRoleRepository';
import { executeQuery, executeStatement, getIdentityDatabase } from '../../src/identity/drizzle/db';

async function createDb() {
  const db = getIdentityDatabase(`sqlite::memory:account-role-${Date.now()}-${Math.random()}`);
  await executeStatement(db, sql`
    CREATE TABLE internal_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER
    )
  `);
  return db;
}

async function insertAccountRow(
  db: Awaited<ReturnType<typeof createDb>>,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = typeof payload.id === 'string' ? payload.id : 'account-1';
  await executeStatement(db, sql`
    INSERT INTO internal_kv (key, value)
    VALUES (${`accounts/data/${id}`}, ${JSON.stringify(payload)})
  `);
}

describe('AccountRoleRepository', () => {
  const legacyRoleTable = 'identity_' + 'account_role';

  it('reads account roles from the internal_kv account payload', async () => {
    const db = await createDb();
    await insertAccountRow(db, {
      id: 'account-1',
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

  it('locates an account by internal_kv WebID link records', async () => {
    const db = await createDb();
    await insertAccountRow(db, { id: 'account-1', roles: [ 'user' ] });
    await insertAccountRow(db, {
      id: 'account-2',
      roles: [ 'admin' ],
      '**webIdLink**': {
        'link-1': {
          accountId: 'account-2',
          webId: 'https://example.test/admin/profile/card#me',
        },
      },
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
    await insertAccountRow(db, {
      id: 'account-1',
      roles: [ 'user' ],
      webId: 'https://example.test/admin/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    await repo.addRoles('account-1', [ 'admin', 'user', 'auditor' ]);

    const result = await executeQuery<{ payload: string }>(db, sql`
      SELECT value AS payload FROM internal_kv WHERE key = 'accounts/data/account-1'
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
    await insertAccountRow(db, {
      id: 'account-1',
      roles: [ 'user' ],
      webId: 'https://example.test/user/profile/card#me',
    });
    const repo = new AccountRoleRepository(db);

    const context = await repo.findByWebId('https://example.test/missing');

    expect(context).toBeUndefined();
  });
});
