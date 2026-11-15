import { setImmediate } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import {
  BaseIdentifierStrategy, BasicRepresentation, GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker,
  WrappedExpiringReadWriteLocker, InternalServerError,
  RepresentationMetadata, BasicConditions, PreconditionFailedHttpError,
  type AuxiliaryIdentifierStrategy, type ChangeMap, type ResourceIdentifier, type ResourceStore,
} from '@solid/community-server';
import { describe, expect, it, vi } from 'vitest';
import { HierarchyLockingResourceStore } from '../../src/storage/HierarchyLockingResourceStore';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { stampStorageVersion } from '../../src/storage/StorageVersion';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';

const root = 'http://localhost/';
class Strategy extends BaseIdentifierStrategy {
  public supportsIdentifier(id: ResourceIdentifier): boolean { return id.path.startsWith(root); }
  public isRootContainer(id: ResourceIdentifier): boolean { return id.path === root; }
}
function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

describe('HierarchyLockingResourceStore parent/child mutation boundary', () => {
  it('keeps ancestor read leases while preparing a slow representation, then releases them at stream end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const entered = barrier();
    const unblock = barrier();
    const body = new PassThrough();
    body.on('error', () => undefined);
    const source = { getRepresentation: async () => {
      entered.release();
      await unblock.promise;
      return new BasicRepresentation(body, 'text/plain', true);
    } } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 6000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    let failure: unknown;
    let response: Awaited<ReturnType<typeof store.getRepresentation>> | undefined;
    const running = store.getRepresentation({ path: `${root}pod/dir/file.txt` }, {}).then(value => { response = value; }, error => { failure = error; });
    const mutation = vi.fn();
    let pending: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(failure).toBeUndefined();
      expect(response).toBeUndefined();
      pending = store.withMutationLocks({ path: `${root}pod/` }, mutation);
      await vi.advanceTimersByTimeAsync(1);
      expect(mutation).not.toHaveBeenCalled();
      unblock.release();
      await running;
      expect(response).toBeDefined();
      body.end('prepared body');
      const chunks: Buffer[] = [];
      for await (const chunk of response!.data) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('prepared body');
      await pending;
      expect(mutation).toHaveBeenCalledOnce();
    } finally {
      unblock.release();
      body.destroy();
      await running;
      await pending;
      vi.useRealTimers();
    }
  });

  it('still expires an unread response under the original lease after preparation finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const body = new PassThrough();
    body.on('error', () => undefined);
    const source = { getRepresentation: async () => new BasicRepresentation(body, 'text/plain', true) } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 6000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    try {
      await store.getRepresentation({ path: `${root}pod/dir/file.txt` }, {});
      const mutation = vi.fn();
      const pending = store.withMutationLocks({ path: `${root}pod/` }, mutation);
      await vi.advanceTimersByTimeAsync(1);
      expect(mutation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6000);
      await pending;
      expect(body.destroyed).toBe(true);
      expect(mutation).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.destroy();
      vi.useRealTimers();
    }
  });

  it('maintains acquired ancestors while waiting for the target read lock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const target = { path: `${root}pod/dir/file.txt` };
    const plain = new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>());
    const held = barrier();
    const release = barrier();
    const blocker = plain.withWriteLock(target, async () => { held.release(); await release.promise; });
    const body = new PassThrough();
    body.on('error', () => undefined);
    const source = { getRepresentation: vi.fn().mockResolvedValue(new BasicRepresentation(body, 'text/plain', true)) } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(plain, 6000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    let failure: unknown;
    const running = store.getRepresentation(target, {}).catch(error => { failure = error; return undefined; });
    try {
      await held.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(failure).toBeUndefined();
      expect(source.getRepresentation).not.toHaveBeenCalled();
      release.release();
      await blocker;
      const response = await running;
      expect(response).toBeDefined();
      body.end('ready');
      for await (const _chunk of response!.data) { /* Drain the real stream. */ }
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.release();
      body.destroy();
      await blocker;
      await running;
      vi.useRealTimers();
    }
  });

  it.each(['action rejection', 'stream error', 'stream close'] as const)('releases read locks and timers on %s', async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const body = new PassThrough();
    body.on('error', () => undefined);
    const source = { getRepresentation: async () => {
      if (mode === 'action rejection') throw new Error('Read failed');
      return new BasicRepresentation(body, 'text/plain', true);
    } } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 6000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    try {
      const response = store.getRepresentation({ path: `${root}pod/dir/file.txt` }, {});
      if (mode === 'action rejection') await expect(response).rejects.toThrow('Read failed');
      else {
        await response;
        body.destroy(mode === 'stream error' ? new Error('Stream failed') : undefined);
      }
      const mutation = vi.fn();
      await store.withMutationLocks({ path: `${root}pod/` }, mutation);
      expect(mutation).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body.destroy();
      vi.useRealTimers();
    }
  });

  it('does not publish a representation after an outer lease failed during an inner acquisition', async () => {
    const entered = barrier();
    const failOuter = barrier();
    const lateAcquire = barrier();
    const body = new PassThrough();
    const source = { getRepresentation: vi.fn().mockResolvedValue(new BasicRepresentation(body, 'text/plain', true)) } as unknown as ResourceStore;
    const locks = {
      withReadLock: async (id: ResourceIdentifier, callback: (renew: () => void) => Promise<unknown>) => {
        if (id.path === root) return Promise.race([callback(() => undefined), failOuter.promise.then(() => { throw new Error('Lease lost'); })]);
        if (id.path.endsWith('file.txt')) { entered.release(); await lateAcquire.promise; }
        return callback(() => undefined);
      },
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    const running = store.getRepresentation({ path: `${root}pod/dir/file.txt` }, {});
    try {
      await entered.promise;
      failOuter.release();
      await expect(running).rejects.toThrow('Lease lost');
      lateAcquire.release();
      await setImmediate();
      expect(source.getRepresentation).not.toHaveBeenCalled();
    } finally {
      lateAcquire.release();
      body.destroy();
    }
  });

  it('holds ancestor read locks until the child response stream ends', async () => {
    const body = new PassThrough();
    const source = { getRepresentation: async () => new BasicRepresentation(body, 'text/plain', true) } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 10_000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    const response = await store.getRepresentation({ path: `${root}pod/dir/file.txt` }, {});
    const attempted = barrier();
    const writeLock = locks.withWriteLock.bind(locks);
    vi.spyOn(locks, 'withWriteLock').mockImplementation((id, callback) => {
      attempted.release();
      return writeLock(id, callback);
    });
    const mutation = vi.fn();
    const pending = store.withMutationLocks({ path: `${root}pod/` }, mutation);
    try {
      await attempted.promise;
      await setImmediate();
      expect(mutation).not.toHaveBeenCalled();
      body.end('original body');
      const chunks: Buffer[] = [];
      for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('original body');
      await pending;
      expect(mutation).toHaveBeenCalledOnce();
    } finally {
      response.data.destroy();
      await pending;
      vi.restoreAllMocks();
    }
  });

  it('discards pre-lock request metadata before validating an old If-Match', async () => {
    const id = { path: `${root}pod/file.txt` };
    const old = new RepresentationMetadata(id, 'text/plain');
    stampStorageVersion(old);
    const current = new RepresentationMetadata(old);
    stampStorageVersion(current);
    const conditions = new BasicConditions(new StorageETagHandler(), { matchesETag: [new StorageETagHandler().getETag(old)!] });
    const source = { setRepresentation: async () => {
      const cached = metadataRequestContext.getStore()?.metadataCache.get(id.path);
      const observed = cached?.kind === 'hit' ? cached.metadata : current;
      if (!conditions.matchesMetadata(observed)) throw new PreconditionFailedHttpError();
      throw new Error('Stale write reached mutation');
    } } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 10_000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    await metadataRequestContext.run({ metadataCache: new Map([[id.path, { kind: 'hit', metadata: old }]]) }, async () => {
      await expect(store.setRepresentation(id, new BasicRepresentation(), conditions)).rejects.toBeInstanceOf(PreconditionFailedHttpError);
    });
  });

  it('maintains every acquired lock beyond the wrapper lease during a long mutation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const entered = barrier();
    const unblock = barrier();
    let settled = false;
    const source = { setRepresentation: async () => { entered.release(); await unblock.promise; return new Map() as ChangeMap; } } as unknown as ResourceStore;
    const locks = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 6000);
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    const running = store.setRepresentation({ path: `${root}pod/dir/file.txt` }, new BasicRepresentation()).finally(() => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
    } finally {
      unblock.release();
      await running;
      vi.useRealTimers();
    }
  });

  it('does not enter the source after an outer lock failed while an inner acquisition was pending', async () => {
    const entered = barrier();
    const failOuter = barrier();
    const lateAcquire = barrier();
    const source = { setRepresentation: vi.fn().mockResolvedValue(new Map()) } as unknown as ResourceStore;
    const locks = {
      withWriteLock: async (id: ResourceIdentifier, callback: (renew: () => void) => Promise<unknown>) => {
        if (id.path === root) return Promise.race([callback(() => undefined), failOuter.promise.then(() => { throw new Error('Lease lost'); })]);
        if (id.path.endsWith('file.txt')) { entered.release(); await lateAcquire.promise; }
        return callback(() => undefined);
      },
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const store = new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
    const running = store.setRepresentation({ path: `${root}pod/dir/file.txt` }, new BasicRepresentation());
    await entered.promise;
    failOuter.release();
    await expect(running).rejects.toThrow('Lease lost');
    lateAcquire.release();
    await setImmediate();
    expect(source.setRepresentation).not.toHaveBeenCalled();
  });

  for (const first of ['child-create', 'parent-delete'] as const) {
    it(`serializes ${first} against the competing operation without time-based sleeps`, async () => {
      const entered = barrier();
      const unblock = barrier();
      const secondAttempt = barrier();
      const events: string[] = [];
      const changes = new Map() as ChangeMap;
      const source = {
        setRepresentation: async () => {
          events.push('child-create');
          if (first === 'child-create') { entered.release(); await unblock.promise; }
          return changes;
        },
        deleteResource: async () => {
          events.push('parent-delete');
          if (first === 'parent-delete') { entered.release(); await unblock.promise; }
          return changes;
        },
      } as unknown as ResourceStore;
      const locks = new WrappedExpiringReadWriteLocker(
        new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), 10_000,
      );
      const auxiliary = { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy;
      const store = new HierarchyLockingResourceStore(source, locks, auxiliary, new Strategy());
      const create = (): Promise<ChangeMap> => store.setRepresentation({ path: `${root}pod/dir/child.txt` }, new BasicRepresentation('child', 'text/plain', true));
      const remove = (): Promise<ChangeMap> => store.deleteResource({ path: `${root}pod/dir/` });
      const running = first === 'child-create' ? create() : remove();
      await entered.promise;
      const readLock = locks.withReadLock.bind(locks);
      const writeLock = locks.withWriteLock.bind(locks);
      vi.spyOn(locks, 'withReadLock').mockImplementation((id, callback) => {
        secondAttempt.release();
        return readLock(id, callback);
      });
      vi.spyOn(locks, 'withWriteLock').mockImplementation((id, callback) => {
        secondAttempt.release();
        return writeLock(id, callback);
      });
      const competing = first === 'child-create' ? remove() : create();
      try {
        await secondAttempt.promise;
        await setImmediate();
        expect(events).toEqual([first]);
      } finally {
        unblock.release();
        await Promise.all([running, competing]);
      }
      expect(events).toEqual([first, first === 'child-create' ? 'parent-delete' : 'child-create']);
      vi.restoreAllMocks();
    });
  }
});

