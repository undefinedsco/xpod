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
    accountAuthState: { status: 'anonymous', mode: 'login' },
    authState: { status: 'anonymous', mode: 'login' },
    state: { status: 'anonymous', mode: 'login' },
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
      <AuthContext.Provider value={authContextValue(authOverrides)}>
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
    switchAccount: vi.fn(async () => undefined),
  };
  return {
    ...defaults,
    ...overrides,
    account: { ...defaults.account, ...(overrides.account ?? {}) },
  };
}

describe('AccountAuthBoundary', () => {
  test('renders an in-shell Account credentials modal without starting navigation or OIDC login', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authorization: 'account-token' }), { status: 200 }));
    const refetchControls = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', fetchMock);
    const rendered = await render(value(), undefined, { refetchControls });
    expect(rendered.container.querySelector('[data-testid="auth-surface-modal"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="account-credentials-scroll"]')).toBeTruthy();
    expect(rendered.container.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('/.account/login/password');

    const email = rendered.container.querySelector('input[type="email"]');
    const password = rendered.container.querySelector('input[type="password"]');
    expect(email).toBeTruthy();
    expect(password).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refetchControls).not.toHaveBeenCalled();
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
    expect(rendered.container.textContent).toContain('Signing in…');
    expect(rendered.container.querySelector('button[type="submit"]')).toBeNull();
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
    const retryButton = Array.from(rendered.container.querySelectorAll('button')).find((node) => /retry/i.test(node.textContent ?? ''));
    expect(retryButton).toBeTruthy();
    await act(async () => retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(retry).toHaveBeenCalledTimes(1);
    await unmount(rendered.root);
  });
});
