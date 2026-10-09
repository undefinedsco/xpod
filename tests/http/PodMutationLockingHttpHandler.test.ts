import { describe, expect, it, vi } from 'vitest';
import {
  HttpHandler, GreedyReadWriteLocker, MemoryResourceLocker, MemoryMapStorage, WrappedExpiringReadWriteLocker,
  type HttpHandlerInput, type PodStore,
} from '@solid/community-server';
import { PodMutationLockingHttpHandler } from '../../src/http/PodMutationLockingHttpHandler';
import { podMutationLockIdentifier, podMutationNamespaceLockIdentifier } from '../../src/provision/PodMutationLock';

const state = vi.hoisted(() => ({ pending: false, revision: 'before' }));
vi.mock('../../src/identity/drizzle/PodDeletionOperationRepository', () => ({
  PodDeletionOperationRepository: class {
    async blocksMutation() { return state.pending; }
    async blocksNamespaceMutation() { return state.pending; }
    async namespaceDeletionRevision() { return state.revision; }
  },
}));
const baseUrl = 'https://pod.example/alice/';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function input(method: string, url: string): HttpHandlerInput {
  return { request: { method, url, headers: { host: 'attacker.example' } }, response: {} } as HttpHandlerInput;
}
function fixture(expiration = 10_000) {
  state.pending = false; state.revision = 'before';
  let registered: { id: string; accountId: string } | undefined = { id: 'pod-1', accountId: 'account-1' };
  const lookup = vi.fn(async (url: string) => url === baseUrl ? registered : undefined);
  const locker = new WrappedExpiringReadWriteLocker(new GreedyReadWriteLocker(new MemoryResourceLocker(), new MemoryMapStorage()), expiration);
  class Source extends HttpHandler {
    public override canHandle = vi.fn(async () => {});
    public handle = vi.fn(async () => {});
  }
  const source = new Source();
  const handler = new PodMutationLockingHttpHandler(source, { findByBaseUrl: lookup } as unknown as PodStore, locker, ':memory:', 'https://pod.example/');
  return { handler, source, locker, lookup, setRegistration: (value: typeof registered) => { registered = value; } };
}

