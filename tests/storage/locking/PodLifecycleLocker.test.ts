import { describe, expect, it, vi } from 'vitest';
import { GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker } from '@solid/community-server';
import { PodLifecycleLocker } from '../../../src/storage/locking/PodLifecycleLocker';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('PodLifecycleLocker', () => {
  it('does not expire or release a live local writer callback after arbitrary elapsed time', async () => {
    vi.useFakeTimers();
    const release = deferred();
    try {
      const locker = new PodLifecycleLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()));
      const entered = deferred(); const identifier = { path: 'urn:owned-test:local' };
      const write = locker.withWriteLock(identifier, async (maintain) => { maintain(); entered.resolve(); await release.promise; });
      await entered.promise;
      let readEntered = false;
      const read = locker.withReadLock(identifier, async (maintain) => { maintain(); readEntered = true; });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(readEntered).toBe(false);
      release.resolve();
      await Promise.all([write, read]);
      expect(readEntered).toBe(true);
      await expect(locker.withWriteLock(identifier, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
      await expect(locker.withReadLock(identifier, async () => 'recovered')).resolves.toBe('recovered');
    } finally { release.resolve(); vi.useRealTimers(); }
  });
});
