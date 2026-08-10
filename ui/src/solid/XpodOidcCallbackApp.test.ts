import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  createXpodLoginTransactionStore,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import {
  completeXpodOidcCallback,
  type XpodOidcCallbackRuntime,
} from './XpodOidcCallbackApp';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom(url: string): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
}

function transaction(id: string, selectedStorage: { webId: string; storageUrl: string }): WebIdLoginTransaction {
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
    selectedStorage,
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
});
