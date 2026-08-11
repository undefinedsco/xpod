import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType, type Controls } from '../context/AuthContextValue';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { createXpodLogoutCoordinator } from '../auth/xpod-logout';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { LoginSelectPage } from './LoginSelectPage';
import { WelcomePage } from './WelcomePage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import { ConsentPage } from './ConsentPage';
import { FirstPodPage } from './FirstPodPage';
import { ProtectedRoute } from '../components/ProtectedRoute';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    accountAuthState: { status: 'anonymous', mode: 'login' },
    authState: { status: 'anonymous', mode: 'login' },
    state: { status: 'anonymous', mode: 'login' },
    ...overrides,
  };
}

function renderWithAuth(
  element: React.ReactNode,
  overrides: Partial<AuthContextType> = {},
  initialEntries: string[] = ['/'],
  xpodAuth: XpodAuthValue | null = null,
) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <XpodAuthContext.Provider value={xpodAuth}>
        <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>
      </XpodAuthContext.Provider>
    </AuthContext.Provider>,
  );
}

function xpodAuthValue(overrides: Partial<XpodAuthValue> = {}): XpodAuthValue {
  const coordinator = createXpodLogoutCoordinator({
    account: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
    webId: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
  });
  return {
    account: {
      accountState: { status: 'authenticated' },
      isLoggedIn: true,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
    routes: [],
    webIdState: { status: 'anonymous' },
    readiness: { dashboard: true, localSettings: true, podSettings: false },
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: coordinator.logout,
    retryLogout: coordinator.retry,
    logoutState: coordinator.getState(),
    logoutCoordinator: coordinator,
    switchAccount: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('CSS identity page controllers', () => {
  it('renders one current-origin Xpod action regardless of advertised Account methods', async () => {
    const controls: Controls = { main: { logins: '/.account/logins/' } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      logins: {
        password: '/.account/login/password/',
        oidc: '/.account/login/oidc/',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const startLogin = vi.fn(async () => undefined);

    renderWithAuth(<LoginSelectPage />, { controls }, ['/'], xpodAuthValue({ startLogin }));

    expect(screen.getByRole('button', { name: /sign in to xpod/i })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('password')).toBeNull();
    expect(screen.queryByText('oidc')).toBeNull();
    expect(screen.queryByText(/cloud|local|external|provider/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /sign in to xpod/i }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
  });

  it('uses the canonical Account credentials view for login and registration', async () => {
    renderWithAuth(<WelcomePage />);
    expect(screen.getByTestId('auth-surface-page')).toBeTruthy();
    expect(screen.getByTestId('account-credentials-scroll')).toBeTruthy();

    cleanup();
    renderWithAuth(<WelcomePage initialIsRegister />);
    await waitFor(() => expect(screen.getByLabelText('Pod name')).toBeTruthy());
  });

  it('uses canonical recovery and reset views while retaining token routes', () => {
    renderWithAuth(<ForgotPasswordPage />);
    expect(screen.getByTestId('password-recovery-scroll')).toBeTruthy();

    cleanup();
    renderWithAuth(<ResetPasswordPage />, {}, ['/.account/login/password/reset/?rid=token']);
    expect(screen.getByTestId('password-reset-scroll')).toBeTruthy();
  });

  it('renders consent and first-storage state through canonical views', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ registered: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderWithAuth(<ConsentPage />, { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } });
    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());

    cleanup();
    const firstPodFetch = vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal('fetch', firstPodFetch);
    renderWithAuth(<FirstPodPage />, { controls: { account: { bindings: '/.account/account/bindings' } } });
    await waitFor(() => expect(screen.getByTestId('storage-bootstrap-scroll')).toBeTruthy());
  });

  it('creates consent storage from the Account username when no WebID is linked yet', async () => {
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
      if (url === '/.account/account/pod/' && init?.method === 'POST') {
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

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create storage' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create storage' }));
    await waitFor(() => expect(podCreate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(podCreate.mock.calls[0]?.[1]?.body))).toEqual({ name: 'alice' });
  });

  it('switches account through the host Xpod coordinator', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ registered: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const accountLogout = vi.fn(async () => undefined);
    const switchAccount = vi.fn(async () => undefined);

    renderWithAuth(
      <ConsentPage />,
      {
        isLoggedIn: true,
        controls: { account: { bindings: '/.account/account/bindings' } },
        logout: accountLogout,
      },
      ['/'],
      xpodAuthValue({ switchAccount }),
    );

    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('/dashboard'));
    expect(accountLogout).not.toHaveBeenCalled();
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ registered: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ client: { client_id: 'client', client_name: 'Client' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pod.example/alice/' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const switchAccount = vi.fn(async () => undefined);

    renderWithAuth(
      <ConsentPage />,
      { isLoggedIn: true, controls: { account: { bindings: '/.account/account/bindings' } } },
      ['/'],
      xpodAuthValue({ switchAccount }),
    );

    await waitFor(() => expect(screen.getByTestId('oidc-consent-scroll')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('/settings/models'));
  });

  it('uses shared restoring and failure views for identity loading states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    renderWithAuth(<ConsentPage />, { isLoggedIn: true });
    expect(screen.getByRole('status').textContent).toContain('Restoring authorization…');

    cleanup();
    renderWithAuth(<FirstPodPage />);
    expect(screen.getByRole('status').textContent).toContain('Restoring storage…');

    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('internal identity response');
    }));
    renderWithAuth(<ConsentPage />, { isLoggedIn: true });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Authorization information could not be loaded. Please try again.'));
    expect(screen.getByRole('alert').tagName).toBe('P');
    expect(screen.queryByText('internal identity response')).toBeNull();
  });

  it('uses the shared failure view for unauthenticated consent prompts', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    renderWithAuth(<ConsentPage />);

    expect(screen.getByRole('alert').tagName).toBe('P');
    expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeTruthy();
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
