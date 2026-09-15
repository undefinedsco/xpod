import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { AuthContext, type AuthContextType } from './context/AuthContextValue';
import { xpodShellRoutes } from './xpod-shell-routes';

const webId = vi.hoisted(() => ({ status: 'anonymous' }));
vi.mock('./solid/XpodSolidRuntime', () => ({
  useXpodSolidRuntimeContext: () => ({ state: webId }),
}));
vi.mock('./layout/XpodDashboardLayout', () => ({
  XpodDashboardLayout: () => <><nav aria-label="Host navigation" /><Outlet /></>,
}));
vi.mock('./pages/status/StatusWorkspace', () => ({ default: () => <Outlet /> }));
vi.mock('./pages/admin', () => ({ StatusPage: () => <div>Protected service status</div> }));

afterEach(() => {
  cleanup();
  webId.status = 'anonymous';
  window.xpodDesktop = undefined;
});

function renderRoute(path: string, accountAuthenticated = false) {
  window.history.replaceState(null, '', path);
  const account: AuthContextType = {
    controls: { password: { login: '/.account/login/password/' } },
    isInitializing: false,
    initError: null,
    idpIndex: 'https://id.example/.account/',
    isLoggedIn: accountAuthenticated,
    authenticating: false,
    hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: accountAuthenticated
      ? { status: 'authenticated' }
      : { status: 'anonymous', mode: 'login' },
  };
  render(<AuthContext.Provider value={account}>
    <RouterProvider router={createMemoryRouter(xpodShellRoutes, { initialEntries: [path] })} />
  </AuthContext.Provider>);
}

describe.each(['/status/overview', '/dashboard/overview'])('Account route %s', (path) => {
  it('retains the host navigation for a WebID session but still requires Account authorization', async () => {
    webId.status = 'authenticated';
    const setWindowMode = vi.fn();
    window.xpodDesktop = { platform: 'darwin', setIdentity: vi.fn(), setWindowMode };
    renderRoute(path);
    expect(await screen.findByRole('navigation', { name: 'Host navigation' })).toBeTruthy();
    expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    for (const name of ['创建账号', '忘记密码？']) {
      const href = screen.getByRole('link', { name }).getAttribute('href');
      expect(new URL(href!, window.location.origin).searchParams.get('returnTo')).toBe(path);
    }
    expect(screen.queryByText('Protected service status')).toBeNull();
    expect(setWindowMode).not.toHaveBeenCalled();
  });

  it('keeps the standalone Account login when both sessions are anonymous', async () => {
    renderRoute(path);
    expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Host navigation' })).toBeNull();
    expect(screen.queryByText('Protected service status')).toBeNull();
  });

  it('renders protected content when Account is authenticated', async () => {
    renderRoute(path, true);
    expect(await screen.findByText('Protected service status')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Host navigation' })).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
  });
});
