import { AsyncLocalStorage } from 'node:async_hooks';
import { getLoggerFor } from 'global-logger-factory';
import { BaseLoginAccountStorage, ForbiddenHttpError, NotFoundHttpError, type IndexedStorage, type LoginStorage } from '@solid/community-server';
import { getIdentityDatabase, lockIdentityAccount, withIdentityTransaction } from '../drizzle/db';
import { DrizzleIndexedStorage } from '../drizzle/DrizzleIndexedStorage';
import { LoginMethodGuardStorage } from '../LoginMethodGuardStorage';
import { EXTERNAL_LOGIN_DESCRIPTION, EXTERNAL_LOGIN_TYPE, ExternalIdentityStorage } from './ExternalIdentityStorage';

export interface ExternalIdentityAccountStorageOptions {
  storage: IndexedStorage<any>;
  identityDbUrl: string;
  /** Preserve CSS's default policy locally; Cloud permits permanent passwordless accounts. */
  allowPasswordlessAccounts?: boolean;
}

const ACCOUNT_EXPIRATION_SECONDS = 30 * 60;

/** Reuse CSS's account policy while coordinating its background expiration hook. */
class TransactionalLocalLoginStorage extends BaseLoginAccountStorage<any> {
  public constructor(storage: IndexedStorage<any>, private readonly expireAccount: (id: string) => Promise<void>) {
    super(storage, ACCOUNT_EXPIRATION_SECONDS);
  }

