// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from './XpodSolidRuntime';
import { XpodSolidRuntimeContext } from './XpodSolidRuntime';
import { WebIdAuthBoundary } from './WebIdAuthBoundary';
import { logoutXpodProduct } from '../auth/xpod-product-logout';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { createXpodLoginTransactionStore } from '../auth/xpod-login-transaction';
import { createXpodLoginRoute } from '../auth/xpod-login-route';
import { XPOD_REMEMBERED_LOGIN_KEY } from '../auth/xpod-remembered-login';

const webId = `${window.location.origin}/alice/profile/card#me`;
const podUrl = `${window.location.origin}/alice/`;

function runtime(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  return {
    session: { getSnapshot: () => ({ status: 'anonymous' }) } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn() as typeof fetch,
    state: { status: 'anonymous' },
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as XpodSolidRuntimeValue;
}

function renderBoundary(
  value: XpodSolidRuntimeValue,
  props: Partial<React.ComponentProps<typeof WebIdAuthBoundary>> = {},
  account: AuthContextType | null = null,
) {
  return render(
    <AuthContext.Provider value={account}><XpodSolidRuntimeContext.Provider value={value}>
      <WebIdAuthBoundary {...props}><span data-testid="protected">ready</span></WebIdAuthBoundary>
    </XpodSolidRuntimeContext.Provider></AuthContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  window.xpodDesktop = undefined;
});

describe('WebIdAuthBoundary', () => {
  test('returns a failed login to manual entry without retrying or logging out', async () => {
    const value = runtime({ state: { status: 'error', error: new Error('offline') } });
    renderBoundary(value, { autoStart: true });
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    expect(window.localStorage.getItem('xpod.auth.login-cancelled')).toBe('1');
    expect(value.login).not.toHaveBeenCalled();
    expect(value.logout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('cancels only the pending login and persists manual recovery until explicitly continued', async () => {
    window.history.replaceState(null, '', '/ai-connections?xpod-login=cancelled');
    const store = createXpodLoginTransactionStore({ origin: window.location.origin });
    store.begin({ id: 'cancel-this-login', route: createXpodLoginRoute(window.location), authorizationSurface: 'redirect', discovery: 'strict' });
    window.localStorage.setItem('unrelated-session', 'preserve');
    const value = runtime();
    const first = renderBoundary(value, { autoStart: true });
    expect(store.readSinglePending()).toBeUndefined();
    expect(value.login).not.toHaveBeenCalled();
    expect(value.logout).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('unrelated-session')).toBe('preserve');
    expect(window.location.search).not.toContain('xpod-login');
    first.unmount();
    renderBoundary(value, { autoStart: true });
    expect(value.login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(value.login).toHaveBeenCalledTimes(1));
    expect(store.readSinglePending()?.id).not.toBe('cancel-this-login');
    expect(window.localStorage.getItem('xpod.auth.login-cancelled')).toBeNull();
  });

  test('switches with standard login for issuers that do not advertise account selection, without silent restore', async () => {
    window.history.replaceState(null, '', '/ai-connections?xpod-login=switch');
    const initialize = vi.fn(async () => ({ status: 'anonymous' as const }));
    const login = vi.fn(async () => undefined);
    const value = runtime({ state: { status: 'loading' }, session: { initialize } as never, login });
    render(<StrictMode><XpodSolidRuntimeContext.Provider value={value}><WebIdAuthBoundary autoStart><span>protected</span></WebIdAuthBoundary></XpodSolidRuntimeContext.Provider></StrictMode>);
    await waitFor(() => expect(initialize).toHaveBeenCalledWith({ restorePreviousSession: false }));
    await waitFor(() => expect(login).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'login' })));
    expect(new URL(window.location.href).searchParams.has('xpod-login')).toBe(false);
    expect(window.localStorage.getItem('xpod.auth.login-cancelled')).toBeNull();
  });

  test('recovery suppresses SDK silent restoration without logging out a valid runtime', async () => {
    window.history.replaceState(null, '', '/ai-connections?xpod-login=cancelled');
    const initialize = vi.fn(async () => ({ status: 'anonymous' as const }));
    const first = renderBoundary(runtime({ state: { status: 'loading' }, session: { initialize } as never }), { autoStart: true });
    await waitFor(() => expect(initialize).toHaveBeenCalledWith({ restorePreviousSession: false }));
    first.unmount();
    const value = runtime({ state: { status: 'authenticated', webId, podUrl }, webId, podUrl,
      selectedStorage: { webId, storageUrl: podUrl }, currentPod: { webId, podUrl } as never });
    renderBoundary(value, { autoStart: true });
    expect(screen.getByTestId('protected')).toBeTruthy();
    expect(value.logout).not.toHaveBeenCalled();
    expect(value.login).not.toHaveBeenCalled();
  });

  test('starts only the Inrupt WebID flow when anonymous', async () => {
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ login }));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('auto-starts the single WebID flow once when the Xpod product route is entered', async () => {
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ login }), { autoStart: true });

    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('restores the previous Inrupt session before auto-starting login', async () => {
    const initialize = vi.fn(async () => ({ status: 'anonymous' as const }));
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({
      session: {
        getSnapshot: () => ({ status: 'initializing' as const }),
        initialize,
      } as XpodSolidRuntimeValue['session'],
      state: { status: 'loading' },
      login,
    }), { autoStart: true });

    await waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    expect(initialize).toHaveBeenCalledWith({ restorePreviousSession: true });
    expect(login).not.toHaveBeenCalled();
  });

  test('uses the native window itself as the WebID gate', () => {
    window.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };

    renderBoundary(runtime());

    const surface = screen.getByTestId('auth-surface-page');
    const frame = screen.getByRole('region', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(frame.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(frame.classList.contains('w-full')).toBe(true);
    expect(frame.classList.contains('h-full')).toBe(true);
    expect(window.xpodDesktop.setWindowMode).toHaveBeenCalledWith('auth');
  });

  test('renders Pod-backed content after the WebID runtime opens storage', () => {
    renderBoundary(runtime({
      state: { status: 'authenticated', webId, podUrl },
      webId,
      podUrl,
      selectedStorage: { webId, storageUrl: podUrl },
      currentPod: { webId, podUrl } as XpodSolidRuntimeValue['currentPod'],
    }));
    expect(screen.getByTestId('protected')).toBeTruthy();
  });

  test('offers explicit account switching after Pod failure through the existing logout action', async () => {
    const value = runtime({ state: { status: 'authenticated', webId }, webId,
      podError: { webId, error: new Error('offline') } });
    renderBoundary(value);
    expect(value.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }));
    await waitFor(() => expect(value.logout).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('retries Pod opening without restarting OIDC', () => {
    const login = vi.fn(async () => undefined);
    const retryPodOpen = vi.fn();
    renderBoundary(runtime({
      state: { status: 'authenticated', webId },
      webId,
      podError: { webId, error: new Error('offline') },
      login,
      retryPodOpen,
    }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retryPodOpen).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });

  test('explicitly selects a new identity after clearing both product sessions', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const logout = vi.fn(async () => undefined);
    const login = vi.fn(async () => undefined);
    const accountLogout = vi.fn(async () => undefined);
    renderBoundary(runtime({ logout, login }), {}, { logout: accountLogout, isAnonymous: () => true } as unknown as AuthContextType);
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(accountLogout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(login).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'login' })));
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();
  });

  test('retries failed Account cleanup before starting a replacement WebID login', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    let anonymous = false;
    const logout = vi.fn(async () => undefined);
    const login = vi.fn(async () => undefined);
    const accountLogout = vi.fn(async () => undefined);
    renderBoundary(runtime({ logout, login }), {}, { logout: accountLogout, isAnonymous: () => anonymous } as unknown as AuthContextType);
    fireEvent.click(screen.getByRole('button', { name: '切换账号' }));
    await screen.findByText('退出未完成');
    expect(login).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).not.toBeNull();
    anonymous = true;
    fireEvent.click(screen.getByRole('button', { name: '重试退出' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(accountLogout).toHaveBeenCalledTimes(2);
    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(login).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'login' })));
  });
  test('does not auto-start OIDC after product sign-out makes Solid anonymous', async () => {
    const login = vi.fn(async () => undefined);
    const value = runtime({ state: { status: 'authenticated', webId, podUrl }, webId, podUrl,
      selectedStorage: { webId, storageUrl: podUrl }, currentPod: { webId, podUrl } as XpodSolidRuntimeValue['currentPod'], login });
    const view = renderBoundary(value, { autoStart: true });
    await act(async () => { await logoutXpodProduct({ logout: async () => undefined, isAnonymous: () => true }, value); });
    view.rerender(<XpodSolidRuntimeContext.Provider value={runtime({ login })}>
      <WebIdAuthBoundary autoStart><span>protected</span></WebIdAuthBoundary>
    </XpodSolidRuntimeContext.Provider>);
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

  test('cold restore failure offers remembered manual login without auto-start or protected access', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId,
      storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ state: { status: 'error', error: new Error('restore failed') }, login }), { autoStart: true });
    expect(screen.getByRole('button', { name: '重新登录 Alice' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('restore failed');
    expect(screen.queryByTestId('protected')).toBeNull();
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新登录 Alice' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

});
