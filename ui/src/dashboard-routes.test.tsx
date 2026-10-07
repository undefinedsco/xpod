import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext, type AuthContextType } from './context/AuthContextValue';
import { XpodSolidRuntimeContext, type XpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { xpodShellRoutes } from './xpod-shell-routes';

vi.mock('./layout/XpodUserCard', () => ({ XpodUserCard: () => <a href="/ai-connections">登录</a> }));
vi.mock('./shell/ShellHeaderControls', () => ({
  ShellHeaderControls: () => <><button>通知</button><button>收件箱</button></>,
  ShellInboxContent: () => <div>Inbox data</div>, ShellNotificationsContent: () => <div>Notification data</div>,
}));
vi.mock('./pages/device/DevicePages', () => ({
  DeviceServicesPage: () => <div>Local service controls</div>, DeviceRuntimePage: () => <div>Local runtime settings</div>,
  DeviceNetworkPage: () => <div>Local network controls</div>, DeviceLogsPage: () => <div>Local logs</div>,
}));
vi.mock('./pages/settings/ModelsPage', () => ({ default: () => <div>Private AI connections</div> }));
vi.mock('./pages/tasks/TasksPage', () => ({ default: () => <div>Private task data</div> }));
vi.mock('./theme/xpod-theme-context', () => ({ useXpodTheme: () => ({ preference: 'system', setPreference: vi.fn() }) }));

afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); window.xpodDesktop = undefined; });

function renderRoute(path: string, accountAuthenticated = false, webIdAuthenticated = false) {
  window.history.replaceState(null, '', path);
  // Keep the login boundary at its manual entry without initiating external OIDC.
  window.localStorage.setItem('xpod.auth.login-cancelled', '1');
  const webId = `${window.location.origin}/alice/profile/card#me`;
  const podUrl = `${window.location.origin}/alice/`;
  const runtime = {
    session: { getSnapshot: () => ({ status: webIdAuthenticated ? 'authenticated' : 'anonymous' }) },
    pod: {}, fetch: vi.fn(), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined),
    state: webIdAuthenticated ? { status: 'authenticated', webId, podUrl } : { status: 'anonymous' },
    ...(webIdAuthenticated ? { webId, podUrl, selectedStorage: { webId, storageUrl: podUrl }, currentPod: { webId, podUrl } } : {}),
  } as unknown as XpodSolidRuntimeValue;
  const account: AuthContextType = {
    controls: {}, isInitializing: false, initError: null, idpIndex: 'https://id.example/.account/',
    isLoggedIn: accountAuthenticated, authenticating: false, hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined), retry: vi.fn(async () => undefined), logout: vi.fn(async () => undefined),
    accountState: accountAuthenticated ? { status: 'authenticated' } : { status: 'anonymous', mode: 'login' },
  };
  const router = createMemoryRouter(xpodShellRoutes, { initialEntries: [path] });
  render(<AuthContext.Provider value={account}><XpodSolidRuntimeContext.Provider value={runtime}>
    <RouterProvider router={router} />
  </XpodSolidRuntimeContext.Provider></AuthContext.Provider>);
  return { router, runtime };
}

describe('local desktop routes', () => {
  it.each(['/status/overview', '/dashboard/overview', '/device/services'])('%s reaches local controls without either login', async (path) => {
    const { router, runtime } = renderRoute(path);
    expect(await screen.findByText('Local service controls')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/device/services');
    expect(screen.getByRole('link', { name: '这台设备' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '设置' })).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
    expect(runtime.login).not.toHaveBeenCalled();
  });
  it('keeps device/settings navigation usable while a private applet is gated', async () => {
    renderRoute('/tasks');
    expect(await screen.findByRole('button', { name: '使用 Xpod 账号登录' })).toBeTruthy();
    expect(screen.queryByText('Private task data')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: '这台设备' }));
    expect(await screen.findByText('Local network controls')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByRole('combobox', { name: '主题' })).toBeTruthy();
  });
});

describe.each([['/tasks', 'Private task data'], ['/ai-connections', 'Private AI connections']])('WebID applet %s', (path, content) => {
  it.each([false, true])('does not admit Account-only access (Account authenticated: %s)', async (accountAuthenticated) => {
    renderRoute(path, accountAuthenticated);
    expect(await screen.findByRole('button', { name: '使用 Xpod 账号登录' })).toBeTruthy();
    expect(screen.queryByText(content)).toBeNull();
    expect(screen.getByRole('link', { name: '这台设备' })).toBeTruthy();
  });
  it('admits a ready WebID and Pod with no Account session', async () => {
    renderRoute(path, false, true);
    expect(await screen.findByText(content)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '使用 Xpod 账号登录' })).toBeNull();
  });
});
