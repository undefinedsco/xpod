// Independent actual hierarchy/store/CSS consumer acceptance. Mix's real getMetadata
// warm-cache path is exercised; this is not backend, Redis or Gateway acceptance.
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  arrayifyStream, BaseAuthorizationManager, BasicRepresentation, GreedyReadWriteLocker,
  INTERNAL_QUADS, MemoryMapStorage, MemoryResourceLocker, RepresentationMetadata,
  SingleRootIdentifierStrategy, SuffixAuxiliaryIdentifierStrategy,
} from '@solid/community-server';
import type { ResourceStore } from '@solid/community-server';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { metadataRequestContext, type MetadataRequestState } from '../../src/storage/MetadataRequestContext';
import { collectAuthorityDependencies, newAuthoritySnapshotState, settleAuthorityReads } from '../../src/storage/AuthoritySnapshotContext';

const base = 'https://authority-lifecycle.invalid/';
const room = { path: `${base}pod/a/room/` };
const strategy = new SingleRootIdentifierStrategy(base);
const auxiliary = new SuffixAuxiliaryIdentifierStrategy('.acl');
const delay = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function locker() {
  return new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), strategy,
  );
}

describe('independent authority read lifecycle', () => {
  it('keeps the mapped subject lock through actual Mix warm metadata reads of ancestors', async () => {
    const locks = locker();
    const accessor = Object.create(MixDataAccessor.prototype) as MixDataAccessor;
    const cache: MetadataRequestState = { metadataCache: new Map() };
    const ancestors = [ base, `${base}pod/`, `${base}pod/a/` ];
    for (const subject of ancestors) {
      const uri = `${subject}.acl`;
      cache.metadataCache.set(uri, { kind: 'hit', metadata: new RepresentationMetadata({ path: uri }) });
    }
    const source = { getRepresentation: async (identifier: { path: string }) =>
      new BasicRepresentation(Readable.from([], { objectMode: true }), await accessor.getMetadata(identifier)) };
    const store = new LockingResourceStore(source as unknown as ResourceStore, locks, auxiliary);
    await locks.withWriteLockAndReadDependencies(room, ancestors.map(path => ({ path })), async () => {
      const state = newAuthoritySnapshotState(uri => locks.hasHeldReadLock({ path: uri }));
      await metadataRequestContext.run(cache, () => collectAuthorityDependencies(state, async () => {
        for (const subject of ancestors) {
          const uri = `${subject}.acl`;
          const representation = await store.getRepresentation({ path: uri }, {});
          await arrayifyStream(representation.data);
          expect(state.dependencies.get(uri)?.lockUri).toBe(subject);
        }
        await settleAuthorityReads(state);
        expect(state.missingLocks.size).toBe(0);
      }));
    });
  });

  it('waits for another outstanding read after one fails, then reports the failure', async () => {
    const locks = locker();
    const pending = deferred();
    const source = { hasResource: async (identifier: { path: string }) => {
      if (identifier.path.endsWith('bad')) throw new Error('independent authority failure');
      await pending.promise;
      return true;
    } };
    const store = new LockingResourceStore(source as unknown as ResourceStore, locks, auxiliary);
    let settled = false;
    await locks.withWriteLockAndReadDependencies(room, [], async () => {
      const state = newAuthoritySnapshotState(uri => locks.hasHeldReadLock({ path: uri }));
      await collectAuthorityDependencies(state, async () => {
        const slow = store.hasResource({ path: `${room.path}slow` });
        const failed = store.hasResource({ path: `${room.path}bad` }).catch(() => undefined);
        const settlement = settleAuthorityReads(state).then(
          () => { settled = true; return undefined; },
          error => { settled = true; return error as Error; },
        );
        await delay(30);
        const premature = settled;
        pending.resolve();
        await Promise.all([ slow, failed ]);
        const error = await settlement;
        expect(premature).toBe(false);
        expect(error?.message).toBe('independent authority failure');
      });
    });
  });

  it('retains a source error already caught by the permission caller', async () => {
    const locks = locker();
    const store = new LockingResourceStore({ hasResource: async () => {
      throw new Error('caught authority failure');
    } } as unknown as ResourceStore, locks, auxiliary);
    await locks.withWriteLockAndReadDependencies(room, [], async () => {
      const state = newAuthoritySnapshotState(uri => locks.hasHeldReadLock({ path: uri }));
      await collectAuthorityDependencies(state, async () => {
        await store.hasResource({ path: `${room.path}bad` }).catch(() => undefined);
        await expect(settleAuthorityReads(state)).rejects.toThrow('caught authority failure');
      });
    });
  });

  it.each([ 'timeout', 'early-close' ] as const)('terminates the actual CSS authorization consumer on %s and waits for close acknowledgement', async mode => {
    const cleanup = deferred();
    const started = deferred();
    const locks = locker();
    const stream = new Readable({ objectMode: true, read() {}, destroy(_error, callback) {
      void cleanup.promise.then(() => callback(_error));
    } });
    const source = { getRepresentation: async () => {
      started.resolve();
      return new BasicRepresentation(stream, INTERNAL_QUADS);
    } };
    const store = new LockingResourceStore(source as unknown as ResourceStore, locks, auxiliary,
      { representationTimeoutMs: mode === 'timeout' ? 25 : 10000 });
    const manager = new BaseAuthorizationManager(strategy, auxiliary, store);
    let consumerSettled = false;
    const plan = locks.withWriteLockAndReadDependencies(room, [], async () => {
      const state = newAuthoritySnapshotState(uri => locks.hasHeldReadLock({ path: uri }));
      await collectAuthorityDependencies(state, async () => {
        try { await manager.getAuthorizationData(room.path); }
        finally { consumerSettled = true; await settleAuthorityReads(state); }
      });
    }).then(() => undefined, error => error as Error);
    await started.promise;
    if (mode === 'early-close') stream.destroy();
    let writerEntered = false;
    const writer = locks.withWriteLock(room, async () => { writerEntered = true; });
    await delay(60);
    const enteredBeforeClose = writerEntered;
    cleanup.resolve();
    await delay(40);
    const naturallySettled = consumerSettled;
    // Preserve a bounded failing test on the old product: unblock its hung CSS consumer.
    if (!consumerSettled) stream.emit('error', new Error('independent probe cleanup'));
    const error = await plan;
    await writer;
    expect(enteredBeforeClose).toBe(false);
    expect(naturallySettled).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(writerEntered).toBe(true);
  });
});
