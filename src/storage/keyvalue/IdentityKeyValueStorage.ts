import type { Finalizable, Initializable, KeyValueStorage } from '@solid/community-server';
import { PostgresKeyValueStorage } from './PostgresKeyValueStorage';
import { SqliteKeyValueStorage } from './SqliteKeyValueStorage';

export interface IdentityKeyValueStorageOptions {
  connectionString: string;
  tableName?: string;
  namespace?: string;
}

export type IdentityKeyValueStorageBackend = 'postgres' | 'sqlite';

export function resolveIdentityKeyValueStorageBackend(connectionString: string): IdentityKeyValueStorageBackend {
  return /^postgres(?:ql)?:\/\//iu.test(connectionString) ? 'postgres' : 'sqlite';
}

/** Selects the durable identity key/value adapter from the configured URL. */
export class IdentityKeyValueStorage<T = unknown> implements
  KeyValueStorage<string, T>, Initializable, Finalizable {
  private readonly delegate: KeyValueStorage<string, T> & Initializable & Finalizable;

  public constructor(options: IdentityKeyValueStorageOptions) {
    if (!options.connectionString) {
      throw new Error('Identity key/value storage requires a connection string.');
    }
    const shared = { tableName: options.tableName, namespace: options.namespace };
    this.delegate = resolveIdentityKeyValueStorageBackend(options.connectionString) === 'postgres'
      ? new PostgresKeyValueStorage<T>({ connectionString: options.connectionString, ...shared })
      : new SqliteKeyValueStorage<T>({ path: options.connectionString, ...shared });
  }

  public async initialize(): Promise<void> {
    await this.delegate.initialize();
  }

  public async finalize(): Promise<void> {
    await this.delegate.finalize();
  }

  public async has(key: string): Promise<boolean> {
    return this.delegate.has(key);
  }

  public async get(key: string): Promise<T | undefined> {
    return this.delegate.get(key);
  }

  public async set(key: string, value: T): Promise<this> {
    await this.delegate.set(key, value);
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    return this.delegate.delete(key);
  }

  public entries(): AsyncIterableIterator<[string, T]> {
    return this.delegate.entries();
  }
}
