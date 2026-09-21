import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createSolidSessionRuntime, createPodRuntime, type WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  createXpodLoginTransactionStore,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import {
  XpodOidcCallbackApp,
  completeXpodOidcCallback,
  resetXpodOidcCallback,
  type XpodOidcCallbackRuntime,
} from './XpodOidcCallbackApp';

afterEach(() => {
  vi.restoreAllMocks();
});

function installDom(url: string): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
}

function transaction(id: string, selectedStorage?: { webId: string; storageUrl: string }): WebIdLoginTransaction {
  return {
    id,
    route: {
      id: 'xpod-current-origin',
      label: window.location.host,
      identityProvider: { url: window.location.origin, label: window.location.host },
      storageProvider: { url: window.location.origin, label: window.location.host },
      availability: 'ready',
    },
    authorizationSurface: 'redirect',
    discovery: 'strict',
    returnTo: '/settings/models',
    ...(selectedStorage ? { selectedStorage } : {}),
  };
}

function runtime(
  webId: string,
  open: XpodOidcCallbackRuntime['pod']['open'],
): XpodOidcCallbackRuntime {
  return {
    session: {
      fetch: vi.fn(async () => new Response('ok')),
      createAuthenticatedFetch() { return (input: RequestInfo | URL, init?: RequestInit) => this.fetch(input, init); },
      subscribe: () => () => undefined,
      getSnapshot: () => ({ status: 'authenticated' as const, webId }),
      handleIncomingRedirect: vi.fn(async () => ({ status: 'authenticated' as const, webId })),
    },
    pod: { open, clear: vi.fn() },
    getIssuer: () => window.location.origin,
    setIssuer: () => undefined,
    setLocalPodRoutes: vi.fn(),
  } as unknown as XpodOidcCallbackRuntime;
}

function mutableStore(initial: WebIdLoginTransaction): {
  store: XpodLoginTransactionStore;
  getPending: () => WebIdLoginTransaction | undefined;
} {
  let pending: WebIdLoginTransaction | undefined = initial;
  const store: XpodLoginTransactionStore = {
    begin: (next) => {
      pending = next;
      return next;
    },
    readSinglePending: () => pending,
    updateSelectedStorage: (_id, binding) => {
      if (!pending) throw new Error('missing transaction');
      pending = { ...pending, selectedStorage: binding };
    },
    consume: (id) => {
      if (!pending || pending.id !== id) throw new Error('missing transaction');
      const consumed = pending;
      pending = undefined;
      return consumed;
    },
    cancel: (id) => {
      if (pending?.id === id) pending = undefined;
    },
  };
  return { store, getPending: () => pending };
}

