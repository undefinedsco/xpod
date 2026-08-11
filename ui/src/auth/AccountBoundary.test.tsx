// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodAuthContext, type XpodAuthValue } from './useXpodAuth';
import { AccountBoundary } from './AccountBoundary';

function authValue(isLoggedIn: boolean): AuthContextType {
  const accountState = isLoggedIn
    ? { status: 'authenticated' } as const
    : { status: 'anonymous', mode: 'login' } as const;
  return {
    controls: isLoggedIn ? { account: { logout: '/.account/logout/' } } : {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState,
    accountAuthState: accountState,
    authState: accountState,
    state: accountState,
  };
}

function xpodValue(isLoggedIn: boolean): XpodAuthValue {
  return {
    account: {
      accountState: isLoggedIn
        ? { status: 'authenticated' }
        : { status: 'anonymous', mode: 'login' },
      isLoggedIn,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
  } as XpodAuthValue;
}

function renderBoundary(isLoggedIn: boolean, redirectToLogin = vi.fn()) {
  return render(
    <AuthContext.Provider value={authValue(isLoggedIn)}>
      <XpodAuthContext.Provider value={xpodValue(isLoggedIn)}>
        <MemoryRouter initialEntries={['/status/services/api-server?tab=errors']}>
          <AccountBoundary redirectToLogin={redirectToLogin}><div>status content</div></AccountBoundary>
        </MemoryRouter>
      </XpodAuthContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('AccountBoundary', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  test('delegates an anonymous account to the in-shell modal without raw navigation', () => {
    const redirectToLogin = vi.fn();
    renderBoundary(false, redirectToLogin);

    expect(redirectToLogin).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-surface-modal')).toBeTruthy();
    expect(sessionStorage.getItem('xpod:returnTo')).toBeNull();
  });

  test('renders account-protected content without requiring a Solid session', () => {
    renderBoundary(true);

    expect(screen.getByText('status content')).toBeTruthy();
  });
});
