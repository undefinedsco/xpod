import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getLoggerFor } from 'global-logger-factory';
import { GreedyReadWriteLocker, MemoryResourceLocker, MemoryMapStorage } from '@solid/community-server';
import type { ReadWriteLocker, ResourceLocker, ResourceIdentifier, Initializable, Finalizable } from '@solid/community-server';
import { attachRedisClientErrorHandler, isIgnorableRedisShutdownError } from '../redis/RedisClientLifecycle';
import { assertLockContextActive, withLockLease, type LockLeaseGuard } from './LockExecutionContext';

// Each hash field is an acquisition owner, not a shared reader count or anonymous writer flag.
// Redis server time defines expiry. Renew never creates a missing/expired owner; release is owner-only.
const OWNER_LEASE_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local entries = redis.call('HGETALL', KEYS[1])
local writer = false
local count = 0
for i = 1, #entries, 2 do
  if tonumber(entries[i + 1]) <= now then
    redis.call('HDEL', KEYS[1], entries[i])
  else
    count = count + 1
    if string.sub(entries[i], 1, 1) == 'w' then writer = true end
  end
end
local action = ARGV[1]
local owner = ARGV[2]
local ttl = tonumber(ARGV[3])
if action == 'acquire' then
  if writer or (string.sub(owner, 1, 1) == 'w' and count > 0) then return 0 end
  redis.call('HSET', KEYS[1], owner, now + ttl)
elseif action == 'renew' then
  if not redis.call('HGET', KEYS[1], owner) then return 0 end
  redis.call('HSET', KEYS[1], owner, now + ttl)
elseif action == 'release' then
  local removed = redis.call('HDEL', KEYS[1], owner)
  if removed == 0 then return 0 end
else
  return redis.error_reply('Unknown owner lease operation')
