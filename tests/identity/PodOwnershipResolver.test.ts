import { describe, expect, it, vi } from 'vitest';
import type { PodStore, WebIdStore } from '@solid/community-server';
import { CssPodOwnershipResolver } from '../../src/identity/oidc/PodOwnershipResolver';

describe('CssPodOwnershipResolver', () => {
  const aliceWebId = 'http://localhost:3000/alice/profile/card#me';
  const bobWebId = 'http://localhost:3000/bob/profile/card#me';
  const externalWebId = 'https://external.example/profile#me';

  function createResolver(options: {
    fetch?: typeof fetch;
    logger?: { warn: (message: string) => void };
    remoteTimeoutMs?: number;
  } = {}) {
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
      resolver: new CssPodOwnershipResolver({ webIdStore, podStore, ...options }),
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

  it('resolves ownership through the remote SP when both credentials are present', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      entries: [{
        webId: aliceWebId,
        podUrl: 'https://node.example/alice/',
        storageUrl: 'https://node.example/alice/',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { resolver, webIdStore, podStore } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/base/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([{
      webId: aliceWebId,
      storageUrl: 'https://node.example/alice/',
      storageMode: 'local',
    }]);
    expect(fetchMock).toHaveBeenCalledWith('https://lookup.example/provision/webids', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer short-lived-token',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ webIds: [aliceWebId] }),
      signal: expect.any(AbortSignal),
    }));
    expect(webIdStore.findLinks).not.toHaveBeenCalled();
    expect(podStore.findPods).not.toHaveBeenCalled();
  });

  it('filters remote entries to the requested candidate WebIDs', async () => {
    const unknownWebId = 'https://id.example/unknown/profile#me';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        {
          webId: unknownWebId,
          storageUrl: 'https://node.example/unknown/',
        },
        {
          webId: aliceWebId,
          storageUrl: 'https://node.example/alice/',
        },
      ],
    }), { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([expect.objectContaining({ webId: aliceWebId })]);
  });

  it('deduplicates repeated remote ownership entries', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        {
          webId: aliceWebId,
          storageUrl: 'https://node.example/alice/',
        },
        {
          webId: aliceWebId,
          storageUrl: 'https://node.example/alice/',
        },
      ],
    }), { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId, aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([{
      webId: aliceWebId,
      storageUrl: 'https://node.example/alice/',
      storageMode: 'local',
    }]);
  });

  it('rejects remote entries whose storage root does not match the target', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [{
        webId: aliceWebId,
        podUrl: 'https://other.example/alice/',
        storageUrl: 'https://other.example/alice/',
      }],
    }), { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
  });

  it('rejects remote entries when podUrl disagrees with storageUrl target ownership', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [{
        webId: aliceWebId,
        podUrl: 'https://other.example/alice/',
        storageUrl: 'https://node.example/alice/',
      }],
    }), { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
  });

  it('fails closed on a non-ok remote response', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream-body-secret', { status: 500 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
  });

  it('fails closed when the remote request throws', async () => {
    const upstreamError = 'upstream-error-secret';
    const fetchMock = vi.fn().mockRejectedValue(new Error(upstreamError));
    const logger = { warn: vi.fn() };
    const { resolver } = createResolver({ fetch: fetchMock, logger });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain(upstreamError);
  });

  it('fails closed when the remote body is malformed JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('{malformed', { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
  });

  it('fails closed when the remote body has an invalid schema', async () => {
    const malformedBodies: unknown[] = [null, [], {}, { entries: {} }, { entries: [null, { webId: aliceWebId }] }];
    for (const malformedBody of malformedBodies) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(malformedBody), { status: 200 }));
      const { resolver } = createResolver({ fetch: fetchMock });

      await expect(resolver.resolveOwnedWebIds({
        accountId: 'alice-account',
        candidateWebIds: [aliceWebId],
        target: {
          storageUrl: 'https://node.example/',
          lookupUrl: 'https://lookup.example/',
          serviceAccessToken: 'short-lived-token',
        },
      })).resolves.toEqual([]);
    }
  });

  it('fails closed when valid and schema-invalid remote entries are mixed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [
        null,
        {
          webId: aliceWebId,
          storageUrl: 'https://node.example/alice/',
        },
      ],
    }), { status: 200 }));
    const logger = { warn: vi.fn() };
    const { resolver } = createResolver({ fetch: fetchMock, logger });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('normalizes candidate WebIDs before the remote request', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ webIds: [aliceWebId] });
      return new Response(JSON.stringify({
        entries: [{
          webId: aliceWebId,
          storageUrl: 'https://node.example/alice/',
        }],
      }), { status: 200 });
    });
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [` ${aliceWebId} `, '', '  ', aliceWebId, `\t${aliceWebId}\n`],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([expect.objectContaining({ webId: aliceWebId })]);
  });

  it('aborts a never-resolving remote request at the configured timeout', async () => {
    let abortObserved = false;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('test guard timeout')), 100);
      init?.signal?.addEventListener('abort', () => {
        abortObserved = true;
        clearTimeout(guard);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }));
    const { resolver } = createResolver({ fetch: fetchMock, remoteTimeoutMs: 10 });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([]);
    expect(abortObserved).toBe(true);
  });

  it('fails closed when the remote response body never resolves', async () => {
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return {
        ok: true,
        json: () => new Promise<never>(() => undefined),
      } as unknown as Response;
    });
    const { resolver } = createResolver({ fetch: fetchMock, remoteTimeoutMs: 10 });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const guardPromise = new Promise<symbol>((resolve) => {
      guard = setTimeout(() => resolve(Symbol('guard-timeout')), 100);
    });

    try {
      const result = await Promise.race([
        resolver.resolveOwnedWebIds({
          accountId: 'alice-account',
          candidateWebIds: [aliceWebId],
          target: {
            storageUrl: 'https://node.example/',
            lookupUrl: 'https://lookup.example/',
            serviceAccessToken: 'short-lived-token',
          },
        }),
        guardPromise,
      ]);
      expect(result).toEqual([]);
      expect(signal?.aborted).toBe(true);
    } finally {
      if (guard !== undefined) {
        clearTimeout(guard);
      }
    }
  });

  it('clears the remote timeout after a response completes', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 }));
      const { resolver } = createResolver({ fetch: fetchMock, remoteTimeoutMs: 25 });
      const timersBefore = vi.getTimerCount();

      await expect(resolver.resolveOwnedWebIds({
        accountId: 'alice-account',
        candidateWebIds: [aliceWebId],
        target: {
          storageUrl: 'https://node.example/',
          lookupUrl: 'https://lookup.example/',
          serviceAccessToken: 'short-lived-token',
        },
      })).resolves.toEqual([]);
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed without requesting when either remote credential is missing', async () => {
    for (const target of [
      {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
      },
      {
        storageUrl: 'https://node.example/',
        serviceAccessToken: 'short-lived-token',
      },
    ]) {
      const fetchMock = vi.fn();
      const { resolver } = createResolver({ fetch: fetchMock });

      await expect(resolver.resolveOwnedWebIds({
        accountId: 'alice-account',
        candidateWebIds: [aliceWebId],
        target,
      })).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('does not leak remote credentials or response data in warnings', async () => {
    const token = 'remote-token-secret';
    const responseSecret = 'response-body-secret';
    const fetchMock = vi.fn(async () => new Response(responseSecret, { status: 502 }));
    const logger = { warn: vi.fn() };
    const { resolver } = createResolver({ fetch: fetchMock, logger });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [aliceWebId],
      target: {
        storageUrl: 'https://node.example/',
        lookupUrl: 'https://lookup.example/',
        serviceAccessToken: token,
      },
    })).resolves.toEqual([]);
    const messages = logger.warn.mock.calls.flat().join(' ');
    expect(messages).not.toContain(token);
    expect(messages).not.toContain(responseSecret);
  });

  it('matches loopback aliases for remote storage targets', async () => {
    const loopbackWebId = 'http://localhost:5737/alice/profile/card#me';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      entries: [{
        webId: loopbackWebId,
        podUrl: 'http://localhost:5737/alice/',
        storageUrl: 'http://localhost:5737/alice/',
      }],
    }), { status: 200 }));
    const { resolver } = createResolver({ fetch: fetchMock });

    await expect(resolver.resolveOwnedWebIds({
      accountId: 'alice-account',
      candidateWebIds: [loopbackWebId],
      target: {
        storageUrl: 'http://[::1]:5737/',
        lookupUrl: 'http://127.0.0.1:5737/',
        serviceAccessToken: 'short-lived-token',
      },
    })).resolves.toEqual([{
      webId: loopbackWebId,
      storageUrl: 'http://localhost:5737/alice/',
      storageMode: 'cloud',
    }]);
  });
});
