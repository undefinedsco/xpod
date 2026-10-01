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
vi.mock('./pages/admin', () => ({
  StatusPage: () => <div>Protected service status</div>,
  LogsPage: () => <div>Service logs</div>,
  RdfPage: () => <div>RDF evidence</div>,
}));
vi.mock('./pages/status/StatusSubjectPanel', () => ({
  ServiceStatusPanel: ({ serviceId }: { serviceId: string }) => <div>Service status {serviceId}</div>,
}));
vi.mock('./pages/status/IndexSubjectPanel', () => ({
  default: ({ kind }: { kind: string }) => <div>Index evidence {kind}</div>,
}));
vi.mock('./pages/settings/NetworkPage', () => ({ default: () => <div>Network settings</div> }));

afterEach(() => {
  cleanup();
  webId.status = 'anonymous';
  window.xpodDesktop = undefined;
  // Keep the shared jsdom document URL neutral for the next test file.
  window.history.replaceState(null, '', '/');
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

describe('legacy Account-gated dashboard route /dashboard/overview', () => {
  const path = '/dashboard/overview';

  it('retains the host navigation for a WebID session but still requires Account authorization', async () => {
    webId.status = 'authenticated';
    const setWindowMode = vi.fn();
    window.xpodDesktop = { platform: 'darwin', setIdentity: vi.fn(), setWindowMode };
    renderRoute(path);
    expect(await screen.findByRole('navigation', { name: 'Host navigation' })).toBeTruthy();
    expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    // The legacy /dashboard gate renders the embedded Account credentials view,
    // whose secondary entries stay "创建账号 · 忘记密码？" (the shared IdP footer
    // on the page surface is the one that reads "没有账号？ 注册账号").
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

describe('local /status service surface', () => {
  it('renders the Gateway service status for an anonymous visitor instead of the login form', async () => {
    renderRoute('/status/services/gateway');

    expect(await screen.findByText('Service status gateway')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Host navigation' })).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
    expect(screen.queryByText('Protected service status')).toBeNull();
  });

  it.each([
    ['/status/overview', 'Protected service status'],
    ['/status/logs', 'Service logs'],
    ['/status/index', 'Index evidence overview'],
    ['/status/index/rdf', 'RDF evidence'],
    ['/status/services/solid-server', 'Service status css'],
    ['/status/services/api-server', 'Service status api'],
  ])('keeps the anonymous %s diagnostics panel reachable', async (path, evidence) => {
    renderRoute(path);

    expect(await screen.findByText(evidence)).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
  });

  it('keeps the local surface for a WebID session that has no Account session', async () => {
    webId.status = 'authenticated';
    renderRoute('/status/overview');

    expect(await screen.findByText('Protected service status')).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
  });

  it('still opens the Account sign-in when the host explicitly asks for the account card', async () => {
    renderRoute('/status/overview?account=open');

    expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    expect(screen.queryByText('Protected service status')).toBeNull();
  });

  it('shows the status surface again once an Account session exists', async () => {
    renderRoute('/status/overview?account=open', true);

    expect(await screen.findByText('Protected service status')).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
  });
});
