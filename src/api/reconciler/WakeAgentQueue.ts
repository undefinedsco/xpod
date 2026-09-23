import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { getLoggerFor } from 'global-logger-factory';
import { sharedWakeAgentJobDedupeKey, type SharedWakeAgentJob } from './coordination';
import { attachRedisClientErrorHandler, closeRedisClient } from '../../storage/redis/RedisClientLifecycle';

export interface WakeAgentEnqueueResult { job: SharedWakeAgentJob; inserted: boolean }
export interface WakeAgentClaimOptions { thread: string; agent: string; owner: string; leaseMs?: number }
export interface WakeAgentLeaseReference extends WakeAgentClaimOptions { id: string; fencingToken: string }
export interface WakeAgentFailureOptions extends WakeAgentLeaseReference { error?: string; retry?: boolean }
export interface WakeAgentQueue {
  enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult>;
  listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]>;
  /**
   * Jobs this queue marked `failed` on its own authority (in-flight attempts
   * exhausted). Unlike a reported failure these may still hold Pod work.
   */
  listExhausted(thread: string, agent?: string): Promise<SharedWakeAgentJob[]>;
  /** Put an exhausted job back in its lane; terminal decisions stay with the Pod. */
  requeue(job: Pick<SharedWakeAgentJob, 'thread' | 'agent' | 'id' | 'triggerMessage'>): Promise<boolean>;
  claim(options: WakeAgentClaimOptions): Promise<SharedWakeAgentJob | undefined>;
  renew(options: WakeAgentLeaseReference): Promise<boolean>;
  complete(options: WakeAgentLeaseReference): Promise<boolean>;
  fail(options: WakeAgentFailureOptions): Promise<boolean>;
  close?(): Promise<void>;
}
export interface WakeAgentQueueOptions { redisUrl?: string; namespace?: string; maxAttempts?: number; now?: () => number }
export function createWakeAgentQueue(options: WakeAgentQueueOptions = {}): WakeAgentQueue {
  return options.redisUrl ? new RedisWakeAgentQueue(options) : new InMemoryWakeAgentQueue(options);
}
export function sharedWakeAgentJobId(input: Pick<SharedWakeAgentJob, 'thread' | 'triggerMessage' | 'agent'>): string {
  return `wake_${hash(sharedWakeAgentJobDedupeKey(input))}`;
}
export function wakeAgentQueueKey(job: Pick<SharedWakeAgentJob, 'thread' | 'agent'>): string {
  return `steer_queue:${hash(JSON.stringify([job.thread, job.agent]))}`;
}
function initialJob(job: SharedWakeAgentJob): SharedWakeAgentJob {
  return { id: job.id, thread: job.thread, triggerMessage: job.triggerMessage, agent: job.agent, reason: job.reason, createdAt: job.createdAt, status: 'queued', attempts: 0 };
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) { throw new Error('Lease duration and attempt limit must be positive integers'); }
  return value;
}
function leaseDuration(options: WakeAgentClaimOptions): number {
  if (!options.owner) { throw new Error('Lease owner is required'); }
  return positive(options.leaseMs ?? 30_000);
}
function clearLease(job: SharedWakeAgentJob): void {
  delete job.leaseOwner;
  delete job.leaseExpiresAt;
  delete job.fencingToken;
}
export class InMemoryWakeAgentQueue implements WakeAgentQueue {
  private readonly jobs = new Map<string, SharedWakeAgentJob>();
  private readonly pending = new Map<string, string[]>();
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private sequence = 0;
  public constructor(options: WakeAgentQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxAttempts = positive(options.maxAttempts ?? 3);
  }
  public async enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult> {
    const key = sharedWakeAgentJobDedupeKey(job);
    const existing = this.jobs.get(key);
    if (existing) { return { job: { ...existing }, inserted: false }; }
    const stored = initialJob(job);
    this.jobs.set(key, stored);
    const lane = wakeAgentQueueKey(job);
    this.pending.set(lane, [...this.pending.get(lane) ?? [], key]);
    return { job: { ...stored }, inserted: true };
  }
  public async listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    return [...this.jobs.values()].filter(job => job.thread === thread && (!agent || job.agent === agent) && (job.status === 'queued' || job.status === 'leased')).map(job => ({ ...job }));
  }
  public async listExhausted(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    return [...this.jobs.values()].filter(job => job.thread === thread && (!agent || job.agent === agent) && job.status === 'failed' && job.exhausted === true).map(job => ({ ...job }));
  }
  public async requeue(job: Pick<SharedWakeAgentJob, 'thread' | 'agent' | 'id' | 'triggerMessage'>): Promise<boolean> {
    const key = sharedWakeAgentJobDedupeKey(job);
    const stored = this.jobs.get(key);
    if (!stored || stored.id !== job.id || stored.status !== 'failed' || stored.exhausted !== true) return false;
    stored.status = 'queued';
    stored.attempts = 0;
    delete stored.exhausted;
    stored.lastError = undefined;
    const lane = wakeAgentQueueKey(stored);
    const keys = this.pending.get(lane) ?? [];
    if (!keys.includes(key)) this.pending.set(lane, [...keys, key]);
    return true;
  }
  public async claim(options: WakeAgentClaimOptions): Promise<SharedWakeAgentJob | undefined> {
    const duration = leaseDuration(options);
    const keys = this.pending.get(wakeAgentQueueKey(options)) ?? [];
    while (keys.length) {
      const job = this.jobs.get(keys[0])!;
      const now = this.now();
      if (job.status === 'leased' && Date.parse(job.leaseExpiresAt!) > now) { return undefined; }
      if ((job.attempts ?? 0) >= this.maxAttempts) {
        job.status = 'failed';
        // In-flight attempts say nothing about Pod work: keep the job repairable.
        job.exhausted = true;
        job.lastError = 'In-flight attempts exhausted before any execution was recorded';
        clearLease(job);
        keys.shift();
        continue;
      }
      job.status = 'leased';
      job.attempts = (job.attempts ?? 0) + 1;
      job.leaseOwner = options.owner;
      job.leaseExpiresAt = new Date(now + duration).toISOString();
      // The nonce prevents stale references becoming valid after process/state reset.
      job.fencingToken = `${++this.sequence}:${randomUUID()}`;
      return { ...job };
    }
    return undefined;
  }
  public async renew(options: WakeAgentLeaseReference): Promise<boolean> {
    const duration = leaseDuration(options);
    const job = this.leased(options);
    if (!job) { return false; }
    job.leaseExpiresAt = new Date(this.now() + duration).toISOString();
    return true;
  }
  public async complete(options: WakeAgentLeaseReference): Promise<boolean> { return this.finish(options, false); }
  public async fail(options: WakeAgentFailureOptions): Promise<boolean> { return this.finish(options, true); }
  private leased(options: WakeAgentLeaseReference): SharedWakeAgentJob | undefined {
    const key = this.pending.get(wakeAgentQueueKey(options))?.[0];
    const job = key ? this.jobs.get(key) : undefined;
    return job?.status === 'leased' && job.id === options.id && job.leaseOwner === options.owner && job.fencingToken === options.fencingToken && Date.parse(job.leaseExpiresAt!) > this.now() ? job : undefined;
  }
  private finish(options: WakeAgentFailureOptions, failed: boolean): boolean {
    const job = this.leased(options);
    if (!job) { return false; }
    const keys = this.pending.get(wakeAgentQueueKey(options))!;
    const key = keys.shift()!;
    job.status = failed ? (options.retry !== false && job.attempts! < this.maxAttempts ? 'queued' : 'failed') : 'completed';
    // A reported failure is Pod-verified, so it is no longer repairable.
    delete job.exhausted;
    if (failed && options.error) { job.lastError = options.error; }
    clearLease(job);
    if (job.status === 'queued') { keys.push(key); }
    return true;
  }
}

