// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { AccountBoundary } from './AccountBoundary';

function authValue(isLoggedIn: boolean): AuthContextType {
  return {
    controls: isLoggedIn ? { account: { logout: '/.account/logout/' } } : {},
    isInitializing: false,
    initError: null,
    idpIndex: '/.account/',
    isLoggedIn,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
  };
}

describe('AccountBoundary', () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  test('redirects an anonymous account to password login and retains the requested Status route', () => {
    const redirectToLogin = vi.fn();
    render(
      <AuthContext.Provider value={authValue(false)}>
        <MemoryRouter initialEntries={['/status/services/api-server?tab=errors']}>
          <AccountBoundary redirectToLogin={redirectToLogin}><div>status content</div></AccountBoundary>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(redirectToLogin).toHaveBeenCalledWith('/.account/login/password/');
    expect(sessionStorage.getItem('xpod:returnTo')).toBe('/status/services/api-server?tab=errors');
  });

  test('renders account-protected content without requiring a Solid session', () => {
    render(
      <AuthContext.Provider value={authValue(true)}>
        <MemoryRouter>
          <AccountBoundary><div>status content</div></AccountBoundary>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getByText('status content')).toBeTruthy();
  });
});