describe('Xpod OIDC callback transaction ordering', () => {
  test.each([
    ['invalid_request', false], ['access_denied', false], ['<script>untrusted</script>', false],
    ['invalid_request', true],
  ] as const)(
    'reports provider error %s without accepting an existing identity (SDK throws: %s)', async (providerError, sdkThrows) => {
      const transactionId = 'provider-error-123456';
      const params = new URLSearchParams({ transaction: transactionId, state: 'state', error: providerError,
        error_description: '<script>untrusted details</script>' });
      const href = `https://app.example/auth/callback?${params}`;
      installDom(href);
      const { store } = mutableStore(transaction(transactionId));
      const open = vi.fn();
      const callbackRuntime = runtime('https://app.example/alice/profile/card#me', open);
      if (sdkThrows) callbackRuntime.session.handleIncomingRedirect = vi.fn().mockRejectedValue(new Error('authorization rejected'));
      const result = await completeXpodOidcCallback({
        href, runtime: callbackRuntime, transactionStore: store, storage: window.sessionStorage,
      });
      expect(result).toMatchObject({ status: 'failure', code: 'oidc-provider-error' });
      expect(JSON.stringify(result)).not.toContain('script');
      expect(callbackRuntime.session.handleIncomingRedirect).toHaveBeenCalledWith(href);
      expect(callbackRuntime.session.fetch).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['unreachable', () => Promise.reject(new Error('offline'))],
    ['unhealthy', async () => new Response('starting', { status: 503 })],
    ['malformed', async () => new Response('<html>starting</html>', { status: 200 })],
  ])('does not report a missing Pod when the storage host status is %s', async (_name, statusFetch) => {
    const transactionId = 'callback-host-status-123456';
    const href = `http://127.0.0.1:3000/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const { store } = mutableStore(transaction(transactionId));
    const open = vi.fn();
    const callbackRuntime = runtime('https://id.example/alice/profile/card#me', open);
    callbackRuntime.session.fetch = vi.fn(async () => new Response(`
      <https://id.example/alice/profile/card#me> <http://www.w3.org/ns/solid/terms#storage> <https://id.example/alice/>.
    `, { headers: { 'content-type': 'text/turtle' } }));

    await expect(completeXpodOidcCallback({
      href, runtime: callbackRuntime, transactionStore: store,
      storage: window.sessionStorage, fetch: vi.fn(statusFetch),
    })).resolves.toMatchObject({ status: 'failure', code: 'provision-status-unavailable' });
    expect(open).not.toHaveBeenCalled();
    expect(callbackRuntime.session.fetch).not.toHaveBeenCalled();
  });

  test('discovers the current Local Xpod Pod when Cloud IdP also exposes a Cloud Pod', async () => {
    const transactionId = 'missing-storage-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const pending = transaction(transactionId);
    store.begin(pending);
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl ?? 'https://app.example/alice/',
      database: {},
      collections: 'ready' as const,
    }));

    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://id.example/alice/profile/card#me');
      return new Response(`@prefix solid: <http://www.w3.org/ns/solid/terms#>.
        <https://id.example/alice/profile/card#me> solid:storage <https://id.example/alice/>.
        <https://id.example/alice/profile/card#me> solid:storage <https://local.nodes.example/alice/>.`, {
        status: 200,
        headers: { 'content-type': 'text/turtle' },
      });
    });
    const callbackRuntime = runtime('https://id.example/alice/profile/card#me', open);
    callbackRuntime.session.fetch = sessionFetch;

    const result = await completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        publicUrl: 'https://local.nodes.example/',
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    expect(result).toMatchObject({
      status: 'redirected',
      selectedStorage: {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://local.nodes.example/alice/',
      },
    });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://local.nodes.example/alice/',
    }));
  });

  test('reports incomplete Local provisioning instead of treating a Cloud Pod as the login target', async () => {
    const transactionId = 'missing-local-storage-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId));
    const open = vi.fn();
    const callbackRuntime = runtime('https://id.example/alice/profile/card#me', open);
    callbackRuntime.session.fetch = vi.fn(async () => new Response(`@prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <https://id.example/alice/profile/card#me> solid:storage <https://id.example/alice/>.`, {
      status: 200,
      headers: { 'content-type': 'text/turtle' },
    }));

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        managed: true,
        provisionUrl: 'https://id.example/.account/?provisionCode=signed-code',
        publicUrl: 'https://local.nodes.example/',
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    })).resolves.toMatchObject({
      status: 'failure',
      code: 'local-binding-missing',
      actionUrl: 'https://id.example/.account/?provisionCode=signed-code',
    });
    expect(open).not.toHaveBeenCalled();
  });

  test('sets the managed Web local Pod route before opening a canonical Local storage', async () => {
    const transactionId = 'callback-local-route-123456';
    const selectedStorage = {
      webId: 'https://id.undefineds.co/alice/profile/card#me',
      storageUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
    };
    const href = `http://127.0.0.1:5173/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const { store } = mutableStore(transaction(transactionId, selectedStorage));
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const callbackRuntime = runtime(selectedStorage.webId, open);
    const setLocalPodRoutes = vi.mocked(callbackRuntime.setLocalPodRoutes);
    const provisionFetch = vi.fn(async () => new Response(JSON.stringify({
      managed: true,
      publicUrl: 'https://acceptance-local.nodes.acceptance.test/',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      fetch: provisionFetch,
    })).resolves.toMatchObject({
      status: 'redirected',
      selectedStorage,
    });

    expect(provisionFetch).toHaveBeenCalledTimes(1);
    expect(setLocalPodRoutes).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        kind: 'loopback',
        canonicalUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
        targetUrl: 'http://127.0.0.1:5173/alice/',
        priority: 10,
      }),
    ]));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(setLocalPodRoutes.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  test('distinguishes temporary WebID profile read failure from missing binding or Pod failure', async () => {
    const transactionId = 'callback-profile-read-failed-123456';
    const href = `http://127.0.0.1:5173/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId));
    const open = vi.fn();
    const callbackRuntime = runtime('https://id.undefineds.co/alice/profile/card#me', open);
    callbackRuntime.session.fetch = vi.fn(async () => new Response('temporarily unavailable', { status: 503 }));

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        managed: true,
        provisionUrl: 'https://id.undefineds.co/.account/?provisionCode=signed-code',
        publicUrl: 'https://acceptance-local.nodes.acceptance.test/',
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    })).resolves.toMatchObject({
      status: 'failure',
      code: 'profile-read-failed',
    });
    expect(open).not.toHaveBeenCalled();
    // The node origin route is registered before discovery; the failing read
    // here targets the IdP-hosted WebID, which that route does not cover.
    expect(callbackRuntime.setLocalPodRoutes).toHaveBeenCalledTimes(1);
    expect(callbackRuntime.setLocalPodRoutes).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        kind: 'loopback',
        canonicalUrl: 'https://acceptance-local.nodes.acceptance.test/',
        targetUrl: 'http://127.0.0.1:5173/',
      }),
    ]));
  });

  test('routes the node origin through loopback before reading a node-hosted WebID profile', async () => {
    const transactionId = 'callback-loopback-profile-123456';
    const webId = 'https://acceptance-local.nodes.acceptance.test/alice/profile/card#me';
    const href = `http://127.0.0.1:5173/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId));
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const callbackRuntime = runtime(webId, open);
    const sessionFetch = vi.fn(async () => new Response(`@prefix solid: <http://www.w3.org/ns/solid/terms#>.
      <${webId}> solid:storage <https://acceptance-local.nodes.acceptance.test/alice/>.`, {
      status: 200,
      headers: { 'content-type': 'text/turtle' },
    }));
    callbackRuntime.session.fetch = sessionFetch;
    const setLocalPodRoutes = vi.mocked(callbackRuntime.setLocalPodRoutes);

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        managed: true,
        publicUrl: 'https://acceptance-local.nodes.acceptance.test/',
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    })).resolves.toMatchObject({ status: 'redirected' });

    // The origin route must be active before the profile read so the session
    // transport fetches the canonical public URL through the loopback gateway.
    expect(setLocalPodRoutes).toHaveBeenNthCalledWith(1, expect.arrayContaining([
      expect.objectContaining({
        kind: 'loopback',
        canonicalUrl: 'https://acceptance-local.nodes.acceptance.test/',
        targetUrl: 'http://127.0.0.1:5173/',
      }),
    ]));
    expect(setLocalPodRoutes.mock.invocationCallOrder[0]).toBeLessThan(sessionFetch.mock.invocationCallOrder[0]);
    // Once storage is known, the narrower Pod-scoped route takes over.
    expect(setLocalPodRoutes).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({
        kind: 'loopback',
        canonicalUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
        targetUrl: 'http://127.0.0.1:5173/alice/',
      }),
    ]));
  });

  test('pending Xpod callback ignores Inrupt currentUrl and completes the host transaction', async () => {
    const transactionId = 'callback-pending-settings-123456';
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=fresh-code&state=fresh-state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId, selectedStorage));
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/settings/models');
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated' as const,
      webId: 'https://app.example/alice/profile/card#me',
    }));
    const open = vi.fn(async () => ({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
      database: {},
      collections: 'ready' as const,
    }));
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', open) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toMatchObject({
      status: 'redirected',
      destination: 'https://app.example/settings/models',
    });
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(replace).toHaveBeenCalledWith('https://app.example/settings/models');
    expect(store.readSinglePending()).toBeUndefined();
  });

  test('reopening a completed stable callback resumes by its state without consuming a newer transaction', async () => {
    const href = 'https://app.example/auth/callback?code=used-code&state=used-state';
    installDom(href);
    const webId = 'https://app.example/alice/profile/card#me';
    const { store } = mutableStore(transaction('stable-replay-completed-123456', { webId, storageUrl: 'https://app.example/alice/' }));
    const value = runtime(webId, vi.fn(async () => ({ webId, podUrl: 'https://app.example/alice/', database: {}, collections: 'ready' as const })));
    expect(await completeXpodOidcCallback({ href, runtime: value, transactionStore: store })).toMatchObject({ status: 'redirected' });
    const pending = transaction('new-interactive-123456');
    store.begin(pending);
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/dashboard/overview');
    expect(await completeXpodOidcCallback({ href, runtime: value, transactionStore: store })).toMatchObject({ status: 'redirected', destination: 'https://app.example/settings/models' });
    expect(value.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(store.readSinglePending()?.id).toBe(pending.id);
  });

  test.each(['state', 'path', 'expired', 'future'])('rejects an invalid stable completion %s without redeeming again', async (invalid) => {
    const href = 'https://app.example/auth/callback?code=used-code&state=used-state';
    installDom(href);
    const webId = 'https://app.example/alice/profile/card#me';
    const { store } = mutableStore(transaction('stable-invalid-completed-123456', { webId, storageUrl: 'https://app.example/alice/' }));
    const value = runtime(webId, vi.fn(async () => ({ webId, podUrl: 'https://app.example/alice/', database: {}, collections: 'ready' as const })));
    const time = Date.now();
    expect(await completeXpodOidcCallback({ href, runtime: value, transactionStore: store, now: () => time })).toMatchObject({ status: 'redirected' });
    const replayHref = invalid === 'state' ? href.replace('used-state', 'tampered-state') : invalid === 'path' ? href.replace('/auth/callback', '/settings/auth-callback.html') : href;
    expect(await completeXpodOidcCallback({ href: replayHref, runtime: value, transactionStore: store, now: () => time + (invalid === 'expired' ? 660_000 : invalid === 'future' ? -1 : 0) })).toMatchObject({ status: 'failure' });
    expect(value.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
  });

  test('reopening a completed callback never redeems the old OIDC code again', async () => {
    const transactionId = 'callback-replay-stale-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=used-code&state=used-state`;
    installDom(href);
    window.sessionStorage.setItem(`xpod.auth.callback.completed.v1.${transactionId}`, JSON.stringify({
      destination: 'https://app.example/dashboard/overview',
      completedAt: Date.now(),
    }));
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn();
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/dashboard/overview',
    });
    expect(handleIncomingRedirect).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('https://app.example/dashboard/overview');
  });

  test('fresh silent restoration with an old completed transaction returns to the current product route', async () => {
    const transactionId = 'callback-silent-stale-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=fresh-code&state=fresh-state`;
    installDom(href);
    window.sessionStorage.setItem(`xpod.auth.callback.completed.v1.${transactionId}`, JSON.stringify({
      destination: 'https://app.example/ai-connections',
      completedAt: Date.now(),
    }));
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/ai-config/model-assignments');
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated' as const,
      webId: 'https://app.example/alice/profile/card#me',
    }));
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    callbackRuntime.session.logout = vi.fn();
    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/ai-config/model-assignments',
    });
    expect(callbackRuntime.session.logout).not.toHaveBeenCalled();
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(replace).toHaveBeenCalledWith('https://app.example/ai-config/model-assignments');
  });

  test('rejects a lost host transaction before redeeming its OIDC code', async () => {
    const transactionId = 'callback-lost-host-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=unused-code&state=unused-state`;
    installDom(href);
    const handleIncomingRedirect = vi.fn();
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
    })).resolves.toMatchObject({
      status: 'failure',
      code: 'missing-transaction',
    });
    expect(handleIncomingRedirect).not.toHaveBeenCalled();
  });

  test('allows Inrupt silent restoration without an Xpod host transaction', async () => {
    const href = 'https://app.example/auth/callback?code=silent-code&state=silent-state';
    installDom(href);
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/settings/models');
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated' as const,
      webId: 'https://app.example/alice/profile/card#me',
    }));
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/settings/models',
    });
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(replace).toHaveBeenCalledWith('https://app.example/settings/models');
  });

  test('failed Inrupt silent restoration returns to the product route instead of parking on callback error', async () => {
    const href = 'https://app.example/auth/callback?error=login_required&error_description=End-User%20authentication%20is%20required&state=silent-state';
    installDom(href);
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/ai-config/model-assignments');
    window.localStorage.setItem('solidClientAuthn:currentSession', 'stale-session');
    window.localStorage.setItem('solidClientAuthenticationUser:stale-session', JSON.stringify({
      issuer: 'https://app.example/',
      redirectUrl: 'https://app.example/auth/callback',
    }));
    const namespacedKeys = [
      'xpod.inrupt.secure:solidClientAuthenticationUser:stale-session',
      'xpod.inrupt.insecure:solidClientAuthenticationUser:stale-session',
      'xpod.inrupt.secure:issuerConfig:https://app.example/',
      'xpod.inrupt.insecure:oidc.stale-state',
      'xpod.inrupt.secure:solidClientAuthenticationUser:other-session',
      'oidc.other-interactive-state',
      'issuerConfig:https://other.example/',
    ];
    for (const target of [window.localStorage, window.sessionStorage]) {
      for (const key of namespacedKeys) target.setItem(key, 'stale');
      target.setItem('xpod.theme', 'dark');
    }
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn(async () => ({
      status: 'error' as const,
      message: 'login_required',
    }));
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    callbackRuntime.session.logout = vi.fn();
    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/ai-config/model-assignments',
    });
    expect(callbackRuntime.session.logout).not.toHaveBeenCalled();
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(replace).toHaveBeenCalledWith('https://app.example/ai-config/model-assignments');
    expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBeNull();
    expect(window.localStorage.getItem('solidClientAuthn:currentSession')).toBeNull();
    expect(window.localStorage.getItem('solidClientAuthenticationUser:stale-session')).not.toBeNull();
    for (const target of [window.localStorage, window.sessionStorage]) {
      for (const key of namespacedKeys) expect(target.getItem(key)).toBe('stale');
      expect(target.getItem('xpod.theme')).toBe('dark');
    }
  });

  test('silent failure preserves pointers replaced by another interactive flow while awaiting the IdP', async () => {
    const href = 'https://app.example/auth/callback?error=login_required&state=silent-state';
    installDom(href);
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/settings/models');
    window.localStorage.setItem('solidClientAuthn:currentSession', 'old-session');
    const value = runtime('https://app.example/alice/#me', vi.fn());
    value.session.handleIncomingRedirect = vi.fn(async () => {
      window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/dashboard/overview');
      window.localStorage.setItem('solidClientAuthn:currentSession', 'new-session');
      window.localStorage.setItem('xpod.solid.sessionId', 'new-session');
      window.localStorage.setItem('oidc.new-interactive-state', 'pkce');
      return { status: 'error', error: new Error('login_required') };
    });
    value.session.logout = vi.fn();
    expect(await completeXpodOidcCallback({ href, runtime: value, storage: window.sessionStorage })).toMatchObject({ status: 'redirected' });
    expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBe('https://app.example/dashboard/overview');
    expect(window.localStorage.getItem('solidClientAuthn:currentSession')).toBe('new-session');
    expect(window.localStorage.getItem('xpod.solid.sessionId')).toBe('new-session');
    expect(window.localStorage.getItem('oidc.new-interactive-state')).toBe('pkce');
    expect(value.session.logout).not.toHaveBeenCalled();
  });

  test('completes the one tab-scoped Xpod transaction from the stable callback URL', async () => {
    const transactionId = 'callback-stable-url-123456';
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const href = 'https://app.example/auth/callback?code=code&state=state';
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId, selectedStorage));
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated' as const,
      webId: selectedStorage.webId,
    }));
    const open = vi.fn(async () => ({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
      database: {},
      collections: 'ready' as const,
    }));
    const callbackRuntime = runtime(selectedStorage.webId, open) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toMatchObject({
      status: 'redirected',
      destination: 'https://app.example/settings/models',
      selectedStorage,
    });
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(store.readSinglePending()).toBeUndefined();
  });

  test('an active stable-url host transaction wins over a stale Inrupt restore marker', async () => {
    const transactionId = 'callback-stable-marker-123456';
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const href = 'https://app.example/auth/callback?code=code&state=state';
    installDom(href);
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/dashboard/overview');
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId, selectedStorage));
    const replace = vi.fn();
    const open = vi.fn(async () => ({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
      database: {},
      collections: 'ready' as const,
    }));
    const callbackRuntime = runtime(selectedStorage.webId, open) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = vi.fn(async () => ({
      status: 'authenticated' as const,
      webId: selectedStorage.webId,
    }));

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toMatchObject({
      status: 'redirected',
      destination: 'https://app.example/settings/models',
      selectedStorage,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(store.readSinglePending()).toBeUndefined();
  });

  test('pure callback replay keeps the recorded destination without reprocessing OIDC', async () => {
    const transactionId = 'callback-replay-pure-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}`;
    installDom(href);
    window.sessionStorage.setItem(`xpod.auth.callback.completed.v1.${transactionId}`, JSON.stringify({
      destination: 'https://app.example/dashboard/overview',
      completedAt: Date.now(),
    }));
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/settings/models');
    const replace = vi.fn();
    const handleIncomingRedirect = vi.fn();
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.handleIncomingRedirect = handleIncomingRedirect;

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toMatchObject({
      status: 'redirected',
      destination: 'https://app.example/dashboard/overview',
    });
    expect(handleIncomingRedirect).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('https://app.example/dashboard/overview');
  });

  test('keeps a transaction pending when Pod open fails, then consumes on retry', async () => {
    const href = 'https://app.example/auth/callback?transaction=pod-open-retry-123456&code=code&state=state';
    installDom(href);
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const pending = transaction('pod-open-retry-123456', selectedStorage);
    store.begin(pending);
    let shouldOpen = false;
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => {
      if (!shouldOpen) throw new Error('Pod unavailable');
      return { webId: args.webId, podUrl: args.podUrl!, database: {}, collections: 'ready' as const };
    });
    const options = {
      href,
      runtime: runtime(selectedStorage.webId, open),
      transactionStore: store,
      storage: window.sessionStorage,
    };

    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({
      status: 'failure',
      code: 'pod-open-failed',
    });
    expect(open).toHaveBeenCalledWith({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
      fetch: expect.any(Function),
    });
    expect(store.readSinglePending()?.id).toBe(pending.id);

    shouldOpen = true;
    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({
      status: 'redirected',
      destination: 'https://app.example/settings/models',
    });
    expect(store.readSinglePending()).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(options.runtime.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
  });

  test('retry button reconnects the Pod without logging out or restarting sign-in', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const id = 'callback-retry-button-123456';
    const href = `https://app.example/auth/callback?transaction=${id}&code=code&state=state`;
    installDom(href);
    const webId = 'https://app.example/alice/profile/card#me';
    const { store } = mutableStore(transaction(id, { webId, storageUrl: 'https://app.example/alice/' }));
    let failing = true;
    const value = runtime(webId, vi.fn(async () => {
      if (failing) throw new Error('offline');
      return { webId, podUrl: 'https://app.example/alice/', database: {}, collections: 'ready' as const };
    }));
    value.session.logout = vi.fn();
    const restartSignIn = vi.fn();
    const location = { replace: vi.fn() };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(XpodOidcCallbackApp, { runtime: value, transactionStore: store, href, location, restartSignIn })); });
      const button = document.querySelector('button');
      expect(button?.textContent).toBe('重试连接');
      failing = false;
      await act(async () => { button!.click(); });
      expect(location.replace).toHaveBeenCalledWith('https://app.example/settings/models');
      expect(value.session.logout).not.toHaveBeenCalled();
      expect(restartSignIn).not.toHaveBeenCalled();
      expect(value.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  test.each(['profile', 'provision', 'open'])('retries transient %s failure after document recreation without redeeming code', async (stage) => {
    const id = `callback-recovery-${stage}-123456`;
    const href = `https://app.example/auth/callback?transaction=${id}&code=code&state=state`;
    installDom(href);
    const webId = 'https://app.example/alice/profile/card#me';
    const { store, getPending } = mutableStore(transaction(id));
    let failing = true;
    const open = vi.fn(async () => {
      if (failing && stage === 'open') throw new Error('offline');
      return { webId, podUrl: 'https://app.example/alice/', database: {}, collections: 'ready' as const };
    });
    const makeRuntime = () => {
      const value = runtime(webId, open);
      value.session.fetch = vi.fn(async () => failing && stage === 'profile'
        ? new Response('offline', { status: 503 })
        : new Response(`<${webId}> <http://www.w3.org/ns/solid/terms#storage> <https://app.example/alice/>.`, {
          headers: { 'content-type': 'text/turtle' },
        }));
      return value;
    };
    const firstRuntime = makeRuntime();
    const options = {
      href, runtime: firstRuntime, transactionStore: store, storage: window.sessionStorage,
      fetch: vi.fn(async () => new Response('', { status: failing && stage === 'provision' ? 503 : 404 })),
    };
    expect(await completeXpodOidcCallback(options)).toMatchObject({ status: 'failure' });
    expect(getPending()?.id).toBe(id);
    expect(Object.keys(window.sessionStorage).filter((key) => key.includes('selected'))).toEqual([]);
    failing = false;
    const freshRuntime = makeRuntime();
    expect(await completeXpodOidcCallback({ ...options, runtime: freshRuntime })).toMatchObject({ status: 'redirected' });
    expect(firstRuntime.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(freshRuntime.session.handleIncomingRedirect).not.toHaveBeenCalled();
  });

  test.each(['expired', 'future', 'state', 'identity', 'session', 'binding', 'route'])('rejects unsafe %s recovery without redeeming the code again', async (invalid) => {
    const id = `callback-invalid-${invalid}-123456`;
    const href = `https://app.example/auth/callback?transaction=${id}&code=code&state=state`;
    installDom(href);
    const webId = 'https://app.example/alice/profile/card#me';
    const pending = transaction(id, { webId, storageUrl: 'https://app.example/alice/' });
    const { store } = mutableStore(pending);
    const open = vi.fn(async () => { throw new Error('offline'); });
    const value = runtime(webId, open);
    let time = Date.now();
    const options = { href, runtime: value, transactionStore: store, storage: window.sessionStorage, now: () => time };
    expect(await completeXpodOidcCallback(options)).toMatchObject({ code: 'pod-open-failed' });
    if (invalid === 'expired') time += 11 * 60_000;
    if (invalid === 'future') time -= 1;
    if (invalid === 'state') options.href = href.replace('state=state', 'state=other');
    if (invalid === 'identity') value.session.getSnapshot = () => ({ status: 'authenticated', webId: 'https://app.example/bob/#me' });
    if (invalid === 'session') value.session.getSnapshot = () => ({ status: 'anonymous' });
    if (invalid === 'binding') pending.selectedStorage!.storageUrl = 'https://foreign.example/alice/';
    if (invalid === 'route') pending.route.identityProvider.url = 'https://foreign.example/';
    expect(await completeXpodOidcCallback(options)).toMatchObject({ status: 'failure' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(value.session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
  });

  test('keeps a transaction pending when selected-storage remember fails, then retries', async () => {
    const href = 'https://app.example/auth/callback?transaction=remember-retry-123456&code=code&state=state';
    installDom(href);
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const pending = transaction('remember-retry-123456', selectedStorage);
    store.begin(pending);
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const failingStorage = Object.create(window.sessionStorage) as Storage;
    failingStorage.setItem = vi.fn(() => {
      throw new Error('session storage unavailable');
    });
    const options = {
      href,
      runtime: runtime(selectedStorage.webId, open),
      transactionStore: store,
      storage: failingStorage,
    };

    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({
      status: 'failure',
      code: 'storage-unavailable',
    });
    expect(store.readSinglePending()?.id).toBe(pending.id);

    await expect(completeXpodOidcCallback({
      ...options,
      storage: window.sessionStorage,
    })).resolves.toMatchObject({ status: 'redirected' });
    expect(store.readSinglePending()).toBeUndefined();
  });

  test('keeps a transaction pending after a Pod binding mismatch, then retries', async () => {
    const href = 'https://app.example/auth/callback?transaction=binding-retry-123456&code=code&state=state';
    installDom(href);
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const pending = transaction('binding-retry-123456', selectedStorage);
    store.begin(pending);
    let mismatch = true;
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: mismatch ? 'https://app.example/bob/profile/card#me' : args.webId,
      podUrl: mismatch ? 'https://app.example/bob/' : args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const options = {
      href,
      runtime: runtime(selectedStorage.webId, open),
      transactionStore: store,
      storage: window.sessionStorage,
    };

    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({
      status: 'failure',
      code: 'binding-mismatch',
    });
    expect(store.readSinglePending()?.id).toBe(pending.id);

    mismatch = false;
    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({ status: 'redirected' });
    expect(store.readSinglePending()).toBeUndefined();
  });

  test('keeps a transaction pending after an unsafe return path, then retries after it is corrected', async () => {
    const href = 'https://app.example/auth/callback?transaction=return-to-retry-123456&code=code&state=state';
    installDom(href);
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const pending = transaction('return-to-retry-123456', selectedStorage);
    const mutable = mutableStore({ ...pending, returnTo: 'https://evil.example/steal' });
    const open = vi.fn(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const options = {
      href,
      runtime: runtime(selectedStorage.webId, open),
      transactionStore: mutable.store,
      storage: window.sessionStorage,
    };

    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({
      status: 'failure',
      code: 'unsafe-return-to',
    });
    expect(mutable.getPending()?.id).toBe(pending.id);
    expect(open).not.toHaveBeenCalled();

    mutable.store.begin({ ...pending, returnTo: '/settings/models' });
    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({ status: 'redirected' });
    expect(mutable.getPending()).toBeUndefined();
  });

  test('reset clears the pending host transaction and Inrupt restore marker before retry', async () => {
    const transactionId = 'callback-reset-123456';
    const href = `https://app.example/auth/callback?transaction=${transactionId}&code=code&state=state`;
    installDom(href);
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    store.begin(transaction(transactionId, {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    }));
    window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/settings/models');
    const callbackRuntime = runtime('https://app.example/alice/profile/card#me', vi.fn()) as XpodOidcCallbackRuntime;
    callbackRuntime.session.logout = vi.fn(async () => undefined);

    await resetXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      transactionStore: store,
      storage: window.sessionStorage,
    });

    expect(store.readSinglePending()).toBeUndefined();
    expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBeNull();
    expect(callbackRuntime.session.logout).toHaveBeenCalledTimes(1);
  });

});


test.each(['logout', 'switch', 'same-WebID restore'] as const)(
  'discards callback Pod completion after %s and retains a retryable transaction', async (transition) => {
    const id = 'callback-session-change-123456';
    const href = `https://app.example/auth/callback?transaction=${id}&code=code&state=state`;
    installDom(href);
    const binding = { webId: 'https://app.example/alice#me', storageUrl: 'https://app.example/alice/' };
    const { store, getPending } = mutableStore(transaction(id, binding));
    const events = new EventEmitter();
    const info = { isLoggedIn: true, webId: binding.webId };
    const session = createSolidSessionRuntime({ session: {
      info, events, fetch: vi.fn(async () => new Response('ok')),
      handleIncomingRedirect: vi.fn(async () => info), login: vi.fn(async () => undefined),
      logout: vi.fn(async () => { info.isLoggedIn = false; events.emit('logout'); }),
    } });
    let resolveOpen!: (value: Record<string, unknown>) => void;
    const openDatabase = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { resolveOpen = resolve; }));
    const podRuntime = createPodRuntime({ adapter: {
      discoverPod: () => binding.storageUrl, openDatabase, hydrateCollections: () => undefined,
    } });
    const open = vi.spyOn(podRuntime, 'open');
    const value = runtime(binding.webId, open);
    value.pod = podRuntime;
    value.session = session;
    const options = { href, runtime: value, transactionStore: store, storage: window.sessionStorage };
    const pending = completeXpodOidcCallback(options);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    let otherPod: Awaited<ReturnType<typeof podRuntime.open>> | undefined;
    if (transition === 'switch') {
      openDatabase.mockResolvedValueOnce({ identity: 'B' });
      otherPod = await podRuntime.open({ webId: 'https://app.example/bob#me', podUrl: 'https://app.example/bob/', fetch: session.fetch });
    }
    if (transition === 'logout') await session.logout();
    else {
      if (transition === 'switch') info.webId = 'https://app.example/bob#me';
      events.emit('sessionRestore');
    }
    resolveOpen({ webId: binding.webId, podUrl: binding.storageUrl, database: {}, collections: 'ready' });
    await expect(pending).resolves.toMatchObject({ status: 'failure', code: 'pod-open-failed' });
    expect(getPending()?.id).toBe(id);
    if (otherPod) {
      expect(await podRuntime.open({ webId: 'https://app.example/bob#me', podUrl: 'https://app.example/bob/', fetch: session.fetch })).toBe(otherPod);
    }
    info.isLoggedIn = true; info.webId = binding.webId; events.emit('sessionRestore');
    openDatabase.mockResolvedValue({ fresh: true });
    await expect(completeXpodOidcCallback(options)).resolves.toMatchObject({ status: 'redirected' });
    expect(getPending()).toBeUndefined();
    expect(openDatabase).toHaveBeenCalledTimes(transition === 'switch' ? 3 : 2);
    session.dispose();
  },
);
