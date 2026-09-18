import { getLoggerFor } from 'global-logger-factory';
import type {
  IndexedStorage,
  LoginStorage,
} from '@solid/community-server';
import {
  ACCOUNT_TYPE,
  BadRequestHttpError,
  NotFoundHttpError,
} from '@solid/community-server';

/**
 * A {@link LoginStorage} wrapper that keeps the CSS account protection which fits
 * Xpod's account model: **the last login method of an account cannot be deleted**.
 *
 * Unlike CSS `BaseLoginAccountStorage` it deliberately does NOT:
 * - require a login method before creating non-login rows — SP-linked cloud accounts
 *   are created without passwords and receive pods through provision receipts;
 * - expire passwordless accounts — those SP custody accounts are legitimate and permanent.
 *
 * @param storage - The underlying IndexedStorage holding the actual rows.
 */
export class LoginMethodGuardStorage implements LoginStorage<any> {
  private readonly logger = getLoggerFor(this);
  private readonly storage: IndexedStorage<any>;
  private readonly loginTypes = new Set<string>();
  private readonly accountKeys: Record<string, string | undefined> = {};

  public constructor(storage: IndexedStorage<any>) {
    this.storage = storage;
  }

  public async defineType(type: string, description: any, isLogin: boolean): Promise<void> {
    this.accountKeys[type] = Object.entries(description as Record<string, unknown>)
      .find(([, desc]) => desc === `id:${ACCOUNT_TYPE}`)?.[0];
    if (isLogin) {
      this.loginTypes.add(type);
    }
    return this.storage.defineType(type, description);
  }

  public async createIndex(type: string, key: string): Promise<void> {
    return this.storage.createIndex(type, key);
  }

  public async create(type: string, value: any): Promise<any> {
    return this.storage.create(type, value);
  }

  public async has(type: string, id: string): Promise<boolean> {
    return this.storage.has(type, id);
  }

  public async get(type: string, id: string): Promise<any | undefined> {
    return this.storage.get(type, id);
  }

  public async find(type: string, query: any): Promise<any[]> {
    return this.storage.find(type, query);
  }

  public async findIds(type: string, query: any): Promise<string[]> {
    return this.storage.findIds(type, query);
  }

  public async set(type: string, value: any): Promise<void> {
    return this.storage.set(type, value);
  }

  public async setField(type: string, id: string, key: string, value: any): Promise<void> {
    return this.storage.setField(type, id, key, value);
  }

  public async delete(type: string, id: string): Promise<void> {
    if (this.loginTypes.has(type)) {
      await this.assertNotLastLoginMethod(type, id);
    }
    return this.storage.delete(type, id);
  }

  public async *entries(type: string): AsyncIterableIterator<any> {
    yield* this.storage.entries(type);
  }

  private async assertNotLastLoginMethod(type: string, id: string): Promise<void> {
    const accountKey = this.accountKeys[type];
    const original = await this.storage.get(type, id);
    if (!original) {
      throw new NotFoundHttpError(`Unknown object of type ${type} with ID ${id}`);
    }
    if (!accountKey) {
      return;
    }
    const accountId = original[accountKey] as string;
    let remaining = 0;
    for (const loginType of this.loginTypes) {
      const key = this.accountKeys[loginType];
      if (!key) {
        continue;
      }
      remaining += (await this.storage.findIds(loginType, { [key]: accountId })).length;
    }
    if (remaining <= 1) {
      this.logger.warn(`Trying to remove last login method from account ${accountId}`);
      throw new BadRequestHttpError('An account needs at least 1 login method.');
    }
  }
}
