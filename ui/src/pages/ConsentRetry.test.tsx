// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodConsentErrors } from '../auth/xpod-account-copy';
import { storageBindingKey } from '../auth/xpod-storage-selection';
import { ConsentPage } from './ConsentPage';

function resetConsentRetryTestState(): void {
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
  resetConsentRetryTestState();
});

afterEach(() => {
  resetConsentRetryTestState();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
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

function renderConsentPage(overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={['/.account/oidc/consent/']}>
        <ConsentPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input), window.location.origin).pathname;
}

describe('ConsentPage storage retry routing', () => {
  it('retries failed binding lookup without creating storage', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (path === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsentPage({
      controls: { account: { username: 'alice', pod: '/.account/account/pod/' } },
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.bindingsFailed));
    expect(fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/.account/oidc/pick-webid/')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) =>
      requestPath(input) === '/.account/oidc/pick-webid/',
    )).toHaveLength(2));
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
  });

  it('retries failed storage creation by posting create again', async () => {
    const createPod = vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (path === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (path === '/.account/account/pod/' && init?.method === 'POST') {
        return createPod();
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsentPage({
      controls: { account: { username: 'alice', pod: '/.account/account/pod/' } },
    });

    await waitFor(() => expect(createPod).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.storageCreateFailed));
    const lookupCallsBeforeRetry = fetchMock.mock.calls.filter(([input]) =>
      requestPath(input) === '/.account/oidc/pick-webid/',
    ).length;

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(createPod).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.filter(([input]) =>
      requestPath(input) === '/.account/oidc/pick-webid/',
    )).toHaveLength(lookupCallsBeforeRetry);
  });

  it('does not complete consent when the selected WebID follow-up fails', async () => {
    const currentBinding = {
      webId: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://storage.example/alice/',
    };
    const selectedBinding = {
      webId: 'https://id.example/bob/profile/card#me',
      storageUrl: 'https://storage.example/bob/',
    };
    const followUpPath = '/.account/oidc/pick-webid/continue';
    const pickWebId = vi.fn(async () =>
      new Response(JSON.stringify({ location: followUpPath }), { status: 200 }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/.account/oidc/consent/' && !init?.method) {
        return new Response(JSON.stringify({
          client: { client_id: 'client', client_name: 'Client' },
          webId: currentBinding.webId,
        }), { status: 200 });
      }
      if (path === '/.account/oidc/pick-webid/' && !init?.method) {
        return new Response(JSON.stringify({
          entries: [currentBinding, selectedBinding],
        }), { status: 200 });
      }
      if (path === '/.account/oidc/pick-webid/' && init?.method === 'POST') {
        return pickWebId();
      }
      if (path === followUpPath) {
        return new Response(JSON.stringify({ message: 'lost interaction' }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConsentPage();

    fireEvent.change(await screen.findByLabelText('身份与存储空间'), {
      target: { value: storageBindingKey(selectedBinding) },
    });
    fireEvent.click(screen.getByRole('button', { name: '批准' }));

    await waitFor(() => expect(pickWebId).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.webIdSelectionFailed));
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/oidc/consent/' && init?.method === 'POST',
    )).toBe(false);
  });
});
