// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { EVENTS } from '@inrupt/solid-client-authn-browser';
import { createSolidSessionRuntime, type SolidSessionAdapter } from '../../../packages/solid-sdk/src/session';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from './XpodSolidRuntime';
import { XpodSolidRuntimeContext, safeAuthError } from './XpodSolidRuntime';
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

  test.each([webId, undefined])('keeps terminal refresh expiry distinct without remembering identity (%s)', async (activeWebId) => {
    const events = new EventEmitter();
    const session: SolidSessionAdapter = {
      info: { isLoggedIn: true, webId: activeWebId },
      events,
      fetch: vi.fn() as typeof fetch,
      handleIncomingRedirect: async () => undefined,
      login: async () => {},
      logout: async () => {},
    };
    const solid = createSolidSessionRuntime({ session });
    // Actual Inrupt terminal refresh failure protocol, in order. The provider
    // description is private diagnostic detail, not the user's expiry message.
    events.emit(EVENTS.ERROR, 'invalid_grant', 'Refresh token is expired or revoked');
    events.emit(EVENTS.SESSION_EXPIRED);
    const snapshot = solid.getSnapshot();
    expect(snapshot.status).toBe('expired');
    if (snapshot.status !== 'expired') throw new Error('Expected expired SDK state');
    const login = vi.fn(async () => undefined);
    try {
      await act(async () => { renderBoundary(runtime({ session: solid, state: snapshot, login }), { autoStart: true }); });
      expect(screen.getByText('登录已过期，需要重新确认', { exact: true })).toBeTruthy();
      expect(screen.queryByText('登录没有完成，请再试一次')).toBeNull();
      expect(screen.queryByText('Refresh token is expired or revoked')).toBeNull();
      expect(screen.queryByTestId('protected')).toBeNull();
      expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();
      expect(login).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '重新登录', exact: true }));
      await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    } finally { solid.dispose(); }
  });

  test('keeps a non-expiry OIDC error generic instead of treating ordinary login failure as refresh expiry', async () => {
    const events = new EventEmitter();
    const session: SolidSessionAdapter = {
      info: { isLoggedIn: false }, events, fetch: vi.fn() as typeof fetch,
      handleIncomingRedirect: async () => undefined, login: async () => {}, logout: async () => {},
    };
    const solid = createSolidSessionRuntime({ session });
    events.emit(EVENTS.ERROR, 'invalid_grant', 'Authorization code rejected');
    const snapshot = solid.getSnapshot();
    expect(snapshot.status).toBe('error');
    if (snapshot.status !== 'error') throw new Error('Expected ordinary error SDK state');
    try {
      await act(async () => { renderBoundary(runtime({ session: solid, state: snapshot }), { autoStart: true }); });
      expect(screen.getByRole('alert').textContent).toBe('登录没有完成，请再试一次');
      expect(screen.queryByText('登录已过期，需要重新确认')).toBeNull();
      expect(screen.queryByText('Authorization code rejected')).toBeNull();
    } finally { solid.dispose(); }
  });

  test('shows a failed login as one line and waits for the user without retrying or logging out', async () => {
    const value = runtime({ state: { status: 'error', error: new Error('offline') } });
    renderBoundary(value, { autoStart: true });
    // C4: one line, no error code, and the primary action is the way forward.
    expect(screen.getByRole('alert').textContent).toBe('登录没有完成，请再试一次');
    expect(screen.queryByText('offline')).toBeNull();
    expect(screen.getByRole('button', { name: '重新登录' })).toBeTruthy();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(value.login).not.toHaveBeenCalled();
    expect(value.logout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  test('reveals the failure detail only in developer mode', () => {
    const value = runtime({ state: { status: 'error', error: new Error('offline') } });
    const first = renderBoundary(value, { autoStart: true });
    expect(screen.queryByText('offline')).toBeNull();
    first.unmount();
    renderBoundary(value, { autoStart: true, developerMode: true });
    expect(screen.getByRole('alert').querySelector('details')).not.toBeNull();
    expect(screen.getByText('offline')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '使用 Xpod 账号登录' }));
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
    // A3: the app is named by the source mark, the one heading is "登录".
    expect(screen.getByRole('heading', { level: 1, name: '登录' })).toBeTruthy();
    const source = document.querySelector('[data-pod-sign-in="source"]');
    expect(source?.textContent).toContain('Xpod');
    expect(source?.querySelectorAll('svg[viewBox="0 0 100 100"]').length).toBe(1);
    expect(screen.getByRole('button', { name: '部署详情' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '使用 Xpod 账号登录' }));
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

    const frame = screen.getByRole('region', { name: '登录 Xpod' });
    expect(frame.getAttribute('data-pod-sign-in-frame')).toBe('window');
    expect(frame.classList.contains('w-full')).toBe(true);
    expect(frame.classList.contains('h-full')).toBe(true);
    expect(window.xpodDesktop.setWindowMode).toHaveBeenCalledWith('auth');
  });

  test('shows the primary action busy instead of a separate verifying screen while connecting', async () => {
    const login = vi.fn(async () => new Promise<void>(() => undefined));
    renderBoundary(runtime({ login }));
    fireEvent.click(screen.getByRole('button', { name: '使用 Xpod 账号登录' }));
    const busy = await screen.findByRole('button', { name: '使用 Xpod 账号登录' }) as HTMLButtonElement;
    await waitFor(() => expect(busy.disabled).toBe(true));
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.queryByText('正在登录…')).toBeNull();
  });

  test('keeps the remembered identity on screen, busy, after Enter is pressed', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const login = vi.fn(async () => new Promise<void>(() => undefined));
    renderBoundary(runtime({ login }));
    fireEvent.click(screen.getByRole('button', { name: '进入 Xpod' }));
    await waitFor(() => expect(login).toHaveBeenCalled());
    const busy = await screen.findByRole('button', { name: '进入 Xpod' }) as HTMLButtonElement;
    await waitFor(() => expect(busy.disabled).toBe(true));
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy();
    expect(document.querySelector('[data-pod-sign-in-state="choose-service"]')).toBeNull();
  });

  test('waits for account discovery inside the busy A1, never on a separate preparing screen', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const login = vi.fn(async () => new Promise<void>(() => undefined));
    const account = { isInitializing: true, logout: vi.fn(), isAnonymous: () => true } as unknown as AuthContextType;
    renderBoundary(runtime({ login }), {}, account);
    fireEvent.click(screen.getByRole('button', { name: '进入 Xpod' }));
    // Discovery still running: same screen, busy button, no "正在准备登录…" page.
    const busy = await screen.findByRole('button', { name: '进入 Xpod' }) as HTMLButtonElement;
    await waitFor(() => expect(busy.disabled).toBe(true));
    expect(screen.queryByText('正在准备登录…')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  test('shows the remembered identity with an avatar badge for where its Pod lives', () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId, storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    renderBoundary(runtime());
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入 Xpod' })).toBeTruthy();
    // The test origin is loopback, so the Pod is an edge Pod: a badge, not the word "Xpod".
    expect(screen.getByRole('img', { name: '数据存在边缘设备上' })).toBeTruthy();
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
    // C1: one line and a retry button; switching is the secondary action.
    expect(screen.getByRole('alert').textContent).toBe('暂时连不上 Xpod，请稍后再试');
    fireEvent.click(screen.getByRole('button', { name: '使用其他账号' }));
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
    fireEvent.click(screen.getByRole('button', { name: '使用其他账号' }));
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
    fireEvent.click(screen.getByRole('button', { name: '使用其他账号' }));
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
    fireEvent.click(screen.getByRole('button', { name: '使用 Xpod 账号登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

  test('cold restore failure offers remembered manual login without auto-start or protected access', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify({
      account: { displayName: 'Alice' }, webId,
      storageBinding: { webId, storageUrl: podUrl }, routeId: 'xpod-current-origin',
    }));
    const login = vi.fn(async () => undefined);
    renderBoundary(runtime({ state: { status: 'error', error: new Error('restore failed') }, login }), { autoStart: true });
    // A1 for the remembered identity, with the C4 line and a relabelled primary action.
    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('登录没有完成，请再试一次');
    expect(screen.queryByText('restore failed')).toBeNull();
    expect(screen.queryByTestId('protected')).toBeNull();
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

});


test('offers page reload for an unfinished previous SDK login instead of an endless retry', () => {
  const error = new Error('private upstream detail');
  error.name = 'SolidSessionPendingError';
  const safe = safeAuthError(error);
  expect(safe.name).toBe('SolidSessionPendingError');
  expect(safe.message).toBe('上次登录尚未结束，请刷新页面后重新登录。');
  const value = runtime({ state: { status: 'error', error: safe } });
  const reload = vi.fn();
  const originalWindow = window;
  vi.stubGlobal('window', new Proxy(originalWindow, {
    get(target, key) {
      if (key === 'location') return { ...target.location, reload };
      return Reflect.get(target, key, target);
    },
  }));
  try {
    renderBoundary(value);
    expect(screen.getByRole('alert').textContent).toBe('上次登录尚未结束');
    expect(screen.queryByText('private upstream detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(value.login).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
