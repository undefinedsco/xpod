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

afterEach(() => vi.restoreAllMocks());

describe('AccountAuthBoundary', () => {
  test('renders the Xpod-owned credential form without navigating to the CSS JSON control', () => {
    const pathname = window.location.pathname;
    renderBoundary();

    expect(screen.queryByTestId('protected')).toBeNull();
    expect(screen.getByText('使用 Xpod 账号登录 Dashboard')).toBeTruthy();
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(window.location.pathname).toBe(pathname);
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
