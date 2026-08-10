import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SolidSessionAdapter, WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import {
  createXpodSolidRuntimeValue,
  discoverPodUrlFromWebId,
  XPOD_LAST_OIDC_ISSUER_STORAGE_KEY,
  type XpodSolidRuntimeCore,
} from './XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from './XpodSolidRuntimeProvider';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';
import {
  XPOD_SELECTED_STORAGE_BINDING_KEY,
  createXpodLoginTransactionStore,
  readXpodSelectedStorage,
  rememberXpodSelectedStorage,
} from '../auth/xpod-login-transaction';
import { completeXpodOidcCallback } from './XpodOidcCallbackApp';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.fn;

type Listener = (...args: unknown[]) => void;

const unsafeRouteCases = [
  ['userinfo', 'https://alice:secret@app.example/'],
  ['query', 'https://app.example/?client_id=leak'],
  ['hash', 'https://app.example/#access_token=leak'],
] as const;

class FakeSession implements SolidSessionAdapter {
  readonly fetch = mock(async () => new Response('ok'));
  readonly handleIncomingRedirect = mock(async () => this.info);
  readonly login = mock(async (options: { oidcIssuer?: string }) => {
    this.loginOptions.push(options);
  });
  readonly logout = mock(async () => {
    this.info = { isLoggedIn: false };
    this.emit('logout');
  });
  info: SolidSessionAdapter['info'] & { issuer?: string } = { isLoggedIn: false };
  loginOptions: { oidcIssuer?: string }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  readonly events = {
    on: (event: string, listener: Listener) => {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    },
    off: (event: string, listener: Listener) => {
      this.listeners.get(event)?.delete(listener);
    },
  } as SolidSessionAdapter['events'];

  authenticate(webId = 'https://id.example/alice#me', issuer?: string) {
    this.info = { isLoggedIn: true, webId, issuer };
    this.emit('login');
  }

