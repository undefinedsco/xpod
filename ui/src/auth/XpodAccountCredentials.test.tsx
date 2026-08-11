// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextType, type Controls } from '../context/AuthContextValue';
import { XpodAccountCredentials } from './XpodAccountCredentials';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
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
    accountAuthState: { status: 'anonymous', mode: 'login' },
    authState: { status: 'anonymous', mode: 'login' },
    state: { status: 'anonymous', mode: 'login' },
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
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
}

describe('XpodAccountCredentials', () => {
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
      expect(JSON.parse(String(init?.body))).toEqual({ email: 'person@example.test', password: 'correct horse battery staple' });
      return new Response(JSON.stringify({ authorization: 'account-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials({ refetchControls }, { surface: 'modal', onAuthenticated });
    expect(screen.getByTestId('auth-surface-modal')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Sign in to Xpod' })).toBeTruthy();

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['fetch', 'refetch', 'authenticated']);
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBe('account-token');
    expect(document.cookie).toContain('css-account=account-token');
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
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

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
    [401, 'Invalid email or password.'],
    [403, 'Invalid email or password.'],
    [429, 'Too many attempts. Please try again later.'],
    [500, 'Sign-in failed. Please try again.'],
  ])('shows a safe inline error for HTTP %s without leaking the response body', async (status, message) => {
    const refetchControls = vi.fn(async () => undefined);
    const onAuthenticated = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'internal account details' }), { status })));

    renderCredentials({ refetchControls }, { surface: 'embedded', onAuthenticated });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain(message);
    expect(error.textContent).not.toContain('internal account details');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(refetchControls).not.toHaveBeenCalled();
  });

  it('does not send credentials to a cross-origin password endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controls: Controls = { password: { login: 'https://idp.example/.account/login/password/' } };

    renderCredentials({ controls });
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Sign-in failed. Please try again.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while the CSS login request is pending', async () => {
    let resolveLogin!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderCredentials();
    fillCredentials();
    const submit = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
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
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Sign-in failed. Please try again.');
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(document.cookie).not.toContain('css-account=unverified-token');
  });
});
