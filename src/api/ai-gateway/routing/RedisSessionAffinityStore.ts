import Redis from 'ioredis';
import { getLoggerFor } from 'global-logger-factory';

import {
  affinityStorageKey,
  cooldownStorageKey,
  isExpired,
  type CredentialCooldownIdentity,
  type SessionAffinityEntry,
  type SessionAffinityIdentity,
  type SessionAffinityStore,
} from './SessionAffinityStore';
import {
  attachRedisClientErrorHandler,
  closeRedisClient,
} from '../../../storage/redis/RedisClientLifecycle';

export interface RedisSessionAffinityStoreOptions {
  client: string | RedisSessionAffinityRedisClient;
  namespace?: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface RedisSessionAffinityRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface StoredAffinityEntry extends Omit<SessionAffinityEntry, 'expiresAt'> {
  expiresAt?: string;
}

export class RedisSessionAffinityStore implements SessionAffinityStore {
  protected readonly logger = getLoggerFor(this);
  private readonly client: RedisSessionAffinityRedisClient;
  private readonly ownClient: Redis | undefined;
  private readonly prefix: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private shuttingDown = false;

  public constructor(options: RedisSessionAffinityStoreOptions) {
    this.prefix = options.namespace ?? 'xpod:';
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    if (typeof options.client === 'string') {
      this.ownClient = new Redis(options.client, { lazyConnect: false });
      attachRedisClientErrorHandler(this.ownClient, {
        logger: this.logger,
        label: 'RedisSessionAffinityStore',
        isShuttingDown: () => this.shuttingDown,
      });
      this.client = this.ownClient;
    } else {
      this.client = options.client;
    }
  }

  public async finalize(): Promise<void> {
    if (!this.ownClient) {
      return;
    }
    this.shuttingDown = true;
    await closeRedisClient(this.ownClient, {
      logger: this.logger,
      label: 'RedisSessionAffinityStore',
    });
  }

  public async get(input: SessionAffinityIdentity): Promise<SessionAffinityEntry | undefined> {
    const raw = await this.client.get(this.toKey(affinityStorageKey(input)));
    const entry = this.parseAffinity(raw);
    if (!entry) {
      return undefined;
    }
    const expiresAt = entry.expiresAt ? new Date(entry.expiresAt) : undefined;
    if (isExpired(expiresAt, this.now())) {
      await this.delete(input);
      return undefined;
    }
    return {
      ...entry,
      expiresAt,
    };
  }

  public async set(input: SessionAffinityEntry): Promise<void> {
    const expiresAt = input.expiresAt ?? new Date(this.now().getTime() + this.ttlMs);
    await this.setWithTtl(this.toKey(affinityStorageKey(input)), {
      ...input,
      expiresAt: expiresAt.toISOString(),
    }, expiresAt);
  }

  public async delete(input: SessionAffinityIdentity): Promise<void> {
    await this.client.del(this.toKey(affinityStorageKey(input)));
  }

  public async getCooldown(input: CredentialCooldownIdentity): Promise<Date | undefined> {
    const raw = await this.client.get(this.toKey(cooldownStorageKey(input)));
    if (!raw) {
      return undefined;
    }
    const until = new Date(raw);
    if (!Number.isFinite(until.getTime()) || isExpired(until, this.now())) {
      await this.client.del(this.toKey(cooldownStorageKey(input)));
      return undefined;
    }
    return until;
  }

  public async setCooldown(input: CredentialCooldownIdentity & { until: Date }): Promise<void> {
    await this.setWithTtl(this.toKey(cooldownStorageKey(input)), input.until.toISOString(), input.until);
  }

  private async setWithTtl(key: string, value: unknown, expiresAt: Date): Promise<void> {
    const ttl = Math.max(1, expiresAt.getTime() - this.now().getTime());
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    await this.client.set(key, payload, 'PX', ttl);
  }

  private toKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private parseAffinity(raw: string | null): StoredAffinityEntry | undefined {
    if (!raw) {
      return undefined;
    }
    try {
      const value = JSON.parse(raw) as Partial<StoredAffinityEntry>;
      if (
        typeof value.deployment !== 'string'
        || typeof value.webId !== 'string'
        || typeof value.conversationId !== 'string'
        || typeof value.provider !== 'string'
        || typeof value.credentialId !== 'string'
      ) {
        return undefined;
      }
      return value as StoredAffinityEntry;
    } catch (error: unknown) {
      this.logger.warn(`Failed to parse AI gateway affinity Redis payload: ${error}`);
      return undefined;
    }
  }
}
