import { describe, expect, it, vi } from 'vitest';
import type { PodStore, WebIdStore } from '@solid/community-server';
import { CssPodOwnershipResolver } from '../../src/identity/oidc/PodOwnershipResolver';

describe('CssPodOwnershipResolver', () => {
  const aliceWebId = 'http://localhost:3000/alice/profile/card#me';
  const bobWebId = 'http://localhost:3000/bob/profile/card#me';
  const externalWebId = 'https://external.example/profile#me';

  function createResolver() {
    const webIdStore: WebIdStore = {
      findLinks: vi.fn().mockResolvedValue([
        { id: 'link-alice', webId: aliceWebId },
        { id: 'duplicate-alice', webId: aliceWebId },
      ]),
      get: vi.fn(),
      isLinked: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const podStore: PodStore = {
      findPods: vi.fn().mockResolvedValue([
        { id: 'pod-alice', baseUrl: 'http://localhost:3000/alice/' },
        { id: 'pod-other-root', baseUrl: 'https://other.example/alice/' },
      ]),
      getOwners: vi.fn().mockImplementation(async (id: string) => id === 'pod-alice'
        ? [{ webId: aliceWebId, visible: false }]
        : [{ webId: externalWebId, visible: false }]),
      get: vi.fn(),
      findByBaseUrl: vi.fn(),
      create: vi.fn(),
      updateOwner: vi.fn(),
      removeOwner: vi.fn(),
    };

    return {
      resolver: new CssPodOwnershipResolver({ webIdStore, podStore }),
      webIdStore,
      podStore,
    };
  }

  it('lists account WebIDs from CSS links and removes duplicates', async () => {
    const { resolver, webIdStore } = createResolver();

    await expect(resolver.listAccountWebIds('alice-account')).resolves.toEqual([aliceWebId]);
    expect(webIdStore.findLinks).toHaveBeenCalledWith('alice-account');
  });

  it('returns only candidate owners on the account and target storage root', async () => {
    const { resolver, podStore } = createResolver();

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId, externalWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([{
      webId: aliceWebId,
      storageUrl: 'http://localhost:3000/alice/',
      storageMode: 'cloud',
    }]);
    expect(podStore.findPods).toHaveBeenCalledWith('alice-account');
    expect(podStore.getOwners).toHaveBeenCalledWith('pod-alice');
    expect(podStore.getOwners).not.toHaveBeenCalledWith('pod-other-root');
  });

  it('classifies an owner on the same storage root as cloud', async () => {
    const { resolver } = createResolver();

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([expect.objectContaining({ storageMode: 'cloud' })]);
  });

  it('classifies an owner on a different storage root as local', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    const localWebId = 'https://id.example/alice/profile/card#me';
    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-local', webId: localWebId }]);
    podStore.findPods = vi.fn().mockResolvedValue([
      { id: 'pod-local', baseUrl: 'https://node.example/alice/' },
    ]);
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: localWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [localWebId],
      target: { storageUrl: 'https://node.example/' },
    })).resolves.toEqual([{
      webId: localWebId,
      storageUrl: 'https://node.example/alice/',
      storageMode: 'local',
    }]);
  });

  it('classifies an owner with an invalid WebID root as custom', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    const customWebId = 'not-a-url';
    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-custom', webId: customWebId }]);
    podStore.findPods = vi.fn().mockResolvedValue([
      { id: 'pod-custom', baseUrl: 'https://node.example/alice/' },
    ]);
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: customWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [customWebId],
      target: { storageUrl: 'https://node.example/' },
    })).resolves.toEqual([{
      webId: customWebId,
      storageUrl: 'https://node.example/alice/',
      storageMode: 'custom',
    }]);
  });

  it('excludes candidates that are not linked to the requested account', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-alice', webId: aliceWebId }]);
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: bobWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId, bobWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);
  });

  it('excludes owners from a mismatched storage root', async () => {
    const { resolver } = createResolver();

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'https://different.example/' },
    })).resolves.toEqual([]);
  });

  it('excludes owners that are not listed by the PodStore', async () => {
    const { resolver, podStore } = createResolver();
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: externalWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);
  });

  it('deduplicates repeated candidate and owner entries', async () => {
    const { resolver, podStore } = createResolver();
    podStore.findPods = vi.fn().mockResolvedValue([
      { id: 'pod-a', baseUrl: 'http://localhost:3000/alice/' },
      { id: 'pod-b', baseUrl: 'http://localhost:3000/alice/' },
    ]);
    podStore.getOwners = vi.fn().mockResolvedValue([
      { webId: aliceWebId, visible: false },
      { webId: aliceWebId, visible: true },
    ]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId, aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([{
      webId: aliceWebId,
      storageUrl: 'http://localhost:3000/alice/',
      storageMode: 'cloud',
    }]);
  });

  it('fails closed when a CSS store throws', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    webIdStore.findLinks = vi.fn().mockRejectedValue(new Error('database token=secret'));

    await expect(resolver.listAccountWebIds('alice-account')).resolves.toEqual([]);
    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);

    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-alice', webId: aliceWebId }]);
    podStore.findPods = vi.fn().mockRejectedValue(new Error('database token=secret'));
    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);

    podStore.findPods = vi.fn().mockResolvedValue([{ id: 'pod-alice', baseUrl: 'http://localhost:3000/alice/' }]);
    podStore.getOwners = vi.fn().mockRejectedValue(new Error('database token=secret'));
    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);
  });

  it('logs store failures without leaking caught credentials', async () => {
    const { webIdStore, podStore } = createResolver();
    const logger = { warn: vi.fn() };
    const resolver = new CssPodOwnershipResolver({ webIdStore, podStore, logger });

    webIdStore.findLinks = vi.fn().mockRejectedValue(new Error('database token=secret'));
    await expect(resolver.listAccountWebIds('alice-account')).resolves.toEqual([]);

    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-alice', webId: aliceWebId }]);
    podStore.findPods = vi.fn().mockRejectedValue(new Error('database token=secret'));
    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);

    podStore.findPods = vi.fn().mockResolvedValue([{ id: 'pod-alice', baseUrl: 'http://localhost:3000/alice/' }]);
    podStore.getOwners = vi.fn().mockRejectedValue(new Error('database token=secret'));
    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: { storageUrl: 'http://localhost:3000/' },
    })).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalled();
    for (const [message] of logger.warn.mock.calls) {
      expect(message).not.toContain('secret');
    }
  });

  it('matches localhost and 127.0.0.1 loopback aliases', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    const loopbackWebId = 'http://localhost:55303/alice/profile/card#me';
    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-alice', webId: loopbackWebId }]);
    podStore.findPods = vi.fn().mockResolvedValue([
      { id: 'pod-alice', baseUrl: 'http://localhost:55303/alice/' },
    ]);
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: loopbackWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [loopbackWebId],
      target: { storageUrl: 'http://127.0.0.1:55303/' },
    })).resolves.toEqual([{
      webId: loopbackWebId,
      storageUrl: 'http://localhost:55303/alice/',
      storageMode: 'cloud',
    }]);
  });

  it('matches the IPv6 loopback alias ::1 with localhost', async () => {
    const { resolver, webIdStore, podStore } = createResolver();
    const loopbackWebId = 'http://localhost:55303/alice/profile/card#me';
    webIdStore.findLinks = vi.fn().mockResolvedValue([{ id: 'link-alice', webId: loopbackWebId }]);
    podStore.findPods = vi.fn().mockResolvedValue([
      { id: 'pod-alice', baseUrl: 'http://localhost:55303/alice/' },
    ]);
    podStore.getOwners = vi.fn().mockResolvedValue([{ webId: loopbackWebId, visible: false }]);

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [loopbackWebId],
      target: { storageUrl: 'http://[::1]:55303/' },
    })).resolves.toEqual([{
      webId: loopbackWebId,
      storageUrl: 'http://localhost:55303/alice/',
      storageMode: 'cloud',
    }]);
  });

  it('fails closed for remote targets until remote resolution is enabled', async () => {
    const { resolver, webIdStore, podStore } = createResolver();

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://node.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
    expect(webIdStore.findLinks).not.toHaveBeenCalled();
    expect(podStore.findPods).not.toHaveBeenCalled();
  });
});
