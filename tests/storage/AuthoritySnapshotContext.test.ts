import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  BasicRepresentation,
  GreedyReadWriteLocker,
  MemoryMapStorage,
  MemoryResourceLocker,
  SingleRootIdentifierStrategy,
} from '@solid/community-server';
import { AuthorityResourceTracker, authorityResourceTracker } from '../../src/storage/AuthorityResourceTracker';
import {
  authorityDependenciesFresh,
  authoritySnapshotContext,
  captureAuthorityDependency,
  collectAuthorityDependencies,
  newAuthoritySnapshotState,
  settleAuthorityReads,
} from '../../src/storage/AuthoritySnapshotContext';
import { HierarchicalReadWriteLocker } from '../../src/storage/HierarchicalReadWriteLocker';
import { LockingResourceStore } from '../../src/storage/LockingResourceStore';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { metadataRequestContext } from '../../src/storage/MetadataRequestContext';
import { RepresentationMetadata, arrayifyStream, guardStream } from '@solid/community-server';
import type { DataAccessor, ResourceStore, AuxiliaryIdentifierStrategy } from '@solid/community-server';

describe('authority resource snapshots', () => {
  it('uses the mapped ancestor READ through actual Mix metadata/data and warm metadata cache', async() => {
    const base = 'http://localhost:3000/'; const acl = `${base}pod/.acl`;
    const locker = new HierarchicalReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()), new SingleRootIdentifierStrategy(base));
    const metadata = new RepresentationMetadata({path:acl}); metadata.contentType = 'text/plain';
    let metadataReads = 0;
    const accessor = {getMetadata: async() => {metadataReads++; return metadata;}, getData: async() => guardStream(Readable.from(['policy']))} as unknown as DataAccessor;
    const mix = new MixDataAccessor(accessor, accessor);
    const source = {getRepresentation: async(identifier: {path:string}) => new BasicRepresentation(await mix.getData(identifier), metadata)} as unknown as ResourceStore;
    const auxiliary = {isAuxiliaryIdentifier: (identifier: {path:string}) => identifier.path.endsWith('.acl'), getSubjectIdentifier: () => ({path:`${base}pod/`})} as unknown as AuxiliaryIdentifierStrategy;
    const store = new LockingResourceStore(source, locker, auxiliary);
    await locker.withWriteLockAndReadDependencies({path:`${base}pod/room/`}, [{path:`${base}pod/`}], async() => {
      const state = newAuthoritySnapshotState(uri => locker.hasHeldReadLock({path:uri}));
      await metadataRequestContext.run({metadataCache:new Map()}, () => collectAuthorityDependencies(state, async() => {
        for (let i = 0; i < 2; i++) {
          const representation = await store.getRepresentation({path:acl}, {type:{'text/plain':1}});
          expect((await arrayifyStream(representation.data)).join('')).toBe('policy');
        }
      }));
      await settleAuthorityReads(state);
      expect(state.dependencies.get(acl)?.lockUri).toBe(`${base}pod/`);
      expect(metadataReads).toBe(1);
    });
  });
  it('drains every pending read before propagating an early rejection', async() => {
    const state = newAuthoritySnapshotState();
    let close: () => void = () => undefined;
    const late = new Promise<void>(resolve => { close = resolve; });
    state.pendingReads.add(Promise.reject(new Error('early read failed')));
    state.pendingReads.add(late);
    let finished = false;
    const drain = settleAuthorityReads(state).then(() => {finished = true;}, () => {finished = true;});
    await new Promise(resolve => setTimeout(resolve, 20));
    try { expect(finished).toBe(false); }
    finally { state.pendingReads.clear(); close(); await drain; }
  });
  it('tracks generation and active state through a mutation', async() => {
    const tracker = new AuthorityResourceTracker();
    expect(tracker.snapshot('pod/.acl')).toEqual({ generation: 0, active: false });
    let inside: { generation: number; active: boolean } | undefined;
    await tracker.runMutation('pod/.acl', async() => {
      inside = tracker.snapshot('pod/.acl');
    });
    expect(inside).toEqual({ generation: 1, active: true });
    // The generation survives; the active flag clears on settle.
    expect(tracker.snapshot('pod/.acl')).toEqual({ generation: 1, active: false });
  });

  it('invalidates a captured dependency when its authority resource is mutated', async() => {
    const state = newAuthoritySnapshotState();
    await collectAuthorityDependencies(state, async() => {
      captureAuthorityDependency('pod/.acl#t2', 'pod/');
    });
    expect(state.dependencies.get('pod/.acl#t2')?.snapshot).toEqual({ generation: 0, active: false });
    expect(authorityDependenciesFresh(state)).toBe(true);

    await authorityResourceTracker.runMutation('pod/.acl#t2', async() => undefined);
    // A later mutation makes the authorization stale.
    expect(authorityDependenciesFresh(state)).toBe(false);
  });

  it('keeps the first snapshot when a warm cache records the dependency again', async() => {
    const state = newAuthoritySnapshotState();
    await collectAuthorityDependencies(state, async() => {
      captureAuthorityDependency('pod/.acl#t3', 'pod/');
      await authorityResourceTracker.runMutation('pod/.acl#t3', async() => undefined);
      // A re-read after the mutation must not refresh the snapshot.
      captureAuthorityDependency('pod/.acl#t3', 'pod/');
    });
    expect(state.dependencies.get('pod/.acl#t3')?.snapshot).toEqual({ generation: 0, active: false });
    expect(authorityDependenciesFresh(state)).toBe(false);
  });
  it('retains the outer auxiliary subject mapping when a lower accessor captures the same ACL', async() => {
    const state = newAuthoritySnapshotState(uri => uri === 'https://pod.invalid/');
    await collectAuthorityDependencies(state, async() => {
      captureAuthorityDependency('https://pod.invalid/.acl', 'https://pod.invalid/');
      captureAuthorityDependency('https://pod.invalid/.acl', 'https://pod.invalid/.acl');
    });
    expect(state.dependencies.get('https://pod.invalid/.acl')?.lockUri).toBe('https://pod.invalid/');
    expect(state.missingLocks.size).toBe(0);
  });

  it('never treats a snapshot captured during an active mutation as fresh', async() => {
    const tracker = new AuthorityResourceTracker();
    let capturedDuringMutation: { generation: number; active: boolean } | undefined;
    await tracker.runMutation('pod/.acl-active',
      async() => { capturedDuringMutation = tracker.snapshot('pod/.acl-active'); });
    expect(capturedDuringMutation).toEqual({ generation: 1, active: true });
    // The mutation has settled with the same generation, but the captured snapshot saw it active.
    expect(tracker.isFresh('pod/.acl-active', capturedDuringMutation!)).toBe(false);
  });

  it('does not record dependencies outside an active snapshot attempt', async() => {
    // Outside the ALS scope, capture is a no-op (permission-only).
    captureAuthorityDependency('pod/.acl#t4', 'pod/');
    expect(authoritySnapshotContext.getStore()).toBeUndefined();
  });

  it('records the mapped lock for an ACL read and invalidates it when the ACL is written', async() => {
    const base = 'http://localhost:3000/';
    const locker = new HierarchicalReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
      new SingleRootIdentifierStrategy(base),
    );
    const source = {
      getRepresentation: async() => new BasicRepresentation(Readable.from([ '' ]), 'text/turtle'),
      setRepresentation: async() => ({}),
    } as never;
    const auxiliary = {
      isAuxiliaryIdentifier: (identifier: { path: string }) => identifier.path.endsWith('.acl'),
      getSubjectIdentifier: (identifier: { path: string }) => ({ path: identifier.path.slice(0, -'.acl'.length) }),
    };
    const store = new LockingResourceStore(
      source as never,
      locker,
      auxiliary as never,
      { representationTimeoutMs: 200 },
    );
    const acl = { path: `${base}alice/.acl` };
    const state = newAuthoritySnapshotState();
    await collectAuthorityDependencies(state, async() => {
      await store.getRepresentation(acl, { type: { 'text/turtle': 1 } });
    });
    const dependency = state.dependencies.get(acl.path);
    // The exact ACL resource is tracked, but the lock it maps to is the subject.
    expect(dependency?.resourceUri).toBe(acl.path);
    expect(dependency?.lockUri).toBe(`${base}alice/`);
    expect(authorityDependenciesFresh(state)).toBe(true);

    // The actual mutation boundary (MixDataAccessor) registers here once the write lock is held.
    await authorityResourceTracker.runMutation(acl.path, async() => undefined);
    expect(authorityDependenciesFresh(state)).toBe(false);
  });

  it('does not invalidate a dependency while an ACL writer is only queued', async() => {
    const base = 'http://localhost:3000/';
    const locker = new HierarchicalReadWriteLocker(
      new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage<number>()),
      new SingleRootIdentifierStrategy(base),
    );
    const source = {
      getRepresentation: async() => new BasicRepresentation(Readable.from([ '' ]), 'text/turtle'),
      setRepresentation: async() => ({}),
    } as never;
    const auxiliary = {
      isAuxiliaryIdentifier: (identifier: { path: string }) => identifier.path.endsWith('.acl'),
      getSubjectIdentifier: (identifier: { path: string }) => ({ path: identifier.path.slice(0, -'.acl'.length) }),
    };
    const store = new LockingResourceStore(source as never, locker, auxiliary as never, { representationTimeoutMs: 200 });
    const acl = { path: `${base}alice/.acl` };

    const state = newAuthoritySnapshotState();
    await collectAuthorityDependencies(state, async() => {
      captureAuthorityDependency(acl.path, `${base}alice/`);
    });
    expect(authorityDependenciesFresh(state)).toBe(true);

    // Hold the dependency READ so the ACL writer can only queue (no actual mutation yet).
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    let readEntered: () => void = () => undefined;
    const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
    const held = locker.withReadLock({ path: `${base}alice/` }, async() => {
      readEntered();
      await readGate;
    });
    await readStarted;
    const queuedWrite = store.setRepresentation(acl, new BasicRepresentation(Readable.from([ '' ]), 'text/turtle'));
    await new Promise(resolve => setTimeout(resolve, 20));
    // Queue entry must not invalidate the snapshot; only the actual mutation boundary does.
    expect(authorityDependenciesFresh(state)).toBe(true);

    releaseRead();
    await Promise.all([ held, queuedWrite ]);
  });
});
