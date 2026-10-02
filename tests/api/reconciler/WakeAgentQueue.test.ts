import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createWakeAgentQueue, InMemoryWakeAgentQueue, type WakeAgentQueue } from '../../../src/api/reconciler/WakeAgentQueue';
import type { SharedWakeAgentJob } from '../../../src/api/reconciler/coordination';

const job = (id: string): SharedWakeAgentJob => ({ id, thread: 'thread', agent: 'agent', triggerMessage: id, reason: 'manual', status: 'queued', createdAt: new Date(0).toISOString() });
function leaseRef(job: SharedWakeAgentJob) {
  return { thread: job.thread, agent: job.agent, id: job.id, owner: job.leaseOwner!, fencingToken: job.fencingToken! };
}
function contracts(make: () => WakeAgentQueue) {
  it('atomically deduplicates parallel enqueue and serializes lane claims', async () => {
    const queue = make();
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () => queue.enqueue(job('one'))));
      expect(results.filter(result => result.inserted)).toHaveLength(1);
      await queue.enqueue(job('two'));
      const claims = await Promise.all(['a', 'b'].map(owner => queue.claim({ thread: 'thread', agent: 'agent', owner })));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find(Boolean)!;
      expect(await queue.complete({ ...leaseRef(first), owner: 'wrong' })).toBe(false);
      expect(await queue.complete(leaseRef(first))).toBe(true);
      const second = await queue.claim({ thread: 'thread', agent: 'agent', owner: 'b' });
      expect(second?.id).toBe('two');
      expect((await queue.enqueue(job('one'))).job.status).toBe('completed');
    } finally { await queue.close?.(); }
  });
  it('requeues failures and bounds attempts without blocking following work', async () => {
    const queue = make();
    try {
      await queue.enqueue(job('retry'));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claimed = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'a' }))!;
        expect(claimed.attempts).toBe(attempt);
        expect(await queue.fail({ ...leaseRef(claimed), error: 'failure', retry: true })).toBe(true);
      }
      expect(await queue.claim({ thread: 'thread', agent: 'agent', owner: 'a' })).toBeUndefined();
      expect((await queue.enqueue(job('retry'))).job.status).toBe('failed');
    } finally { await queue.close?.(); }
  });
}
describe('InMemoryWakeAgentQueue', () => {
  contracts(() => new InMemoryWakeAgentQueue());
  it('rejects a stale lease after restart even when owner and job are reused', async () => {
    const before = new InMemoryWakeAgentQueue();
    await before.enqueue(job('same'));
    const stale = (await before.claim({ thread: 'thread', agent: 'agent', owner: 'runtime' }))!;
    const after = new InMemoryWakeAgentQueue();
    await after.enqueue(job('same'));
    const current = (await after.claim({ thread: 'thread', agent: 'agent', owner: 'runtime' }))!;
    expect(await after.renew(leaseRef(stale))).toBe(false);
    expect(await after.complete(leaseRef(stale))).toBe(false);
    expect(await after.fail(leaseRef(stale))).toBe(false);
    expect(await after.complete(leaseRef(current))).toBe(true);
  });
  it('fences expired owners and recovers abandoned jobs with monotonic tokens', async () => {
    let now = 1000;
    const queue = new InMemoryWakeAgentQueue({ now: () => now });
    await queue.enqueue(job('one'));
    const first = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'a', leaseMs: 100 }))!;
    now += 101;
    expect(await queue.complete(leaseRef(first))).toBe(false);
    expect(await queue.renew(leaseRef(first))).toBe(false);
    const second = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'b', leaseMs: 100 }))!;
    expect(Number(second.fencingToken!.split(':')[0])).toBeGreaterThan(Number(first.fencingToken!.split(':')[0]));
    expect(await queue.fail(leaseRef(first))).toBe(false);
    expect(await queue.renew({ ...leaseRef(second), leaseMs: 200 })).toBe(true);
    now += 150;
    expect(await queue.complete(leaseRef(second))).toBe(true);
  });
  it('expires exhausted jobs and advances to the next job without blocking other lanes', async () => {
    let now = 0;
    const queue = new InMemoryWakeAgentQueue({ now: () => now, maxAttempts: 1 });
    await queue.enqueue(job('one'));
    await queue.enqueue(job('two'));
    await queue.enqueue({ ...job('other'), agent: 'other-agent' });
    await queue.claim({ thread: 'thread', agent: 'agent', owner: 'a', leaseMs: 1 });
    expect((await queue.claim({ thread: 'thread', agent: 'other-agent', owner: 'b' }))?.id).toBe('other');
    now = 2;
    expect((await queue.claim({ thread: 'thread', agent: 'agent', owner: 'b' }))?.id).toBe('two');
    expect((await queue.enqueue(job('one'))).job.status).toBe('failed');
  });
  it('does not confuse delimiter-containing identities and ignores caller lifecycle fields', async () => {
    const queue = new InMemoryWakeAgentQueue();
    expect((await queue.enqueue({ ...job('a'), thread: 'a|b', triggerMessage: 'c', status: 'completed', attempts: 99 })).inserted).toBe(true);
    expect((await queue.enqueue({ ...job('b'), thread: 'a', triggerMessage: 'b|c' })).inserted).toBe(true);
    expect((await queue.listQueued('a|b'))[0].status).toBe('queued');
  });
});
const redisUrl = process.env.WAKE_QUEUE_TEST_REDIS_URL;
describe.skipIf(!redisUrl)('RedisWakeAgentQueue real Redis', () => {
  const namespaces: string[] = [];
  function make() {
    const namespace = `test:wake:${crypto.randomUUID()}:`;
    namespaces.push(namespace);
    return createWakeAgentQueue({ redisUrl, namespace });
  }
  afterAll(async () => {
    if (!redisUrl) { return; }
    const redis = new Redis(redisUrl);
    try {
      for (const namespace of namespaces) {
        const keys = await redis.keys(`${namespace}*`);
        if (keys.length) { await redis.del(...keys); }
      }
    } finally { await redis.quit(); }
  });
  contracts(make);
  it('rejects stale references after Redis state and counters are reset', async () => {
    const namespace = `test:wake:${crypto.randomUUID()}:`;
    namespaces.push(namespace);
    const queue = createWakeAgentQueue({ redisUrl, namespace });
    const redis = new Redis(redisUrl!);
    try {
      await queue.enqueue(job('same'));
      const stale = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'runtime' }))!;
      const keys = await redis.keys(`${namespace}*`);
      await redis.del(...keys);
      await queue.enqueue(job('same'));
      const current = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'runtime' }))!;
      expect(await queue.renew(leaseRef(stale))).toBe(false);
      expect(await queue.complete(leaseRef(stale))).toBe(false);
      expect(await queue.fail(leaseRef(stale))).toBe(false);
      expect(await queue.complete(leaseRef(current))).toBe(true);
    } finally { await queue.close?.(); await redis.quit(); }
  });
  it('recovers expired Redis leases and rejects stale acknowledgements', async () => {
    const queue = make();
    try {
      await queue.enqueue(job('expired'));
      const first = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'a', leaseMs: 30 }))!;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(await queue.renew(leaseRef(first))).toBe(false);
      const second = (await queue.claim({ thread: 'thread', agent: 'agent', owner: 'b' }))!;
      expect(Number(second.fencingToken!.split(':')[0])).toBeGreaterThan(Number(first.fencingToken!.split(':')[0]));
      expect(await queue.complete(leaseRef(first))).toBe(false);
      expect(await queue.fail(leaseRef(first))).toBe(false);
      expect(await queue.renew(leaseRef(second))).toBe(true);
      expect(await queue.complete(leaseRef(second))).toBe(true);
      expect(await queue.listQueued('thread')).toEqual([]);
    } finally { await queue.close?.(); }
  });
});
