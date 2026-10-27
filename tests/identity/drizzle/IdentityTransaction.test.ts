import { afterAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeAllIdentityConnections, executeQuery, executeStatement, getIdentityDatabase, lockIdentityAccount,
  withIdentityTransaction } from '../../../src/identity/drizzle/db';
import { ServiceTokenRepository } from '../../../src/identity/drizzle/ServiceTokenRepository';

const db = getIdentityDatabase('sqlite::memory:identity-transactions');
afterAll(() => closeAllIdentityConnections());

it('does not roll back an unrelated repository write that reports success', async () => {
  const repository = new ServiceTokenRepository(db);
  await repository.listTokens();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const transaction = withIdentityTransaction(db, async () => {
    enter();
    await released;
    throw new Error('login failed');
  });
  const rejected = expect(transaction).rejects.toThrow('login failed');
  await entered;
  const write = repository.createToken({ serviceType: 'business', serviceId: 'isolated', scopes: [] });
  // Let the concurrent request reach its database operation before rolling back.
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await rejected;
  const created = await write;
  expect(await repository.verifyToken(created.token)).toMatchObject({ id: created.id });
});

it('rolls back repository operations invoked inside the transaction', async () => {
  const repository = new ServiceTokenRepository(db);
  await repository.listTokens();
  let token = '';
  await expect(withIdentityTransaction(db, async () => {
    token = (await repository.createToken({ serviceType: 'business', serviceId: 'rollback', scopes: [] })).token;
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await repository.verifyToken(token)).toBeUndefined();
});

it('keeps unrelated reads and writes outside a failed asynchronous transaction', async () => {
  await executeStatement(db, sql`CREATE TABLE transaction_fixture (id TEXT PRIMARY KEY)`);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const transaction = withIdentityTransaction(db, async () => {
    await executeStatement(db, sql`INSERT INTO transaction_fixture VALUES ('rolled-back')`);
    enter();
    await released;
    throw new Error('fixture failure');
  });
  const rejected = expect(transaction).rejects.toThrow('fixture failure');
  await entered;
  const read = executeQuery(db, sql`SELECT * FROM transaction_fixture`);
  const write = executeStatement(db, sql`INSERT INTO transaction_fixture VALUES ('committed')`);
  release();
  await rejected;
  expect((await read).rows).toEqual([]);
  await write;
  expect((await executeQuery(db, sql`SELECT id FROM transaction_fixture`)).rows).toEqual([{ id: 'committed' }]);
});

it('starts a fresh transaction in a callback inherited from a completed transaction', async () => {
  let delayed!: Promise<void>;
  await withIdentityTransaction(db, async () => {
    delayed = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        withIdentityTransaction(db, async () => {
          await lockIdentityAccount(db, 'delayed');
          await executeStatement(db, sql`CREATE TABLE delayed_transaction_fixture (id TEXT)`);
          throw new Error('delayed failure');
        }).then(() => reject(new Error('expected rollback')), error => {
          if (error.message === 'delayed failure') resolve(); else reject(error);
        });
      }, 0);
    });
  });
  await delayed;
  expect((await executeQuery(db, sql`SELECT name FROM sqlite_master WHERE name = 'delayed_transaction_fixture'`)).rows).toEqual([]);
});
