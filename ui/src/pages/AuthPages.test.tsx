import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthContext, type AuthContextType, type Controls } from '../context/AuthContextValue';
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
) {
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('CSS identity page controllers', () => {
  it('renders advertised Account login methods without provider or deployment choices', async () => {
    const controls: Controls = { main: { logins: '/.account/logins/' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      logins: {
        password: '/.account/login/password/',
        oidc: '/.account/login/oidc/',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    renderWithAuth(<LoginSelectPage />, { controls });

    await waitFor(() => expect(screen.getByTestId('account-login-method-scroll')).toBeTruthy());
    expect(screen.queryByText(/cloud|local|external|provider/i)).toBeNull();
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
