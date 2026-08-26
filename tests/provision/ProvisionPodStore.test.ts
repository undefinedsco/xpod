import { describe, expect, it, vi } from 'vitest';
import { OWNER_STORAGE_TYPE, POD_STORAGE_TYPE } from '@solid/community-server';
import { ProvisionPodStore, XPOD_REMOTE_PROVISIONED } from '../../src/provision/ProvisionPodStore';

describe('ProvisionPodStore', () => {
  it('records remote provisioned Pods by canonical storage URL without creating a Cloud Pod', async () => {
    const storage = {
      create: vi.fn()
        .mockResolvedValueOnce({ id: 'pod-id-1' })
        .mockResolvedValueOnce({ id: 'owner-id-1' }),
    };
    const manager = { createPod: vi.fn() };
    const store = new ProvisionPodStore(storage as any, manager as any, true);

    const result = await store.create(
      'account-1',
      {
        base: { path: 'https://id.example/alice/' },
        webId: 'https://id.example/alice/profile/card#me',
        storage: 'https://node.example/alice/',
        [XPOD_REMOTE_PROVISIONED]: true,
      } as any,
      false,
    );

    expect(result).toBe('pod-id-1');
    expect(storage.create).toHaveBeenNthCalledWith(1, POD_STORAGE_TYPE, {
      baseUrl: 'https://node.example/alice/',
      accountId: 'account-1',
    });
    expect(storage.create).toHaveBeenNthCalledWith(2, OWNER_STORAGE_TYPE, {
      podId: 'pod-id-1',
      webId: 'https://id.example/alice/profile/card#me',
      visible: true,
    });
    expect(manager.createPod).not.toHaveBeenCalled();
  });

  it('keeps standard Pod creation delegated to CSS', async () => {
    const storage = {
      create: vi.fn()
        .mockResolvedValueOnce({ id: 'pod-id-1' })
        .mockResolvedValueOnce({ id: 'owner-id-1' }),
      delete: vi.fn(),
    };
    const manager = { createPod: vi.fn().mockResolvedValue(undefined) };
    const store = new ProvisionPodStore(storage as any, manager as any, false);

    const result = await store.create(
      'account-1',
      {
        name: 'alice',
        base: { path: 'https://id.example/alice/' },
        webId: 'https://id.example/alice/profile/card#me',
        storage: 'https://id.example/alice/',
      } as any,
      false,
    );

    expect(result).toBe('pod-id-1');
    expect(storage.create).toHaveBeenNthCalledWith(1, POD_STORAGE_TYPE, {
      baseUrl: 'https://id.example/alice/',
      accountId: 'account-1',
    });
    expect(manager.createPod).toHaveBeenCalledTimes(1);
    expect(manager.createPod).toHaveBeenCalledWith(
      expect.objectContaining({
        base: { path: 'https://id.example/alice/' },
        storage: 'https://id.example/alice/',
      }),
      false,
    );
  });
});
