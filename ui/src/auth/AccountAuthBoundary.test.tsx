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

  test('uses the compact Electron window itself as the Account login surface', () => {
    window.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };

    renderBoundary();

    const surface = screen.getByTestId('auth-surface-modal');
    const dialog = screen.getByRole('dialog', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(surface.className).toContain('items-stretch');
    expect(surface.className).not.toContain('bg-black/50');
    expect(dialog.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(dialog.className).toContain('h-full');
    expect(dialog.className).toContain('w-full');
  });

  test.each([
    ['initializing', { status: 'initializing' } as const, '正在加载账号'],
    ['submitting', { status: 'submitting', mode: 'login' } as const, '正在登录…'],
    ['error', { status: 'error', mode: 'login', message: 'Account unavailable' } as const, 'Account unavailable'],
  ])('keeps the Electron %s state in the same full-window surface', (_name, accountState, copy) => {
    window.xpodDesktop = {
      platform: 'darwin',
      setIdentity: vi.fn(),
      setWindowMode: vi.fn(),
    };

    renderBoundary(account({ accountState }));

    const surface = screen.getByTestId('auth-surface-modal');
    const dialog = screen.getByRole('dialog', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(dialog.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(screen.getByText(copy)).toBeTruthy();
  });

  test('uses the browser viewport as the same full Account login surface', () => {
    renderBoundary();

    const surface = screen.getByTestId('auth-surface-modal');
    const dialog = screen.getByRole('dialog', { name: '登录 Xpod' });
    expect(surface.getAttribute('data-auth-surface-host')).toBe('window');
    expect(surface.className).toContain('items-stretch');
    expect(dialog.getAttribute('data-auth-surface-frame')).toBe('window');
    expect(dialog.className).toContain('h-full');
    expect(dialog.className).toContain('w-full');
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
