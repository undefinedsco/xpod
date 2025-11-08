import Redis from 'ioredis';
import type {
  Finalizable,
  Initializable,
  KeyValueStorage,
} from '@solid/community-server';
import { getLoggerFor } from '@solid/community-server';

export interface RedisKeyValueStorageOptions {
  client: string;
  username?: string;
  password?: string;
  database?: number;
  namespace?: string;
  tls?: boolean;
  scanCount?: number;
}

export class RedisKeyValueStorage<T = unknown> implements
  KeyValueStorage<string, T>,
  Initializable,
  Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly scanCount: number;

  public constructor(options: RedisKeyValueStorageOptions) {
    if (!options.client) {
      throw new Error('Redis client configuration is required.');
    }
    this.prefix = options.namespace ?? 'css:kv:';
    this.scanCount = options.scanCount ?? 100;
    this.client = this.createClient(options);
  }

  public async initialize(): Promise<void> {
    await this.client.ping();
  }

  public async finalize(): Promise<void> {
    await this.client.quit().catch((error: unknown) => {
      this.logger.warn(`Failed to close Redis connection: ${error}`);
    });
  }

  public async has(key: string): Promise<boolean> {
    const result = await this.client.exists(this.toStorageKey(key));
    return result > 0;
  }

  public async get(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.toStorageKey(key));
    if (raw == null) {
      return undefined;
    }
    return this.parse(raw);
  }

  public async set(key: string, value: T): Promise<this> {
    const storageKey = this.toStorageKey(key);
    const payload = JSON.stringify(value ?? null);
    const ttl = this.getTtl(value);
    if (ttl > 0) {
      await this.client.set(storageKey, payload, 'PX', ttl);
    } else {
      await this.client.set(storageKey, payload);
    }
    return this;
  }

  public async delete(key: string): Promise<boolean> {
    const result = await this.client.del(this.toStorageKey(key));
    return result > 0;
  }

  public async *entries(): AsyncIterableIterator<[ string, T ]> {
    const match = `${this.prefix}*`;
    let cursor = '0';
    do {
      const [ nextCursor, keys ] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', this.scanCount);
      cursor = nextCursor;
      if (keys.length === 0) {
        continue;
      }
      const values = await this.client.mget(keys);
      for (let index = 0; index < keys.length; index += 1) {
        const raw = values[index];
        if (raw == null) {
          continue;
        }
        const logicalKey = this.fromStorageKey(keys[index]);
        const value = this.parse(raw);
        if (typeof value === 'undefined') {
          continue;
        }
        yield [ logicalKey, value ];
      }
    } while (cursor !== '0');
  }

  protected createClient(options: RedisKeyValueStorageOptions): Redis {
    if (options.client.startsWith('redis://') || options.client.startsWith('rediss://')) {
      return new Redis(options.client, {
        username: options.username,
        password: options.password,
        db: options.database,
        tls: options.tls ? {} : undefined,
        lazyConnect: false,
      });
    }
    const match = /^(?:([^:]+):)?(\d{2,5})$/u.exec(options.client);
    if (!match) {
      throw new Error(`Invalid Redis client string "${options.client}". Expected "host:port" or "port".`);
    }
    const host = match[1];
    const port = Number.parseInt(match[2], 10);
    return new Redis({
      host: host ?? '127.0.0.1',
      port,
      username: options.username,
      password: options.password,
      db: options.database,
      tls: options.tls ? {} : undefined,
      lazyConnect: false,
    });
  }

  protected toStorageKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  protected fromStorageKey(storageKey: string): string {
    return storageKey.slice(this.prefix.length);
  }

  protected parse(raw: string): T | undefined {
    try {
      return JSON.parse(raw) as T;
    } catch (error: unknown) {
      this.logger.error(`Failed to parse Redis payload: ${error}`);
      return undefined;
    }
  }

  protected getTtl(value: T): number {
    if (!value || typeof value !== 'object') {
      return 0;
    }
    const maybeExpires = (value as Record<string, unknown>).expires;
    if (typeof maybeExpires !== 'string') {
      return 0;
    }
    const expiresAt = Number(new Date(maybeExpires));
    if (Number.isNaN(expiresAt)) {
      return 0;
    }
    const ttl = expiresAt - Date.now();
    return ttl > 0 ? ttl : 0;
  }
}