  expire() {
    this.emit('sessionExpired');
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function installDom(url = 'https://app.example/dashboard/models') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  return dom;
}

async function renderWithRoot(element: React.ReactNode) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

function RuntimeProbe() {
  const runtime = useXpodSolidRuntime();
  const snapshot = runtime.session.getSnapshot();
  return (
    <div>
      <span data-testid="status">{snapshot.status}</span>
      <span data-testid="issuer">{runtime.issuer ?? 'no-issuer'}</span>
      <button type="button" onClick={() => void runtime.login(currentOriginTransaction())}>
        login
      </button>
      <button type="button" onClick={() => void runtime.logout()}>
        logout
      </button>
      <button type="button" onClick={() => void runtime.fetch('/resource')}>
        fetch
      </button>
    </div>
  );
}

function currentOriginTransaction(overrides: Partial<WebIdLoginTransaction> = {}): WebIdLoginTransaction {
  return {
    id: 'xpod-test-transaction-123456',
    route: {
      id: 'xpod-current-origin',
      label: window.location.host,
      identityProvider: { url: window.location.origin, label: window.location.host },
      storageProvider: { url: window.location.origin, label: window.location.host },
      availability: 'ready',
    },
    authorizationSurface: 'redirect',
    discovery: 'strict',
    ...overrides,
  };
}

function CapabilityProbe() {
  const runtime = useXpodSolidRuntime();
  return (
    <div>
      <span data-testid="capability">
        {runtime.aiClientConfiguration?.available === true
          ? runtime.aiClientConfiguration.authority
          : runtime.aiClientConfiguration?.manualInstructions ?? 'no-capability'}
      </span>
    </div>
  );
}

function IdentityPairProbe() {
  const runtime = useXpodSolidRuntime();
  const selectedStorage = (runtime as XpodSolidRuntimeValueWithBinding).selectedStorage;
  return (
    <div>
      <span data-testid="identity-pair">{runtime.currentPod ? `${runtime.currentPod.webId}|${runtime.currentPod.podUrl}` : 'none'}</span>
      <span data-testid="selected-pair">{selectedStorage ? `${selectedStorage.webId}|${selectedStorage.storageUrl}` : 'none'}</span>
      <span data-testid="capability-pair">{runtime.aiClientConfiguration?.available === true ? 'available' : 'none'}</span>
    </div>
  );
}

type XpodSolidRuntimeValueWithBinding = XpodSolidRuntimeValue & {
  readonly selectedStorage?: { webId: string; storageUrl: string };
};

describe('Xpod Solid runtime', () => {
  test('validates Inrupt state before consuming, then consumes once and opens the exact selected storage', async () => {
    installDom('https://app.example/auth/callback?transaction=callback-test-12345678&code=code&state=state');
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const transaction = currentOriginTransaction({
      id: 'callback-test-12345678',
      selectedStorage,
      returnTo: '/settings/models',
    });
    store.begin(transaction);
    const handleIncomingRedirect = mock(async () => ({ status: 'authenticated' as const, webId: selectedStorage.webId }));
    const open = mock(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    const runtime = {
      session: {
        fetch: mock(async () => new Response('ok')),
        getSnapshot: () => ({ status: 'authenticated' as const, webId: selectedStorage.webId }),
        handleIncomingRedirect,
      },
      pod: { open },
      getIssuer: () => window.location.origin,
      setIssuer: () => undefined,
    } as unknown as Parameters<typeof completeXpodOidcCallback>[0]['runtime'];
    const replace = mock(() => undefined);

    const result = await completeXpodOidcCallback({
      href: window.location.href,
      runtime,
      transactionStore: store,
      storage: window.sessionStorage,
      locationReplace: replace,
    });

    expect(result.status).toBe('redirected');
    expect(handleIncomingRedirect).toHaveBeenCalledWith(window.location.href);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(replace).toHaveBeenCalledWith('https://app.example/settings/models');
    expect(window.sessionStorage.getItem('xpod.auth.transaction.v1.active')).toBeNull();
    expect(readXpodSelectedStorage({ origin: window.location.origin, webId: selectedStorage.webId })).toEqual(selectedStorage);
    expect((await completeXpodOidcCallback({
      href: window.location.href,
      runtime,
      transactionStore: store,
      storage: window.sessionStorage,
      locationReplace: replace,
    }))).toMatchObject({ status: 'failure', code: 'replayed-transaction' });
  });

  test('does not consume the host transaction when Inrupt rejects callback state', async () => {
    installDom('https://app.example/auth/callback?transaction=callback-test-87654321&code=code&state=bad');
    const store = createXpodLoginTransactionStore({ origin: window.location.origin, storage: window.sessionStorage });
    const transaction = currentOriginTransaction({ id: 'callback-test-87654321' });
    store.begin(transaction);
    const runtime = {
      session: {
        fetch: mock(async () => new Response('ok')),
        getSnapshot: () => ({ status: 'anonymous' as const }),
        handleIncomingRedirect: mock(async () => { throw new Error('state mismatch'); }),
      },
      pod: { open: mock(async () => { throw new Error('must not open'); }) },
      getIssuer: () => window.location.origin,
      setIssuer: () => undefined,
    } as unknown as Parameters<typeof completeXpodOidcCallback>[0]['runtime'];

    await expect(completeXpodOidcCallback({
      href: window.location.href,
      runtime,
      transactionStore: store,
      storage: window.sessionStorage,
    })).resolves.toMatchObject({ status: 'failure', code: 'oidc-state-invalid' });
    expect(store.readSinglePending()?.id).toBe(transaction.id);
  });

  test('persists a selected public binding for one callback replacement and rejects another WebID', () => {
    installDom('https://app.example/auth/callback?transaction=tx');
    const binding = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };

    rememberXpodSelectedStorage(binding, { now: () => 1000 });
    expect(window.sessionStorage.getItem(XPOD_SELECTED_STORAGE_BINDING_KEY)).toContain('alice');
    expect(readXpodSelectedStorage({ origin: window.location.origin, webId: binding.webId, now: () => 1001 })).toEqual(binding);
    expect(readXpodSelectedStorage({ origin: window.location.origin, webId: 'https://app.example/bob/profile/card#me', now: () => 1001 })).toBeUndefined();
    expect(window.sessionStorage.getItem(XPOD_SELECTED_STORAGE_BINDING_KEY)).toBeNull();
  });

  test('restores a callback-selected binding in a fresh runtime document and opens that Pod explicitly', async () => {
    installDom('https://app.example/settings/models');
    const selectedStorage = {
      webId: 'https://app.example/alice/profile/card#me',
      storageUrl: 'https://app.example/alice/',
    };
    rememberXpodSelectedStorage(selectedStorage);
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.authenticate(selectedStorage.webId, window.location.origin);
      return session.info;
    });
    const runtime = createXpodSolidRuntimeValue({ sessionFactory: () => session });
    const open = mock(async (args: { webId: string; podUrl?: string }) => ({
      webId: args.webId,
      podUrl: args.podUrl!,
      database: {},
      collections: 'ready' as const,
    }));
    runtime.pod.open = open as typeof runtime.pod.open;

    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <XpodSolidRuntimeProvider value={runtime}>
          <IdentityPairProbe />
        </XpodSolidRuntimeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      webId: selectedStorage.webId,
      podUrl: selectedStorage.storageUrl,
    }));
    expect(container.querySelector('[data-testid="selected-pair"]')?.textContent)
      .toBe(`${selectedStorage.webId}|${selectedStorage.storageUrl}`);
    await unmount(root);
  });

  test('constructs one browser session and initializes redirect handling once', async () => {
    let constructions = 0;
    const session = new FakeSession();
    const value = createXpodSolidRuntimeValue({
      sessionFactory: () => {
        constructions += 1;
        return session;
      },
    });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <RuntimeProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(constructions).toBe(1);
    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('anonymous');
    await unmount(root);
  });

  test('keeps the same runtime while switching settings routes', async () => {
    const session = new FakeSession();
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <MemoryRouter initialEntries={['/models']}>
          <Routes>
            <Route
              path="/models"
              element={(
                <>
                  <RuntimeProbe />
                  <Link to="/pod">pod</Link>
                </>
              )}
            />
            <Route path="/pod" element={<RuntimeProbe />} />
          </Routes>
        </MemoryRouter>
      </XpodSolidRuntimeProvider>,
    );

    const link = container.querySelector('a[href="/pod"]');
    if (!link) throw new Error('missing route link');
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('anonymous');
    await unmount(root);
  });

  test('accepts only a validated current-origin transaction, exposes authenticated fetch, and logs out without raw token storage', async () => {
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.authenticate();
      return session.info;
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });
    const localStorageSet = mock(() => undefined);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { setItem: localStorageSet, getItem: mock(() => null), removeItem: mock(() => undefined) },
    });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <RuntimeProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.textContent).toContain('authenticated');

    const [loginButton, logoutButton, fetchButton] = Array.from(container.querySelectorAll('button'));
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fetchButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      logoutButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(session.loginOptions).toEqual([expect.objectContaining({
      oidcIssuer: 'https://app.example/',
      redirectUrl: 'https://app.example/auth/callback?transaction=xpod-test-transaction-123456',
    })]);
    expect(session.fetch).toHaveBeenCalledWith('/resource');
    expect(localStorageSet).not.toHaveBeenCalled();
    expect(container.textContent).toContain('anonymous');
    await unmount(root);
  });

  test('preserves the real Solid issuer across redirect and login calls', async () => {
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.authenticate('https://id.example/alice#me', 'https://issuer.identity.example/');
      return session.info;
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <RuntimeProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.querySelector('[data-testid="issuer"]')?.textContent).toBe('https://issuer.identity.example/');

    const loginButton = container.querySelector('button');
    if (!loginButton) throw new Error('missing login button');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector('[data-testid="issuer"]')?.textContent).toBe('https://app.example/');
    await unmount(root);
  });

  test('restores the last valid login issuer after a redirect reload when Inrupt session info omits issuer', async () => {
    installDom();
    window.sessionStorage.clear();
    window.localStorage.clear();

    const firstSession = new FakeSession();
    firstSession.handleIncomingRedirect.mockImplementation(async () => {
      firstSession.authenticate('https://id.example/alice#me');
      return firstSession.info;
    });
    const firstRuntime = createXpodSolidRuntimeValue({ sessionFactory: () => firstSession });
    const firstRootNode = document.getElementById('root');
    if (!firstRootNode) throw new Error('missing root');
    const firstRoot = createRoot(firstRootNode);
    await act(async () => {
      firstRoot.render(
        <XpodSolidRuntimeProvider value={firstRuntime}>
          <RuntimeProbe />
        </XpodSolidRuntimeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const firstLoginButton = firstRootNode.querySelector('button');
    if (!firstLoginButton) throw new Error('missing first login button');
    await act(async () => {
      firstLoginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(firstSession.loginOptions).toEqual([expect.objectContaining({ oidcIssuer: 'https://app.example/' })]);
    await unmount(firstRoot);

    const secondSession = new FakeSession();
    secondSession.handleIncomingRedirect.mockImplementation(async () => {
      secondSession.authenticate('https://id.example/alice#me');
      return secondSession.info;
    });
    const secondRuntime = createXpodSolidRuntimeValue({ sessionFactory: () => secondSession });
    const secondRootNode = document.createElement('div');
    document.body.append(secondRootNode);
    const secondRoot = createRoot(secondRootNode);
    await act(async () => {
      secondRoot.render(
        <XpodSolidRuntimeProvider value={secondRuntime}>
          <RuntimeProbe />
        </XpodSolidRuntimeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(secondRootNode.querySelector('[data-testid="issuer"]')?.textContent).toBe('https://app.example/');
    const secondLoginButton = secondRootNode.querySelector('button');
    if (!secondLoginButton) throw new Error('missing second login button');
    await act(async () => {
      secondLoginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(secondSession.loginOptions).toEqual([expect.objectContaining({ oidcIssuer: 'https://app.example/' })]);
    expect(JSON.stringify(window.sessionStorage)).not.toContain('token');
    expect(JSON.stringify(window.localStorage)).not.toContain('issuer.example');
    await unmount(secondRoot);
  });

  test('ignores invalid stored issuers instead of enabling Login again', async () => {
    installDom();
    window.sessionStorage.setItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, 'javascript:alert(1)');
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.authenticate('https://id.example/alice#me');
      return session.info;
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <XpodSolidRuntimeProvider value={value}>
          <RuntimeProbe />
        </XpodSolidRuntimeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="issuer"]')?.textContent).toBe('no-issuer');
    await unmount(root);
  });

  test('rejects arbitrary login input without persisting or redirecting', async () => {
    installDom();
    window.sessionStorage.clear();
    const session = new FakeSession();
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <XpodSolidRuntimeProvider value={value}>
          <InvalidLoginProbe transaction={'javascript:alert(1)'} />
        </XpodSolidRuntimeProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const loginButton = container.querySelector('button');
    if (!loginButton) throw new Error('missing login button');
    await act(async () => {
      loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(session.login).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY)).toBeNull();
    await unmount(root);
  });

  for (const [label, unsafeIdentityProvider] of unsafeRouteCases) {
    test(`rejects current-origin routes containing ${label} without persisting or redirecting`, async () => {
      installDom();
      window.sessionStorage.clear();
      const session = new FakeSession();
      const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });
      const container = document.getElementById('root');
      if (!container) throw new Error('missing root');
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <XpodSolidRuntimeProvider value={value}>
            <InvalidLoginProbe transaction={currentOriginTransaction({
              route: {
                ...currentOriginTransaction().route,
                identityProvider: { url: unsafeIdentityProvider, label: 'unsafe' },
              },
            })} />
          </XpodSolidRuntimeProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const loginButton = container.querySelector('button');
      if (!loginButton) throw new Error('missing login button');
      await act(async () => {
        loginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });

      expect(session.login).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY)).toBeNull();
      await unmount(root);
    });
  }

  test('discovers Pod storage from the authenticated WebID profile only', async () => {
    const fetchImpl = mock(async () => new Response(
      '<https://id.example/alice#me> <http://www.w3.org/ns/solid/terms#storage> <https://pod.example/alice/> .',
      { headers: { 'content-type': 'text/turtle' } },
    ));

    await expect(discoverPodUrlFromWebId({
      webId: 'https://id.example/alice#me',
      fetch: fetchImpl as typeof fetch,
    })).resolves.toBe('https://pod.example/alice/');
    expect(fetchImpl).toHaveBeenCalledWith('https://id.example/alice#me', expect.objectContaining({
      headers: expect.objectContaining({ Accept: expect.stringContaining('text/turtle') }),
    }));
  });

  test('discovers and normalizes pim storage from Turtle profile regressions', async () => {
    const fetchImpl = mock(async () => new Response(
      [
        '@prefix pim: <http://www.w3.org/ns/pim/space#> .',
        '<https://id.example/alice#me> pim:storage <https://pod.example/alice> .',
        '<https://id.example/alice#me> <http://www.w3.org/ns/pim/space#storage> <https://pod.example/alice/> .',
      ].join('\n'),
      { headers: { 'content-type': 'text/turtle' } },
    ));

    await expect(discoverPodUrlFromWebId({
      webId: 'https://id.example/alice#me',
      fetch: fetchImpl as typeof fetch,
    })).resolves.toBe('https://pod.example/alice/');
  });

  test('discovers and normalizes storage URLs from JSON-LD profile namespaces', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({
      '@id': 'https://id.example/alice#me',
      'http://www.w3.org/ns/pim/space#storage': [
        { '@id': 'https://pod.example/alice' },
        { '@id': 'https://pod.example/alice/' },
      ],
    }), { headers: { 'content-type': 'application/ld+json' } }));

    await expect(discoverPodUrlFromWebId({
      webId: 'https://id.example/alice#me',
      fetch: fetchImpl as typeof fetch,
    })).resolves.toBe('https://pod.example/alice/');
  });

  test('maps session errors and expiry to safe public runtime states', async () => {
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      throw new Error('raw internal failure');
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <RuntimeStateProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.querySelector('[data-testid="runtime-state"]')?.textContent).toBe('error');
    expect(container.querySelector('[data-testid="runtime-error"]')?.textContent).toBe('Solid login failed. Please reconnect your Pod.');
    expect(container.textContent).not.toContain('raw internal failure');

    await act(async () => {
      session.expire();
    });
    expect(container.querySelector('[data-testid="runtime-state"]')?.textContent).toBe('expired');
    await unmount(root);
  });

  test('does not render a provider chooser or arbitrary issuer form', async () => {
    const session = new FakeSession();
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <RuntimeProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.textContent).not.toMatch(/Cloud|Local|Add provider|Solid Pod/);
    expect(container.querySelector('label')).toBeNull();

    await unmount(root);
  });

  test('discovers AI client configuration capability from the authenticated API path and exposes the host bridge descriptor', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      if (new URL(String(input), window.location.href).pathname === '/api/ai/client-configuration/capability') {
        return new Response(JSON.stringify({
          available: true,
          authority: 'local-filesystem',
          manualInstructions: 'Manual setup remains available.',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        '<https://id.example/alice#me> <http://www.w3.org/ns/solid/terms#storage> <https://pod.example/alice/> .',
        { headers: { 'content-type': 'text/turtle' } },
      );
    }) as typeof fetch;
    const runtime = runtimeCoreWithCapabilityFetch(fetchImpl, 'https://id.example/alice#me');

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={runtime}>
        <CapabilityProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.querySelector('[data-testid="capability"]')?.textContent).toBe('local-filesystem');
    expect(fetchImpl).toHaveBeenCalledWith(new URL('/api/ai/client-configuration/capability', window.location.href).toString(), expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ accept: 'application/json' }),
    }));
    await unmount(root);
  });

  test('clears the old Pod binding and AI capability immediately when the authenticated WebID changes', async () => {
    const session = new FakeSession();
    const aliceWebId = 'https://id.example/alice#me';
    const bobWebId = 'https://id.example/bob#me';
    session.handleIncomingRedirect.mockImplementation(async () => {
      session.authenticate(aliceWebId);
      return session.info;
    });
    let capabilityCalls = 0;
    session.fetch.mockImplementation(async (input) => {
      if (String(input).includes('/api/ai/client-configuration/capability')) {
        capabilityCalls += 1;
        if (capabilityCalls > 1) return new Promise(() => undefined);
        return new Response(JSON.stringify({
          available: true,
          authority: 'local-filesystem',
          manualInstructions: 'Manual setup remains available.',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('ok');
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });
    const alicePod = {
      webId: aliceWebId,
      podUrl: 'https://pod.example/alice/',
      database: {} as never,
      collections: 'ready' as const,
    };
    vi.spyOn(value.pod, 'open').mockImplementation(async ({ webId }) => {
      if (webId === aliceWebId) return alicePod;
      return new Promise(() => undefined);
    });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <IdentityPairProbe />
      </XpodSolidRuntimeProvider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="identity-pair"]')?.textContent).toContain(aliceWebId);
    expect(container.querySelector('[data-testid="selected-pair"]')?.textContent).toContain(aliceWebId);
    expect(container.querySelector('[data-testid="capability-pair"]')?.textContent).toBe('available');

    await act(async () => {
      session.authenticate(bobWebId);
    });

    expect(container.querySelector('[data-testid="identity-pair"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="selected-pair"]')?.textContent).toBe('none');
    expect(container.querySelector('[data-testid="capability-pair"]')?.textContent).toBe('none');
    await unmount(root);
  });

  test('falls back to manual AI client configuration capability when discovery is unavailable', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      if (new URL(String(input), window.location.href).pathname === '/api/ai/client-configuration/capability') {
        return new Response(JSON.stringify({ code: 'client_configuration_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        '<https://id.example/alice#me> <http://www.w3.org/ns/solid/terms#storage> <https://pod.example/alice/> .',
        { headers: { 'content-type': 'text/turtle' } },
      );
    }) as typeof fetch;
    const runtime = runtimeCoreWithCapabilityFetch(fetchImpl, 'https://id.example/alice#me');

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={runtime}>
        <CapabilityProbe />
      </XpodSolidRuntimeProvider>,
    );

    expect(container.querySelector('[data-testid="capability"]')?.textContent).toContain('manual');
    await unmount(root);
  });
});

