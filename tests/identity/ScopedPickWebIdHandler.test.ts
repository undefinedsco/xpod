import { describe, expect, it, vi } from 'vitest';
import { BadRequestHttpError, FoundHttpError } from '@solid/community-server';
import { ScopedPickWebIdHandler } from '../../src/identity/oidc/ScopedPickWebIdHandler';
import type { OwnedWebIdEntry, PodOwnershipTarget } from '../../src/identity/oidc/PodOwnershipResolver';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';

describe('ScopedPickWebIdHandler', () => {
  const cloudIssuer = 'https://id.example/';
  const aliceWebId = `${cloudIssuer}alice/profile/card#me`;
  const bobWebId = `${cloudIssuer}bob/profile/card#me`;
  const remoteStorageUrl = 'https://node-0000.undefineds.co/';
  const provisionCode = new ProvisionCodeCodec(cloudIssuer).encode({
    spUrl: remoteStorageUrl,
    serviceToken: 'service-token',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const routeAccessTokenExp = Math.floor(Date.now() / 1000) + 3600;
  const managedProvisionCode = new ProvisionCodeCodec(cloudIssuer).encode({
    spUrl: remoteStorageUrl,
    serviceAccessToken: 'local-callback-token',
    serviceAccessTokenExp: routeAccessTokenExp,
    signalApiUrl: 'https://api.example/',
    routeAccessToken: 'cloud-route-token',
    routeAccessTokenExp,
    nodeId: 'node-1',
    exp: routeAccessTokenExp,
  });

  function createHandler(options: {
    entries?: OwnedWebIdEntry[];
    candidateWebIds?: string[];
    resolverError?: Error;
  } = {}) {
    const entries = options.entries ?? [{
      webId: aliceWebId,
      storageUrl: `${remoteStorageUrl}alice/`,
      storageMode: 'local' as const,
    }];
    const ownershipResolver = {
      listAccountWebIds: vi.fn(async () => {
        if (options.resolverError) {
          throw options.resolverError;
        }
        return options.candidateWebIds ?? [aliceWebId, bobWebId];
      }),
      resolveOwnedWebIds: vi.fn(async ({ candidateWebIds }: {
        accountId: string;
        candidateWebIds: string[];
        target: PodOwnershipTarget;
      }) => {
        if (options.resolverError) {
          throw options.resolverError;
        }
        const allowed = new Set(candidateWebIds);
        return entries.filter((entry) => allowed.has(entry.webId));
      }),
    };
    const providerFactory = {
      getProvider: vi.fn(async () => ({ issuer: cloudIssuer }) as any),
    };

    return {
      handler: new ScopedPickWebIdHandler({
        ownershipResolver,
        providerFactory,
      }),
      ownershipResolver,
      providerFactory,
    };
  }

  function getInput(oidcInteraction: unknown, accountId = 'account-1') {
    return {
      method: 'GET' as const,
      accountId,
      oidcInteraction: oidcInteraction as any,
      json: {},
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    };
  }

  it('returns resolver-owned WebIDs and entries for GET', async () => {
    const { handler, ownershipResolver } = createHandler();

    const view = await handler.getView(getInput({ params: {} }));

    expect(view.json.webIds).toEqual([aliceWebId]);
    expect(view.json.entries).toEqual([{
      webId: aliceWebId,
      storageUrl: `${remoteStorageUrl}alice/`,
      storageMode: 'local',
    }]);
    expect(ownershipResolver.listAccountWebIds).toHaveBeenCalledWith('account-1');
    expect(ownershipResolver.resolveOwnedWebIds).toHaveBeenCalledWith({
      accountId: 'account-1',
      candidateWebIds: [aliceWebId, bobWebId],
      target: { storageUrl: cloudIssuer },
    });
  });

  it('passes provision target storage and credentials to the resolver', async () => {
    const { handler, ownershipResolver } = createHandler();

    await handler.getView(getInput({ params: { provisionCode } }));

    expect(ownershipResolver.resolveOwnedWebIds).toHaveBeenCalledWith({
      accountId: 'account-1',
      candidateWebIds: [aliceWebId, bobWebId],
      target: {
        storageUrl: remoteStorageUrl,
        lookupUrl: remoteStorageUrl,
        serviceAccessToken: 'service-token',
      },
    });
  });

  it('reads the provision scope from the OIDC redirect URI used by Inrupt login', async () => {
    const { handler, ownershipResolver } = createHandler();
    const redirectUri = new URL('http://127.0.0.1:3000/auth/callback');
    redirectUri.searchParams.set('provisionCode', provisionCode);

    await handler.getView(getInput({ params: { redirect_uri: redirectUri.toString() } }));

    expect(ownershipResolver.resolveOwnedWebIds).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        storageUrl: remoteStorageUrl,
        lookupUrl: remoteStorageUrl,
        serviceAccessToken: 'service-token',
      },
    }));
  });

  it('passes managed route credentials to remote ownership resolution', async () => {
    const { handler, ownershipResolver } = createHandler();

    await handler.getView(getInput({ params: { provisionCode: managedProvisionCode } }));

    expect(ownershipResolver.resolveOwnedWebIds).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        storageUrl: remoteStorageUrl,
        lookupUrl: remoteStorageUrl,
        serviceAccessToken: 'local-callback-token',
        signalApiUrl: 'https://api.example/',
        routeAccessToken: 'cloud-route-token',
        routeAccessTokenExp,
        nodeId: 'node-1',
      },
    }));
  });

  it('re-resolves allowed entries on POST before finishing the interaction', async () => {
    const { handler, ownershipResolver } = createHandler();
    const interaction = {
      params: {},
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

    expect(ownershipResolver.listAccountWebIds).toHaveBeenCalledTimes(1);
    expect(ownershipResolver.resolveOwnedWebIds).toHaveBeenCalledTimes(1);
    expect((interaction as any).result.login).toEqual({
      accountId: aliceWebId,
      remember: true,
    });
    expect(interaction.persist).toHaveBeenCalledTimes(1);
  });

  it('rejects a submitted WebID absent from the resolver allowed set', async () => {
    const { handler } = createHandler({
      entries: [{
        webId: aliceWebId,
        storageUrl: `${remoteStorageUrl}alice/`,
        storageMode: 'local',
      }],
    });

    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: {
        params: {},
        persist: vi.fn(),
        returnTo: 'https://client.example/callback',
      } as any,
      json: { webId: bobWebId, remember: false },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toMatchObject({
      message: 'WebID does not belong to this storage provider.',
    });
  });

  it('fails closed with a stable BadRequest when resolver verification fails', async () => {
    const { handler } = createHandler({ resolverError: new Error('database token=secret') });

    const view = await handler.getView(getInput({ params: {} }));
    expect(view.json.webIds).toEqual([]);
    expect(view.json.entries).toEqual([]);

    await expect(handler.handle({
      method: 'POST',
      accountId: 'account-1',
      oidcInteraction: {
        params: {},
        persist: vi.fn(),
        returnTo: 'https://client.example/callback',
      } as any,
      json: { webId: aliceWebId, remember: false },
      metadata: {} as any,
      target: { path: '/.account/oidc/pick-webid/' },
    })).rejects.toMatchObject({
      message: 'WebID does not belong to this storage provider.',
    });
  });

  it('does not require an identity database URL', async () => {
    const { handler } = createHandler({
      entries: [{
        webId: bobWebId,
        storageUrl: `${cloudIssuer}bob/`,
        storageMode: 'cloud',
      }],
      candidateWebIds: [bobWebId],
    });

    const view = await handler.getView(getInput({ params: {} }));

    expect(view.json.webIds).toEqual([bobWebId]);
  });

  it('rejects an invalid provision code without invoking the resolver', async () => {
    const { handler, ownershipResolver } = createHandler();

    await expect(handler.getView(getInput({ params: { provisionCode: 'invalid' } })))
      .rejects.toMatchObject({ message: 'Invalid or expired provisionCode.' });
    expect(ownershipResolver.listAccountWebIds).not.toHaveBeenCalled();
  });
});
