import { describe, expect, it } from 'vitest';
import {
  GreedyReadWriteLocker,
  MemoryMapStorage,
  MemoryResourceLocker,
  SingleRootIdentifierStrategy,
} from '@solid/community-server';
import type { IdentifierStrategy, ReadWriteLocker, ResourceIdentifier } from '@solid/community-server';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';

const BASE = 'http://localhost:3000/';
const strategy = new SingleRootIdentifierStrategy(BASE);
const id = (path: string): ResourceIdentifier => ({ path: `${BASE}${path}` });

const delay = async(ms: number): Promise<void> =>
  await new Promise(resolve => setTimeout(resolve, ms));

describe('held authority plan coverage', () => {
  it('requires this live locker, exact READ or strategy-proven ancestor WRITE', async() => {
    const make = (): HierarchicalReadWriteLocker => new HierarchicalReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), strategy);
    const locker = make(); const other = make();
    let late: Promise<boolean> | undefined;
    const finish = deferred();
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [id('policy.ttl')], async() => {
      expect(locker.hasHeldReadLock(id('policy.ttl'))).toBe(true);
      expect(locker.hasHeldReadLock(id('pod/room/day.ttl'))).toBe(true);
      expect(locker.hasHeldReadLock(id('pod/other/day.ttl'))).toBe(false);
      expect(locker.hasHeldReadLock(id('policy.ttl/child'))).toBe(false);
      expect(other.hasHeldReadLock(id('policy.ttl'))).toBe(false);
      late = finish.promise.then(() => locker.hasHeldReadLock(id('policy.ttl')));
    });
    finish.resolve();
    expect(await late).toBe(false);
    expect(locker.hasHeldReadLock(id('pod/room/'))).toBe(false);
  });
});

/** A deferred used as an explicit entered/released barrier instead of guessing with a delay. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** A recording locker that runs the callback immediately and remembers the acquisition order. */
function recordingLocker(): { locker: ReadWriteLocker; calls: string[] } {
  const calls: string[] = [];
  const locker: ReadWriteLocker = {
    withReadLock: async<T>(identifier: ResourceIdentifier, whileLocked: () => T | Promise<T>): Promise<T> => {
      calls.push(`read ${identifier.path}`);
      return await whileLocked();
    },
    withWriteLock: async<T>(identifier: ResourceIdentifier, whileLocked: () => T | Promise<T>): Promise<T> => {
      calls.push(`write ${identifier.path}`);
      return await whileLocked();
    },
  };
  return { locker, calls };
}

function realLocker(): HierarchicalReadWriteLocker {
  return new HierarchicalReadWriteLocker(
    new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
    strategy,
  );
}

