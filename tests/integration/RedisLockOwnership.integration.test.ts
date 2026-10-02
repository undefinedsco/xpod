import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { UrlAwareRedisLocker } from '../../src/storage/locking/UrlAwareRedisLocker';

const redisUrl = process.env.XPOD_AGENT_DIRECTORY_TEST_REDIS_URL;

describe.skipIf(!redisUrl)('Candidate Redis lock ownership', () => {
  for (const mode of ['read', 'write'] as const) {
    it(`accepts identical ${mode} command replay after a simulated lost reply`, async () => {
      const namespace = `directory-lock-test-${randomUUID()}:`;
      const locker = new UrlAwareRedisLocker({ redisClient: redisUrl!, namespacePrefix: namespace, attemptSettings_retryCount: 0 });
      // Inject reply loss at the transport boundary; both command executions hit the real Redis.
      const client = (locker as unknown as { redis: Redis }).redis;
      const original = client.eval.bind(client);
      const replay = vi.spyOn(client, 'eval').mockImplementation(async (...args: Parameters<Redis['eval']>) => {
        await original(...args);
        return original(...args);
      });
      const observer = new Redis(redisUrl!);
      const id = { path: 'https://candidate.example/pod/file' };
      const key = `${namespace}__XPOD_OWNER_LOCK__rw:${id.path}`;
      try {
        const action = vi.fn();
        if (mode === 'read') await locker.withReadLock(id, action);
        else await locker.withWriteLock(id, action);
        expect(action).toHaveBeenCalledOnce();
        expect(replay).toHaveBeenCalledTimes(2);
        expect(await observer.exists(key)).toBe(0);
      } finally {
        replay.mockRestore();
        await locker.finalize();
        observer.disconnect(false);
      }
    });
  }

  it('does not clear a live writer when another replica initializes or finalizes', async () => {
    const namespace = `directory-lock-test-${randomUUID()}:`;
    const options = { redisClient: redisUrl!, namespacePrefix: namespace, attemptSettings_retryCount: 0 };
    const first = new UrlAwareRedisLocker(options);
    const second = new UrlAwareRedisLocker(options);
    const observer = new Redis(redisUrl!);
    const id = { path: 'https://candidate.example/pod/file' };
    let unblock!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const holding = first.withWriteLock(id, async () => { entered(); await blocked; });
    try {
      await enteredPromise;
      await second.initialize();
      await expect(second.withWriteLock(id, async () => undefined)).rejects.toThrow('acquisition exhausted');
      const key = `${namespace}__XPOD_OWNER_LOCK__rw:${id.path}`;
      expect(await observer.ttl(key)).toBe(-1);
      await second.finalize();
      expect(await observer.hlen(key)).toBe(1);
    } finally {
      unblock();
      await holding;
      await first.finalize();
      await second.finalize();
      observer.disconnect(false);
    }
  });

  it('refuses an old-owner release without deleting a replacement owner', async () => {
    const namespace = `directory-lock-test-${randomUUID()}:`;
    const locker = new UrlAwareRedisLocker({ redisClient: redisUrl!, namespacePrefix: namespace });
    const observer = new Redis(redisUrl!);
    const id = { path: 'https://candidate.example/pod/file' };
    const key = `${namespace}__XPOD_OWNER_LOCK__rw:${id.path}`;
    try {
      await expect(locker.withWriteLock(id, async () => {
        // Simulate an explicitly replaced owner only on this random test key.
        await observer.hset(key, 'writer', 'replacement-test-owner');
      })).rejects.toThrow('ownership lost');
      expect(await observer.hget(key, 'writer')).toBe('replacement-test-owner');
      await locker.finalize();
      expect(await observer.hget(key, 'writer')).toBe('replacement-test-owner');
    } finally {
      await observer.del(key);
      observer.disconnect(false);
      await locker.finalize();
    }
  });
});
