import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BasicRepresentation,
  GreedyReadWriteLocker,
  MemoryMapStorage,
  MemoryResourceLocker,
  SingleRootIdentifierStrategy,
  arrayifyStream,
} from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, Representation, ResourceStore } from '@solid/community-server';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { collectAuthorityDependencies, newAuthoritySnapshotState, settleAuthorityReads } from '../../src/storage/AuthoritySnapshotContext';

const BASE = 'http://localhost:3000/';
const strategy = new SingleRootIdentifierStrategy(BASE);
const id = (path: string): { path: string } => ({ path: `${BASE}${path}` });
const auxiliaryStrategy = {
  isAuxiliaryIdentifier: () => false,
  getSubjectIdentifier: (identifier: { path: string }) => identifier,
} as unknown as AuxiliaryIdentifierStrategy;

const delay = async(ms: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** A Readable whose teardown is not acknowledged until `cleanup` resolves. */
class SlowDestroyReadable extends Readable {
  public destroyStarted = false;
  public constructor(private readonly cleanup: Promise<void>, private readonly cleanupError?: Error) {
    super();
  }

  public override _read(): void {
    // Never produces data on its own.
  }

  public override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.destroyStarted = true;
    void this.cleanup.then(() => callback(this.cleanupError), () => callback(this.cleanupError));
  }
}

function makeStore(representation: Representation, timeoutMs: number): {
  store: LockingResourceStore;
  locker: HierarchicalReadWriteLocker;
} {
  const locker = new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
    strategy,
  );
  const source = { getRepresentation: async() => representation } as unknown as ResourceStore;
  const store = new LockingResourceStore(source, locker, auxiliaryStrategy, { representationTimeoutMs: timeoutMs });
  return { store, locker };
}

