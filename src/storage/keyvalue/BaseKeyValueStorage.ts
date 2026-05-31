import type {
  Finalizable,
  Initializable,
  KeyValueStorage,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';

export interface BaseKeyValueStorageOptions {
  tableName?: string;
  namespace?: string;
}

export interface BaseKeyValueStorageRow {
  key: string;
  value: unknown;
}

export abstract class BaseKeyValueStorage<T = unknown> implements
  KeyValueStorage<string, T>,
  Initializable,
  Finalizable {
  protected readonly logger = getLoggerFor(this);
  protected readonly tableName: string;
  protected readonly namespace: string;

  private ready: Promise<void> = Promise.resolve();

  protected constructor(options: BaseKeyValueStorageOptions) {
    this.tableName = options.tableName ?? 'internal_kv';
    this.namespace = options.namespace ?? '';
    assertIdentifier(this.tableName);
  }

  protected setReady(ready: Promise<void>): void {
    this.ready = ready;
  }

  public async initialize(): Promise<void> {
    await this.ready;
  }

  public async finalize(): Promise<void> {
    await this.ready;
    await this.closeStorage();
  }

  public async has(key: string): Promise<boolean> {
    await this.ready;
    return this.hasValue(this.toStorageKey(key));
  }

  public async get(key: string): Promise<T | undefined> {
    await this.ready;
    const raw = await this.selectValue(this.toStorageKey(key));
    if (typeof raw === 'undefined') {
      return undefined;
    }
    return this.parseValue(raw);
  }

  public async set(key: string, value: T): Promise<this> {
    await this.ready;
    const storageKey = this.toStorageKey(key);

    let payload: string;
    try {
      payload = this.validateAndSerialize(value, key);
    } catch (error: unknown) {
      this.logger.error(`Failed to serialize value for key "${key}": ${error}`);
      throw error;
    }

    await this.upsertValue(storageKey, payload);
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    await this.ready;
    return this.deleteValue(this.toStorageKey(key));
  }

  public async *entries(): AsyncIterableIterator<[ string, T ]> {
    await this.ready;
    const prefix = this.namespace;
    const rows = await this.selectEntries(prefix);

    for (const row of rows) {
      if (!row.key.startsWith(prefix)) {
        continue;
      }

      const logicalKey = row.key.slice(prefix.length);
      const value = this.parseValue(row.value);
      if (typeof value === 'undefined') {
        continue;
      }

      yield [ logicalKey, value ];
    }
  }

  protected toStorageKey(key: string): string {
    return `${this.namespace}${key}`;
  }

  protected validateAndSerialize(value: T, key: string): string {
    try {
      const payload = JSON.stringify(value ?? null);
      if (payload === 'undefined') {
        throw new Error('Cannot serialize undefined value');
      }
      JSON.parse(payload);
      return payload;
    } catch (error: unknown) {
      this.logger.error(`JSON serialization failed for key "${key}": ${error}`);
      throw new Error(`JSON serialization failed for key "${key}": ${error}`);
    }
  }

  protected parseValue(raw: unknown): T | undefined {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (parsed && typeof parsed === 'object' && 'key' in parsed && 'payload' in parsed) {
        return (parsed as { payload: T }).payload;
      }

      return parsed as T;
    } catch (error: unknown) {
      this.logger.error(`Failed to parse stored value: ${error}. Raw value: ${JSON.stringify(raw)}`);
      return undefined;
    }
  }

  protected abstract closeStorage(): Promise<void>;
  protected abstract hasValue(key: string): Promise<boolean>;
  protected abstract selectValue(key: string): Promise<unknown | undefined>;
  protected abstract upsertValue(key: string, payload: string): Promise<void>;
  protected abstract deleteValue(key: string): Promise<boolean>;
  protected abstract selectEntries(prefix: string): Promise<BaseKeyValueStorageRow[]>;
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z0-9_]+$/u.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Only alphanumeric and underscore are allowed.`);
  }
}
