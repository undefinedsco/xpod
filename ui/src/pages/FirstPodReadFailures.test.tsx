// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { FirstPodPage } from './FirstPodPage';

function resetFirstPodReadFailureState(): void {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  globalThis.sessionStorage?.clear();
  window.localStorage.clear();
  globalThis.localStorage?.clear();
  window.xpodDesktop = undefined;
  globalThis.xpodDesktop = undefined;
  window.__XPOD__ = undefined;
}

beforeEach(() => {
  resetFirstPodReadFailureState();
});

afterEach(() => {
  resetFirstPodReadFailureState();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: 'https://id.example/.account/',
    isLoggedIn: true,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: { status: 'authenticated' },
    ...overrides,
  };
}

function renderFirstPodPage(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={['/.account/create-pod/']}>
        <FirstPodPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function makeProvisionCode(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
  return `${encoded}.signature`;
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

function installLocalProvisionContext(): void {
  window.__XPOD__ = {
    authenticating: false,
    provisionCode: makeProvisionCode({
      spUrl: 'https://node.example/',
      serviceToken: 'test-token',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  };
}

function makeExpiredLocalProvisionCode(storageDomain: string): string {
  return makeProvisionCode({
    spUrl: `https://${storageDomain}/`,
    spDomain: storageDomain,
    serviceToken: 'expired-token',
    exp: 1,
  });
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

describe('FirstPodPage Account WebID read failures', () => {
  it.each([
    {
      name: 'endpoint 500',
      webIdResponse: () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
    },
    {
      name: 'malformed JSON',
      webIdResponse: () => new Response('not-json', { status: 200 }),
    },
    {
      name: 'malformed shape',
      webIdResponse: () => new Response(JSON.stringify({}), { status: 200 }),
    },
  ])('does not create storage when Account WebID read returns $name, including retry', async ({ webIdResponse }) => {
    installLocalProvisionContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/account/webid/') {
        return webIdResponse();
      }
      if (path === '/.account/account/pod/' && init?.method === 'POST') {
        return new Response(JSON.stringify({ pod: 'created' }), { status: 201 });
      }
      if (path === '/provision/webids') {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFirstPodPage({
      controls: {
        account: {
          username: 'alice',
          webId: 'https://id.example/.account/account/webid/',
          pod: 'https://id.example/.account/account/pod/',
        },
      },
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) =>
      requestPath(input) === '/.account/account/webid/',
    )).toHaveLength(2));
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
  });

  it('does not create storage when the Account WebID control is missing, including retry', async () => {
    installLocalProvisionContext();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(input) === '/.account/account/pod/' && init?.method === 'POST') {
        return new Response(JSON.stringify({ pod: 'created' }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderFirstPodPage({
      controls: {
        account: {
          username: 'alice',
          pod: 'https://id.example/.account/account/pod/',
        },
      },
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));

    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
  });

  it('uses Account WebIDs as Local lookup candidates when durable bindings are empty', async () => {
    installLocalProvisionContext();
    const webId = 'https://node.example/alice/profile/card#me';
    const storageUrl = 'https://node.example/alice/';
    const createPod = vi.fn(async () => new Response(JSON.stringify({ pod: 'created' }), { status: 201 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/account/bindings/') {
        return new Response(JSON.stringify({ bindings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/.account/account/webid/') {
        return new Response(JSON.stringify({
          webIdLinks: { [webId]: 'https://id.example/.account/account/webid/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/provision/webids') {
        expect(JSON.parse(String(init?.body))).toEqual({ webIds: [webId] });
        return new Response(JSON.stringify({ entries: [{ webId, storageUrl }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/.account/account/pod/' && init?.method === 'POST') {
        return createPod();
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            bindings: 'https://id.example/.account/account/bindings/',
            username: 'alice',
            webId: 'https://id.example/.account/account/webid/',
            pod: 'https://id.example/.account/account/pod/',
          },
        },
      })}>
        <MemoryRouter initialEntries={['/.account/create-pod/']}>
          <FirstPodPage />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/.account/account/'));
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/.account/account/webid/')).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(true);
    expect(createPod).not.toHaveBeenCalled();
  });

  it('accepts durable exact storage before requiring an expired Local provision code', async () => {
    const webId = 'https://id.example/alice/profile/card#me';
    const storageUrl = 'https://node-a.example/alice/';
    sessionStorage.setItem('provisionCode', makeExpiredLocalProvisionCode('node-a.example'));
    const createPod = vi.fn(async () => new Response(JSON.stringify({ pod: 'created' }), { status: 201 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/account/bindings/') {
        return new Response(JSON.stringify({ bindings: [{ webId, storageUrl }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/provision/webids') {
        throw new Error('Durable exact storage must not require Local lookup');
      }
      if (path === '/.account/account/pod/' && init?.method === 'POST') {
        return createPod();
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            bindings: 'https://id.example/.account/account/bindings/',
            username: 'alice',
            webId: 'https://id.example/.account/account/webid/',
            pod: 'https://id.example/.account/account/pod/',
          },
        },
      })}>
        <MemoryRouter initialEntries={['/.account/create-pod/']}>
          <FirstPodPage />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/.account/account/'));
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
    expect(createPod).not.toHaveBeenCalled();
  });

  it('does not create or lookup when expired Local target has only another node durable binding', async () => {
    const webId = 'https://id.example/alice/profile/card#me';
    sessionStorage.setItem('provisionCode', makeExpiredLocalProvisionCode('node-a.example'));
    const createPod = vi.fn(async () => new Response(JSON.stringify({ pod: 'created' }), { status: 201 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/account/bindings/') {
        return new Response(JSON.stringify({ bindings: [{
          webId,
          storageUrl: 'https://node-b.example/alice/',
        }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/provision/webids') {
        throw new Error('Expired Local target without exact durable storage must not lookup');
      }
      if (path === '/.account/account/pod/' && init?.method === 'POST') {
        return createPod();
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthContext.Provider value={authValue({
        controls: {
          account: {
            bindings: 'https://id.example/.account/account/bindings/',
            username: 'alice',
            webId: 'https://id.example/.account/account/webid/',
            pod: 'https://id.example/.account/account/pod/',
          },
        },
      })}>
        <MemoryRouter initialEntries={['/.account/create-pod/']}>
          <FirstPodPage />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.cloudRouteUnavailable));
    expect(screen.getByTestId('location').textContent).toBe('/.account/create-pod/');
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/provision/webids')).toBe(false);
    expect(createPod).not.toHaveBeenCalled();
  });
});