describe('LockingResourceStore GET cancellation', () => {
  it('retains a swallowed hasResource failure for the final authority drain', async() => {
    const {locker} = makeStore(new BasicRepresentation(Readable.from([]), 'text/plain'), 1000);
    const store = new LockingResourceStore({hasResource: async() => {throw new Error('source failed');}} as unknown as ResourceStore, locker, auxiliaryStrategy);
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await collectAuthorityDependencies(state, async() => {
        await store.hasResource(id('pod/room/day.ttl')).catch(() => false);
      });
      await expect(settleAuthorityReads(state)).rejects.toThrow('source failed');
    });
  });
  it.each(['timeout', 'early-close', 'cleanup-error'] as const)('terminates the actual CSS arrayify consumer on authority %s after close acknowledgement', async mode => {
    const cleanup = deferred(); const ready = deferred();
    const stream = new SlowDestroyReadable(cleanup.promise, mode === 'cleanup-error' ? new Error('cleanup failed') : undefined);
    const {store, locker} = makeStore(new BasicRepresentation(stream, 'text/plain'), mode === 'early-close' ? 10000 : 25);
    let finished = false;
    const read = locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      try {
        await collectAuthorityDependencies(state, async() => {
          const representation = await store.getRepresentation(id('pod/room/day.ttl'), {type:{'text/plain':1}});
          ready.resolve();
          await arrayifyStream(representation.data);
        });
      } finally { await settleAuthorityReads(state); }
    }).then(() => {finished = true;}, () => {finished = true;});
    await ready.promise;
    if (mode === 'early-close') stream.destroy();
    await delay(60);
    expect(finished).toBe(false);
    cleanup.resolve();
    await delay(30);
    try { expect(finished).toBe(true); }
    finally { stream.emit('end'); await read; }
  });
  it('does not leave a stall timer when a different locker denies the representation read', async() => {
    vi.useFakeTimers();
    try {
      const {locker} = makeStore(new BasicRepresentation(Readable.from([]), 'text/plain'), 1000);
      const other = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), strategy);
      let calls = 0;
      const store = new LockingResourceStore({getRepresentation: async() => {calls++; return new BasicRepresentation(Readable.from([]), 'text/plain');}} as unknown as ResourceStore, other, auxiliaryStrategy);
      await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
        const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
        await expect(collectAuthorityDependencies(state, () => store.getRepresentation(id('pod/room/day.ttl'), {type:{'text/plain':1}}))).rejects.toThrow('held authority plan');
        expect(calls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      });
    } finally { vi.useRealTimers(); }
  });
  it.each(['timeout', 'error'] as const)('keeps the held plan until %s teardown is acknowledged', async mode => {
    const cleanup = deferred(); const ready = deferred();
    const stream = new SlowDestroyReadable(cleanup.promise);
    const {store, locker} = makeStore(new BasicRepresentation(stream, 'text/plain'), mode === 'timeout' ? 25 : 10000);
    const read = locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await collectAuthorityDependencies(state, async() => {
        await store.getRepresentation(id('pod/room/day.ttl'), {type:{'text/plain':1}});
        ready.resolve();
        await settleAuthorityReads(state);
      });
    });
    const rejected = expect(read).rejects.toThrow('Authority read did not complete normally');
    await ready.promise;
    let entered = false;
    const write = locker.withWriteLock(id('pod/room/'), async() => { entered = true; });
    if (mode === 'error') { stream.destroy(); stream.emit('error', new Error('authority stream failed')); }
    await delay(60);
    expect(stream.destroyStarted).toBe(true);
    expect(entered).toBe(false);
    cleanup.resolve();
    await Promise.all([rejected, write]);
    expect(entered).toBe(true);
  });

  it('rejects an escaped fresh read after its original plan has expired', async() => {
    const {store, locker} = makeStore(new BasicRepresentation(Readable.from([]), 'text/plain'), 1000);
    const resume = deferred(); let escaped: Promise<unknown> | undefined;
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await collectAuthorityDependencies(state, async() => {
        escaped = resume.promise.then(() => store.getRepresentation(id('pod/room/day.ttl'), {type:{'text/plain':1}}));
      });
    });
    resume.resolve();
    await expect(escaped).rejects.toThrow('held authority plan');
  });
  it('reads under the same held plan without reacquiring and waits for actual stream completion', async() => {
    const {store, locker} = makeStore(new BasicRepresentation(Readable.from(['authority']), 'text/plain'), 1000);
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await collectAuthorityDependencies(state, async() => {
        const representation = await store.getRepresentation(id('pod/room/day.ttl'), {type:{'text/plain':1}});
        expect(state.pendingReads.size).toBe(1);
        const data: string[] = [];
        for await (const chunk of representation.data) data.push(String(chunk));
        await settleAuthorityReads(state);
        expect(data.join('')).toBe('authority');
        expect(state.pendingReads.size).toBe(0);
      });
    });
  });

  it('denies a different locker before consulting the source even if its URL matches', async() => {
    const {locker} = makeStore(new BasicRepresentation(Readable.from([]), 'text/plain'), 1000);
    const other = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), strategy);
    let calls = 0;
    const store = new LockingResourceStore({hasResource: async() => {calls++; return true;}} as unknown as ResourceStore, other, auxiliaryStrategy);
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await expect(collectAuthorityDependencies(state, () => store.hasResource(id('pod/room/day.ttl')))).rejects.toThrow('held authority plan');
      expect(calls).toBe(0);
    });
  });

  it('does not read below an ancestor READ held only to protect a sibling WRITE', async() => {
    const {store, locker} = makeStore(new BasicRepresentation(Readable.from([]), 'text/plain'), 1000);
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await expect(collectAuthorityDependencies(state, () => store.getRepresentation(id('pod/sibling/.acl'), {type:{'text/plain':1}}))).rejects.toThrow('held authority plan');
    });
  });
  it('releases the read lock after a normally read stream ends (event consumer)', async() => {
    const { store, locker } = makeStore(
      new BasicRepresentation(Readable.from([ 'hello' ]), 'text/plain'),
      1000,
    );
    const wrapped = await store.getRepresentation(id('pod/room/day.ttl'), { type: { 'text/plain': 1 } });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      wrapped.data.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      wrapped.data.on('end', () => resolve());
      wrapped.data.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('hello');

    let scopeEntered = false;
    await locker.withWriteLock(id('pod/room/'), async() => { scopeEntered = true; });
    expect(scopeEntered).toBe(true);
  }, 10000);

  it('keeps the returned stream iterable (asyncIterator regression)', async() => {
    // The representation must carry the real source stream; an Object.create facade breaks the
    // async iterator (root baseline stream-facade-baseline.ts).
    const { store, locker } = makeStore(
      new BasicRepresentation(Readable.from([ 'a', 'b' ]), 'text/plain'),
      1000,
    );
    const wrapped = await store.getRepresentation(id('pod/room/day.ttl'), { type: { 'text/plain': 1 } });
    const chunks: string[] = [];
    for await (const chunk of wrapped.data) {
      chunks.push(Buffer.from(chunk).toString());
    }
    expect(chunks.join('')).toBe('ab');

    let scopeEntered = false;
    await locker.withWriteLock(id('pod/room/'), async() => { scopeEntered = true; });
    expect(scopeEntered).toBe(true);
  }, 10000);

  it('holds the read lock until a timed-out stream acknowledges its teardown', async() => {
    const cleanup = deferred();
    const stalled = new SlowDestroyReadable(cleanup.promise);
    const { store, locker } = makeStore(new BasicRepresentation(stalled, 'text/plain'), 25);

    const get = store.getRepresentation(id('pod/room/day.ttl'), { type: { 'text/plain': 1 } });
    await get;

    let scopeEntered = false;
    const scopeWrite = locker.withWriteLock(id('pod/room/'), async() => { scopeEntered = true; });

    await delay(80);
    expect(stalled.destroyStarted).toBe(true);
    expect(scopeEntered).toBe(false);

    cleanup.resolve();
    await Promise.all([ get, scopeWrite ]);
    expect(scopeEntered).toBe(true);
  }, 10000);

  it('treats an error before cleanup acknowledgement as cancellation, not completion', async() => {
    const cleanup = deferred();
    const source = new SlowDestroyReadable(cleanup.promise);
    const { store, locker } = makeStore(new BasicRepresentation(source, 'text/plain'), 10000);
    await store.getRepresentation(id('pod/room/day.ttl'), { type: { 'text/plain': 1 } });

    let writerEntered = false;
    const write = locker.withWriteLock(id('pod/room/'), async() => { writerEntered = true; });

    source.destroy();
    source.emit('error', new Error('dummy error before destroy acknowledgement'));
    await delay(30);
    expect(writerEntered).toBe(false);
    expect(source.closed).toBe(false);

    cleanup.resolve();
    await write;
    expect(writerEntered).toBe(true);
  }, 10000);

  it('queues a writer until an active normal read actually finishes', async() => {
    const { store, locker } = makeStore(
      new BasicRepresentation(Readable.from([ 'a', 'b' ]), 'text/plain'),
      10000,
    );
    const wrapped = await store.getRepresentation(id('pod/room/day.ttl'), { type: { 'text/plain': 1 } });

    let writerEntered = false;
    const write = locker.withWriteLock(id('pod/room/'), async() => { writerEntered = true; });
    await delay(20);
    // The reader is holding the stream but has not consumed it yet: the writer must wait.
    expect(writerEntered).toBe(false);

    await new Promise<void>((resolve, reject) => {
      wrapped.data.on('data', () => undefined);
      wrapped.data.on('end', () => resolve());
      wrapped.data.on('error', reject);
    });
    await write;
    expect(writerEntered).toBe(true);
  }, 10000);
});