describe('HierarchicalReadWriteLocker', () => {
  it('locks every ancestor shared, then the target read or write', async() => {
    const { locker: inner, calls } = recordingLocker();
    const locker = new HierarchicalReadWriteLocker(inner, strategy);
    const target = id('pod/room/2026/10/02/messages.ttl');

    await locker.withWriteLock(target, async() => undefined);
    expect(calls).toEqual([
      `read ${BASE}`,
      `read ${BASE}pod/`,
      `read ${BASE}pod/room/`,
      `read ${BASE}pod/room/2026/`,
      `read ${BASE}pod/room/2026/10/`,
      `read ${BASE}pod/room/2026/10/02/`,
      `write ${target.path}`,
    ]);

    calls.length = 0;
    await locker.withReadLock(target, async() => undefined);
    expect(calls.at(-1)).toBe(`read ${target.path}`);
    expect(calls.slice(0, -1).every(call => call.startsWith('read '))).toBe(true);
  });

  it('merges policy dependencies once and prunes descendants protected by the scope write', async() => {
    const { locker: inner, calls } = recordingLocker();
    const locker = new HierarchicalReadWriteLocker(inner, strategy);
    await locker.withWriteLockAndReadDependencies(id('pod/room/'), [
      id('pod/'), id('pod/policy/acl.ttl'), id('pod/room/day/messages.ttl'), id('pod/policy/acl.ttl'),
    ], async() => undefined);
    expect(calls).toEqual([
      `read ${BASE}`, `read ${BASE}pod/`, `read ${BASE}pod/policy/`,
      `write ${BASE}pod/room/`, `read ${BASE}pod/policy/acl.ttl`,
    ]);
  });

  it('holds a sibling policy dependency until the actual callback settles', async() => {
    const locker = realLocker();
    const entered = deferred(); const release = deferred();
    const held = locker.withWriteLockAndReadDependencies(id('pod/room/'), [ id('pod/policy.ttl') ], async() => {
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    let policyWritten = false;
    const writer = locker.withWriteLock(id('pod/policy.ttl'), async() => { policyWritten = true; });
    await delay(20); expect(policyWritten).toBe(false);
    release.resolve(); await Promise.all([ held, writer ]); expect(policyWritten).toBe(true);
  });

  it('orders opposed dependency plans consistently without reentrant ancestor locks', async() => {
    const locker = realLocker(); const finished: string[] = [];
    await Promise.all([
      locker.withWriteLockAndReadDependencies(id('pod/a/'), [ id('pod/b/') ], async() => { await delay(10); finished.push('a'); }),
      locker.withWriteLockAndReadDependencies(id('pod/b/'), [ id('pod/a/') ], async() => { await delay(10); finished.push('b'); }),
    ]);
    expect(finished.sort()).toEqual([ 'a', 'b' ]);
  });

  it('validates every dependency before acquiring any scope lock', async() => {
    const { locker: inner, calls } = recordingLocker();
    const locker = new HierarchicalReadWriteLocker(inner, strategy);
    let entered = false;
    await expect(locker.withWriteLockAndReadDependencies(id('pod/room/'), [
      id(`${Array.from({ length: 70 }, (_, i) => `d${i}/`).join('')}policy.ttl`),
    ], async() => { entered = true; })).rejects.toThrow(/exceeds/u);
    expect(entered).toBe(false); expect(calls).toEqual([]);
  });

  it('treats a legitimate root as a one-element chain and still runs the callback', async() => {
    const { locker: inner, calls } = recordingLocker();
    const locker = new HierarchicalReadWriteLocker(inner, strategy);
    let entered = false;
    await locker.withWriteLock(id(''), async() => { entered = true; });
    expect(entered).toBe(true);
    expect(calls).toEqual([ `write ${BASE}` ]);
  });

  it('fails closed on a too-deep chain: no lock, callback never enters', async() => {
    const { locker: inner, calls } = recordingLocker();
    const locker = new HierarchicalReadWriteLocker(inner, strategy);
    const deep = id(`${Array.from({ length: 70 }, (_, i) => `d${i}/`).join('')}document.ttl`);
    let entered = false;
    await expect(locker.withWriteLock(deep, async() => { entered = true; }))
      .rejects.toThrow(/exceeds/u);
    expect(entered).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails closed when a parent lookup throws: callback never enters', async() => {
    const { locker: inner, calls } = recordingLocker();
    const broken: IdentifierStrategy = {
      supportsIdentifier: () => true,
      isRootContainer: () => false,
      getParentContainer: () => { throw new Error('dummy parent failure'); },
      contains: () => true,
    };
    const locker = new HierarchicalReadWriteLocker(inner, broken);
    let entered = false;
    await expect(locker.withWriteLock(id('pod/day.ttl'), async() => { entered = true; }))
      .rejects.toThrow(/cannot resolve the parent/u);
    expect(entered).toBe(false);
    expect(calls).toEqual([]);
  });

  it('fails closed on a cyclic chain: callback never enters', async() => {
    const { locker: inner, calls } = recordingLocker();
    const cyclic: IdentifierStrategy = {
      supportsIdentifier: () => true,
      isRootContainer: () => false,
      getParentContainer: identifier => identifier,
      contains: () => true,
    };
    const locker = new HierarchicalReadWriteLocker(inner, cyclic);
    let entered = false;
    await expect(locker.withWriteLock(id('pod/day.ttl'), async() => { entered = true; }))
      .rejects.toThrow(/re-enters/u);
    expect(entered).toBe(false);
    expect(calls).toEqual([]);
  });

  it('excludes a descendant write while a scope container is write-locked (scope first)', async() => {
    const locker = realLocker();
    const scope = id('pod/room/');
    const document = id('pod/room/2026/10/02/messages.ttl');

    const scopeEntered = deferred();
    const releaseScope = deferred();
    const scopeHeld = locker.withWriteLock(scope, async() => {
      scopeEntered.resolve();
      await releaseScope.promise;
    });
    await scopeEntered.promise;

    let descendantEntered = false;
    const descendant = locker.withWriteLock(document, async() => { descendantEntered = true; });
    const outcome = await Promise.race([
      descendant.then(() => 'settled'),
      delay(30).then(() => 'blocked'),
    ]);
    expect(outcome).toBe('blocked');
    expect(descendantEntered).toBe(false);

    releaseScope.resolve();
    await Promise.all([ scopeHeld, descendant ]);
    expect(descendantEntered).toBe(true);
  });

  it('excludes a scope write while a descendant document is write-locked (document first)', async() => {
    const locker = realLocker();
    const scope = id('pod/room/');
    const document = id('pod/room/2026/10/02/messages.ttl');

    const docEntered = deferred();
    const releaseDoc = deferred();
    const docHeld = locker.withWriteLock(document, async() => {
      docEntered.resolve();
      await releaseDoc.promise;
    });
    await docEntered.promise;

    let scopeEntered = false;
    const scoped = locker.withWriteLock(scope, async() => { scopeEntered = true; });
    const outcome = await Promise.race([
      scoped.then(() => 'settled'),
      delay(30).then(() => 'blocked'),
    ]);
    expect(outcome).toBe('blocked');
    expect(scopeEntered).toBe(false);

    releaseDoc.resolve();
    await Promise.all([ docHeld, scoped ]);
    expect(scopeEntered).toBe(true);
  });

  it('serialises two writes to the same document', async() => {
    const locker = realLocker();
    const document = id('pod/room/2026/10/02/messages.ttl');
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = locker.withWriteLock(document, async() => {
      order.push('first-enter');
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push('first-exit');
    });
    await firstEntered.promise;
    let secondEntered = false;
    const second = locker.withWriteLock(document, async() => {
      secondEntered = true;
      order.push('second-enter');
    });
    await delay(20);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await Promise.all([ first, second ]);
    expect(order).toEqual([ 'first-enter', 'first-exit', 'second-enter' ]);
  });

  it('lets two disjoint documents under one container proceed concurrently', async() => {
    const locker = realLocker();
    const a = id('pod/room/2026/10/02/messages.ttl');
    const b = id('pod/room/2026/10/03/messages.ttl');

    let active = 0;
    let maxActive = 0;
    const run = async(document: ResourceIdentifier): Promise<void> => {
      await locker.withWriteLock(document, async() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(40);
        active -= 1;
      });
    };
    await Promise.all([ run(a), run(b) ]);
    expect(maxActive).toBe(2);
  });

  it('releases the whole chain when the callback throws, so a later writer can reacquire', async() => {
    const locker = realLocker();
    const document = id('pod/room/2026/10/02/messages.ttl');
    await expect(locker.withWriteLock(document, async() => { throw new Error('callback failed'); }))
      .rejects.toThrow('callback failed');
    // If any ancestor or target lock leaked, this would hang instead of resolving.
    let entered = false;
    await locker.withWriteLock(document, async() => { entered = true; });
    expect(entered).toBe(true);
  });
});