/**
 * Regressions for the pending representation/child lease gap: an acquired
 * ancestor read lock must stay alive while a descendant lock acquisition or the
 * representation creation is still pending, then hand off to the original CSS
 * stream-read renewal. These use the real WrappedExpiringReadWriteLocker with a
 * fake clock, so an expired lease really rejects.
 */
describe('HierarchyLockingResourceStore pending read lease renewal', () => {
  const target = { path: `${root}pod/dir/file.txt` };

  function fakeLockTimers(): void {
    vi.useFakeTimers({ toFake: [ 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval' ] });
  }

  /**
   * Counts live setInterval timers so a leak cannot hide behind a passing
   * assertion, and can manually fire the still-active callbacks exactly like
   * the ROOT outer-loss counterexample does. Firing after an abort must be 0.
   */
  function trackIntervals(): { active: () => number; fire: () => number; restore: () => void } {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const timers = new Map<ReturnType<typeof setInterval>, () => void>();
    (globalThis as any).setInterval = (...args: any[]) => {
      const timer = (realSetInterval as any)(...args);
      timers.set(timer, args[0]);
      return timer;
    };
    (globalThis as any).clearInterval = (timer: any) => {
      timers.delete(timer);
      return realClearInterval(timer);
    };
    return {
      active: () => timers.size,
      fire: () => { let fired = 0; for (const callback of [ ...timers.values() ]) { callback(); fired += 1; } return fired; },
      restore: () => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; },
    };
  }

  function realLocks(expiration = 6000): WrappedExpiringReadWriteLocker {
    return new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), expiration);
  }

  function store(source: ResourceStore, locks: import('@solid/community-server').ExpiringReadWriteLocker): HierarchyLockingResourceStore {
    return new HierarchyLockingResourceStore(source, locks, { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy, new Strategy());
  }

  async function drain(representation: { data: AsyncIterable<unknown> }): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of representation.data) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString();
  }

  it('(a) keeps a pending source read alive across multiple leases and blocks a writer', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const entered = barrier();
    const unblock = barrier();
    const body = new PassThrough();
    const source = {
      getRepresentation: async () => { entered.release(); await unblock.promise; return new BasicRepresentation(body, 'text/plain', true); },
    } as unknown as ResourceStore;
    const locks = realLocks();
    const hierarchy = store(source, locks);
    try {
      const reading = hierarchy.getRepresentation(target, {});
      await entered.promise;
      // Two full production leases pass while the source is still pending.
      await vi.advanceTimersByTimeAsync(13_000);

      let writerAcquired = false;
      const writing = locks.withWriteLock(target, async () => { writerAcquired = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writerAcquired).toBe(false);

      unblock.release();
      const representation = await reading;
      expect(writerAcquired).toBe(false);
      body.end('renewed body');
      await expect(drain(representation)).resolves.toBe('renewed body');
      await writing;
      expect(writerAcquired).toBe(true);
      expect(intervals.active()).toBe(0);
    } finally {
      body.destroy();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(b) revives a held ancestor while the child lock acquisition waits longer than a lease', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const sourceCalls: string[] = [];
    const body = new PassThrough();
    const source = {
      getRepresentation: async () => { sourceCalls.push('read'); return new BasicRepresentation(body, 'text/plain', true); },
    } as unknown as ResourceStore;
    // Hold a raw (non-expiring) write lock on the shared locker so the deepest
    // read acquisition is queued while the ancestors hold their read locks.
    const greedy = new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>());
    const locks = new WrappedExpiringReadWriteLocker(greedy, 6000);
    const hierarchy = store(source, locks);
    let releaseWrite!: () => void;
    try {
      const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const blocker = greedy.withWriteLock(target, async () => { await writeHeld; });
      const reading = hierarchy.getRepresentation(target, {});
      await setImmediate();
      await setImmediate();
      expect(intervals.active()).toBeGreaterThan(0);

      // The child waits longer than a full lease: held ancestors must renew
      // themselves and the source must not run before the child is acquired.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sourceCalls).toEqual([]);

      releaseWrite();
      await vi.advanceTimersByTimeAsync(1_000);
      const representation = await reading;
      expect(sourceCalls).toEqual([ 'read' ]);
      body.end('child body');
      await expect(drain(representation as any)).resolves.toBe('child body');
      await blocker;
      expect(intervals.active()).toBe(0);
    } finally {
      releaseWrite();
      body.destroy();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(c) stops the pending interval once a representation is delivered and lets an unread stream expire', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const body = new PassThrough();
    const source = {
      getRepresentation: async () => new BasicRepresentation(body, 'text/plain', true),
    } as unknown as ResourceStore;
    const locks = realLocks();
    const hierarchy = store(source, locks);
    try {
      const representation = await hierarchy.getRepresentation(target, {});
      // The pending interval has handed off to the stream-read renewal.
      expect(intervals.active()).toBe(0);

      let writerAcquired = false;
      const writing = locks.withWriteLock(target, async () => { writerAcquired = true; });
      await vi.advanceTimersByTimeAsync(7_000);
      // The unread stream expired by the original lease, releasing ancestor locks.
      expect(writerAcquired).toBe(true);
      await writing;
      expect(body.destroyed).toBe(true);
      expect(intervals.active()).toBe(0);
      expect(representation.data).toBeDefined();
    } finally {
      body.destroy();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(c) lets a read-then-stalled stream expire and releases the writer without an immortal timer', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const body = new PassThrough();
    const source = {
      getRepresentation: async () => new BasicRepresentation(body, 'text/plain', true),
    } as unknown as ResourceStore;
    const locks = realLocks();
    const hierarchy = store(source, locks);
    try {
      const representation = await hierarchy.getRepresentation(target, {});
      const iterator = (representation.data as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      body.write('first');
      const first = await iterator.next();
      expect(Buffer.from(first.value!).toString()).toBe('first');
      // A read renewed the lease once; the stall then exceeds the 6s lease.
      await vi.advanceTimersByTimeAsync(7_000);
      let writerAcquired = false;
      const writing = locks.withWriteLock(target, async () => { writerAcquired = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(writerAcquired).toBe(true);
      await writing;
      expect(intervals.active()).toBe(0);
    } finally {
      body.destroy();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(d) preserves a source rejection identity and clears timers and locks', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const failure = new Error('source read exploded');
    const source = {
      getRepresentation: async () => { throw failure; },
    } as unknown as ResourceStore;
    const locks = realLocks();
    const hierarchy = store(source, locks);
    try {
      await expect(hierarchy.getRepresentation(target, {})).rejects.toBe(failure);
      let writerAcquired = false;
      const writing = locks.withWriteLock(target, async () => { writerAcquired = true; });
      await vi.advanceTimersByTimeAsync(500);
      await writing;
      expect(writerAcquired).toBe(true);
      expect(intervals.active()).toBe(0);
    } finally {
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(d) releases ancestor locks on stream end, close and error', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const locks = realLocks();
    const hierarchy = store({ getRepresentation: async () => new BasicRepresentation(new PassThrough(), 'text/plain', true) } as unknown as ResourceStore, locks);
    const outcomes: Array<'end' | 'close' | 'error'> = [ 'end', 'close', 'error' ];
    try {
      for (const outcome of outcomes) {
        const body = new PassThrough();
        const localLocks = realLocks();
        const local = store({ getRepresentation: async () => new BasicRepresentation(body, 'text/plain', true) } as unknown as ResourceStore, localLocks);
        const representation = await local.getRepresentation(target, {});
        const iterator = (representation.data as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
        if (outcome === 'end') { body.end('done'); await iterator.next(); }
        if (outcome === 'close') body.destroy();
        if (outcome === 'error') body.destroy(new Error('stream failed'));
        await vi.advanceTimersByTimeAsync(50);
        let writerAcquired = false;
        const writing = localLocks.withWriteLock(target, async () => { writerAcquired = true; });
        await vi.advanceTimersByTimeAsync(500);
        await writing;
        expect(writerAcquired, outcome).toBe(true);
      }
      expect(intervals.active()).toBe(0);
      expect(locks).toBeDefined();
      expect(hierarchy).toBeDefined();
    } finally {
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(e) refuses a child that was still acquiring when the outer lease was lost', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const lostOuter = barrier();
    const sourceCalls: string[] = [];
    const real = realLocks();
    const locks = {
      withReadLock: <T>(id: ResourceIdentifier, callback: (maintainLock: () => void) => Promise<T>): Promise<T> => {
        if (id.path !== root) return real.withReadLock(id, callback);
        return Promise.race([
          callback(() => undefined),
          lostOuter.promise.then(() => { throw new InternalServerError('Lock expired after 6000ms on /'); }),
        ]);
      },
      withWriteLock: real.withWriteLock.bind(real),
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const source = {
      getRepresentation: async () => { sourceCalls.push('read'); return new BasicRepresentation('late', 'text/plain', true); },
    } as unknown as ResourceStore;
    const hierarchy = store(source, locks);
    try {
      // Block the deepest child acquisition with a real held write lock.
      let releaseWrite!: () => void;
      const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const blocker = real.withWriteLock(target, async () => { await writeHeld; });

      const reading = hierarchy.getRepresentation(target, {}) as Promise<{ data: unknown }>;
      await setImmediate();
      lostOuter.release();
      await expect(reading).rejects.toBeInstanceOf(InternalServerError);

      // The child may now acquire, but the aborted chain must never run the source.
      releaseWrite();
      await vi.advanceTimersByTimeAsync(2_000);
      await blocker;
      expect(sourceCalls).toEqual([]);
      expect(intervals.active()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(e) destroys a representation delivered after the outer lease was lost', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const lostOuter = barrier();
    const sourceGate = barrier();
    const lateBody = new PassThrough();
    const real = realLocks();
    const locks = {
      withReadLock: <T>(id: ResourceIdentifier, callback: (maintainLock: () => void) => Promise<T>): Promise<T> => {
        if (id.path !== root) return real.withReadLock(id, callback);
        return Promise.race([
          callback(() => undefined),
          lostOuter.promise.then(() => { throw new InternalServerError('Lock expired after 6000ms on /'); }),
        ]);
      },
      withWriteLock: real.withWriteLock.bind(real),
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const source = {
      getRepresentation: async () => { await sourceGate.promise; return new BasicRepresentation(lateBody, 'text/plain', true); },
    } as unknown as ResourceStore;
    const hierarchy = store(source, locks);
    try {
      const reading = hierarchy.getRepresentation(target, {}) as Promise<{ data: unknown }>;
      await setImmediate();
      // Lose the outer lease while the source read is still in flight.
      lostOuter.release();
      await expect(reading).rejects.toBeInstanceOf(InternalServerError);
      // The late representation must be destroyed, not handed out.
      sourceGate.release();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lateBody.destroyed).toBe(true);
      expect(intervals.active()).toBe(0);
    } finally {
      sourceGate.release();
      vi.restoreAllMocks();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(e) clears every pending renewal timer immediately when the outer lease is lost (source pending)', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const lostOuter = barrier();
    const sourceEntered = barrier();
    const sourceGate = barrier();
    const lateBody = new PassThrough();
    const sourceCalls: string[] = [];
    const real = realLocks();
    const locks = {
      withReadLock: <T>(id: ResourceIdentifier, callback: (maintainLock: () => void) => Promise<T>): Promise<T> => {
        if (id.path !== root) return real.withReadLock(id, callback);
        // Race the real wrapper so the callback keeps running after expiry,
        // exactly like WrappedExpiringReadWriteLocker does in production.
        return Promise.race([
          real.withReadLock(id, callback),
          lostOuter.promise.then(() => { throw new InternalServerError('Lock expired after 6000ms on /'); }),
        ]);
      },
      withWriteLock: real.withWriteLock.bind(real),
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const source = {
      getRepresentation: async () => {
        sourceCalls.push('read');
        sourceEntered.release();
        await sourceGate.promise;
        return new BasicRepresentation(lateBody, 'text/plain', true);
      },
    } as unknown as ResourceStore;
    const hierarchy = store(source, locks);
    try {
      const reading = hierarchy.getRepresentation(target, {}) as Promise<{ data: unknown }>;
      await sourceEntered.promise;
      // Ancestor layers hold pending renewals while the source is still in flight.
      expect(intervals.active()).toBeGreaterThan(0);

      lostOuter.release();
      await expect(reading).rejects.toBeInstanceOf(InternalServerError);

      // IMMEDIATELY after the outer reject, before the source gate is opened:
      // no timer may survive and manually firing callbacks must invoke nothing.
      expect(intervals.active()).toBe(0);
      expect(intervals.fire()).toBe(0);
      expect(sourceCalls).toEqual([ 'read' ]);
      expect(lateBody.destroyed).toBe(false);

      // Releasing the still-pending source must destroy the late representation.
      sourceGate.release();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lateBody.destroyed).toBe(true);
      expect(sourceCalls).toEqual([ 'read' ]);
      expect(intervals.active()).toBe(0);
      expect(intervals.fire()).toBe(0);
    } finally {
      sourceGate.release();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(e) clears every pending renewal timer immediately when the outer lease is lost (child acquisition pending)', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const lostOuter = barrier();
    const sourceCalls: string[] = [];
    const real = realLocks();
    const locks = {
      withReadLock: <T>(id: ResourceIdentifier, callback: (maintainLock: () => void) => Promise<T>): Promise<T> => {
        if (id.path !== root) return real.withReadLock(id, callback);
        return Promise.race([
          real.withReadLock(id, callback),
          lostOuter.promise.then(() => { throw new InternalServerError('Lock expired after 6000ms on /'); }),
        ]);
      },
      withWriteLock: real.withWriteLock.bind(real),
    } as unknown as import('@solid/community-server').ExpiringReadWriteLocker;
    const source = {
      getRepresentation: async () => { sourceCalls.push('read'); return new BasicRepresentation('late', 'text/plain', true); },
    } as unknown as ResourceStore;
    const hierarchy = store(source, locks);
    let releaseWrite!: () => void;
    try {
      // Hold the target write lock so the deepest read acquisition stays queued.
      const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const blocker = real.withWriteLock(target, async () => { await writeHeld; });

      const reading = hierarchy.getRepresentation(target, {}) as Promise<{ data: unknown }>;
      await setImmediate();
      await setImmediate();
      expect(intervals.active()).toBeGreaterThan(0);

      lostOuter.release();
      await expect(reading).rejects.toBeInstanceOf(InternalServerError);

      // IMMEDIATELY after the outer reject, before the writer is released.
      expect(intervals.active()).toBe(0);
      expect(intervals.fire()).toBe(0);
      expect(sourceCalls).toEqual([]);

      // The child may acquire now, but the aborted chain must never run the source.
      releaseWrite();
      await vi.advanceTimersByTimeAsync(2_000);
      await blocker;
      expect(sourceCalls).toEqual([]);
      expect(intervals.active()).toBe(0);
      expect(intervals.fire()).toBe(0);
    } finally {
      releaseWrite();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(f) keeps the existing write root-first acquisition, renewal and metadata refresh order', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const events: string[] = [];
    const source = {
      setRepresentation: async () => { events.push('source'); return new Map() as ChangeMap; },
      hasResource: async () => false,
    } as unknown as ResourceStore;
    const locks = realLocks();
    const order: string[] = [];
    const originalWrite = locks.withWriteLock.bind(locks);
    vi.spyOn(locks, 'withWriteLock').mockImplementation((id, callback) => {
      order.push(id.path);
      return originalWrite(id, callback);
    });
    const auxiliary = { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryIdentifierStrategy;
    const hierarchy = new HierarchyLockingResourceStore(source, locks, auxiliary, new Strategy());
    try {
      await hierarchy.setRepresentation(target, new BasicRepresentation());
      // Root-first: every ancestor precedes the target, and the source runs last.
      expect(order).toEqual([ root, `${root}pod/`, `${root}pod/dir/`, target.path ]);
      expect(events).toEqual([ 'source' ]);
      expect(intervals.active()).toBe(0);
    } finally {
      vi.restoreAllMocks();
      intervals.restore();
      vi.useRealTimers();
    }
  });

  it('(g) rejects when the underlying source violates its return contract and resolves undefined', async () => {
    fakeLockTimers();
    const intervals = trackIntervals();
    const source = {
      getRepresentation: async () => undefined as unknown as BasicRepresentation,
    } as unknown as ResourceStore;
    const locks = realLocks();
    const hierarchy = store(source, locks);
    try {
      // A contract-violating source resolves no representation. The original
      // CSS consumer rejects with a TypeError; the hierarchy must not swallow
      // that failure into an outward promise that never settles.
      const settledPromise = Promise.race([
        hierarchy.getRepresentation(target, {}).then(
          () => ({ status: 'resolved' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ status: 'observer_timeout' }>((resolve) => {
          setTimeout(() => resolve({ status: 'observer_timeout' }), 50);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(50);
      const settled = await settledPromise;
      expect(settled.status).toBe('rejected');
      if (settled.status === 'rejected') expect(settled.error).toBeInstanceOf(TypeError);
      expect(intervals.active()).toBe(0);
    } finally {
      intervals.restore();
      vi.useRealTimers();
    }
  });
});
