// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AccountAuthBoundary } from '../../ui/src/auth/AccountAuthBoundary';
import { AuthContext, type AuthContextType } from '../../ui/src/context/AuthContextValue';
import { WebIdAuthBoundary } from '../../ui/src/solid/WebIdAuthBoundary';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from '../../ui/src/solid/XpodSolidRuntime';

const webId = 'https://id.example/alice/profile/card#me';
const podUrl = 'https://alice.example/';

function account(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: { password: { login: '/.account/login/password/' } },
    isInitializing: false,
    initError: null,
    idpIndex: 'https://id.example/.account/',
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

function authenticatedRuntime(overrides: Partial<XpodSolidRuntimeValue> = {}): XpodSolidRuntimeValue {
  return runtime({
    state: { status: 'authenticated', webId, podUrl },
    webId,
    podUrl,
    selectedStorage: { webId, storageUrl: podUrl },
    currentPod: { webId, podUrl } as XpodSolidRuntimeValue['currentPod'],
    ...overrides,
  });
}

function renderWithAuthSurfaces(children: React.ReactNode, {
  accountValue = account(),
  runtimeValue = runtime(),
}: {
  accountValue?: AuthContextType;
  runtimeValue?: XpodSolidRuntimeValue;
} = {}) {
  return render(
    <AuthContext.Provider value={accountValue}>
      <XpodSolidRuntimeContext.Provider value={runtimeValue}>
        {children}
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  globalThis.xpodDesktop = undefined;
  vi.restoreAllMocks();
});

describe('auth authority behavior boundaries', () => {
  test('Account boundary owns the desktop auth and workspace window modes', async () => {
    const setWindowMode = vi.fn();
    globalThis.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode,
    };

    const view = renderWithAuthSurfaces(
      <AccountAuthBoundary><span>Status ready</span></AccountAuthBoundary>,
    );

    await waitFor(() => expect(setWindowMode).toHaveBeenLastCalledWith('auth'));

    view.rerender(
      <AuthContext.Provider value={account({
        isLoggedIn: true,
        accountState: { status: 'authenticated' },
      })}>
        <XpodSolidRuntimeContext.Provider value={runtime()}>
          <AccountAuthBoundary><span>Status ready</span></AccountAuthBoundary>
        </XpodSolidRuntimeContext.Provider>
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(setWindowMode).toHaveBeenLastCalledWith('workspace'));
    view.unmount();
    expect(setWindowMode).toHaveBeenLastCalledWith('workspace');
  });

  test('Status renders with an Account session when no WebID session exists', () => {
    renderWithAuthSurfaces(
      <AccountAuthBoundary><span data-testid="status">Status ready</span></AccountAuthBoundary>,
      {
        accountValue: account({
          isLoggedIn: true,
          accountState: { status: 'authenticated' },
        }),
        runtimeValue: runtime({ state: { status: 'anonymous' } }),
      },
    );

    expect(screen.getByTestId('status').textContent).toBe('Status ready');
  });

  test('AI Connections renders with a WebID session when Account controls are failing', () => {
    renderWithAuthSurfaces(
      <WebIdAuthBoundary><span data-testid="ai-connections">AI Connections ready</span></WebIdAuthBoundary>,
      {
        accountValue: account({
          initError: 'Account service unavailable',
          accountState: { status: 'error', mode: 'login', message: 'Account service unavailable' },
        }),
        runtimeValue: authenticatedRuntime(),
      },
    );

    expect(screen.getByTestId('ai-connections').textContent).toBe('AI Connections ready');
  });

  test('Account failure does not start a second WebID login for ready AI Connections', () => {
    const login = vi.fn(async () => undefined);
    renderWithAuthSurfaces(
      <WebIdAuthBoundary autoStart><span data-testid="ai-connections">AI Connections ready</span></WebIdAuthBoundary>,
      {
        accountValue: account({
          accountState: { status: 'error', mode: 'login', message: 'Account service unavailable' },
        }),
        runtimeValue: authenticatedRuntime({ login }),
      },
    );

    expect(screen.getByTestId('ai-connections')).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  test('WebID failure does not hide Account-protected Status', () => {
    renderWithAuthSurfaces(
      <AccountAuthBoundary><span data-testid="status">Status ready</span></AccountAuthBoundary>,
      {
        accountValue: account({
          isLoggedIn: true,
          accountState: { status: 'authenticated' },
        }),
        runtimeValue: runtime({ state: { status: 'error', error: new Error('Solid session failed') } }),
      },
    );

    expect(screen.getByTestId('status').textContent).toBe('Status ready');
  });
});
