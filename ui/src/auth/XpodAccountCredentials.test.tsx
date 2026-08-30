// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType, type Controls } from '../context/AuthContextValue';
import { XpodAccountCredentials } from './XpodAccountCredentials';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.xpodDesktop = undefined;
  document.cookie = 'css-account=; Path=/; Max-Age=0';
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: { password: { login: '/.account/login/password/' } },
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

function renderCredentials(
  overrides: Partial<AuthContextType> = {},
  props: Partial<React.ComponentProps<typeof XpodAccountCredentials>> = {},
) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <XpodAccountCredentials surface="embedded" {...props} />
    </AuthContext.Provider>,
  );
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'person@example.test' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } });
}

describe('XpodAccountCredentials', () => {
  it('uses a compact document card in the Electron workspace', () => {
    window.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };

    renderCredentials({}, { surface: 'modal', presentation: 'compact' });

    const surface = screen.getByTestId('auth-surface-modal');
    const dialog = screen.getByRole('dialog', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBeNull();
    expect(surface.classList.contains('bg-black/50')).toBe(true);
    expect(dialog.getAttribute('data-auth-surface-frame')).toBeNull();
    expect(dialog.className).toMatch(/rounded|shadow/);
    expect(dialog.classList.contains('w-[280px]')).toBe(true);
    expect(dialog.classList.contains('h-[400px]')).toBe(true);
    expect(screen.getByTestId('xpod-login-brand').getAttribute('data-presentation')).toBe('compact');
    expect(screen.queryByText('使用 WebID 登录')).toBeNull();
  });

  it('uses a modal AuthSurface and authenticates through the same-origin CSS password control', async () => {
    const events: string[] = [];
    const refetchControls = vi.fn(async () => {
      events.push('refetch');
    });
    const onAuthenticated = vi.fn(() => {
      events.push('authenticated');
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      events.push('fetch');
      expect(String(input)).toBe(new URL('/.account/login/password/', window.location.origin).href);
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'person@example.test',
        password: 'correct horse battery staple',
        remember: true,
      });
      return new Response(JSON.stringify({ authorization: 'account-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials({ refetchControls }, { surface: 'modal', onAuthenticated });
    expect(screen.getByTestId('auth-surface-modal')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '登录 Xpod' })).toBeTruthy();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['fetch', 'refetch', 'authenticated']);
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBe('account-token');
    expect(document.cookie).toContain('css-account=account-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('authenticates a managed local Xpod through the Cloud Account service', async () => {
    const cloudAccountIndex = 'https://id.undefineds.co/.account/';
    const refetchControls = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://id.undefineds.co/.account/login/password/');
      expect(init?.credentials).toBe('include');
      return new Response(JSON.stringify({ authorization: 'cloud-account-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials({
      idpIndex: cloudAccountIndex,
      controls: { password: { login: '/.account/login/password/' } },
      refetchControls,
    }, { surface: 'modal', onAuthenticated });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(refetchControls).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the current Dashboard path after Account login without router, system, or OIDC navigation', async () => {
    const initialUrl = window.location.href;
    window.history.replaceState(null, '', '/status/overview');
    const dashboardUrl = window.location.href;
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const refetchControls = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn(async () => undefined);
    const retry = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(new URL('/.account/login/password/', window.location.origin).href);
      return new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      renderCredentials({
        controls: {
          password: { login: '/.account/login/password/' },
          oidc: {
            webId: '/.account/login/oidc/',
            consent: '/.account/oidc/consent/',
          },
        },
        hasOidcPending: false,
        refetchControls,
        retry,
      }, { surface: 'modal', onAuthenticated });
      fillCredentials();
      fireEvent.click(screen.getByRole('button', { name: '登录' }));

      await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
      expect(window.location.href).toBe(dashboardUrl);
      expect(window.location.pathname).toBe('/status/overview');
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/.account/oidc/'))).toBe(false);
      expect(refetchControls).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
    } finally {
      pushState.mockRestore();
      replaceState.mockRestore();
      open.mockRestore();
      window.history.replaceState(null, '', initialUrl);
    }
  });

  it('renders as an embedded surface without starting navigation or an OIDC login', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials({}, { surface: 'embedded' });

    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, '邮箱或密码不正确。'],
    [403, '邮箱或密码不正确。'],
    [429, '尝试次数过多，请稍后再试。'],
    [500, '登录失败，请重试。'],
  ])('shows a safe inline error for HTTP %s without leaking the response body', async (status, message) => {
    const refetchControls = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'internal account details' }), { status })));

    renderCredentials({ refetchControls }, { surface: 'embedded', onAuthenticated });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain(message);
    expect(error.textContent).not.toContain('internal account details');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(refetchControls).not.toHaveBeenCalled();
  });

  it('maps an advertised public password endpoint back to the local Xpod Gateway', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controls: Controls = { password: { login: 'https://idp.example/.account/login/password/' } };

    renderCredentials({ controls });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/.account/login/password/',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('prevents duplicate submissions while the CSS login request is pending', async () => {
    let resolveLogin!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials();
    fillCredentials();
    const submit = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement;
    fireEvent.click(submit);
    await waitFor(() => expect(submit.disabled).toBe(true));
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveLogin(new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 }));
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it('keeps the surface open and clears the token when refreshed Account controls remain anonymous', async () => {
    const refetchControls = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ authorization: 'unverified-token' }), { status: 200 })));

    renderCredentials({ refetchControls, isAnonymous: () => true }, { onAuthenticated });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('登录失败，请重试。');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(document.cookie).not.toContain('css-account=unverified-token');
  });
});