describe('PodMutationLockingHttpHandler', () => {
  it('holds a child mutation through completion before exclusive Pod deletion can enter', async () => {
    const f = fixture();
    const entered = deferred(); const release = deferred(); const events: string[] = [];
    f.source.handle.mockImplementation(async () => { events.push('write'); entered.resolve(); await release.promise; events.push('write-done'); });
    const write = f.handler.handleSafe(input('PUT', '/alice/nested/file'));
    await entered.promise;
    const deletion = f.locker.withWriteLock(podMutationLockIdentifier(baseUrl), async () => { events.push('delete'); });
    expect(events).toEqual(['write']);
    release.resolve();
    await Promise.all([write, deletion]);
    expect(events).toEqual(['write', 'write-done', 'delete']);
  });

  it.each(['PUT', 'PATCH', 'POST', 'DELETE'])('rejects queued %s after a durable deletion fence appears', async (method) => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    const deletion = f.locker.withWriteLock(podMutationLockIdentifier(baseUrl), async () => { entered.resolve(); await release.promise; state.pending = true; });
    await entered.promise;
    const write = f.handler.handleSafe(input(method, method === 'POST' ? '/alice/.sparql?query=update' : '/alice/nested/file'));
    const rejected = expect(write).rejects.toThrow('POD_DELETE_IN_PROGRESS');
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledWith(baseUrl));
    release.resolve();
    await Promise.all([deletion, rejected]);
    expect(f.source.handle).not.toHaveBeenCalled();
  });

  it.each([undefined, { id: 'pod-2', accountId: 'account-1' }])('rejects stale queued writes after removal or recreation', async (next) => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    const deletion = f.locker.withWriteLock(podMutationLockIdentifier(baseUrl), async () => { entered.resolve(); await release.promise; f.setRegistration(next); });
    await entered.promise;
    const write = f.handler.handleSafe(input('PATCH', '/alice/'));
    const rejected = expect(write).rejects.toThrow('POD_INCARNATION_CHANGED');
    await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledWith(baseUrl));
    release.resolve();
    await Promise.all([deletion, rejected]);
    expect(f.source.handle).not.toHaveBeenCalled();
  });

  it.each(['/-/sparql', '/unregistered/file'])('keeps %s writes inside the namespace gate until the write completes', async (target) => {
    const f = fixture(); const entered = deferred(); const release = deferred(); const events: string[] = [];
    f.source.handle.mockImplementation(async () => { events.push('sparql'); entered.resolve(); await release.promise; events.push('sparql-done'); });
    const write = f.handler.handleSafe(input('POST', target));
    await entered.promise;
    const deletion = f.locker.withWriteLock(podMutationNamespaceLockIdentifier('https://pod.example/'), async () => { events.push('delete'); });
    expect(events).toEqual(['sparql']);
    release.resolve();
    await Promise.all([write, deletion]);
    expect(events).toEqual(['sparql', 'sparql-done', 'delete']);
  });

  it.each([true, false])('rejects queued root SPARQL after a deletion becomes pending or completed (%s)', async (pending) => {
    const f = fixture(); const entered = deferred(); const release = deferred();
    const deletion = f.locker.withWriteLock(podMutationNamespaceLockIdentifier('https://pod.example/'), async () => {
      entered.resolve(); await release.promise; state.pending = pending; state.revision = 'after';
    });
    await entered.promise;
    const readLock = vi.spyOn(f.locker, 'withReadLock');
    const write = f.handler.handleSafe(input('POST', '/-/sparql'));
    const rejected = expect(write).rejects.toThrow(pending ? 'POD_DELETE_IN_PROGRESS' : 'POD_NAMESPACE_CHANGED');
    await vi.waitFor(() => expect(readLock).toHaveBeenCalledWith(podMutationNamespaceLockIdentifier('https://pod.example/'), expect.any(Function)));
    release.resolve();
    await Promise.all([deletion, rejected]);
    expect(f.source.handle).not.toHaveBeenCalled();
  });

  it('forwards reads and deletion/provisioning control paths without acquiring the Pod gate', async () => {
    const f = fixture(); state.pending = true;
    const spy = vi.spyOn(f.locker, 'withReadLock');
    for (const request of [input('GET', '/alice/file'), input('DELETE', '/provision/pods/alice'), input('POST', '/.account/pod/delete')]) {
      await f.handler.handleSafe(request);
    }
    expect(f.source.handle).toHaveBeenCalledTimes(3);
    expect(f.source.canHandle).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('renews long-running writes and releases the barrier when the source fails', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(2_000); const entered = deferred(); const release = deferred();
      f.source.handle.mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error('write failed'); });
      const write = f.handler.handleSafe(input('PUT', '/alice/file'));
      const rejected = expect(write).rejects.toThrow('write failed');
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      let deleted = false;
      const deletion = f.locker.withWriteLock(podMutationLockIdentifier(baseUrl), async () => { deleted = true; });
      expect(deleted).toBe(false);
      release.resolve();
      await Promise.all([rejected, deletion]);
      expect(deleted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('uses trusted baseUrl despite hostile Host, rejects cross-origin absolute targets, and blocks unregistered pending paths', async () => {
    const f = fixture();
    await f.handler.handleSafe(input('POST', '/alice/.sparql'));
    expect(f.lookup).toHaveBeenCalledWith(baseUrl);
    await expect(f.handler.handleSafe(input('PUT', 'https://attacker.example/alice/file'))).rejects.toThrow('Invalid Pod mutation target');
    f.setRegistration(undefined); state.pending = true;
    await expect(f.handler.handleSafe(input('PUT', '/alice/file'))).rejects.toThrow('POD_DELETE_IN_PROGRESS');
    expect(f.source.handle).toHaveBeenCalledTimes(1);
  });
});
