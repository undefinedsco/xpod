import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { getLoggerFor } from 'global-logger-factory';
import {
  sharedWakeAgentJobDedupeKey,
  type SharedWakeAgentJob,
} from './coordination';
import {
  attachRedisClientErrorHandler,
  closeRedisClient,
} from '../../storage/redis/RedisClientLifecycle';

export interface WakeAgentEnqueueResult {
  job: SharedWakeAgentJob;
  inserted: boolean;
}

export interface WakeAgentQueue {
  enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult>;
  listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]>;
  close?(): Promise<void>;
}

export interface WakeAgentQueueOptions {
  redisUrl?: string;
  namespace?: string;
}

export function createWakeAgentQueue(options: WakeAgentQueueOptions = {}): WakeAgentQueue {
  return options.redisUrl
    ? new RedisWakeAgentQueue(options)
    : new InMemoryWakeAgentQueue();
}

export function sharedWakeAgentJobId(input: Pick<SharedWakeAgentJob, 'thread' | 'triggerMessage' | 'agent'>): string {
  return `wake_${hash(sharedWakeAgentJobDedupeKey(input))}`;
}

export function wakeAgentQueueKey(job: Pick<SharedWakeAgentJob, 'thread' | 'agent'>): string {
  return `steer_queue:${job.thread}:${job.agent}`;
}

export class InMemoryWakeAgentQueue implements WakeAgentQueue {
  private readonly jobsByDedupeKey = new Map<string, SharedWakeAgentJob>();
  private readonly queueKeysByDedupeKey = new Map<string, string>();

  public async enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult> {
    const dedupeKey = sharedWakeAgentJobDedupeKey(job);
    const existing = this.jobsByDedupeKey.get(dedupeKey);
    if (existing) {
      return { job: { ...existing }, inserted: false };
    }
    const stored = { ...job };
    this.jobsByDedupeKey.set(dedupeKey, stored);
    this.queueKeysByDedupeKey.set(dedupeKey, wakeAgentQueueKey(stored));
    return { job: { ...stored }, inserted: true };
  }

  public async listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    return Array.from(this.jobsByDedupeKey.entries())
      .filter(([ dedupeKey, job ]) => (
        job.thread === thread
        && (!agent || job.agent === agent)
        && this.queueKeysByDedupeKey.has(dedupeKey)
      ))
      .map(([, job]) => ({ ...job }));
  }
}

class RedisWakeAgentQueue implements WakeAgentQueue {
  private readonly logger = getLoggerFor(this);
  private readonly redis: Redis;
  private readonly namespace: string;
  private shuttingDown = false;

  public constructor(options: WakeAgentQueueOptions) {
    if (!options.redisUrl) {
      throw new Error('redisUrl is required for RedisWakeAgentQueue');
    }
    this.namespace = options.namespace ?? 'xpod:wake:';
    this.redis = new Redis(options.redisUrl, { lazyConnect: false });
    attachRedisClientErrorHandler(this.redis, {
      logger: this.logger,
      label: 'WakeAgentQueue',
      isShuttingDown: () => this.shuttingDown,
    });
  }

  public async enqueue(job: SharedWakeAgentJob): Promise<WakeAgentEnqueueResult> {
    const dedupeKey = this.dedupeStorageKey(job);
    const payload = JSON.stringify(job);
    const inserted = await this.redis.set(dedupeKey, payload, 'NX');
    if (inserted === 'OK') {
      await this.redis.rpush(this.queueStorageKey(job.thread, job.agent), payload);
      await this.redis.sadd(this.threadAgentsKey(job.thread), job.agent);
      return { job: { ...job }, inserted: true };
    }

    const existing = parseJson<SharedWakeAgentJob>(await this.redis.get(dedupeKey)) ?? job;
    return { job: existing, inserted: false };
  }

  public async listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    const agents = agent ? [ agent ] : await this.redis.smembers(this.threadAgentsKey(thread));
    const jobs: SharedWakeAgentJob[] = [];
    for (const agent of agents) {
      const raws = await this.redis.lrange(this.queueStorageKey(thread, agent), 0, -1);
      for (const raw of raws) {
        const job = parseJson<SharedWakeAgentJob>(raw);
        if (job) {
          jobs.push(job);
        }
      }
    }
    return jobs;
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    await closeRedisClient(this.redis, {
      logger: this.logger,
      label: 'WakeAgentQueue',
    });
  }

  private dedupeStorageKey(job: Pick<SharedWakeAgentJob, 'thread' | 'triggerMessage' | 'agent'>): string {
    return `${this.namespace}dedupe:${hash(sharedWakeAgentJobDedupeKey(job))}`;
  }

  private queueStorageKey(thread: string, agent: string): string {
    return `${this.namespace}${wakeAgentQueueKey({ thread, agent })}`;
  }

  private threadAgentsKey(thread: string): string {
    return `${this.namespace}thread_agents:${hash(thread)}`;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
