import { setImmediate } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import {
  BaseIdentifierStrategy, BasicRepresentation, GreedyReadWriteLocker, MemoryMapStorage, MemoryResourceLocker,
  WrappedExpiringReadWriteLocker,
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
