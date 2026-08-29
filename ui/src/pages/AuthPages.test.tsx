import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType, type Controls } from '../context/AuthContextValue';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { LoginSelectPage } from './LoginSelectPage';
import { WelcomePage } from './WelcomePage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import { ConsentPage } from './ConsentPage';
import { FirstPodPage } from './FirstPodPage';
import { IndexPage } from './IndexPage';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { rememberPendingXpodAccountEmail } from '../auth/xpod-remembered-login';
import { xpodConsentErrors, xpodFirstPodErrors } from '../auth/xpod-account-copy';
import { storageBindingKey } from '../auth/xpod-storage-selection';

function resetAuthPageTestState(): void {
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
  resetAuthPageTestState();
});

afterEach(() => {
  resetAuthPageTestState();
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn: false,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: { status: 'anonymous', mode: 'login' },
    ...overrides,
  };
}

function renderWithAuth(
  element: React.ReactNode,
  overrides: Partial<AuthContextType> = {},
  initialEntries: string[] = ['/'],
) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>
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

describe('CSS identity page controllers', () => {
  it('checks the current Xpod storage binding before entering the Account dashboard', async () => {
    function LocationProbe() {
      return <span data-testid="account-index-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><IndexPage /><LocationProbe /></>,
      { isLoggedIn: true, accountState: { status: 'authenticated' } },
      ['/.account/'],
    );

    await waitFor(() => expect(screen.getByTestId('account-index-location').textContent).toBe('/.account/create-pod/'));
  });

  it('skips the redundant Account-method chooser and enters the sole local IdP verification step', async () => {
    const controls: Controls = { html: { password: { login: '/.account/login/password/' } } };

    function LocationProbe() {
      return <span data-testid="login-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><LoginSelectPage /><LocationProbe /></>,
      { controls },
      ['/.account/login/'],
    );

    await waitFor(() => expect(screen.getByTestId('login-location').textContent).toBe('/.account/login/password/'));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/cloud|local|external|provider/i)).toBeNull();
  });

  it('uses the canonical Account credentials view for login and registration', async () => {
    renderWithAuth(<WelcomePage />);
    const page = screen.getByTestId('auth-surface-page');
    expect(page).toBeTruthy();
    expect(page.getAttribute('data-auth-surface-presentation')).toBe('compact');
    expect(page.className).toContain('bg-black/50');
    expect(screen.getByTestId('xpod-login-brand').getAttribute('data-presentation')).toBe('compact');
    expect(page.querySelector('[data-account-credentials-frame="bare"]')).toBeTruthy();
    expect(page.querySelector('[data-account-credentials-frame="card"]')).toBeNull();
    expect(screen.queryByTestId('account-credentials-scroll')).toBeNull();
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '忘记密码？' })).toBeTruthy();
    const email = screen.getByLabelText('邮箱');
    expect(email.closest('form')?.contains(screen.getByLabelText('密码'))).toBe(true);
    expect(email.parentElement?.getAttribute('data-floating-field')).toBe('true');
    expect(email.getAttribute('placeholder')).toBe(' ');
    expect(screen.getAllByRole('heading', { name: '登录' })).toHaveLength(1);

    cleanup();
    renderWithAuth(<WelcomePage initialIsRegister />);
    await waitFor(() => expect(screen.getByLabelText('Pod 名称')).toBeTruthy());
  });

  it('prefills the CSS Account step from the remembered WebID identity hint', () => {
    rememberPendingXpodAccountEmail('alice@example.test', window.localStorage, '/.account/');

    renderWithAuth(<WelcomePage />);

    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('alice@example.test');
  });

  it('does not prefill a remembered Local Account email on the Cloud Account page', () => {
    rememberPendingXpodAccountEmail('test@dev.local', window.localStorage, 'http://127.0.0.1:3000/.account/');

    renderWithAuth(<WelcomePage />, {
      idpIndex: 'https://id.undefineds.co/.account/',
    });

    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('');
  });

  it('fills the native Electron window with a compact Chinese password surface', async () => {
    const desktopBridge = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };
    window.xpodDesktop = desktopBridge;
    globalThis.xpodDesktop = desktopBridge;

    renderWithAuth(<WelcomePage />);
    const page = await screen.findByTestId('auth-surface-page');
    expect(page.getAttribute('data-auth-surface-host')).toBe('window');
    expect(page.getAttribute('data-auth-surface-presentation')).toBe('compact');
    expect(screen.getByTestId('xpod-login-brand').getAttribute('data-presentation')).toBe('compact');
    expect(screen.getByText('使用 WebID 账号')).toBeTruthy();
    expect(screen.getByLabelText('邮箱').getAttribute('placeholder')).toBe(' ');
    expect(page.querySelector('[data-auth-surface-frame="window"]')).toBeTruthy();
    expect(page.querySelector('[data-slot="card"]')).toBeNull();
    expect(page.querySelector('[data-account-credentials-frame="card"]')).toBeNull();
    expect(screen.getByLabelText('邮箱').closest('form')).toBeTruthy();
  });

  it('asks CSS to remember the local Account session for desktop WebID restoration', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'alice@example.test',
        password: 'secret',
        remember: true,
      });
      return new Response(JSON.stringify({ message: 'invalid credentials' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<WelcomePage />, {
      controls: { password: { login: 'https://managed-node.example/.account/login/password/' } },
    });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/.account/login/password/',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByText('邮箱或密码不正确。')).toBeTruthy();
  });

  it('submits managed local Account credentials to the discovered Cloud Account issuer', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'alice@example.test',
        password: 'secret',
        remember: true,
      });
      return new Response(JSON.stringify({ message: 'invalid credentials' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<WelcomePage />, {
      controls: { password: { login: '/.account/login/password/' } },
      idpIndex: 'https://id.undefineds.co/.account/',
    });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'https://id.undefineds.co/.account/login/password/',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByText('邮箱或密码不正确。')).toBeTruthy();
  });

  it('carries the active OIDC provisioning scope through Cloud account registration into first Pod creation', async () => {
    const cloudAccountIndex = 'https://id.undefineds.co/.account/';
    const cloudWebId = 'https://id.undefineds.co/alice/profile/card#me';
    const localStorageRoot = 'https://node.example/';
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      spDomain: 'node.example',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    window.sessionStorage.setItem('provisionCode', provisionCode);
    let webIdReady = false;
    const createPod = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        name: 'alice',
        settings: { provisionCode },
      });
      webIdReady = true;
      return new Response(JSON.stringify({
        webId: cloudWebId,
        podUrl: `${localStorageRoot}alice/`,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/identity/alice') {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url === 'https://id.undefineds.co/.account/account/' && init?.method === 'POST') {
        return new Response(JSON.stringify({ authorization: 'acct-token-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === cloudAccountIndex && !init?.method) {
        return new Response(JSON.stringify({
          controls: {
            password: {
              create: '/.account/login/password/',
              login: '/.account/login/password/',
            },
            account: {
              pod: '/.account/account/pod/',
              webId: '/.account/account/webid/',
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://id.undefineds.co/.account/login/password/' && init?.method === 'POST'
        && (init.headers as Record<string, string> | undefined)?.Authorization) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === 'https://id.undefineds.co/.account/login/password/' && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'invalid credentials' }), { status: 401 });
      }
      if (url === 'https://id.undefineds.co/.account/account/webid/') {
        return new Response(JSON.stringify({
          webIdLinks: webIdReady ? { [cloudWebId]: '/.account/account/webid/1' } : {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'http://localhost:5737/provision/webids') {
        return new Response(JSON.stringify({
          entries: [{
            webId: cloudWebId,
            storageUrl: `${localStorageRoot}alice/`,
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'https://id.undefineds.co/.account/account/pod/' && init?.method === 'POST') {
        return createPod(input, init);
      }
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<WelcomePage initialIsRegister />, {
      controls: {
        password: { login: '/.account/login/password/' },
        account: { create: '/.account/account/' },
      },
      hasOidcPending: true,
      idpIndex: cloudAccountIndex,
    });
    fireEvent.change(await screen.findByLabelText('Pod 名称'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.test' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '创建账号' }));

    await waitFor(() => expect(createPod).toHaveBeenCalledTimes(1));
  });

  it('uses canonical recovery and reset views while retaining token routes', () => {
    renderWithAuth(<ForgotPasswordPage />);
    const recovery = screen.getByTestId('password-recovery-scroll');
    expect(recovery.getAttribute('data-account-auxiliary-frame')).toBe('bare');
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.getByRole('button', { name: '发送重置链接' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回登录' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: '找回密码' })).toHaveLength(1);
    expect(screen.getByText('如果这个邮箱已注册，我们会发送重置链接。')).toBeTruthy();

    cleanup();
    renderWithAuth(<ResetPasswordPage />, {}, ['/.account/login/password/reset/?rid=token']);
    const reset = screen.getByTestId('password-reset-scroll');
    expect(reset.getAttribute('data-account-auxiliary-frame')).toBe('bare');
    expect(screen.getByLabelText('新密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重设密码' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: '重设密码' })).toHaveLength(1);
    expect(screen.getByText('为你的账号选择一个新密码。')).toBeTruthy();
  });

  it('renders consent through canonical views and keeps first-storage preparation automatic', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });
    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());

    cleanup();
    const firstPodFetch = vi.fn(async () => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', firstPodFetch);
    renderWithAuth(<FirstPodPage />);
    expect(screen.getByRole('status').textContent).toContain('正在检查本机存储空间…');
    expect(screen.queryByLabelText('Pod 名称')).toBeNull();
    expect(screen.queryByTestId('storage-bootstrap-scroll')).toBeNull();
  });

  it('renders consent from existing picker bindings without refreshing stale provisioning', async () => {
    const binding = {
      webId: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
    };
    window.__XPOD__ = { authenticating: true, provisionCode: makeProvisionCode({ exp: Math.floor(Date.now() / 1000) - 60 }) };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' }, webId: binding.webId }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [binding] }), { status: 200 });
      }
      if (url === '/provision/status') {
        throw new Error('ConsentPage must not refresh provision code when picker has exact bindings');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { pod: '/.account/account/pod/' } } });

    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
  });

  it('does not prepare consent storage when the picker cannot be loaded', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
      }
      if (url === '/provision/status') {
        throw new Error('ConsentPage must not refresh provision code when picker failed');
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        throw new Error('ConsentPage must not create storage when picker failed');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, {
      isLoggedIn: true,
      controls: { account: { username: 'alice', pod: '/.account/account/pod/' } },
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.bindingsFailed));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
  });

  it('does not prepare consent storage from malformed picker entries', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({
          entries: [
            { webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' },
            { webId: 'https://id.example/bob/profile/card#me' },
          ],
        }), { status: 200 });
      }
      if (url === '/provision/status') {
        throw new Error('ConsentPage must not refresh provision code when picker is malformed');
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        throw new Error('ConsentPage must not create storage when picker is malformed');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, {
      isLoggedIn: true,
      controls: { account: { username: 'alice', pod: '/.account/account/pod/' } },
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodConsentErrors.bindingsFailed));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST',
    )).toBe(false);
  });

  it('automatically prepares first storage from the Account username', async () => {
    const podCreate = vi.fn(async () => new Response(JSON.stringify({
      webId: `${window.location.origin}/alice/profile/card#me`,
      podUrl: `${window.location.origin}/alice/`,
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const refetchControls = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/bindings') {
        return new Response(JSON.stringify({ bindings: [] }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        return podCreate(input, init);
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function LocationProbe() {
      return <span data-testid="first-pod-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><FirstPodPage /><LocationProbe /></>,
      {
        refetchControls,
        controls: {
          account: {
            username: 'alice',
            bindings: '/.account/account/bindings',
            pod: '/.account/account/pod/',
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(podCreate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(podCreate.mock.calls[0]?.[1]?.body))).toEqual({ name: 'alice' });
    expect(screen.queryByLabelText('Pod 名称')).toBeNull();
    expect(screen.queryByTestId('storage-bootstrap-scroll')).toBeNull();
    await waitFor(() => expect(refetchControls).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('first-pod-location').textContent).toBe('/.account/account/'));
  });

  it('derives first storage from the remembered Account email when CSS exposes no username', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    rememberPendingXpodAccountEmail('alice@rc.example', window.localStorage, cloudAccountIndex);
    const podCreate = vi.fn(async () => new Response(JSON.stringify({
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://id.example/alice/',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/bindings') {
        return new Response(JSON.stringify({ bindings: [] }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        return podCreate(input, init);
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(
      <FirstPodPage />,
      {
        idpIndex: cloudAccountIndex,
        isLoggedIn: true,
        controls: {
          account: {
            bindings: '/.account/account/bindings',
            pod: '/.account/account/pod/',
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(podCreate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(podCreate.mock.calls[0]?.[1]?.body))).toEqual({ name: 'alice' });
  });

  it('uses a trusted Cloud Account WebID to create the missing Local Xpod storage', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const cloudWebIdControlUrl = 'https://id.example/.account/account/account-1/web-id/';
    const cloudCreatePodUrl = 'https://id.example/.account/account/account-1/pod/';
    const localStorageRoot = 'https://node.example/';
    const cloudWebId = 'https://id.example/alice/profile/card#me';
    const provisionCode = makeProvisionCode({
      spUrl: localStorageRoot,
      spDomain: 'node.example',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const refetchControls = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({
          managed: true,
          registered: true,
          provisionCode,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === cloudWebIdControlUrl) {
        return new Response(JSON.stringify({
          webIdLinks: { [cloudWebId]: 'https://id.example/.account/web-id/alice/' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `${localStorageRoot}provision/webids`) {
        return new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === cloudCreatePodUrl && init?.method === 'POST') {
        return new Response(JSON.stringify({
          webId: cloudWebId,
          podUrl: `${localStorageRoot}alice/`,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function LocationProbe() {
      return <span data-testid="managed-first-pod-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><FirstPodPage /><LocationProbe /></>,
      {
        idpIndex: cloudAccountIndex,
        isLoggedIn: true,
        refetchControls,
        controls: {
          account: {
            webId: cloudWebIdControlUrl,
            pod: cloudCreatePodUrl,
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      cloudCreatePodUrl,
      expect.objectContaining({ method: 'POST' }),
    ));
    const createCall = fetchMock.mock.calls.find(([input, init]) => String(input) === cloudCreatePodUrl && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      name: 'alice',
      settings: { provisionCode },
    });
    await waitFor(() => expect(refetchControls).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('managed-first-pod-location').textContent).toBe('/.account/account/'));
  });

  it('enters consent from existing OIDC picker bindings without refreshing stale first-pod provisioning', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const cloudCreatePodUrl = 'https://id.example/.account/account/account-1/pod/';
    const selectedBinding = {
      webId: 'https://id.example/alice/profile/card#me',
      storageUrl: 'https://acceptance-local.nodes.acceptance.test/accept-web-mtcam75t/',
    };
    const expiredProvisionCode = makeProvisionCode({
      spUrl: 'https://acceptance-local.nodes.acceptance.test/',
      serviceAccessToken: 'expired-service-token',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    window.__XPOD__ = { authenticating: true, provisionCode: expiredProvisionCode };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://id.example/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [selectedBinding] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/provision/status') {
        throw new Error('FirstPod must not refresh provision code before using picker bindings');
      }
      if (url === cloudCreatePodUrl && init?.method === 'POST') {
        throw new Error('FirstPod must not create when picker already has an exact binding');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function LocationProbe() {
      return <span data-testid="first-pod-existing-binding-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><FirstPodPage /><LocationProbe /></>,
      {
        idpIndex: cloudAccountIndex,
        hasOidcPending: true,
        isLoggedIn: true,
        controls: {
          account: {
            username: 'alice',
            pod: cloudCreatePodUrl,
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(screen.getByTestId('first-pod-existing-binding-location').textContent).toBe('/.account/oidc/consent/'));
    expect(fetchMock).toHaveBeenCalledWith('https://id.example/.account/oidc/pick-webid/', expect.objectContaining({
      credentials: 'include',
    }));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === cloudCreatePodUrl && init?.method === 'POST')).toBe(false);
  });

  it('does not create first storage when the OIDC picker cannot be loaded', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const cloudCreatePodUrl = 'https://id.example/.account/account/account-1/pod/';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://id.example/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
      }
      if (url === '/provision/status') {
        throw new Error('FirstPod must not refresh provision code when picker failed');
      }
      if (url === cloudCreatePodUrl && init?.method === 'POST') {
        throw new Error('FirstPod must not create when picker failed');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(
      <FirstPodPage />,
      {
        idpIndex: cloudAccountIndex,
        hasOidcPending: true,
        isLoggedIn: true,
        controls: {
          account: {
            username: 'alice',
            pod: cloudCreatePodUrl,
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === cloudCreatePodUrl && init?.method === 'POST')).toBe(false);
  });

  it.each([
    {
      name: 'missing storageUrl',
      entries: [{ webId: 'https://id.example/alice/profile/card#me' }],
    },
    {
      name: 'invalid URL mixed with a valid binding',
      entries: [
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://acceptance-local.nodes.acceptance.test/alice/',
        },
        {
          webId: 'https://id.example/bob/profile/card#me',
          storageUrl: 'not a url',
        },
      ],
    },
  ])('does not create first storage when the OIDC picker returns malformed $name entries', async ({ entries }) => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const cloudCreatePodUrl = 'https://id.example/.account/account/account-1/pod/';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://id.example/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/provision/status') {
        throw new Error('FirstPod must not refresh provision code when picker entries are malformed');
      }
      if (url === cloudCreatePodUrl && init?.method === 'POST') {
        throw new Error('FirstPod must not create when picker entries are malformed');
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(
      <FirstPodPage />,
      {
        idpIndex: cloudAccountIndex,
        hasOidcPending: true,
        isLoggedIn: true,
        controls: {
          account: {
            username: 'alice',
            pod: cloudCreatePodUrl,
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(xpodFirstPodErrors.checkFailed));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/provision/status')).toBe(false);
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === cloudCreatePodUrl && init?.method === 'POST')).toBe(false);
  });

  it('creates first storage for OIDC only after the picker succeeds with explicit empty bindings', async () => {
    const cloudAccountIndex = 'https://id.example/.account/';
    const cloudCreatePodUrl = 'https://id.example/.account/account/account-1/pod/';
    const localStorageRoot = 'https://acceptance-local.nodes.acceptance.test/';
    const cloudWebId = 'https://id.example/accept-web-mtcam75t/profile/card#me';
    const provisionCode = makeProvisionCode({
      spUrl: localStorageRoot,
      spDomain: 'acceptance-local.nodes.acceptance.test',
      serviceAccessToken: 'service-token',
      serviceAccessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    let created = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://id.example/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({
          webIds: [cloudWebId],
          entries: created
            ? [{ webId: cloudWebId, storageUrl: `${localStorageRoot}accept-web-mtcam75t/` }]
            : [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/provision/status') {
        return new Response(JSON.stringify({
          managed: true,
          registered: true,
          provisionCode,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `${localStorageRoot}provision/webids`) {
        throw new Error('FirstPod must not query scoped WebIDs after picker returned explicit empty bindings');
      }
      if (url === cloudCreatePodUrl && init?.method === 'POST') {
        created = true;
        return new Response(JSON.stringify({
          webId: cloudWebId,
          podUrl: `${localStorageRoot}accept-web-mtcam75t/`,
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function LocationProbe() {
      return <span data-testid="first-pod-empty-picker-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <><FirstPodPage /><LocationProbe /></>,
      {
        idpIndex: cloudAccountIndex,
        hasOidcPending: true,
        isLoggedIn: true,
        controls: {
          account: {
            pod: cloudCreatePodUrl,
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      cloudCreatePodUrl,
      expect.objectContaining({ method: 'POST' }),
    ));
    const createCall = fetchMock.mock.calls.find(([input, init]) => String(input) === cloudCreatePodUrl && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      name: 'accept-web-mtcam75t',
      settings: { provisionCode },
    });
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `${localStorageRoot}provision/webids`)).toBe(false);
    await waitFor(() => expect(screen.getByTestId('first-pod-empty-picker-location').textContent).toBe('/.account/oidc/consent/'));
  });

  it('shows a local Cloud-route recovery message when first storage creation cannot reach the managed SP', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: true, provisionCode: 'fresh-provision-code' }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/bindings') {
        return new Response(JSON.stringify({ bindings: [] }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'fetch failed' }), { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(
      <FirstPodPage />,
      {
        controls: {
          account: {
            username: 'alice',
            bindings: '/.account/account/bindings',
            pod: '/.account/account/pod/',
          },
        },
      },
      ['/.account/create-pod/'],
    );

    await waitFor(() => {
      expect(screen.getByText('本机 Xpod 还没有和 Cloud 打通，暂时不能准备存储空间。请保持 Xpod 运行，稍后重试。')).toBeTruthy();
    });
  });

  it('automatically creates consent storage from the Account username before showing WebID consent', async () => {
    const podCreate = vi.fn(async () => new Response(JSON.stringify({
      webId: 'https://app.example/alice/profile/card#me',
      podUrl: 'https://app.example/alice/',
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === 'https://app.example/.account/account/bindings') {
        return new Response(JSON.stringify({ bindings: [] }), { status: 200 });
      }
      if (new URL(url, window.location.origin).pathname === '/.account/account/pod/' && init?.method === 'POST') {
        return podCreate(input, init);
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(
      <ConsentPage />,
      {
        isLoggedIn: true,
        controls: {
          account: {
            username: 'alice',
            pod: '/.account/account/pod/',
            bindings: '/.account/account/bindings',
          },
        },
      },
    );

    await waitFor(() => expect(podCreate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: '创建存储空间' })).toBeNull();
    expect(JSON.parse(String(podCreate.mock.calls[0]?.[1]?.body))).toEqual({ name: 'alice' });
  });

  it('switches account through the native CSS Account session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const accountLogout = vi.fn(async () => undefined);

    renderWithAuth(
      <ConsentPage />,
      {
        isLoggedIn: true,
        controls: { account: { bindings: '/.account/account/bindings' } },
        logout: accountLogout,
      },
      ['/'],
    );

    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '换一个账号' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
  });

  it('preserves a normalized pending product return path when switching account', async () => {
    window.sessionStorage.clear();
    const transactionStore = createXpodLoginTransactionStore({
      storage: window.sessionStorage,
      origin: window.location.origin,
    });
    transactionStore.begin({
      id: 'return-to-test-1234',
      route: createXpodLoginRoute(window.location),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/settings/models',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/.account/oidc/consent/') {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/') {
        return new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const accountLogout = vi.fn(async () => undefined);

    renderWithAuth(
      <ConsentPage />,
      { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } }, logout: accountLogout },
      ['/'],
    );

    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '换一个账号' }));
    await waitFor(() => expect(accountLogout).toHaveBeenCalledTimes(1));
    expect(transactionStore.readSinglePending()?.returnTo).toBe('/settings/models');
  });

  it('auto-submits consent for a same-origin pending transaction with one exact ready Pod binding', async () => {
    window.sessionStorage.clear();
    const binding = {
      webId: `${window.location.origin}/alice/profile/card#me`,
      storageUrl: `${window.location.origin}/alice/`,
    };
    const transactionStore = createXpodLoginTransactionStore({
      storage: window.sessionStorage,
      origin: window.location.origin,
    });
    transactionStore.begin({
      id: 'auto-consent-test-1234',
      route: createXpodLoginRoute(window.location),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/dashboard',
      selectedStorage: binding,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (url === '/.account/oidc/consent/' && !init?.method) {
        return new Response(JSON.stringify({
          client: { client_id: 'client', client_name: 'Client' },
          webId: binding.webId,
        }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && !init?.method) {
        return new Response(JSON.stringify({ entries: [binding] }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && init?.method === 'POST') {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === '/.account/oidc/consent/' && init?.method === 'POST') {
        return new Promise<Response>(() => undefined);
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/.account/oidc/consent/',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  });

  it('asks CSS to remember the selected WebID before completing consent', async () => {
    window.sessionStorage.clear();
    const binding = {
      webId: `${window.location.origin}/alice/profile/card#me`,
      storageUrl: `${window.location.origin}/alice/`,
    };
    const transactionStore = createXpodLoginTransactionStore({
      storage: window.sessionStorage,
      origin: window.location.origin,
    });
    transactionStore.begin({
      id: 'remember-webid-test-1234',
      route: createXpodLoginRoute(window.location),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/dashboard',
      selectedStorage: binding,
    });
    const pickWebId = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        webId: binding.webId,
        remember: true,
      });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') return new Response(JSON.stringify({ registered: false }), { status: 200 });
      if (url === '/.account/oidc/consent/' && !init?.method) {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && !init?.method) {
        return new Response(JSON.stringify({ entries: [binding] }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && init?.method === 'POST') return pickWebId(input, init);
      if (url === '/.account/oidc/consent/' && init?.method === 'POST') return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });

    await waitFor(() => expect(pickWebId).toHaveBeenCalledTimes(1));
  });

  it('binds and auto-submits an unambiguous one-Pod product transaction', async () => {
    window.sessionStorage.clear();
    const binding = {
      webId: `${window.location.origin}/alice/profile/card#me`,
      storageUrl: `${window.location.origin}/alice/`,
    };
    const transactionStore = createXpodLoginTransactionStore({
      storage: window.sessionStorage,
      origin: window.location.origin,
    });
    transactionStore.begin({
      id: 'auto-bind-consent-1234',
      route: createXpodLoginRoute(window.location),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/status/overview',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') return new Response(JSON.stringify({ registered: false }), { status: 200 });
      if (url === '/.account/oidc/consent/' && !init?.method) {
        return new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' }, webId: binding.webId }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && !init?.method) {
        return new Response(JSON.stringify({ entries: [binding] }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && init?.method === 'POST') {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url === '/.account/oidc/consent/' && init?.method === 'POST') return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/.account/oidc/consent/',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(transactionStore.readSinglePending()?.selectedStorage).toEqual(binding);
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
  });

  it('keeps explicit consent when a pending transaction has more than one exact Pod binding available', async () => {
    window.sessionStorage.clear();
    const selectedBinding = {
      webId: `${window.location.origin}/alice/profile/card#me`,
      storageUrl: `${window.location.origin}/alice/`,
    };
    const otherBinding = {
      webId: `${window.location.origin}/bob/profile/card#me`,
      storageUrl: `${window.location.origin}/bob/`,
    };
    const transactionStore = createXpodLoginTransactionStore({
      storage: window.sessionStorage,
      origin: window.location.origin,
    });
    transactionStore.begin({
      id: 'multi-consent-test-123',
      route: createXpodLoginRoute(window.location),
      authorizationSurface: 'redirect',
      discovery: 'strict',
      returnTo: '/dashboard',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/provision/status') {
        return new Response(JSON.stringify({ registered: false }), { status: 200 });
      }
      if (url === '/.account/oidc/consent/' && !init?.method) {
        return new Response(JSON.stringify({
          client: { client_id: 'client', client_name: 'Client' },
          webId: selectedBinding.webId,
        }), { status: 200 });
      }
      if (url === '/.account/oidc/pick-webid/' && !init?.method) {
        return new Response(JSON.stringify({ entries: [selectedBinding, otherBinding] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });

    const bindingSelector = await screen.findByLabelText('身份与存储空间');
    const approve = screen.getByRole('button', { name: '批准' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(bindingSelector, { target: { value: storageBindingKey(otherBinding) } });
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/.account/oidc/consent/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses shared restoring and failure views for identity loading states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    renderWithAuth(<ConsentPage />, { isLoggedIn: true });
    expect(screen.getByRole('status').textContent).toContain('正在恢复授权…');

    cleanup();
    renderWithAuth(<FirstPodPage />);
    expect(screen.getByRole('status').textContent).toContain('正在检查本机存储空间…');

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('internal identity response');
    }));
    renderWithAuth(<ConsentPage />, { isLoggedIn: true });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法加载授权信息，请重试。'));
    expect(screen.getByRole('alert').tagName).toBe('P');
    expect(screen.queryByText('internal identity response')).toBeNull();
  });

  it('uses the shared failure view for unauthenticated consent prompts', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    renderWithAuth(<ConsentPage />);

    expect(screen.getByRole('alert').tagName).toBe('P');
    expect(screen.getByRole('button', { name: '去登录' })).toBeTruthy();
  });

  it('guards only the Account domain and follows the advertised Account login control', async () => {
    function LocationProbe() {
      return <span data-testid="guard-location">{useLocation().pathname}</span>;
    }

    renderWithAuth(
      <>
        <ProtectedRoute><span data-testid="protected">private</span></ProtectedRoute>
        <LocationProbe />
      </>,
      { controls: { html: { password: { login: '/.account/login/custom/' } } } },
    );

    await waitFor(() => expect(screen.getByTestId('guard-location').textContent).toBe('/.account/login/custom/'));
    expect(screen.queryByText(/cloud|local|external|provider/i)).toBeNull();
  });
});
