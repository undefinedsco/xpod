import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { isValidElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Navigate, matchRoutes, useLocation, useRoutes } from 'react-router-dom';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { dashboardRoutes, networkSurfaceRoutes, statusSurfaceRoutes } from './dashboard-routes';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import { AuthContext, type AuthContextType } from './context/AuthContextValue';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Listener = (...args: unknown[]) => void;

class FakeSession implements SolidSessionAdapter {
  readonly fetch = mock(async () => new Response('ok'));
  readonly handleIncomingRedirect = mock(async () => this.info);
  readonly login = mock(async () => undefined);
  readonly logout = mock(async () => undefined);
  readonly info: SolidSessionAdapter['info'] = { isLoggedIn: false };
  private readonly listeners = new Map<string, Set<Listener>>();

  readonly events = {
    on: (event: string, listener: Listener) => {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    },
    off: (event: string, listener: Listener) => {
      this.listeners.get(event)?.delete(listener);
    },
  } as SolidSessionAdapter['events'];
}

function routeElementFor(path: string) {
  const matches = matchRoutes(dashboardRoutes, path);
  return matches?.at(-1)?.route.element;
}

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

function installDom(path: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `https://app.example/dashboard${path}`,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { assign: mock(() => undefined) },
  });
  return dom;
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function TestRoutes() {
  const routes = useRoutes([
    ...dashboardRoutes,
    { path: '*', element: <LocationProbe /> },
  ]);
  return (
    <>
      <LocationProbe />
      {routes}
    </>
  );
}

async function renderDashboardRoute(path: string) {
  installDom(path);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  let sessionConstructions = 0;
  const session = new FakeSession();
  const runtime = createXpodSolidRuntimeValue({
    sessionFactory: () => {
      sessionConstructions += 1;
      return session;
    },
  });
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <AuthContext.Provider value={{
        controls: {}, isInitializing: false, initError: null, idpIndex: '/.account/', isLoggedIn: false,
        authenticating: false, hasOidcPending: false, refetchControls: mock(async () => undefined),
      } satisfies AuthContextType}>
        <XpodSolidRuntimeProvider value={runtime}>
          <MemoryRouter initialEntries={[path]}>
            <TestRoutes />
          </MemoryRouter>
        </XpodSolidRuntimeProvider>
      </AuthContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { container, root, session, sessionConstructions };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe('dashboard routes', () => {
  test('exposes canonical Status and Network surface route trees', () => {
    expect(matchRoutes(statusSurfaceRoutes, '/overview')).toBeTruthy();
    expect(matchRoutes(statusSurfaceRoutes, '/services/gateway')).toBeTruthy();
    expect(matchRoutes(statusSurfaceRoutes, '/index/vector')).toBeTruthy();
    expect(matchRoutes(networkSurfaceRoutes, '/diagnostics')).toBeTruthy();
  });
  test('redirects the dashboard index to Overview', () => {
    expect(redirectTargetFor('/')).toBe('/overview');
  });

  test('owns the read-oriented observability routes', () => {
    for (const path of [
      '/overview', '/services/gateway', '/services/solid-server', '/services/api-server', '/logs',
      '/index', '/index/rdf', '/index/fts', '/index/vector', '/index/retrieval-points', '/index/cache', '/index/slow-queries', '/index/benchmark',
      '/network', '/network/endpoints', '/network/addresses', '/network/domain-dns', '/network/https', '/network/tunnel-profiles', '/network/p2p', '/network/diagnostics',
      '/usage', '/usage/storage', '/usage/bandwidth', '/usage/ai', '/usage/index-storage',
    ]) expect(routeElementFor(path)).toBeTruthy();
    expect(redirectTargetFor('/runtime')).toBe('/overview');
    expect(redirectTargetFor('/rdf')).toBe('/index/rdf');
  });

  test('does not own canonical settings sections', () => {
    expect(redirectTargetFor('/models')).toBe('/overview');
    expect(redirectTargetFor('/pod')).toBe('/overview');
    expect(redirectTargetFor('/services')).toBe('/overview');
  });

  test('normalizes anonymous dashboard routes before the account boundary', async () => {
    const cases = [
      ['/', '/overview'],
      ['/status', '/overview'],
      ['/dashboard.html', '/overview'],
    ];

    for (const [from, to] of cases) {
      const { container, root, session, sessionConstructions } = await renderDashboardRoute(from);

      expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(to);
      expect(sessionStorage.getItem('xpod:returnTo')).toBe(to);
      expect(container.textContent).not.toContain('登录 Xpod Dashboard');
      expect(sessionConstructions).toBe(1);
      expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
      await unmount(root);
    }
  });
});
