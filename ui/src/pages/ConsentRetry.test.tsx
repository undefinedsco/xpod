// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { xpodConsentErrors } from '../auth/xpod-account-copy';
import { storageBindingKey } from '../auth/xpod-storage-selection';
import { FIRST_POD_BINDING_MISSING } from '../utils/consent-first-pod';
import { peekConsentContinuation } from '../utils/safe-continuation';
import { ConsentPage } from './ConsentPage';
import { FirstPodPage } from './FirstPodPage';

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

/** jsdom's location is read-only; swap in a facade the page reads and navigates. */
function installLocation(pathname: string) {
  const browserWindow = window;
  const navigation = {
    href: `${browserWindow.location.origin}${pathname}`,
    origin: browserWindow.location.origin,
    pathname,
    assign: vi.fn(),
  };
  const facade = Object.create(browserWindow);
  Object.defineProperty(facade, 'location', { value: navigation });
  vi.stubGlobal('window', facade);
  return navigation;
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderAt(path: string, page: 'consent' | 'create-pod', overrides: Partial<AuthContextType> = {}) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        {page === 'consent' ? <ConsentPage /> : <FirstPodPage />}
      </MemoryRouter>
    </AuthContext.Provider>,
  );
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

  it('does not create storage from the authorization page without an explicit click', async () => {
    const createPod = vi.fn(async () => new Response(JSON.stringify({ pods: {} }), { status: 200 }));
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

    // 缺存储时授权页说明原因并给出"创建 / 前往 Pod 管理 / 拒绝"三个出口；
    // 加载本身不创建任何资源，创建只发生在用户显式点击之后。
    await screen.findByRole('button', { name: '创建并继续' });
    await screen.findByRole('button', { name: '存到边缘设备（打开账号页）' });
    expect(createPod).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input, init]) =>
      requestPath(input) === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
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

    fireEvent.change(await screen.findByLabelText('用哪个 WebID 登录？', { selector: 'select' }), {
      target: { value: storageBindingKey(selectedBinding) },
    });
    fireEvent.click(screen.getByRole('button', { name: '允许' }));

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
  fireEvent.click(await screen.findByRole('checkbox', { name: '以后不再询问' }));
  fireEvent.click(screen.getByRole('button', { name: '允许' }));
  fireEvent.click(await screen.findByRole('button', { name: '返回授权' }));
  expect((await screen.findByRole('checkbox', { name: '以后不再询问' }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('button', { name: '允许' })).toBeTruthy();
  expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(1);
});

it('retries a failed manual approval by refreshing interaction state before a new explicit approval', async () => {
  const fetchMock = mockFailedConsent();
  renderConsentPage();
  fireEvent.click(await screen.findByRole('button', { name: '允许' }));
  const retry = await screen.findByRole('button', { name: '重试' });
  const before = fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === '/.account/oidc/consent/' && !init?.method).length;
  fireEvent.click(retry);
  await screen.findByRole('button', { name: '允许' });
  expect(fetchMock.mock.calls.filter(([input, init]) => requestPath(input) === '/.account/oidc/consent/' && !init?.method)).toHaveLength(before + 1);
  expect(mutationCount(fetchMock, '/.account/oidc/consent/')).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '允许' }));
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
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull();
  } finally { window.history.replaceState({}, '', '/'); }
});

it('does not create a replacement for ownerless existing storage', async () => {
  const uid = 'ownerless-retry';
  const interaction = `/.account/interaction/${uid}`;
  const consentPath = `${interaction}/oidc/consent/`;
  const pickPath = `${interaction}/oidc/pick-webid/`;
  const createPath = `${interaction}/create-pod/`;
  const accountId = 'alice';
  const accountBase = `https://id.example/.account/account/${accountId}/`;
  // 权威 Account 控制：id 与所有 account-scoped 路由都指向同一个真实 Account。
  const accountControls = {
    account: {
      id: accountId,
      username: 'different-name',
      pod: `${accountBase}pod/`,
      bindings: `${accountBase}bindings/`,
    },
  };
  // 账号权威清单里已有 Pod，但该 WebID 没有可用绑定。
  const ownerlessInventory = { pods: { 'https://storage.example/old-name/': '/.account/pod/id' } };
  const binding = { webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://storage.example/alice/' };

  // 1) 缺 Pod 的授权页本身只读：点击只把"真实 Account id + 精确 UID + 同源原
  //    ConsentURL"的一次性任务交给同 UID 轻量创建页，不在 Consent 内 prepare/POST。
  const consentNavigation = installLocation(consentPath);
  const consentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    if (path === consentPath) return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }));
    if (path === pickPath) return new Response(JSON.stringify({ entries: [] }));
    if (path.endsWith('/pod/')) return new Response(JSON.stringify(ownerlessInventory));
    if (path.endsWith('/bindings/')) return new Response(JSON.stringify({ bindings: [] }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', consentFetch);

  renderAt(consentPath, 'consent', { controls: accountControls });

  fireEvent.click(await screen.findByRole('button', { name: '创建并继续' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(createPath));
  const task = peekConsentContinuation({ accountId });
  expect(task?.kind).toBe('consent');
  expect(task?.interaction).toBe(interaction);
  expect(task?.returnTo).toBe(consentPath);
  expect(consentFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(consentNavigation.assign).not.toHaveBeenCalled();

  // 2) 轻量创建页显式 submit 时，共享守卫必须挡下"账号已有 Pod 却无绑定"的替代
  //    创建：只读清单、无 POST，把用户交回权威绑定重读出口。
  cleanup();
  vi.unstubAllGlobals();
  installLocation(createPath);
  const createFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    if (path === consentPath) return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }));
    if (path.endsWith('/pod/')) return new Response(JSON.stringify(ownerlessInventory));
    if (path.endsWith('/bindings/')) return new Response(JSON.stringify({ bindings: [] }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', createFetch);

  renderAt(createPath, 'create-pod', { controls: accountControls, idpIndex: 'https://id.example/.account/' });

  fireEvent.click(await screen.findByRole('button', { name: '创建 Pod 并继续授权' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(FIRST_POD_BINDING_MISSING));
  expect(createFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(screen.getByTestId('location').textContent).toBe(createPath);

  // 3) 绑定就绪后重新进入该 interaction 才能继续批准（权威绑定与 owner 由 Pod 管理侧修复）。
  cleanup();
  vi.unstubAllGlobals();
  installLocation(consentPath);
  const readyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input);
    if (init?.method === 'POST') throw new Error('Unexpected mutation');
    if (path === consentPath) return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }));
    if (path === pickPath) return new Response(JSON.stringify({ entries: [binding] }));
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', readyFetch);
  renderAt(consentPath, 'consent', { controls: accountControls });
  await waitFor(() => expect((screen.getByRole('button', { name: '允许', exact: true }) as HTMLButtonElement).disabled).toBe(false));
  expect(readyFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
