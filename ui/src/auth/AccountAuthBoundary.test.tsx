// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { AccountAuthBoundary } from './AccountAuthBoundary';

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

function renderBoundary(value = account()) {
  return render(
    <AuthContext.Provider value={value}>
      <AccountAuthBoundary><span data-testid="protected">Dashboard</span></AccountAuthBoundary>
    </AuthContext.Provider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.xpodDesktop = undefined;
});

describe('AccountAuthBoundary', () => {
  test.each([
    { status: 'anonymous', mode: 'login' } as const,
    { status: 'initializing' } as const,
    { status: 'submitting', mode: 'login' } as const,
    { status: 'error', mode: 'login', message: 'Account unavailable' } as const,
  ])('does not resize the host window for embedded $status', (accountState) => {
    const setWindowMode = vi.fn();
    window.xpodDesktop = { platform: 'darwin', setIdentity: vi.fn(), setWindowMode };
    render(<AuthContext.Provider value={account({ accountState })}>
      <AccountAuthBoundary surface="embedded"><span data-testid="protected">Dashboard</span></AccountAuthBoundary>
    </AuthContext.Provider>);
    expect(screen.queryByTestId('protected')).toBeNull();
    expect(screen.getByRole('heading', { name: '登录 Xpod' })).toBeTruthy();
    expect(setWindowMode).not.toHaveBeenCalled();
  });

  test('renders the Xpod-owned credential form without navigating to the CSS JSON control', () => {
    const pathname = window.location.pathname;
    renderBoundary();

    expect(screen.queryByTestId('protected')).toBeNull();
    expect(screen.getByRole('heading', { name: '登录 Xpod' })).toBeTruthy();
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    // The auth redesign spec pairs the sign-in action with the register and
    // password-recovery entries, so the Dashboard gate must offer both.
    expect(screen.getByRole('link', { name: '创建账号' }).getAttribute('href'))
      .toBe('/.account/login/password/register/');
    expect(screen.getByRole('link', { name: '忘记密码？' }).getAttribute('href'))
      .toBe('/.account/login/password/forgot/');
    expect(window.location.pathname).toBe(pathname);
  });

  test.each([false, true])('uses the CSS Account layout with desktop=%s', (desktop) => {
    const setWindowMode = vi.fn();
    window.xpodDesktop = desktop ? { platform: 'darwin', setIdentity: vi.fn(), setWindowMode } : undefined;
    renderBoundary();
    expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('compact');
    expect(screen.queryByTestId('auth-surface-modal')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    if (desktop) expect(setWindowMode).toHaveBeenCalledWith('account');
    expect(setWindowMode).not.toHaveBeenCalledWith('auth');
  });

  test.each([
    ['initializing', { status: 'initializing' } as const, '正在加载账号'],
    ['submitting', { status: 'submitting', mode: 'login' } as const, '正在登录…'],
    ['error', { status: 'error', mode: 'login', message: 'Account unavailable' } as const, 'Account unavailable'],
  ])('keeps the %s state in the CSS Account layout', (_name, accountState, copy) => {
    window.xpodDesktop = { platform: 'darwin', setIdentity: vi.fn(), setWindowMode: vi.fn() };
    renderBoundary(account({ accountState }));
    expect(screen.getByTestId('web-account-panel').getAttribute('data-web-account-layout')).toBe('compact');
    expect(screen.queryByTestId('auth-surface-modal')).toBeNull();
    expect(screen.getByText(copy)).toBeTruthy();
    expect(window.xpodDesktop.setWindowMode).toHaveBeenCalledWith('account');
  });

  test('renders Dashboard only for the native authenticated Account state', () => {
    renderBoundary(account({
      isLoggedIn: true,
      accountState: { status: 'authenticated' },
    }));

    expect(screen.getByTestId('protected').textContent).toBe('Dashboard');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('retries CSS Account controls without starting a Solid login', () => {
    const retry = vi.fn(async () => undefined);
    renderBoundary(account({
      retry,
      accountState: { status: 'error', mode: 'login', message: 'Account unavailable' },
    }));

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
