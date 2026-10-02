import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import {
  Initializer,
  type ExpiringReadWriteLocker, type Finalizable, type PromiseOrValue, type ResourceIdentifier,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { attachRedisClientErrorHandler } from '../redis/RedisClientLifecycle';

export interface UrlAwareRedisLockerOptions {
  redisClient?: string;
  attemptSettings_retryCount?: number;
  attemptSettings_retryDelay?: number;
  attemptSettings_retryJitter?: number;
  namespacePrefix?: string;
}

const ACQUIRE = `
  local mode = ARGV[1]
  if mode == 'write' and redis.call('hget', KEYS[1], 'writer') == ARGV[2] then return 1 end
  if mode == 'read' and redis.call('hget', KEYS[1], 'reader:'..ARGV[2]) == ARGV[2] then return 1 end
  if mode == 'write' and redis.call('hlen', KEYS[1]) > 0 then return 0 end
  if mode == 'read' and redis.call('hexists', KEYS[1], 'writer') == 1 then return 0 end
  if mode == 'write' then redis.call('hset', KEYS[1], 'writer', ARGV[2])
  else redis.call('hset', KEYS[1], 'reader:'..ARGV[2], ARGV[2]) end
  return 1
`;
const RELEASE = `
  local field = ARGV[1] == 'write' and 'writer' or 'reader:'..ARGV[2]
  if redis.call('hexists', KEYS[1], field) == 0 then return 1 end
  if redis.call('hget', KEYS[1], field) ~= ARGV[2] then return 0 end
  redis.call('hdel', KEYS[1], field)
  if redis.call('hlen', KEYS[1]) == 0 then redis.call('del', KEYS[1]) end
  return 1
`;

/**
 * Shared owner-checked locks. Never expire an active writer without storage fencing.
 * A crashed owner remains locked until an operator proves it is stopped and repairs that key.
 * Initialize/finalize never clear the namespace or another instance's locks.
 */
export class UrlAwareRedisLocker extends Initializer implements ExpiringReadWriteLocker, Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly retryCount: number;
  private readonly retryDelay: number;
  private readonly retryJitter: number;
  private readonly resourceOwners = new Map<string, string>();
  private shuttingDown = false;

  public constructor(options: UrlAwareRedisLockerOptions = {}) {
    super();
    const address = options.redisClient ?? '127.0.0.1:6379';
    this.redis = new Redis(address.startsWith('redis://') || address.startsWith('rediss://')
      ? address : `redis://${address.includes(':') ? address : `127.0.0.1:${address}`}`);
    this.namespace = `${options.namespacePrefix ?? ''}__XPOD_OWNER_LOCK__`;
    this.retryCount = options.attemptSettings_retryCount ?? -1;
    this.retryDelay = options.attemptSettings_retryDelay ?? 50;
    this.retryJitter = options.attemptSettings_retryJitter ?? 30;
    attachRedisClientErrorHandler(this.redis, {
      logger: this.logger, label: 'UrlAwareRedisLocker', isShuttingDown: () => this.shuttingDown,
    });
  }

  public override async handle(): Promise<void> { await this.initialize(); }

  public async initialize(): Promise<void> { await this.redis.ping(); }

  public async withReadLock<T>(id: ResourceIdentifier, action: (maintainLock: () => void) => PromiseOrValue<T>): Promise<T> {
    return this.withLock(id, 'read', action);
  }

  public async withWriteLock<T>(id: ResourceIdentifier, action: (maintainLock: () => void) => PromiseOrValue<T>): Promise<T> {
    return this.withLock(id, 'write', action);
  }

  public async acquire(id: ResourceIdentifier): Promise<void> {
    const owner = randomUUID();
    await this.claim(`resource:${id.path}`, 'write', owner);
    this.resourceOwners.set(id.path, owner);
  }

  public async release(id: ResourceIdentifier): Promise<void> {
    const owner = this.resourceOwners.get(id.path);
    if (!owner) throw new Error('This Redis locker does not own the resource lock');
    this.resourceOwners.delete(id.path);
    await this.releaseOwner(`resource:${id.path}`, 'write', owner);
  }

  public async finalize(): Promise<void> {
    this.shuttingDown = true;
    // A premature shutdown preserves held locks; it cannot allow an in-flight writer to race.
    this.redis.disconnect(false);
  }

  private async withLock<T>(id: ResourceIdentifier, mode: 'read' | 'write', action: (maintainLock: () => void) => PromiseOrValue<T>): Promise<T> {
    const owner = randomUUID();
    await this.claim(`rw:${id.path}`, mode, owner);
    try { return await action(() => undefined); }
    finally { await this.releaseOwner(`rw:${id.path}`, mode, owner); }
  }

  private async claim(path: string, mode: 'read' | 'write', owner: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.shuttingDown) throw new Error('Redis locker is shutting down');
      if (await this.redis.eval(ACQUIRE, 1, `${this.namespace}${path}`, mode, owner) === 1) return;
      if (this.retryCount >= 0 && attempt >= this.retryCount) throw new Error('Redis lock acquisition exhausted');
      await delay(this.retryDelay + Math.floor(Math.random() * this.retryJitter));
    }
  }

  private async releaseOwner(path: string, mode: 'read' | 'write', owner: string): Promise<void> {
    if (await this.redis.eval(RELEASE, 1, `${this.namespace}${path}`, mode, owner) !== 1) {
      throw new Error('Redis lock ownership lost; refusing to release another owner');
    }
  }
}
