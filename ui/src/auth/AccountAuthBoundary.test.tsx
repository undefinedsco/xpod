import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { AccountAuthBoundary } from './AccountAuthBoundary';
import { XpodAuthContext, type XpodAuthValue } from './useXpodAuth';
import { createXpodLogoutCoordinator } from './xpod-logout';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example/dashboard/overview',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
}

function authContextValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
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

async function render(value: XpodAuthValue, children?: ReactNode, authOverrides: Partial<AuthContextType> = {}) {
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthContext.Provider value={authContextValue({
        isLoggedIn: value.account.isLoggedIn,
        accountState: value.account.accountState,
        identity: value.account.identity,
        retry: value.account.retry,
        refetchControls: value.account.refetchControls,
        logout: value.account.logout,
        ...authOverrides,
      })}>
        <XpodAuthContext.Provider value={value}>
          <AccountAuthBoundary>{children}</AccountAuthBoundary>
        </XpodAuthContext.Provider>
      </AuthContext.Provider>,
    );
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

type AuthOverrides = Omit<Partial<XpodAuthValue>, 'account'> & {
  account?: Partial<XpodAuthValue['account']>;
};

function value(overrides: AuthOverrides = {}): XpodAuthValue {
  const defaults: XpodAuthValue = {
    account: {
      accountState: { status: 'anonymous', mode: 'login' },
      isLoggedIn: false,
      identity: undefined,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    routes: [],
    webIdState: { status: 'anonymous' },
    readiness: { dashboard: false, localSettings: true, podSettings: false },
    runtime: undefined,
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    retryLogout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
    logoutState: { status: 'idle' },
    logoutCoordinator: createXpodLogoutCoordinator({
      account: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
      webId: { logout: vi.fn(async () => undefined), verifyAnonymous: () => true },
    }),
    switchAccount: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
  };
  return {
    ...defaults,
    ...overrides,
    account: { ...defaults.account, ...(overrides.account ?? {}) },
  };
}

describe('AccountAuthBoundary', () => {
  test('does not resize the native window around Account login', async () => {
    installDom();
    const setWindowMode = vi.fn();
    const desktopBridge = { platform: 'darwin' as const, setIdentity: vi.fn(), setWindowMode };
    window.xpodDesktop = desktopBridge;
    globalThis.xpodDesktop = desktopBridge;
    const rendered = await render(value(), <div>workspace</div>);
    expect(setWindowMode).not.toHaveBeenCalled();
    await unmount(rendered.root);
    delete window.xpodDesktop;
    delete globalThis.xpodDesktop;
  });

  test('starts the one Xpod WebID transaction instead of rendering a second Account password login', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 }));
    const refetchControls = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', fetchMock);
    const startLogin = vi.fn(async () => undefined);
    const rendered = await render(value({ startLogin }), undefined, { refetchControls });
    expect(rendered.container.querySelector('[data-testid="auth-surface-modal"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="account-credentials-scroll"]')).toBeNull();
    expect(rendered.container.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(rendered.container.querySelector('input[type="email"]')).toBeNull();
    expect(rendered.container.querySelector('input[type="password"]')).toBeNull();

    const loginButton = Array.from(rendered.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '使用 WebID 登录');
    expect(loginButton).toBeTruthy();
    await act(async () => loginButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refetchControls).not.toHaveBeenCalled();
    await unmount(rendered.root);
  });

  test('keeps the single-login surface blocking without revealing protected content', async () => {
    const rendered = await render(value(), <span data-testid="protected">private status</span>);

    const closeButton = Array.from(rendered.container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === '关闭登录');
    expect(closeButton).toBeUndefined();
    expect(rendered.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();

    await unmount(rendered.root);
  });

  test('renders a non-submittable pending modal while Account authentication is submitting', async () => {
    const baseValue = value();
    const pendingValue: XpodAuthValue = {
      ...baseValue,
      account: {
        ...baseValue.account,
        accountState: { status: 'submitting', mode: 'login' },
      },
    };
    const rendered = await render(pendingValue);

    expect(rendered.container.querySelector('[data-testid="auth-surface-modal"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="account-credentials-scroll"]')).toBeNull();
    expect(rendered.container.textContent).toContain('正在登录…');
    expect(rendered.container.querySelector('button[type="submit"]')).toBeNull();
    await unmount(rendered.root);
  });

  test('keeps initialization in the same blocking modal', async () => {
    const rendered = await render(value({
      account: {
        accountState: { status: 'initializing' },
        isLoggedIn: false,
      },
    }), <span data-testid="protected">private status</span>);

    expect(rendered.container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(rendered.container.textContent).toContain('正在加载账号');
    const closeButton = Array.from(rendered.container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === '关闭登录');
    expect(closeButton).toBeUndefined();
    expect(rendered.container.querySelector('[data-testid="protected"]')).toBeNull();
    await unmount(rendered.root);
  });

  test('renders authenticated children and retryable Account errors', async () => {
    const retry = vi.fn(async () => undefined);
    const rendered = await render(value({
      account: {
        accountState: { status: 'error', mode: 'login', message: 'Account temporarily unavailable' },
        isLoggedIn: false,
        identity: undefined,
        retry,
        refetchControls: retry,
        logout: vi.fn(async () => undefined),
      },
    }), <span data-testid="protected">ready</span>);

    expect(rendered.container.textContent).toContain('Account temporarily unavailable');
    expect(rendered.container.querySelector('[role="dialog"]')).toBeTruthy();
    const retryButton = Array.from(rendered.container.querySelectorAll('button')).find((node) => /重试|retry/i.test(node.textContent ?? ''));
    expect(retryButton).toBeTruthy();
    await act(async () => retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(retry).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });
});
