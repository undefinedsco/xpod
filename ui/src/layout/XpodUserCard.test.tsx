import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import { createXpodLogoutCoordinator } from '../auth/xpod-logout';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodUserCard } from './XpodUserCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  document.cookie = 'css-account=; Path=/; Max-Age=0';
});

function runtime(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  const state = overrides.state ?? { status: 'anonymous' };
  return {
    session: { getSnapshot: () => state.status === 'authenticated'
      ? { status: 'authenticated', webId: state.webId }
      : { status: 'anonymous' } } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn() as typeof fetch,
    state,
    webId: state.status === 'authenticated' ? state.webId : undefined,
    podUrl: state.status === 'authenticated' ? state.podUrl : undefined,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

type AuthOverrides = Omit<Partial<XpodAuthValue>, 'account'> & {
  account?: Partial<XpodAuthValue['account']>;
};

function auth(overrides: AuthOverrides = {}): XpodAuthValue {
  const coordinator = createXpodLogoutCoordinator({
    account: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
    webId: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
  });
  const defaults: XpodAuthValue = {
    account: {
      accountState: { status: 'anonymous', mode: 'login' },
      isLoggedIn: false,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      ...overrides.account,
    },
    runtime: runtime(),
    routes: [],
    webIdState: { status: 'anonymous' },
    readiness: { dashboard: false, localSettings: true, podSettings: false },
    selectedStorage: undefined,
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    retryLogout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    logoutState: { status: 'idle' },
    logoutCoordinator: coordinator,
    switchAccount: vi.fn(async () => undefined),
  };
  return {
    ...defaults,
    ...overrides,
    account: { ...defaults.account, ...(overrides.account ?? {}) },
  };
}

function authContext(overrides: Partial<AuthContextType> = {}): AuthContextType {
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

function renderCard(value: XpodAuthValue, solid: XpodSolidRuntimeValue = runtime()) {
  return render(
    <AuthContext.Provider value={authContext({ refetchControls: value.account.refetchControls })}>
      <XpodAuthContext.Provider value={value}>
        <XpodSolidRuntimeContext.Provider value={solid}>
          <XpodUserCard product="dashboard" switchHref="/settings/models" />
        </XpodSolidRuntimeContext.Provider>
      </XpodAuthContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('XpodUserCard', () => {
  test('opens the shared account card from the desktop tray route and clears the trigger when closed', async () => {
    const initialUrl = window.location.href;
    window.history.replaceState(null, '', '/status/overview?account=open');

    try {
      renderCard(auth());

      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(new URLSearchParams(window.location.search).has('account')).toBe(false);
    } finally {
      window.history.replaceState(null, '', initialUrl);
    }
  });

  test('opens a real dialog with embedded Account credentials when anonymous', async () => {
    const value = auth();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderCard(value);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(value.startLogin).not.toHaveBeenCalled();
    expect(value.account.refetchControls).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
  });

  test('shows sanitized Account, WebID, and selected Pod summary without secrets', async () => {
    const secret = 'Bearer super-secret-token';
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      selectedStorage: { webId: 'https://id.example/alice#me', storageUrl: 'https://pod.example/alice/' },
    });
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { displayName: 'Alice', username: 'alice' },
      },
      runtime: solid,
    });
    renderCard(value, solid);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });

    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByText('https://id.example/alice#me')).toBeTruthy();
    expect(screen.getByText('https://pod.example/alice/')).toBeTruthy();
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use a different account/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings/models');
  });

  test('switches to a new Account session through coordinated logout without leaving the card', async () => {
    const accountLogout = vi.fn(async () => undefined);
    const webIdLogout = vi.fn(async () => undefined);
    const coordinator = createXpodLogoutCoordinator({
      account: { logout: accountLogout, verifyAnonymous: () => true },
      webId: { logout: webIdLogout, verifyAnonymous: () => true },
    });
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
    });
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { username: 'alice' },
      },
      runtime: solid,
      logoutCoordinator: coordinator,
    });
    const logout = vi.fn(async () => coordinator.logout());
    value.logout = logout;
    const reset = vi.spyOn(coordinator, 'reset');

    renderCard(value, solid);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use a different account/i }));
    });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(accountLogout).toHaveBeenCalledTimes(1);
    expect(webIdLogout).toHaveBeenCalledTimes(1);
    expect(value.switchAccount).not.toHaveBeenCalled();
    expect(value.startLogin).not.toHaveBeenCalled();
    expect(solid.login).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy();
  });

  test('resets a completed coordinated sign out for a later Account session', async () => {
    const accountLogout = vi.fn(async () => undefined);
    const webIdLogout = vi.fn(async () => undefined);
    const coordinator = createXpodLogoutCoordinator({
      account: { logout: accountLogout, verifyAnonymous: () => true },
      webId: { logout: webIdLogout, verifyAnonymous: () => true },
    });
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
    });
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { username: 'alice' },
      },
      runtime: solid,
      logoutCoordinator: coordinator,
    });
    value.logout = vi.fn(async () => coordinator.logout());
    const reset = vi.spyOn(coordinator, 'reset');

    renderCard(value, solid);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^sign out$/i }));
    });

    expect(accountLogout).toHaveBeenCalledTimes(1);
    expect(webIdLogout).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
  });

  test('keeps the switch flow in logout progress until a partial logout retry completes', async () => {
    let failAccountLogout = true;
    const accountLogout = vi.fn(async () => {
      if (failAccountLogout) {
        failAccountLogout = false;
        throw new Error('temporary account logout failure');
      }
    });
    const webIdLogout = vi.fn(async () => undefined);
    const coordinator = createXpodLogoutCoordinator({
      account: { logout: accountLogout, verifyAnonymous: () => true },
      webId: { logout: webIdLogout, verifyAnonymous: () => true },
    });
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
    });
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { username: 'alice' },
      },
      runtime: solid,
      logoutCoordinator: coordinator,
    });
    value.logout = vi.fn(async () => coordinator.logout());
    value.retryLogout = vi.fn(async () => coordinator.retry());

    renderCard(value, solid);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use a different account/i }));
    });

    expect(screen.getByText(/sign out incomplete/i)).toBeTruthy();
    expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });

    expect(value.retryLogout).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('auth-surface-embedded')).toBeTruthy();
  });

  test('marks the shared identity control as Pod-ready only for an exact open binding', async () => {
    const solid = runtime({
      state: {
        status: 'authenticated',
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
      },
      webId: 'https://id.example/alice#me',
      podUrl: 'https://pod.example/alice/',
      selectedStorage: { webId: 'https://id.example/alice#me', storageUrl: 'https://pod.example/alice/' },
      currentPod: { webId: 'https://id.example/alice#me', podUrl: 'https://pod.example/alice/' } as XpodSolidRuntimeValue['currentPod'],
    });
    const value = auth({
      account: { accountState: { status: 'authenticated' }, isLoggedIn: true, identity: { username: 'alice' } },
      runtime: solid,
    });
    renderCard(value, solid);

    expect(screen.getByTestId('xpod-user-card-trigger').getAttribute('data-pod-ready')).toBe('true');
  });

  test('hides authenticated actions after a partial failure and offers deterministic retry', async () => {
    const retryLogout = vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const));
    const value = auth({
      account: { accountState: { status: 'error', mode: 'login', message: 'unavailable' }, isLoggedIn: false, identity: { username: 'alice' } },
      logoutState: { status: 'error', account: 'error', webId: 'complete' },
      retryLogout,
    });
    renderCard(value, runtime({ state: { status: 'authenticated', webId: 'https://id.example/alice#me' } }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });

    expect(screen.getByText(/sign out incomplete/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use a different account/i })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(retryLogout).toHaveBeenCalledTimes(1);
  });
});
