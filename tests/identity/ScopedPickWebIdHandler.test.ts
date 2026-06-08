import { describe, expect, it, vi } from 'vitest';
import { BadRequestHttpError, FoundHttpError } from '@solid/community-server';
import { ScopedPickWebIdHandler } from '../../src/identity/oidc/ScopedPickWebIdHandler';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import type { PodLookupResult } from '../../src/identity/drizzle/PodLookupRepository';

describe('ScopedPickWebIdHandler', () => {
  const cloudIssuer = 'https://id.example/';
  const aliceWebId = `${cloudIssuer}alice/profile/card#me`;
  const bobWebId = `${cloudIssuer}bob/profile/card#me`;
  const provisionCode = new ProvisionCodeCodec(cloudIssuer).encode({
    spUrl: 'https://node-0000.undefineds.co',
    serviceToken: 'service-token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  function createHandler() {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { webIds?: string[] } : {};
      const webIds = body.webIds ?? [];
      const entries = webIds.includes(aliceWebId)
        ? [
          {
            webId: aliceWebId,
            podUrl: 'https://node-0000.undefineds.co/alice/',
            storageUrl: 'https://node-0000.undefineds.co/alice/',
          },
        ]
        : [];

      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const webIdStore = {
      findLinks: vi.fn().mockResolvedValue([
        { id: 'link-alice', webId: aliceWebId },
        { id: 'link-bob', webId: bobWebId },
      ]),
      isLinked: vi.fn(async (webId: string, accountId: string) => accountId === 'account-1' && [aliceWebId, bobWebId].includes(webId)),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const findByWebId = vi.fn(async (webId: string): Promise<PodLookupResult | undefined> => {
      if (webId === aliceWebId) {
        return {
          podId: 'pod-1',
          accountId: 'account-1',
          baseUrl: 'https://node-0000.undefineds.co/alice/',
          storageUrl: 'https://node-0000.undefineds.co/alice/',
          webId,
        };
      }

      if (webId === bobWebId) {
        return {
          podId: 'pod-2',
          accountId: 'account-1',
          baseUrl: `${cloudIssuer}bob/`,
          storageUrl: `${cloudIssuer}bob/`,
          webId,
        };
      }

      return undefined;
    });
    const findByWebIds = vi.fn(async (webIds: string[]): Promise<PodLookupResult[]> => {
      const pods = await Promise.all(webIds.map(async (webId) => findByWebId(webId)));
      return pods.filter((pod): pod is PodLookupResult => Boolean(pod));
    });
    const listByAccountId = vi.fn(async (accountId: string): Promise<PodLookupResult[]> => {
      if (accountId !== 'account-1') {
        return [];
      }
      const pods = await Promise.all([aliceWebId, bobWebId].map(async (webId) => findByWebId(webId)));
      return pods.filter((pod): pod is PodLookupResult => Boolean(pod));
    });
    const podLookupRepository = {
      findByWebId,
      findByWebIds,
      listByAccountId,
    };
    const providerFactory = {
      getProvider: vi.fn(async () => ({ issuer: cloudIssuer }) as any),
    };

    return {
      handler: new ScopedPickWebIdHandler({
        webIdStore,
        providerFactory,
        podLookupRepository,
        fetch: fetchMock as unknown as typeof fetch,
      }),
      webIdStore,
      podLookupRepository,
      providerFactory,
      fetchMock,
    };
  }

  it('returns only WebIDs backed by Pods in the current storage provider', async () => {
    const { handler, podLookupRepository, fetchMock } = createHandler();

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: {
        params: { provisionCode },
      } as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([aliceWebId]);
    expect(view.json.entries).toEqual([
      {
        webId: aliceWebId,
        storageUrl: 'https://node-0000.undefineds.co/alice/',
        storageMode: 'local',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://node-0000.undefineds.co/provision/webids',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer service-token',
        }),
      }),
    );
    expect(podLookupRepository.findByWebId).not.toHaveBeenCalled();
  });

  it('does not fall back to Cloud-local Pod facts when remote SP lookup fails', async () => {
    const { handler, fetchMock, podLookupRepository } = createHandler();
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 502 }));

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: {
        params: { provisionCode },
      } as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([]);
    expect(podLookupRepository.findByWebId).not.toHaveBeenCalled();
  });

  it('recovers candidate WebIDs from account-scoped Pod facts when WebIdStore links are empty', async () => {
    const { handler, webIdStore, podLookupRepository, fetchMock } = createHandler();
    webIdStore.findLinks.mockResolvedValueOnce([]);

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: {
        params: { provisionCode },
      } as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([aliceWebId]);
    expect(view.json.entries).toEqual([
      {
        webId: aliceWebId,
        storageUrl: 'https://node-0000.undefineds.co/alice/',
        storageMode: 'local',
      },
    ]);
    expect(podLookupRepository.listByAccountId).toHaveBeenCalledWith('account-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://node-0000.undefineds.co/provision/webids',
      expect.objectContaining({
        body: JSON.stringify({ webIds: [aliceWebId, bobWebId] }),
      }),
    );
  });

  it('rejects an account-linked WebID that the current storage provider cannot resolve', async () => {
    const { handler } = createHandler();

    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: {
        params: { provisionCode },
        persist: vi.fn(),
        returnTo: 'https://client.example/callback',
      } as any,
      json: { webId: bobWebId, remember: false },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toBeInstanceOf(BadRequestHttpError);
  });

  it('persists the scoped WebID into the OIDC interaction', async () => {
    const { handler } = createHandler();
    const interaction = {
      params: { provisionCode },
      lastSubmission: { account: 'account-1' },
      persist: vi.fn(),
      returnTo: 'https://client.example/callback',
    };

    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: interaction as any,
      json: { webId: aliceWebId, remember: true },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toBeInstanceOf(FoundHttpError);

    expect((interaction as any).result).toEqual({
      account: 'account-1',
      login: {
        accountId: aliceWebId,
        remember: true,
      },
    });
    expect(interaction.persist).toHaveBeenCalledTimes(1);
  });

  it('accepts a scoped WebID backed by account Pod facts when WebIdStore link lookup is stale', async () => {
    const { handler, webIdStore, podLookupRepository } = createHandler();
    webIdStore.isLinked.mockResolvedValueOnce(false);

    const interaction = {
      params: { provisionCode },
      lastSubmission: { account: 'account-1' },
      persist: vi.fn(),
      returnTo: 'https://client.example/callback',
    };

    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: interaction as any,
      json: { webId: aliceWebId, remember: true },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toBeInstanceOf(FoundHttpError);

    expect(podLookupRepository.listByAccountId).toHaveBeenCalledWith('account-1');
    expect((interaction as any).result.login).toEqual({
      accountId: aliceWebId,
      remember: true,
    });
  });

  it('falls back to the issuer storage when no provisionCode is present', async () => {
    const { handler } = createHandler();

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: {
        params: {},
      } as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([bobWebId]);
    expect(view.json.entries).toEqual([
      {
        webId: bobWebId,
        storageUrl: `${cloudIssuer}bob/`,
        storageMode: 'cloud',
      },
    ]);
  });

  it('does not expose split Local Pods on the Cloud route when canonical storage differs from Cloud', async () => {
    const { handler, podLookupRepository } = createHandler();
    podLookupRepository.findByWebId.mockImplementation(async (webId: string) => {
      if (webId === aliceWebId) {
        return {
          podId: 'pod-local',
          accountId: 'account-1',
          baseUrl: `${cloudIssuer}alice/`,
          storageUrl: 'https://node-0000.undefineds.co/alice/',
          webId,
        };
      }

      if (webId === bobWebId) {
        return {
          podId: 'pod-cloud',
          accountId: 'account-1',
          baseUrl: `${cloudIssuer}bob/`,
          storageUrl: `${cloudIssuer}bob/`,
          webId,
        };
      }

      return undefined;
    });

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: {
        params: {},
      } as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([bobWebId]);
    expect(view.json.entries).toEqual([
      {
        webId: bobWebId,
        storageUrl: `${cloudIssuer}bob/`,
        storageMode: 'cloud',
      },
    ]);
  });

  it('accepts Standalone loopback WebIDs when issuer and Pod use localhost aliases', async () => {
    const issuer = 'http://127.0.0.1:55303/';
    const webId = 'http://localhost:55303/alice/profile/card#me';
    const webIdStore = {
      findLinks: vi.fn().mockResolvedValue([{ id: 'link-local', webId }]),
      isLinked: vi.fn(async (candidate: string, accountId: string) => accountId === 'account-1' && candidate === webId),
      get: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    };
    const podLookupRepository = {
      findByWebId: vi.fn(),
      findAllByWebId: vi.fn(async (candidate: string) => candidate === webId
        ? [{
          podId: 'pod-local',
          accountId: 'account-1',
          baseUrl: 'http://localhost:55303/alice/',
          storageUrl: 'http://localhost:55303/alice/',
          webId,
        }]
        : []),
      listByAccountId: vi.fn(async () => [{
        podId: 'pod-local',
        accountId: 'account-1',
        baseUrl: 'http://localhost:55303/alice/',
        storageUrl: 'http://localhost:55303/alice/',
        webId,
      }]),
    };
    const interaction = {
      params: {},
      lastSubmission: { account: 'account-1' },
      persist: vi.fn(),
      returnTo: 'http://localhost:5173/auth/callback',
    };
    const handler = new ScopedPickWebIdHandler({
      webIdStore,
      providerFactory: {
        getProvider: vi.fn(async () => ({ issuer }) as any),
      },
      podLookupRepository,
    });

    const view = await handler.getView({
      method: 'GET',
      accountId: 'account-1',
      oidcInteraction: interaction as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    });

    expect(view.json.webIds).toEqual([webId]);
    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: interaction as any,
      json: { webId, remember: true },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toBeInstanceOf(FoundHttpError);
    expect((interaction as any).result.login).toEqual({
      accountId: webId,
      remember: true,
    });
  });
});
