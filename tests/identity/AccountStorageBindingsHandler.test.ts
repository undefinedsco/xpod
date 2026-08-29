import { describe, expect, it, vi } from 'vitest';
import { NotFoundHttpError, type PodStore } from '@solid/community-server';
import { AccountStorageBindingsHandler } from '../../src/identity/AccountStorageBindingsHandler';

describe('AccountStorageBindingsHandler', () => {
  const storageRoot = 'https://app.example/';
  const aliceStorage = 'https://app.example/alice/';
  const bobStorage = 'https://app.example/bob/';
  const remoteStorage = 'https://node.example/carol/';
  const alice = 'https://id.example/alice/profile/card#me';
  const bob = 'https://id.example/bob/profile/card#me';
  const carol = 'https://id.example/carol/profile/card#me';

  function createHandler() {
    const podStore = {
      findPods: vi.fn(async (accountId: string) => accountId === 'account-1'
        ? [
          { id: 'pod-alice', baseUrl: aliceStorage },
          { id: 'pod-bob', baseUrl: bobStorage },
          { id: 'pod-remote', baseUrl: remoteStorage },
        ]
        : []),
      getOwners: vi.fn(async (podId: string) => {
        if (podId === 'pod-alice') return [
          { webId: alice, visible: true },
          { webId: alice, visible: false },
          { webId: bob, visible: true },
        ];
        if (podId === 'pod-bob') return [
          { webId: bob, visible: true },
          { webId: carol, visible: true },
        ];
        return [{ webId: carol, visible: true }];
      }),
    };

    return {
      handler: new AccountStorageBindingsHandler({ podStore: podStore as unknown as PodStore, storageBaseUrl: storageRoot }),
      podStore,
    };
  }

  it('returns exact WebID/storage pairs from every account Pod and filters the current storage root', async () => {
    const { handler, podStore } = createHandler();

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      json: {},
      metadata: {} as any,
      target: { path: '/.account/account/account-1/bindings/' },
    });

    expect(podStore.findPods).toHaveBeenCalledWith('account-1');
    expect(podStore.getOwners).toHaveBeenCalledWith('pod-alice');
    expect(view.json).toEqual({
      bindings: [
        { webId: alice, storageUrl: aliceStorage },
        { webId: bob, storageUrl: aliceStorage },
        { webId: bob, storageUrl: bobStorage },
        { webId: carol, storageUrl: bobStorage },
      ],
    });
  });

  it('rejects requests without an account id and does not read request JSON for identity', async () => {
    const { handler, podStore } = createHandler();

    await expect(handler.getView({
      method: 'GET',
      json: { accountId: 'account-1' },
      metadata: {} as any,
      target: { path: '/.account/account/account-1/bindings/' },
    })).rejects.toBeInstanceOf(NotFoundHttpError);
    expect(podStore.findPods).not.toHaveBeenCalled();
  });

  it('deduplicates rows by the exact pair while retaining distinct WebIDs on one Pod', async () => {
    const { handler, podStore } = createHandler();
    podStore.findPods.mockResolvedValueOnce([
      { id: 'pod-a', baseUrl: 'https://app.example/alice' },
      { id: 'pod-b', baseUrl: 'https://app.example/alice/' },
    ]);
    podStore.getOwners.mockResolvedValue([{ webId: alice, visible: true }]);

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      json: {},
      metadata: {} as any,
      target: { path: '/.account/account/account-1/bindings/' },
    });

    expect(view.json).toEqual({
      bindings: [{ webId: alice, storageUrl: aliceStorage }],
    });
  });

  it('canonicalizes legacy loopback Pod URLs to the current public storage root', async () => {
    const podStore = {
      findPods: vi.fn(async () => [
        { id: 'pod-alice', baseUrl: 'http://localhost:3000/alice/' },
      ]),
      getOwners: vi.fn(async () => [
        { webId: alice, visible: true },
      ]),
    };
    const handler = new AccountStorageBindingsHandler({
      podStore: podStore as unknown as PodStore,
      storageBaseUrl: storageRoot,
    });

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      json: {},
      metadata: {} as any,
      target: { path: '/.account/account/account-1/bindings/' },
    });

    expect(view.json).toEqual({
      bindings: [{ webId: alice, storageUrl: aliceStorage }],
    });
  });
});
