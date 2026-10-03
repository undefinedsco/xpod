// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppRoutes } from '../App';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { AboutPage } from './AboutPage';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  window.xpodDesktop = undefined;
});

function authValue(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    controls: {},
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

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderAbout(overrides: Partial<AuthContextType> = {}) {
  window.history.replaceState(null, '', '/.account/about/');
  return render(
    <AuthContext.Provider value={authValue(overrides)}>
      <MemoryRouter initialEntries={['/.account/about/']}>
        <Routes>
          <Route path="/.account/about/" element={<AboutPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('AboutPage', () => {
  test('uses semantic theme tokens instead of light-only colors', () => {
    const source = readFileSync(join(process.cwd(), 'ui/src/pages/AboutPage.tsx'), 'utf8');

    expect(source).toContain('bg-background');
    expect(source).toContain('bg-card');
    expect(source).toContain('text-foreground');
    expect(source).toContain('text-muted-foreground');
    expect(source).toContain('bg-primary');
    expect(source).not.toMatch(/bg-white|bg-zinc|text-zinc|border-zinc|#7C4DFF|#6B3FE8|shadow-zinc/);
  });

  test('renders the about surface for an anonymous visitor', () => {
    renderAbout();

    expect(screen.getByRole('heading', { name: 'About Xpod' })).toBeTruthy();
    expect(screen.getByText('Learn more about the platform and resources.')).toBeTruthy();
  });

  test('returns an anonymous visitor to the Account login', () => {
    renderAbout();

    fireEvent.click(screen.getByRole('button', { name: 'Back to Login' }));

    expect(screen.getByTestId('location').textContent).toBe('/.account/login/password/');
  });

  test('returns a signed-in Account to the Account surface', () => {
    renderAbout({ isLoggedIn: true, accountState: { status: 'authenticated' } });

    fireEvent.click(screen.getByRole('button', { name: 'Back to Account' }));

    expect(screen.getByTestId('location').textContent).toBe('/.account/account/');
  });

  test('is not blocked by a pending or failed Account bootstrap', () => {
    for (const overrides of [
      { isInitializing: true, accountState: { status: 'initializing' } as const },
      { initError: 'Account unavailable', accountState: { status: 'error', mode: 'login', message: 'Account unavailable' } as const },
    ]) {
      window.history.replaceState(null, '', '/.account/about/');
      const view = render(
        <AuthContext.Provider value={authValue(overrides)}>
          <MemoryRouter initialEntries={['/.account/about/']}>
            <AppRoutes />
          </MemoryRouter>
        </AuthContext.Provider>,
      );

      expect(screen.getByRole('heading', { name: 'About Xpod' })).toBeTruthy();
      expect(screen.queryByText('正在加载…')).toBeNull();
      expect(screen.queryByRole('heading', { name: '账号服务暂时不可用' })).toBeNull();
      view.unmount();
    }
  });
});
