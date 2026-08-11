import { describe, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { JSDOM } from 'jsdom';
import { isValidElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Navigate, matchRoutes, useLocation, useRoutes } from 'react-router-dom';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { dashboardRoutes } from './dashboard-routes';
import { AccountAuthBoundary } from './auth/AccountAuthBoundary';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import { SettingsAuthBoundary } from './solid/SettingsAuthBoundary';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import { DashboardApp } from './DashboardApp';

const mock = vi.fn;

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

function protectedElementFor(path: string) {
  return matchRoutes(dashboardRoutes, path)
    ?.map((match) => match.route.element)
    .find((element) => containsElementType(element, AccountAuthBoundary));
}

function redirectTargetFor(path: string) {
  const element = routeElementFor(path);
  if (!isValidElement(element) || element.type !== Navigate) return null;
  return element.props.to;
}

function containsElementType(element: unknown, type: unknown): boolean {
  if (!isValidElement(element)) return false;
  if (element.type === type) return true;
  const children = element.props?.children;
  return Array.isArray(children)
    ? children.some((child) => containsElementType(child, type))
    : containsElementType(children, type);
}

function installDom(path: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `https://app.example/dashboard${path}`,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.fetch = mock(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
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
      <XpodSolidRuntimeProvider value={runtime}>
        <XpodAuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <TestRoutes />
          </MemoryRouter>
        </XpodAuthProvider>
      </XpodSolidRuntimeProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await waitFor(() => expect(container.textContent).toContain('Sign in to Xpod'));

  return { container, root, session, sessionConstructions };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe('dashboard routes', () => {
  test('reuses a callback-provided runtime instead of creating a second browser session', async () => {
    installDom('/overview');
    let sessionConstructions = 0;
    const session = new FakeSession();
    const runtime = createXpodSolidRuntimeValue({
      sessionFactory: () => {
        sessionConstructions += 1;
        return session;
      },
    });
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);

    await act(async () => {
      root.render(<DashboardApp runtime={runtime} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sessionConstructions).toBe(1);
    expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
    await unmount(root);
  });

  test('redirects the dashboard index to Overview', () => {
    expect(redirectTargetFor('/')).toBe('overview');
  });

  test('owns the read-oriented observability routes', () => {
    expect(routeElementFor('/overview')).toBeTruthy();
    expect(routeElementFor('/runtime')).toBeTruthy();
    expect(routeElementFor('/logs')).toBeTruthy();
    expect(routeElementFor('/rdf')).toBeTruthy();
    expect(routeElementFor('/network')).toBeTruthy();
    expect(routeElementFor('/usage')).toBeTruthy();
  });

  test('uses the Account boundary for protected routes instead of the Solid provider chooser', () => {
    const element = protectedElementFor('/overview');
    expect(isValidElement(element)).toBe(true);
    expect(containsElementType(element, AccountAuthBoundary)).toBe(true);
    expect(containsElementType(element, SettingsAuthBoundary)).toBe(false);
  });

  test('does not own canonical settings sections', () => {
    expect(redirectTargetFor('/models')).toBe('../overview');
    expect(redirectTargetFor('/pod')).toBe('../overview');
    expect(redirectTargetFor('/services')).toBe('../overview');
  });

  test('keeps index, alias, and wildcard redirects relative inside the dashboard basename', () => {
    for (const [path, target] of [['/', 'overview'], ['/status', 'overview'], ['/unknown', '../overview']]) {
      expect(redirectTargetFor(path)).toBe(target);
      expect(redirectTargetFor(path)).not.toMatch(/^\//u);
    }
  });

  test('normalizes anonymous dashboard redirects before the Account auth guard', async () => {
    const cases = [
      ['/', '/overview'],
      ['/status', '/overview'],
      ['/dashboard.html', '/overview'],
    ];

    for (const [from, to] of cases) {
      const { container, root, session, sessionConstructions } = await renderDashboardRoute(from);

      expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(to);
      expect(container.textContent).toContain('Sign in to Xpod');
      expect(container.textContent).not.toContain('Cloud');
      expect(container.textContent).not.toContain('Add provider');
      expect(container.textContent).not.toContain('Solid issuer');
      expect(sessionConstructions).toBe(1);
      expect(session.handleIncomingRedirect).toHaveBeenCalledTimes(1);
      await unmount(root);
    }
  });

  test('keeps the Status workspace mounted behind the anonymous Account login modal', async () => {
    const { container, root } = await renderDashboardRoute('/overview');

    expect(container.textContent).toContain('Sign in to Xpod');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector('[data-list-navigation]')).toBeTruthy();
    expect(container.querySelector('[data-list-navigation]')?.textContent).toContain('Overview');
    expect(container.textContent).toContain('Status · Overview');

    await unmount(root);
  });
});
