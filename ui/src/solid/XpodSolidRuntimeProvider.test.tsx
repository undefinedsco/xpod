import { describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { EVENTS } from '@inrupt/solid-client-authn-browser';
import {
  createXpodSolidRuntimeValue,
  currentXpodSurfaceRedirectUrl,
  discoverPodUrlFromWebId,
  ensureXpodOidcClient,
  markOidcClientAsNonExpiring,
  syncStoredOidcRedirectUrl,
  XPOD_LAST_OIDC_ISSUER_STORAGE_KEY,
  type XpodSolidRuntimeCore,
} from './XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from './XpodSolidRuntimeProvider';
import { SettingsAuthBoundary } from './SettingsAuthBoundary';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mock = vi.fn;

type Listener = (...args: unknown[]) => void;

const unsafeIssuerCases = [
  ['userinfo', 'https://alice:secret@issuer.example/'],
  ['query', 'https://issuer.example/?client_id=leak'],
  ['hash', 'https://issuer.example/#access_token=leak'],
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

  restore(url: string) {
    this.emit(EVENTS.SESSION_RESTORED, url);
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
      <button type="button" onClick={() => void runtime.login(' https://issuer.example/ ')}>
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

describe('Xpod Solid runtime', () => {
  test('maps deep links to the owning product surface redirect URL', () => {
    installDom('https://app.example/settings/pod?tab=storage');

    expect(currentXpodSurfaceRedirectUrl()).toBe('https://app.example/settings/');
  });

  test('syncs the stored OIDC redirect URL to the current product surface', () => {
    installDom('https://app.example/settings/pod');
    window.localStorage.clear();
    window.localStorage.setItem('solidClientAuthn:currentSession', 'session-1');
    window.localStorage.setItem('solidClientAuthenticationUser:session-1', JSON.stringify({
      clientId: 'client-1',
      redirectUrl: 'https://app.example/ai-connections/',
    }));

    syncStoredOidcRedirectUrl();

    expect(JSON.parse(window.localStorage.getItem('solidClientAuthenticationUser:session-1') ?? '{}')).toEqual({
      clientId: 'client-1',
      redirectUrl: 'https://app.example/settings/',
    });
  });

  test('registers one OIDC client for all product surface callbacks', async () => {
    installDom('https://app.example/settings/pod');
    window.localStorage.clear();
    const requests: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === 'https://app.example/.well-known/openid-configuration') {
        return Response.json({
          registration_endpoint: 'https://app.example/reg',
          id_token_signing_alg_values_supported: ['ES256'],
        });
      }
      if (url === 'https://app.example/reg') {
        return Response.json({ client_id: 'client-1', client_secret: 'secret-1' }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }));

    try {
      const client = await ensureXpodOidcClient('https://app.example/');
      expect(client).toEqual({
        issuer: 'https://app.example/',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        redirectUris: [
          'https://app.example/ai-connections/',
          'https://app.example/ai-config/',
          'https://app.example/settings/',
          'https://app.example/status/',
          'https://app.example/network/',
          'https://app.example/dashboard/',
        ],
      });
      expect(JSON.parse(requests.find((request) => request.url === 'https://app.example/reg')?.body ?? '{}')).toEqual(
        expect.objectContaining({
          client_name: 'Xpod',
          redirect_uris: client?.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('marks a statically registered OIDC client as non-expiring for Inrupt session restore', () => {
    installDom('https://app.example/settings/');
    window.localStorage.clear();
    window.localStorage.setItem('solidClientAuthenticationUser:session-1', JSON.stringify({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      clientType: 'static',
    }));

    markOidcClientAsNonExpiring('client-1');

    expect(JSON.parse(window.localStorage.getItem('solidClientAuthenticationUser:session-1') ?? '{}')).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      clientType: 'static',
      expiresAt: '0',
    });
  });

  test('navigates inside the current product surface when Inrupt restores a session', () => {
    installDom('https://app.example/settings/');
    const session = new FakeSession();
    createXpodSolidRuntimeValue({ sessionFactory: () => session });

    session.restore('https://app.example/settings/pod?tab=storage');

    expect(`${window.location.pathname}${window.location.search}`).toBe('/settings/pod?tab=storage');
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

  test('trims login issuer, exposes authenticated fetch, and logs out without raw token storage', async () => {
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

    expect(session.loginOptions).toEqual([expect.objectContaining({ oidcIssuer: 'https://issuer.example/' })]);
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

    expect(container.querySelector('[data-testid="issuer"]')?.textContent).toBe('https://issuer.example/');
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
    expect(firstSession.loginOptions).toEqual([expect.objectContaining({ oidcIssuer: 'https://issuer.example/' })]);
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

    expect(secondRootNode.querySelector('[data-testid="issuer"]')?.textContent).toBe('https://issuer.example/');
    const secondLoginButton = secondRootNode.querySelector('button');
    if (!secondLoginButton) throw new Error('missing second login button');
    await act(async () => {
      secondLoginButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(secondSession.loginOptions).toEqual([expect.objectContaining({ oidcIssuer: 'https://issuer.example/' })]);
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

  test('rejects non-http login issuers without persisting or redirecting', async () => {
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
          <InvalidLoginProbe />
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

  for (const [label, unsafeIssuer] of unsafeIssuerCases) {
    test(`rejects login issuers containing ${label} without persisting or redirecting`, async () => {
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
            <InvalidLoginProbe issuer={unsafeIssuer} />
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

  test('maps session errors and expiry to a safe auth boundary login state', async () => {
    const session = new FakeSession();
    session.handleIncomingRedirect.mockImplementation(async () => {
      throw new Error('raw internal failure');
    });
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <SettingsAuthBoundary>
          <RuntimeProbe />
        </SettingsAuthBoundary>
      </XpodSolidRuntimeProvider>,
    );

    expect(container.textContent).toContain('登录未完成');
    expect(container.textContent).toContain('Solid login failed. Please reconnect your Pod.');
    expect(container.textContent).not.toContain('raw internal failure');

    await act(async () => {
      const dismissButton = [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '重新选择登录方式');
      dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain('使用 undefineds 账号');
    expect(container.textContent).toContain('云端');
    expect(container.textContent).toContain('本机');

    await act(async () => {
      session.expire();
    });
    expect(container.textContent).toContain('登录未完成');
    expect(container.textContent).toContain('Solid session expired');
    await unmount(root);
  });

  test('renders the Linx account space chooser instead of the raw Solid issuer form', async () => {
    const session = new FakeSession();
    const value = createXpodSolidRuntimeValue({ sessionFactory: () => session });

    const { container, root } = await renderWithRoot(
      <XpodSolidRuntimeProvider value={value}>
        <SettingsAuthBoundary>
          <RuntimeProbe />
        </SettingsAuthBoundary>
      </XpodSolidRuntimeProvider>,
    );

    expect(container.textContent).toContain('使用 undefineds 账号');
    expect(container.textContent).toContain('云端');
    expect(container.textContent).toContain('本机');
    expect(container.querySelector('label')).toBeNull();
    expect(container.textContent).not.toContain('Solid Pod 地址');

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

function InvalidLoginProbe({ issuer = 'javascript:alert(1)' }: { issuer?: string }) {
  const runtime = useXpodSolidRuntime();
  return (
    <button type="button" onClick={() => void runtime.login(issuer)}>
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
