import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  createXpodLoginTransactionStore,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import {
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
      getSnapshot: () => ({ status: 'authenticated' as const, webId }),
      handleIncomingRedirect: vi.fn(async () => ({ status: 'authenticated' as const, webId })),
    },
    pod: { open },
    getIssuer: () => window.location.origin,
    setIssuer: () => undefined,
    setLocalPodRoute: vi.fn(),
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
    const setLocalPodRoute = vi.mocked(callbackRuntime.setLocalPodRoute);
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
    expect(setLocalPodRoute).toHaveBeenCalledWith({
      canonicalBaseUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
      localBaseUrl: 'http://127.0.0.1:5173/alice/',
    });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(setLocalPodRoute.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
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
    expect(callbackRuntime.setLocalPodRoute).not.toHaveBeenCalled();
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

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/ai-config/model-assignments',
    });
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

    await expect(completeXpodOidcCallback({
      href,
      runtime: callbackRuntime,
      storage: window.sessionStorage,
      locationReplace: replace,
    })).resolves.toEqual({
      status: 'redirected',
      destination: 'https://app.example/ai-config/model-assignments',
    });
    expect(handleIncomingRedirect).toHaveBeenCalledWith(href);
    expect(replace).toHaveBeenCalledWith('https://app.example/ai-config/model-assignments');
    expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBeNull();
    expect(window.localStorage.getItem('solidClientAuthn:currentSession')).toBeNull();
    expect(window.localStorage.getItem('solidClientAuthenticationUser:stale-session')).toBeNull();
    for (const target of [window.localStorage, window.sessionStorage]) {
      for (const key of namespacedKeys) expect(target.getItem(key)).toBeNull();
      expect(target.getItem('xpod.theme')).toBe('dark');
    }
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
