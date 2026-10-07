import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PodStore, IndexedStorage, ExpiringReadWriteLocker } from '@solid/community-server';
import { PodDeletionLifecycleService } from '../../src/service/PodDeletionLifecycleService';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase } from '../../src/identity/drizzle/db';
import type { PodDataDeletionService } from '../../src/service/PodDataDeletionService';

describe('Pod deletion lifecycle', () => {
  function fixture() {
    const storageUrl = 'https://id.test/alice/';
    const pods = new Map([['p', { accountId: 'a', baseUrl: storageUrl }]]);
    const metadataDeletes: string[] = [];
    const podStore = {
      get: async (id: string) => pods.get(id),
      getOwners: async () => [{ webId: `https://id.test/alice/profile/card#me`, visible: false }],
      findByBaseUrl: async (baseUrl: string) => {
        const match = [...pods].find(([, value]) => value.baseUrl === baseUrl);
        return match ? { id: match[0], accountId: match[1].accountId } : undefined;
      },
    } as unknown as PodStore;
    const accountStorage = {
      find: async () => [{ id: 'o' }],
      delete: async (type: string, id: string) => { metadataDeletes.push(`${type}:${id}`); if (type === 'pod') { pods.delete(id); } },
    } as unknown as IndexedStorage<any>;
    const prepare = vi.fn(async () => ({ baseUrl: storageUrl, resources: [`${storageUrl}nested/data`, storageUrl] }));
    const deletePodData = vi.fn(async () => undefined);
    const options = {
      podStore, accountStorage,
      dataDeletion: { prepare, deletePodData } as unknown as PodDataDeletionService,
      identityDbUrl: `sqlite::memory:${randomUUID()}`, storageBaseUrl: 'https://id.test/', edition: 'local',
      resourceLocker: { withWriteLock: async (_id: unknown, run: () => Promise<void>) => run() } as ExpiringReadWriteLocker,
    };
    return { options, pods, storageUrl, prepare, deletePodData, metadataDeletes, service: new PodDeletionLifecycleService(options) };
  }
  it('requires creator and rejects unknown provider before any data deletion', async () => {
    const f = fixture();
    await expect(f.service.deleteOwned('other', 'p')).rejects.toThrow('creating account');
    f.pods.set('p', { accountId: 'a', baseUrl: 'https://external.test/alice/' });
    await expect(f.service.deleteOwned('a', 'p')).rejects.toThrow('UNSUPPORTED_PROVIDER');
    expect(f.deletePodData).not.toHaveBeenCalled();
    expect(f.metadataDeletes).toEqual([]);
  });
  it('persists the full plan before deletion and only removes owner/pod metadata after success', async () => {
    const f = fixture();
    f.deletePodData.mockImplementation(async () => {
      expect((await f.service.operations.find('a', 'p'))?.plan?.resources).toEqual([`${f.storageUrl}nested/data`, f.storageUrl]);
      expect(f.metadataDeletes).toEqual([]);
    });
    await f.service.deleteOwned('a', 'p');
    expect(f.metadataDeletes).toEqual(['owner:o', 'pod:p']);
    expect((await f.service.operations.find('a', 'p'))?.state).toBe('completed');
  });
  it('retries with persisted original plan after recreation of lifecycle, retaining binding on failure', async () => {
    const f = fixture();
    f.deletePodData.mockRejectedValueOnce(new Error('offline'));
    await expect(f.service.deleteOwned('a', 'p')).rejects.toThrow('offline');
    expect(f.pods.has('p')).toBe(true);
    const resumed = new PodDeletionLifecycleService(f.options);
    await resumed.deleteOwned('a', 'p');
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.deletePodData).toHaveBeenCalledTimes(2);
  });
  it('does not delete a new Pod at the same URL when an old completed command is replayed', async () => {
    const f = fixture();
    await f.service.deleteLocal(f.storageUrl, 'remote-operation');
    f.pods.set('new-pod', { accountId: 'a', baseUrl: f.storageUrl });
    const resumed = new PodDeletionLifecycleService(f.options);
    await resumed.deleteLocal(f.storageUrl, 'remote-operation');
    expect(f.pods.has('new-pod')).toBe(true);
    expect(f.deletePodData).toHaveBeenCalledTimes(1);
  });
  it('retains a managed remote binding when its registered SP is offline or returns an unrelated 404', async () => {
    const f = fixture();
    const remoteUrl = 'https://registered-node.test/alice/';
    f.pods.set('p', { accountId: 'a', baseUrl: remoteUrl });
    const service = new PodDeletionLifecycleService({ ...f.options, edition: 'server' });
    const nodes = new EdgeNodeRepository(getIdentityDatabase(f.options.identityDbUrl));
    await nodes.registerSpNode({ nodeId: 'node', publicUrl: 'https://registered-node.test/' });
    await service.operations.bindRemoteGeneration('p', 'node', remoteUrl, 'local-generation');
    expect(await service.canDelete(remoteUrl, 'p')).toBe(true);
    expect(await service.canDelete('https://unknown-node.test/alice/')).toBe(false);
    const originalFetch = globalThis.fetch;
    const remoteFetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response('missing', { status: 404 }));
    globalThis.fetch = remoteFetch;
    try {
      await expect(service.deleteOwned('a', 'p')).rejects.toThrow('NODE_UNAVAILABLE');
      await expect(service.deleteOwned('a', 'p')).rejects.toThrow('NODE_FAILED');
      expect(f.metadataDeletes).toEqual([]);
      expect(f.pods.has('p')).toBe(true);
      expect(f.deletePodData).not.toHaveBeenCalled();
    } finally { globalThis.fetch = originalFetch; }
  });

  it('rechecks the authorized Pod incarnation inside the execution lock', async () => {
    const f = fixture();
    f.options.resourceLocker.withWriteLock = async (_id, run) => {
      f.pods.delete('p');
      f.pods.set('replacement', { accountId: 'bob', baseUrl: f.storageUrl });
      return run(() => undefined);
    };
    await expect(f.service.deleteOwned('a', 'p')).rejects.toThrow('incarnation changed');
    expect(f.pods.has('replacement')).toBe(true);
    expect(f.deletePodData).not.toHaveBeenCalled();
  });

  it('rejects a delayed first remote command when the received generation predates the current Pod', async () => {
    const f = fixture();
    await expect(f.service.deleteLocal(f.storageUrl, 'delayed-cloud-operation', { podId: 'old-generation', ownerWebIds: ['https://id.test/alice/profile/card#me'] }))
      .rejects.toThrow('incarnation changed');
    expect(f.pods.has('p')).toBe(true);
    expect(f.deletePodData).not.toHaveBeenCalled();
  });

  it('releases the durable reservation when completion persisted but the first release failed', async () => {
    const f = fixture();
    const release = vi.spyOn(f.service.operations, 'releaseStorage').mockRejectedValueOnce(new Error('release unavailable'));
    await expect(f.service.deleteOwned('a', 'p')).rejects.toThrow('release unavailable');
    expect(f.pods.has('p')).toBe(false);
    expect((await f.service.operations.find('a', 'p'))?.state).toBe('completed');
    await f.service.deleteOwned('a', 'p');
    expect(release).toHaveBeenCalledTimes(2);
    await f.service.operations.reserveStorage(f.storageUrl, 'recreation', 'create');
    expect(f.deletePodData).toHaveBeenCalledTimes(1);
  });

});