function RuntimeStateProbe() {
  const runtime = useXpodSolidRuntime();
  return (
    <div>
      <span data-testid="runtime-state">{runtime.state.status}</span>
      <span data-testid="runtime-error">{runtime.state.status === 'error' ? runtime.state.error.message : ''}</span>
    </div>
  );
}

function InvalidLoginProbe({ transaction }: { transaction: unknown }) {
  const runtime = useXpodSolidRuntime();
  return (
    <button type="button" onClick={() => void runtime.login(transaction as WebIdLoginTransaction).catch(() => undefined)}>
      login
    </button>
  );
}

function runtimeCoreWithCapabilityFetch(fetchImpl: typeof fetch, webId: string): XpodSolidRuntimeCore {
  return {
    session: {
      fetch: fetchImpl,
      getSnapshot: () => ({ status: 'authenticated', webId }),
      subscribe: () => () => undefined,
      initialize: mock(async () => ({ status: 'authenticated', webId })),
      login: mock(async () => undefined),
      logout: mock(async () => undefined),
    } as unknown as XpodSolidRuntimeCore['session'],
    pod: {
      open: mock(async () => ({ podUrl: 'https://pod.example/alice/' })),
      clear: mock(() => undefined),
    } as unknown as XpodSolidRuntimeCore['pod'],
    getIssuer: () => 'https://issuer.example/',
    setIssuer: mock(() => undefined),
  };
}