// All lane mutations are one Redis operation. Redis TIME is authoritative, so workers'
// clock skew cannot steal leases. The head stays in the list until acknowledgement.
const TRANSITION = `
local op = ARGV[1]
local input = ARGV[2] ~= '' and cjson.decode(ARGV[2]) or nil
local duration = tonumber(ARGV[3])
local maxAttempts = tonumber(ARGV[4])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local function save(key, job) redis.call('HSET', KEYS[1], key, cjson.encode(job)) end
local function clear(job) job.leaseOwner = nil; job.leaseExpiresAt = nil; job.fencingToken = nil; job.leaseUntil = nil end
if op == 'enqueue' then
 local existing = redis.call('HGET', KEYS[1], ARGV[5])
 if existing then
  local stale = cjson.decode(existing)
  if stale.status == 'failed' and stale.exhausted == true then
   existing = nil
   redis.call('SREM', KEYS[5], ARGV[5])
  end
 end
 if existing then return cjson.encode({job=cjson.decode(existing), inserted=false}) end
 save(ARGV[5], input)
 redis.call('RPUSH', KEYS[2], ARGV[5])
 redis.call('SADD', KEYS[4], input.agent)
 redis.call('SREM', KEYS[5], ARGV[5])
 return cjson.encode({job=input, inserted=true})
end
if op == 'requeue' then
 if redis.call('SISMEMBER', KEYS[5], input.key) == 0 then return '' end
 local queued = cjson.decode(redis.call('HGET', KEYS[1], input.key))
 if queued == nil or queued.id ~= input.id or queued.status ~= 'failed' or queued.exhausted ~= true then return '' end
 queued.status = 'queued'
 queued.attempts = 0
 queued.exhausted = nil
 queued.lastError = nil
 queued.leaseOwner = nil
 queued.leaseExpiresAt = nil
 queued.leaseUntil = nil
 queued.fencingToken = nil
 save(input.key, queued)
 redis.call('RPUSH', KEYS[2], input.key)
 redis.call('SREM', KEYS[5], input.key)
 return 'true'
end
while true do
 local key = redis.call('LINDEX', KEYS[2], 0)
 if not key then return '' end
 local job = cjson.decode(redis.call('HGET', KEYS[1], key))
 if op == 'claim' then
  if job.status == 'leased' and job.leaseUntil > now then return '' end
  if (job.attempts or 0) >= maxAttempts then
   job.status='failed'; job.exhausted=true; job.lastError='In-flight attempts exhausted before any execution was recorded'; clear(job); save(key, job); redis.call('LPOP', KEYS[2]); redis.call('SADD', KEYS[5], key)
  else
   job.status='leased'; job.attempts=(job.attempts or 0)+1; job.leaseOwner=input.owner
   job.leaseUntil=now+duration; job.fencingToken=tostring(redis.call('INCR', KEYS[3])) .. ':' .. ARGV[6]
   save(key,job); return cjson.encode(job)
  end
 else
  if job.status ~= 'leased' or job.id ~= input.id or job.leaseOwner ~= input.owner or job.fencingToken ~= input.fencingToken or job.leaseUntil <= now then return '' end
  if op == 'renew' then job.leaseUntil=now+duration; save(key,job); return 'true' end
  redis.call('LPOP', KEYS[2]); clear(job)
  if op == 'complete' then job.status='completed'
  else
   job.status='failed'
   if input.retry ~= false and job.attempts < maxAttempts then job.status='queued'; redis.call('RPUSH', KEYS[2],key) end
   if input.error then job.lastError=input.error end
  end
  job.exhausted = nil
  redis.call('SREM', KEYS[5], key)
  save(key,job); return 'true'
 end
end
`;
class RedisWakeAgentQueue implements WakeAgentQueue {
  private readonly logger = getLoggerFor(this);
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly maxAttempts: number;
  private shuttingDown = false;
  public constructor(options: WakeAgentQueueOptions) {
    this.namespace = options.namespace ?? 'xpod:wake:v2:';
    this.maxAttempts = positive(options.maxAttempts ?? 3);
    this.redis = new Redis(options.redisUrl!, { lazyConnect: false });
    attachRedisClientErrorHandler(this.redis, { logger: this.logger, label: 'WakeAgentQueue', isShuttingDown: () => this.shuttingDown });
  }
  private keys(thread: string, agent: string): string[] {
    // A thread hash tag keeps the transaction in one Redis Cluster slot.
    const root = `${this.namespace}{${hash(thread)}}`;
    const lane = `${root}:${wakeAgentQueueKey({ thread, agent })}`;
    return [`${lane}:jobs`, `${lane}:pending`, `${lane}:fence`, `${root}:agents`, `${lane}:exhausted`];
  }
  public async enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult> {
    const raw = await this.redis.eval(TRANSITION, 5, ...this.keys(job.thread, job.agent), 'enqueue', JSON.stringify(initialJob(job)), '0', String(this.maxAttempts), sharedWakeAgentJobDedupeKey(job)) as string;
    const result = JSON.parse(raw) as WakeAgentEnqueueResult;
    result.job = fromRedis(result.job);
    return result;
  }
  public async listExhausted(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    const agents = agent ? [agent] : await this.redis.smembers(this.keys(thread, '')[3]);
    const jobs: SharedWakeAgentJob[] = [];
    for (const id of agents) {
      const keys = this.keys(thread, id);
      const members = await this.redis.smembers(keys[4]);
      if (!members.length) { continue; }
      for (const raw of await this.redis.hmget(keys[0], ...members)) {
        if (!raw) { continue; }
        const job = fromRedis(JSON.parse(raw));
        if (job.status === 'failed' && job.exhausted === true) { jobs.push(job); }
      }
    }
    return jobs;
  }

