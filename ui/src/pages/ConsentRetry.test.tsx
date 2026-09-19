// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
      if (path === '/.account/account/pod/' && (!init?.method || init.method === 'GET')) return new Response(JSON.stringify({ pods: {} }));
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

  it('does not complete consent when selecting the WebID fails', async () => {
    const currentBinding = {
      webId: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://storage.example/alice/',
    };
    const selectedBinding = {
      webId: 'https://id.example/bob/profile/card#me',
      storageUrl: 'https://storage.example/bob/',
    };
    const pickWebId = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'lost interaction' }), { status: 500 }),
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

function mockFailedConsent() {
  const binding = { webId: 'https://pod.example/alice#me', storageUrl: 'https://pod.example/alice/' };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
    if (path === '/.account/oidc/consent/') return new Response(JSON.stringify({ client: { client_id: 'client' }, webId: binding.webId }));
    if (path === '/.account/oidc/pick-webid/') return new Response(JSON.stringify({ entries: [binding] }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mutationCount(fetchMock: ReturnType<typeof mockFailedConsent>, pathname: string) {
  return fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === pathname && init?.method === 'POST').length;
}

it('returns from failed consent to the editable form with remember disabled without submitting again', async () => {
  const fetchMock = mockFailedConsent();
  renderConsentPage();
  fireEvent.click(await screen.findByRole('checkbox', { name: '记住这个应用' }));
  fireEvent.click(screen.getByRole('button', { name: '批准' }));
  fireEvent.click(await screen.findByRole('button', { name: '返回授权' }));
  expect((await screen.findByRole('checkbox', { name: '记住这个应用' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
  expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(1);
});

it('retries a failed manual approval by refreshing interaction state before a new explicit approval', async () => {
  const fetchMock = mockFailedConsent();
  renderConsentPage();
  fireEvent.click(await screen.findByRole('button', { name: '批准' }));
  const retry = await screen.findByRole('button', { name: '重试' });
  const before = fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === '/.account/oidc/consent/' && !init?.method).length;
  fireEvent.click(retry);
  await screen.findByRole('button', { name: '批准' });
  expect(fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === '/.account/oidc/consent/' && !init?.method)).toHaveLength(before + 1);
  expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '批准' }));
  await waitFor(() => expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(2));
});

it('retries cancellation only after a failed cancellation without posting consent', async () => {
  const fetchMock = mockFailedConsent();
  renderConsentPage();
  fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
  fireEvent.click(await screen.findByRole('button', { name: '重试取消' }));
  await waitFor(() => expect(mutationCount(fetchMock, '/.account/oidc/cancel')).toBe(2));
  expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(0);
  expect(mutationCount(fetchMock, '/.account/oidc/pick-webid/')).toBe(0);
});


it('refreshes expired Account controls and preserves the interaction when going to sign in', async () => {
  const scoped = '/.account/interaction/recover-session/oidc/consent/';
  window.history.replaceState({}, '', scoped);
  const refetchControls = vi.fn(async () => ({ status: 'anonymous' as const }));
  const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  function LocationProbe() {
    return <output data-testid="route">{useLocation().pathname}</output>;
  }
  try {
    render(<AuthContext.Provider value={authValue({ refetchControls })}>
      <MemoryRouter initialEntries={[scoped]}><ConsentPage /><LocationProbe /></MemoryRouter>
    </AuthContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: '去登录' }));
    expect(refetchControls).toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/.account/interaction/recover-session/login/password/');
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  } finally { window.history.replaceState({}, '', '/'); }
});

it('shows ownerless existing storage recovery and retries reads without prepare or create', async () => {
  let bindingsReady = false;
  const binding = { webId: `${window.location.origin}/old-name/profile/card#me`, storageUrl: `${window.location.origin}/old-name/` };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    if (path === '/.account/oidc/consent/') return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }));
    if (path === '/.account/oidc/pick-webid/') return new Response(JSON.stringify({ entries: bindingsReady ? [binding] : [] }));
    if (path === '/.account/account/pod/') return new Response(JSON.stringify({ pods: { 'https://storage.example/old-name/': '/.account/pod/id' } }));
    if (path === '/provision/status') return new Response(JSON.stringify({ registered: false }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  renderConsentPage({ controls: { account: { username: 'different-name', pod: '/.account/account/pod/' } } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('已有 Pod 的身份绑定尚未确认'));
  const reads = fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/.account/oidc/pick-webid/').length;
  fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/.account/oidc/pick-webid/').length).toBeGreaterThan(reads));
  await waitFor(() => expect(screen.getByRole('button', { name: '拒绝', exact: true })).toBeTruthy());
  expect(screen.getByRole('button', { name: '换一个账号', exact: true })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('已有 Pod 的身份绑定尚未确认'));
  fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('已有 Pod 的身份绑定尚未确认'));
  bindingsReady = true;
  fireEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
  await waitFor(() => expect((screen.getByRole('button', { name: '批准', exact: true }) as HTMLButtonElement).disabled).toBe(false));
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