end
local remaining = redis.call('HGETALL', KEYS[1])
local lastExpiry = now
for i = 2, #remaining, 2 do lastExpiry = math.max(lastExpiry, tonumber(remaining[i])) end
if #remaining == 0 then redis.call('DEL', KEYS[1])
else redis.call('PEXPIRE', KEYS[1], math.max(1, lastExpiry - now)) end
return 1
`;
export interface UrlAwareRedisLockerOptions {
  redisClient?: string;
  attemptSettings_retryCount?: number;
  attemptSettings_retryDelay?: number;
  attemptSettings_retryJitter?: number;
  namespacePrefix?: string;
  /** Owner lease duration; active acquisitions renew automatically. */
  lockKeyTtlSeconds?: number;
}
interface OwnerLease extends LockLeaseGuard {
  key: string;
  token: string;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  renewal?: Promise<void>;
}
/** Same CSS public interfaces; one client and no namespace-wide startup/shutdown deletion. */
export class UrlAwareRedisLocker implements ReadWriteLocker, ResourceLocker, Initializable, Finalizable {
  protected readonly logger = getLoggerFor(this);
  private readonly client: Redis;
  private readonly local = new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>());
  private readonly mutex = new MemoryResourceLocker();
  private readonly raw = new Map<string, { lease: OwnerLease; done: () => void }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly ttlMs: number;
  private readonly prefix: string;
  private readonly retries: number;
  private readonly delay: number;
  private readonly jitter: number;
  private shuttingDown = false;
  private initialized?: Promise<void>;
  private finalizing?: Promise<void>;

  public constructor(options: UrlAwareRedisLockerOptions = {}) {
    const seconds = options.lockKeyTtlSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 1) throw new Error('Redis owner lease must be at least one second');
    this.ttlMs = Math.floor(seconds * 1000);
    this.prefix = options.namespacePrefix ?? '';
    this.retries = options.attemptSettings_retryCount ?? -1;
    this.delay = options.attemptSettings_retryDelay ?? 50;
    this.jitter = options.attemptSettings_retryJitter ?? 30;
    if (!Number.isInteger(this.retries) || this.retries < -1 || !Number.isFinite(this.delay) || this.delay < 0 || !Number.isFinite(this.jitter) || this.jitter < 0) throw new Error('Invalid Redis lock retry settings');
    const address = options.redisClient ?? '127.0.0.1:6379';
    const settings = { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: Math.max(100, Math.floor(this.ttlMs / 3)), connectTimeout: 10_000 };
    if (address.startsWith('redis://') || address.startsWith('rediss://')) this.client = new Redis(address, settings);
    else {
      const match = /^(?:([^:]+):)?(\d{4,5})$/u.exec(address);
      if (!match) throw new Error('Redis locker requires a Redis URL or host:port address');
      this.client = new Redis(Number(match[2]), match[1] ?? '127.0.0.1', settings);
    }
    attachRedisClientErrorHandler(this.client, { logger: this.logger, label: 'UrlAwareRedisLocker', isShuttingDown: () => this.shuttingDown });
  }
  public initialize(): Promise<void> {
    this.ensureAccepting();
    this.initialized ??= (async() => { if (this.client.status === 'wait') await this.client.connect(); await this.client.ping(); })();
    return this.initialized;
  }
  public withReadLock<T>(identifier: ResourceIdentifier, callback: () => T | Promise<T>): Promise<T> { return this.withLease(identifier, 'r', callback); }
  public withWriteLock<T>(identifier: ResourceIdentifier, callback: () => T | Promise<T>): Promise<T> { return this.withLease(identifier, 'w', callback); }
  private async withLease<T>(identifier: ResourceIdentifier, mode: 'r' | 'w', callback: () => T | Promise<T>): Promise<T> {
    this.ensureAccepting();
    const done = this.track();
    const lock = mode === 'r' ? this.local.withReadLock.bind(this.local) : this.local.withWriteLock.bind(this.local);
    try {
      return await lock(identifier, async() => {
        this.ensureAccepting();
        await this.initialize();
        const lease = await this.acquireOwner(`${this.prefix}__RW__${identifier.path}.owners`, mode);
        let failed = false;
        try { return await withLockLease(lease, callback); }
        catch (error) { failed = true; throw error; }
        finally { try { await this.releaseOwner(lease); } catch (error) { if (!failed) throw error; } }
      }) as T;
    } finally { done(); }
  }
  public async acquire(identifier: ResourceIdentifier): Promise<void> {
    this.ensureAccepting();
    const done = this.track();
    let localHeld = false;
    try {
      await this.mutex.acquire(identifier); localHeld = true;
      this.ensureAccepting(); await this.initialize();
      const lease = await this.acquireOwner(`${this.prefix}__L__${identifier.path}.owners`, 'w');
      this.raw.set(identifier.path, { lease, done });
    } catch (error) { if (localHeld) await this.mutex.release(identifier); done(); throw error; }
  }
  public async release(identifier: ResourceIdentifier): Promise<void> {
    const owner = this.raw.get(identifier.path);
    if (!owner) throw new Error('Cannot release a resource not owned by this locker');
    this.raw.delete(identifier.path);
    try { await this.releaseOwner(owner.lease); }
    finally { await this.mutex.release(identifier); owner.done(); }
  }
  public finalize(): Promise<void> {
    this.shuttingDown = true;
    this.finalizing ??= (async() => {
      // Pending callbacks and raw holders must actually settle; closing another instance never clears their keys.
      while (this.pending.size) await Promise.all([...this.pending]);
      try { if (this.client.status !== 'wait' && this.client.status !== 'end') await this.client.quit(); }
      catch (error) { if (!isIgnorableRedisShutdownError(error)) throw error; }
      finally { this.client.disconnect(false); }
    })();
    return this.finalizing;
  }
  private ensureAccepting(): void { if (this.shuttingDown) throw new Error('Redis locker is shutting down'); assertLockContextActive(); }
  private track(): () => void {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.pending.add(promise);
    return () => { this.pending.delete(promise); resolve(); };
  }
  private async operation(lease: Pick<OwnerLease, 'key' | 'token'>, action: string): Promise<boolean> {
    return Number(await this.client.eval(OWNER_LEASE_SCRIPT, 1, lease.key, action, lease.token, this.ttlMs)) === 1;
  }
  private async acquireOwner(key: string, mode: 'r' | 'w'): Promise<OwnerLease> {
    const lease: OwnerLease = { key, token: `${mode}:${randomUUID()}`, stopped: false, assertOwned: () => this.renewOwner(lease) };
    for (let attempt = 0; ; attempt++) {
      this.ensureAccepting();
      if (await this.operation(lease, 'acquire')) break;
      if (this.retries >= 0 && attempt >= this.retries) throw new Error('Redis owner lease acquisition exhausted its retry budget');
      await new Promise<void>(resolve => setTimeout(resolve, this.delay + Math.random() * this.jitter));
    }
    this.scheduleRenewal(lease);
    return lease;
  }
  private lose(lease: OwnerLease): Error {
    if (!lease.failure) { lease.failure = new Error('Redis lock ownership was lost; this execution cannot commit'); lease.onLoss?.(lease.failure); }
    return lease.failure;
  }
  private renewOwner(lease: OwnerLease): Promise<void> {
    if (lease.failure) return Promise.reject(lease.failure);
    if (lease.stopped) return Promise.reject(this.lose(lease));
    lease.renewal ??= (async() => {
      try { if (!await this.operation(lease, 'renew')) throw this.lose(lease); }
      catch { throw this.lose(lease); }
      finally { lease.renewal = undefined; }
    })();
    return lease.renewal;
  }
  private scheduleRenewal(lease: OwnerLease): void {
    lease.timer = setTimeout(() => {
      if (lease.stopped || lease.failure) return;
      void this.renewOwner(lease).then(() => { if (!lease.stopped && !lease.failure) this.scheduleRenewal(lease); }, () => undefined);
    }, Math.max(50, Math.floor(this.ttlMs / 3)));
    lease.timer.unref();
  }
  private async releaseOwner(lease: OwnerLease): Promise<void> {
    lease.stopped = true;
    if (lease.timer) clearTimeout(lease.timer);
    await lease.renewal?.catch(() => undefined);
    const released = await this.operation(lease, 'release');
    if (!released && !lease.failure) throw this.lose(lease);
  }
}
