import { describe, expect, it } from 'vitest';
import { AccountRoleRepository } from '../../src/identity/drizzle/AccountRoleRepository';

class FakeIdentityDatabase {
  public readonly statements: unknown[] = [];
  private schemaHandled = false;
  public constructor(private readonly responses: Array<{ rows: any[] }> = []) {}

  public async execute(statement: unknown): Promise<{ rows: any[] }> {
    this.statements.push(statement);
    if (!this.schemaHandled) {
      this.schemaHandled = true;
      return { rows: [] };
    }
    return this.responses.shift() ?? { rows: [] };
  }
}

describe('AccountRoleRepository', () => {
  it('reads account roles by accountId', async () => {
    const payload = {
      roles: [ 'admin', 'auditor' ],
      webId: 'https://example.test/admin/profile/card#me',
    };
    const db = new FakeIdentityDatabase([
      { rows: [ { payload } ] },
      { rows: [ { role: 'admin' }, { role: 'auditor' } ] },
    ]);
    const repo = new AccountRoleRepository(db as unknown as any);

    const context = await repo.findByAccountId('account-1');

    expect(context).toEqual({
      accountId: 'account-1',
      webId: payload.webId,
      roles: [ 'admin', 'auditor' ],
    });
    expect(db.statements).toHaveLength(3);
  });

  it('locates account by webId scanning payloads', async () => {
    const db = new FakeIdentityDatabase([
      { rows: [
        { id: 'account-1', payload: { roles: [ 'user' ], pods: [] }},
        { id: 'account-2', payload: { pods: [{ webId: 'https://example.test/admin/profile/card#me' }], roles: ['admin'] }},
      ] },
      { rows: [ { role: 'admin' } ] },
    ]);
    const repo = new AccountRoleRepository(db as unknown as any);

    const context = await repo.findByWebId('https://example.test/admin/profile/card#me');

    expect(context).toEqual({
      accountId: 'account-2',
      webId: 'https://example.test/admin/profile/card#me',
      roles: [ 'admin' ],
    });
  });

  it('returns undefined when webId not found', async () => {
    const db = new FakeIdentityDatabase([
      { rows: [
        { id: 'account-1', payload: { roles: [ 'user' ], pods: [] }},
      ] },
    ]);
    const repo = new AccountRoleRepository(db as unknown as any);

    const context = await repo.findByWebId('https://example.test/missing');

    expect(context).toBeUndefined();
  });
});
