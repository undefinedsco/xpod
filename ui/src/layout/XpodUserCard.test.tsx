// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import { createXpodLogoutCoordinator } from '../auth/xpod-logout';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { accountCardPosition } from './account-card-position';
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
    switchAccount: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
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
    ...overrides,
  };
}

function renderCard(value: XpodAuthValue, solid: XpodSolidRuntimeValue = runtime()) {
  return render(
    <AuthContext.Provider value={authContext({ refetchControls: value.account.refetchControls })}>
      <XpodAuthContext.Provider value={value}>
        <XpodSolidRuntimeContext.Provider value={solid}>
          <XpodUserCard />
        </XpodSolidRuntimeContext.Provider>
      </XpodAuthContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('XpodUserCard', () => {
  test('positions the desktop profile card beside the top-left avatar trigger', () => {
    expect(accountCardPosition({
      left: 12,
      right: 48,
      top: 8,
      bottom: 44,
    }, 960, 720)).toMatchObject({
      left: 60,
      top: 8,
      width: 360,
    });
  });

  test('does not render a second account or login entry inside the anonymous product shell', () => {
    const initialUrl = window.location.href;
    window.history.replaceState(null, '', '/status/overview?account=open');

    try {
      renderCard(auth());

      expect(screen.queryByTestId('xpod-user-card-trigger')).toBeNull();
      expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Xpod account' })).toBeNull();
      expect(window.location.pathname + window.location.search).toBe('/status/overview');
    } finally {
      window.history.replaceState(null, '', initialUrl);
    }
  });

  test('presents an authenticated person as a consumer profile card instead of a SaaS status panel', async () => {
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
      currentPod: {
        webId: 'https://id.example/alice#me',
        podUrl: 'https://pod.example/alice/',
        database: {},
        collections: 'ready',
      } as XpodSolidRuntimeValue['currentPod'],
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
    expect(screen.getByTestId('xpod-profile-avatar').className).toContain('h-20');
    expect(screen.getByText('Xpod ID')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText('Pod connected')).toBeTruthy();
    expect(screen.getByText('alice Pod')).toBeTruthy();
    expect(screen.getByText(/Personal Pod · pod\.example/)).toBeTruthy();
    expect(screen.queryByText('https://id.example/alice#me')).toBeNull();
    expect(screen.queryByText('https://pod.example/alice/')).toBeNull();
    expect(screen.queryByText('WebID')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy Xpod ID' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /switch account/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pod settings' }).getAttribute('href')).toBe('/settings/pod');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  test('uses the remembered Account email when CSS controls do not expose a display name', async () => {
    window.localStorage.setItem('xpod.pending-account-email.v1', 'alice@example.test');
    const value = auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: undefined,
      },
    });
    renderCard(value);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu for alice/i }));
    });

    expect(screen.getByRole('heading', { name: 'alice' })).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Xpod account' })).toBeNull();
  });

  test('switches accounts through coordinated logout and lets the product gate own the next login', async () => {
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
      fireEvent.click(screen.getByRole('button', { name: /switch account/i }));
    });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(accountLogout).toHaveBeenCalledTimes(1);
    expect(webIdLogout).toHaveBeenCalledTimes(1);
    expect(value.switchAccount).not.toHaveBeenCalled();
    expect(value.startLogin).not.toHaveBeenCalled();
    expect(solid.login).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
    expect(screen.queryByRole('region', { name: 'alice' })).toBeNull();
    expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
  });

  test('copies the public Xpod ID and exposes deterministic success or failure feedback', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const solid = runtime({
      state: { status: 'authenticated', webId: 'https://id.example/alice#me', podUrl: 'https://pod.example/alice/' },
      webId: 'https://id.example/alice#me',
    });
    renderCard(auth({
      account: {
        accountState: { status: 'authenticated' },
        isLoggedIn: true,
        identity: { username: 'alice', webId: 'https://id.example/alice#me' },
      },
      runtime: solid,
    }), solid);
    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));

    fireEvent.click(await screen.findByRole('button', { name: 'Copy Xpod ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://id.example/alice#me'));
    expect(screen.getByRole('status').textContent).toBe('Copied');

    writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Xpod ID' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copy failed'));
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
      fireEvent.click(screen.getByRole('button', { name: /switch account/i }));
    });

    expect(screen.getByText(/sign out incomplete/i)).toBeTruthy();
    expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });

    expect(value.retryLogout).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({ status: 'idle' });
    expect(screen.queryByRole('region', { name: 'alice' })).toBeNull();
    expect(screen.queryByTestId('auth-surface-embedded')).toBeNull();
  });

  test('dismisses the account card on Escape and outside pointer interaction', async () => {
    const solid = runtime({
      state: { status: 'authenticated', webId: 'https://id.example/alice#me', podUrl: 'https://pod.example/alice/' },
    });
    renderCard(auth({
      account: { accountState: { status: 'authenticated' }, isLoggedIn: true, identity: { username: 'alice' } },
      runtime: solid,
    }), solid);
    const trigger = screen.getByRole('button', { name: /open account menu/i });

    fireEvent.click(trigger);
    const card = await screen.findByRole('region', { name: 'alice' });
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'alice' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('region', { name: 'alice' })).toBeTruthy());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('region', { name: 'alice' })).toBeNull();
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
    await act(async () => {
      renderCard(value, solid);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('xpod-user-card-trigger').getAttribute('data-pod-ready')).toBe('true');
  });

  test('hides authenticated actions after a partial failure and offers deterministic retry', async () => {
    const retryLogout = vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const));
    const value = auth({
      account: { accountState: { status: 'error', mode: 'login', message: 'unavailable' }, isLoggedIn: false, identity: { username: 'alice' } },
      logoutState: { status: 'error', account: 'error', webId: 'complete' },
      retryLogout,
    });
    renderCard(value, runtime({
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    });
    await waitFor(() => expect(screen.getByText(/sign out incomplete/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /switch account/i })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });
    expect(retryLogout).toHaveBeenCalledTimes(1);
  });
});