  public async requeue(job: Pick<SharedWakeAgentJob, 'thread' | 'agent' | 'id' | 'triggerMessage'>): Promise<boolean> {
    const payload = JSON.stringify({ key: sharedWakeAgentJobDedupeKey(job), id: job.id });
    return Boolean(await this.redis.eval(TRANSITION, 5, ...this.keys(job.thread, job.agent), 'requeue', payload, '0', String(this.maxAttempts), '') as string);
  }

  public async listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    const agents = agent ? [agent] : await this.redis.smembers(this.keys(thread, '')[3]);
    const jobs: SharedWakeAgentJob[] = [];
    for (const id of agents) {
      const keys = this.keys(thread, id);
      const pending = await this.redis.lrange(keys[1], 0, -1);
      if (!pending.length) { continue; }
      const raws = await this.redis.hmget(keys[0], ...pending);
      for (const raw of raws) {
        if (!raw) { continue; }
        const job = fromRedis(JSON.parse(raw));
        if (job.status === 'queued' || job.status === 'leased') { jobs.push(job); }
      }
    }
    return jobs;
  }
  public async claim(options: WakeAgentClaimOptions): Promise<SharedWakeAgentJob | undefined> {
    const raw = await this.transition('claim', options);
    return raw ? fromRedis(JSON.parse(raw)) : undefined;
  }
  public async renew(options: WakeAgentLeaseReference): Promise<boolean> { return Boolean(await this.transition('renew', options)); }
  public async complete(options: WakeAgentLeaseReference): Promise<boolean> { return Boolean(await this.transition('complete', options)); }
  public async fail(options: WakeAgentFailureOptions): Promise<boolean> { return Boolean(await this.transition('fail', options)); }
  private async transition(operation: string, options: WakeAgentClaimOptions): Promise<string> {
    return await this.redis.eval(TRANSITION, 5, ...this.keys(options.thread, options.agent), operation, JSON.stringify(options), String(leaseDuration(options)), String(this.maxAttempts), '', randomUUID()) as string;
  }
  public async close(): Promise<void> {
    this.shuttingDown = true;
    await closeRedisClient(this.redis, { logger: this.logger, label: 'WakeAgentQueue' });
  }
}
function fromRedis(input: SharedWakeAgentJob & { leaseUntil?: number }): SharedWakeAgentJob {
  const { leaseUntil, ...job } = input;
  if (leaseUntil !== undefined) { job.leaseExpiresAt = new Date(leaseUntil).toISOString(); }
  return job;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