  protected override createAccountTimeout(id: string): void {
    const timer = setTimeout(async () => {
      try { await this.expireAccount(id); }
      catch (error) {
        getLoggerFor(this).error(`Failed to remove expired account ${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }, ACCOUNT_EXPIRATION_SECONDS * 1000);
    timer.unref();
  }
}

/** One CSS LoginStorage with SQL external identities and account-scoped mutation coordination. */
export class ExternalIdentityAccountStorage implements LoginStorage<any> {
  private readonly db;
  private readonly identities: ExternalIdentityStorage;
  private readonly policy: LoginStorage<any>;
  private readonly accountKeys = new Map<string, string>();
  private readonly mutations = new AsyncLocalStorage<{ created: Set<string>; counts: Map<string, number>; active: boolean }>();
  private ready?: Promise<void>;

  public constructor(private readonly options: ExternalIdentityAccountStorageOptions) {
    this.db = getIdentityDatabase(options.identityDbUrl);
    this.identities = new ExternalIdentityStorage(options.storage, options.identityDbUrl);
    this.policy = options.allowPasswordlessAccounts ? new LoginMethodGuardStorage(this.identities)
      : new TransactionalLocalLoginStorage(this.identities, id => this.expireAccount(id));
  }

  private initialize(): Promise<void> {
    return this.ready ??= (async () => {
      // Legacy-file migration may precede AccountStore's initializer.
      await this.options.storage.defineType('account', { rememberLogin: 'boolean?', linkedLoginsCount: 'number?' });
      await this.identities.initialize();
      await this.policy.defineType(EXTERNAL_LOGIN_TYPE, EXTERNAL_LOGIN_DESCRIPTION, true);
      this.accountKeys.set(EXTERNAL_LOGIN_TYPE, 'accountId');
    })();
  }

  /** Registration uses this boundary so SQL account creation rolls back with identity creation. */
  public async withTransaction<T>(action: () => Promise<T>, lockKey?: string): Promise<T> {
    await this.initialize();
    await this.identities.prepare();
    const run = async () => {
      if (lockKey) await lockIdentityAccount(this.db, lockKey);
      return action();
    };
    if (this.mutations.getStore()?.active) return withIdentityTransaction(this.db, run);
    const created = new Set<string>();
    const counts = new Map<string, number>();
    const mutation = { created, counts, active: true };
    try {
      return await this.mutations.run(mutation, () => withIdentityTransaction(this.db, async () => {
        try { return await run(); } catch (error) {
          // File-backed CSS stores cannot join SQL rollback. Compensate before
          // releasing account locks. Local SqliteKeyValueStorage joins SQL rollback.
          if (!(this.options.storage instanceof DrizzleIndexedStorage)) {
            for (const [id, count] of counts) {
              if (!created.has(id) && await this.options.storage.has('account', id)) {
                await this.options.storage.setField('account', id, 'linkedLoginsCount', count);
              }
            }
            for (const id of created) await this.options.storage.delete('account', id);
          }
          throw error;
        }
      }));
    } finally { mutation.active = false; }
  }

  public async withAccountTransaction<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    return this.mutate(EXTERNAL_LOGIN_TYPE, accountId, action);
  }

  private async expireAccount(accountId: string): Promise<void> {
    await this.mutate('account', accountId, async () => {
      // Re-read after acquiring the same lock used by first-login creation.
      const account = await this.identities.get('account', accountId);
      if (account?.linkedLoginsCount === 0) await this.identities.delete('account', accountId);
    });
  }

  private async mutate<T>(type: string, accountId: string | undefined, action: () => Promise<T>): Promise<T> {
    return this.withTransaction(async () => {
      if (accountId) {
        await lockIdentityAccount(this.db, `account:${accountId}`);
        if (type !== 'account' && !await this.identities.has('account', accountId)) throw new ForbiddenHttpError('ACCOUNT_LOGIN_REQUIRED');
        if (!(this.options.storage instanceof DrizzleIndexedStorage) && !this.mutations.getStore()!.counts.has(accountId)) {
          const account = await this.options.storage.get('account', accountId);
          if (typeof account?.linkedLoginsCount === 'number') this.mutations.getStore()!.counts.set(accountId, account.linkedLoginsCount);
        }
      }
      return action();
    });
  }

  public async defineType(type: string, description: any, isLogin: boolean): Promise<void> {
    await this.initialize();
    const key = Object.entries(description as Record<string, unknown>).find(([, value]) => value === 'id:account')?.[0];
    if (key) this.accountKeys.set(type, key);
    await this.policy.defineType(type, description, isLogin);
  }
  public async createIndex(type: string, key: string): Promise<void> { await this.initialize(); return this.policy.createIndex(type, key); }
  public async create(type: string, value: any): Promise<any> {
    await this.initialize();
    return this.mutate(type, value[this.accountKeys.get(type) ?? ''], async () => {
      const row = await this.policy.create(type, value);
      if (type === 'account') this.mutations.getStore()?.created.add(row.id);
      return row;
    });
  }
  public async has(type: string, id: string): Promise<boolean> { await this.initialize(); return this.policy.has(type, id); }
  public async get(type: string, id: string): Promise<any> { await this.initialize(); return this.policy.get(type, id); }
  public async find(type: string, query: any): Promise<any[]> { await this.initialize(); return this.policy.find(type, query); }
  public async findIds(type: string, query: any): Promise<string[]> { await this.initialize(); return this.policy.findIds(type, query); }
  private async update(type: string, id: string, action: (current: any) => Promise<void>): Promise<void> {
    await this.initialize();
    const current = await this.policy.get(type, id);
    if (!current) throw new NotFoundHttpError('Unknown account storage object');
    const accountId = type === 'account' ? id : current[this.accountKeys.get(type) ?? ''] as string | undefined;
    await this.mutate(type, accountId, async () => {
      const latest = await this.policy.get(type, id);
      if (!latest) throw new NotFoundHttpError('Unknown account storage object');
      await action(latest);
    });
  }
  public async set(type: string, value: any): Promise<void> {
    return this.update(type, value.id, async current => {
      const key = this.accountKeys.get(type);
      if (key && current[key] !== value[key]) throw new ForbiddenHttpError('ACCOUNT_RELATION_IMMUTABLE');
      await this.policy.set(type, value);
    });
  }
  public async setField(type: string, id: string, key: string, value: any): Promise<void> {
    return this.update(type, id, async current => {
      if (key === this.accountKeys.get(type) && current[key] !== value) throw new ForbiddenHttpError('ACCOUNT_RELATION_IMMUTABLE');
      await this.policy.setField(type, id, key, value);
    });
  }
  public async delete(type: string, id: string): Promise<void> {
    return this.update(type, id, async () => this.policy.delete(type, id));
  }
  public async *entries(type: string): AsyncIterableIterator<any> { await this.initialize(); yield* this.policy.entries(type); }
}
