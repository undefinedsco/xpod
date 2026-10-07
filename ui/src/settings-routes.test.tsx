import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { isValidElement } from 'react';
import { matchRoutes, Navigate, MemoryRouter, Route, Routes } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';
import { AccountAuthBoundary, AccountWorkspaceBoundary } from './auth/AccountAuthBoundary';
import { XpodProductLayout } from './layout/XpodProductLayout';
import { WebIdAuthBoundary } from './solid/WebIdAuthBoundary';
import { PodManagementBoundary, PodManagementTaskRoute } from './pages/settings/PodDeletionAuthorizationPanel';
import { AuthContext, type AuthContextType } from './context/AuthContextValue';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPodManagementAdmission(path: string, authenticated: boolean) {
  const account: AuthContextType = {
    controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/',
    isLoggedIn: authenticated, authenticating: false, hasOidcPending: false,
    refetchControls: vi.fn(async () => undefined), retry: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    accountState: authenticated ? { status: 'authenticated' } : { status: 'anonymous', mode: 'login' },
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ edition: 'local', managed: false })));
  return render(<AuthContext.Provider value={account}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PodManagementBoundary />}>
          <Route path="/pod" element={<span data-testid="pod-workspace">Pod workspace</span>} />
        </Route>
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>);
}

function containsElementType(element: unknown, type: unknown): boolean {
  if (!isValidElement(element)) return false;
  if (element.type === type) return true;
  const children = element.props?.children;
  return Array.isArray(children)
    ? children.some((child) => containsElementType(child, type))
    : containsElementType(children, type);
}
function routeElements(path: string) {
  const matches = matchRoutes(xpodShellRoutes, path);
  expect(matches, path).toBeTruthy();
  return matches!.map(({ route }) => route.element);
}

describe('desktop settings and applet route boundaries', () => {
  test.each(['/device/network', '/device/services', '/device/runtime', '/device/logs', '/settings/appearance'])(
    '%s remains inside the shell without Account or WebID authorization', (path) => {
      const elements = routeElements(path);
      expect(elements.some(element => containsElementType(element, XpodProductLayout))).toBe(true);
      for (const boundary of [AccountAuthBoundary, AccountWorkspaceBoundary, WebIdAuthBoundary]) {
        expect(elements.some(element => containsElementType(element, boundary))).toBe(false);
      }
      const page = elements.at(-1);
      expect(isValidElement(page) && page.type === Navigate).toBe(false);
    },
  );
  test.each(['/ai-connections', '/tasks', '/pod/models', '/pod/search', '/pod/apps', '/pod/data', '/inbox', '/notifications'])(
    '%s requires WebID inside the existing shell', (path) => {
      const elements = routeElements(path);
      const layout = elements.findIndex(element => containsElementType(element, XpodProductLayout));
      const gate = elements.findIndex(element => containsElementType(element, WebIdAuthBoundary));
      expect(layout).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThan(layout);
      expect(elements.filter(element => containsElementType(element, WebIdAuthBoundary))).toHaveLength(1);
      expect(elements.some(element => containsElementType(element, AccountAuthBoundary) || containsElementType(element, AccountWorkspaceBoundary))).toBe(false);
    },
  );
  test.each([
    ['/settings/pod', '/pod/models'], ['/settings/storage', '/pod/data'],
    ['/settings/identity-access', '/pod/apps'], ['/settings/runtime', '/device/runtime'],
    ['/ai-config/search-indexing', '/pod/search'], ['/status/overview', '/device/services'],
  ])('redirects legacy %s to its one canonical owner', (path, target) => {
    const redirect = routeElements(path).at(-1);
    expect(isValidElement(redirect) && redirect.type).toBe(path === '/settings/pod' ? PodManagementTaskRoute : Navigate);
    expect(isValidElement(redirect) && redirect.props.to).toBe(target);
  });
});


describe('explicit Pod deletion operator admission', () => {
  test.each([false, true])('keeps ordinary management behind Account admission: %s', async authenticated => {
    renderPodManagementAdmission('/pod', authenticated);
    if (authenticated) {
      expect(await screen.findByTestId('pod-workspace')).toBeTruthy();
      expect(screen.queryByLabelText('邮箱')).toBeNull();
    } else {
      expect(screen.queryByTestId('pod-workspace')).toBeNull();
      expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    }
  });
  test('admits a deletion task without Account login', () => {
    renderPodManagementAdmission('/pod?deletionAuthorization=opaque.challenge&podName=alice', false);
    expect(screen.getByTestId('pod-workspace')).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
  });
});
