import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { legacyDashboardRedirects } from '../../layout/settings-navigation';
import ServicesPage from './ServicesPage';
import { useServicesStatus } from './services-status-context';
import { serviceNavigationItems } from './services-navigation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/services',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.open = mock(() => null) as unknown as typeof window.open;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function createAdminStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    pid: 123,
    ppid: 1,
    uptime: 42_000,
    env: { CSS_BASE_URL: 'https://pod.example/', XPOD_EDITION: 'local', CSS_PORT: '3000' },
    configs: [{ name: '.env.local', path: '/xpod/.env.local', exists: true }],
    capabilities: {
      services: {
        lifecycle: {
          restart: { supported: false, reason: 'requires_loopback_or_admin_token' },
        },
        configuration: {
          write: { supported: false, reason: 'requires_loopback_or_admin_token' },
        },
      },
    },
    ...overrides,
  };
}

function createAdminConfig(overrides: Record<string, unknown> = {}) {
  return {
    env: {
      CSS_BASE_URL: 'https://pod.example/',
      CSS_PORT: '3000',
      XPOD_TUNNEL_PROVIDER: 'none',
      ...((overrides.env as Record<string, string> | undefined) ?? {}),
    },
    secrets: {},
    configFiles: [{ name: '.env.local', path: '/xpod/.env.local', exists: true }],
    ...overrides,
  };
}

function createDdnsStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    allocated: false,
    fqdn: null,
    baseUrl: 'https://pod.example/',
    mode: 'direct',
    tunnelProvider: 'none',
    ipv4: '192.168.1.24',
    ipv6: null,
    detail: 'direct',
    ...overrides,
  };
}

function createServiceState() {
  return [
    { name: 'css', status: 'running', pid: 10, uptime: 5_000, restartCount: 0 },
    { name: 'api', status: 'running', pid: 11, uptime: 4_000, restartCount: 0 },
  ];
}

function createFetch(
  statusOverrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
  ddnsOverrides: Record<string, unknown> = {},
) {
  return mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/service/status') return jsonResponse(createServiceState());
    if (url === '/api/admin/status') return jsonResponse(createAdminStatus(statusOverrides));
    if (url === '/api/admin/config') return jsonResponse(createAdminConfig(configOverrides));
    if (url.startsWith('/api/admin/public-ip')) {
      return jsonResponse({ status: 'pass', publicIp: '203.0.113.10', baseUrl: 'https://pod.example/', detail: 'reachable' });
    }
    if (url === '/api/admin/ddns') return jsonResponse(createDdnsStatus(ddnsOverrides));
    if (url.startsWith('/api/admin/logs/file')) return jsonResponse({ file: '/tmp/xpod.log', lines: ['ready'] });
    if (url.startsWith('/api/admin/logs')) {
      return jsonResponse({ logs: [{ timestamp: '2026-07-31T00:00:00.000Z', level: 'info', source: 'xpod', message: 'ready' }] });
    }
    if (url.startsWith('/api/admin/rdf/stats')) {
      return jsonResponse({ available: false, engine: 'unsupported', generatedAt: '2026-07-31T00:00:00.000Z', reason: 'not-cloud' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function RuntimeProbe() {
  const servicesStatus = useServicesStatus();
  return (
    <div>
      <h1>Xpod runtime</h1>
      <div>{servicesStatus?.snapshot?.adminData?.pid ?? 'loading'}</div>
      <div>{servicesStatus?.snapshot?.servicesData?.map((service) => service.name).join(',') ?? 'no services'}</div>
    </div>
  );
}

function ConfigurationProbe() {
  const servicesStatus = useServicesStatus();
  if (!servicesStatus?.configurationWriteCapability.supported) {
    return <div>Configuration changes are not supported</div>;
  }
  return (
    <div>
      <button type="button">保存配置</button>
      {servicesStatus.restartCapability.supported ? <button type="button">保存并重启</button> : null}
    </div>
  );
}

function LogsProbe() {
  return <div>Logs probe</div>;
}

async function renderServices(path: string, fetchImpl = createFetch(), product: 'legacy' | 'dashboard' | 'settings' = 'legacy') {
  installDom();
  globalThis.fetch = fetchImpl;
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/services" element={<ServicesPage product={product} />}>
            <Route index element={<RuntimeProbe />} />
            <Route path="runtime" element={<RuntimeProbe />} />
            <Route path="configuration" element={<ConfigurationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  return { container, root, fetchImpl };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe('Services settings navigation', () => {
  test('links runtime status and writable configuration across products', async () => {
    const dashboard = await renderServices('/services', createFetch(), 'dashboard');
    expect(dashboard.container.querySelector('a[href="/settings/services"]')).toBeTruthy();
    await unmount(dashboard.root);

    const settings = await renderServices('/services/configuration', createFetch(), 'settings');
    expect(settings.container.querySelector('a[href="/dashboard/runtime"]')).toBeTruthy();
    await unmount(settings.root);
  });

  test('declares Runtime, Logs, RDF, and Configuration as one services subtree', () => {
    expect(serviceNavigationItems.map((item) => [item.id, item.label, item.path])).toEqual([
      ['runtime', 'Runtime', '/services/runtime'],
      ['logs', 'Logs', '/services/logs'],
      ['rdf', 'RDF', '/services/rdf'],
      ['configuration', 'Configuration', '/services/configuration'],
    ]);
  });

  test('keeps legacy admin URLs pointed at Services routes', () => {
    expect(legacyDashboardRedirects.status).toBe('/services/runtime');
    expect(legacyDashboardRedirects.logs).toBe('/services/logs');
    expect(legacyDashboardRedirects.rdf).toBe('/services/rdf');
    expect(legacyDashboardRedirects.settings).toBe('/services/configuration');
  });

  test('renders services through SDK two-pane slots with runtime data and a single main landmark', async () => {
    const { container, root, fetchImpl } = await renderServices('/services');

    expect(container.querySelector('[data-workspace-layout="two-pane"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('Runtime');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('Logs');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('RDF');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('Configuration');
    expect(container.querySelector('[data-testid="workspace-main-pane"]')?.textContent).toContain('Xpod runtime');
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith('/service/status', expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/status', expect.anything());
    await unmount(root);
  });

  test('uses SDK stack navigation and back-to-list behavior in narrow mode', async () => {
    installDom();
    globalThis.fetch = createFetch();
    const stackContainer = document.getElementById('root');
    if (!stackContainer) throw new Error('missing root');
    const stackRoot = createRoot(stackContainer);

    await act(async () => {
      stackRoot.render(
        <MemoryRouter initialEntries={['/services']}>
          <Routes>
            <Route path="/services" element={<ServicesPage mode="stack" />}>
              <Route index element={<RuntimeProbe />} />
              <Route path="runtime" element={<RuntimeProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const listPane = stackContainer.querySelector('[data-testid="workspace-list-pane"]');
    const mainPane = stackContainer.querySelector('[data-testid="workspace-main-pane"]') as HTMLElement | null;
    expect(listPane).toBeTruthy();
    expect(mainPane?.hidden).toBe(true);

    const runtimeLink = Array.from(stackContainer.querySelectorAll('a')).find((link) => link.textContent?.includes('Runtime'));
    await act(async () => {
      runtimeLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect((stackContainer.querySelector('[data-testid="workspace-list-pane"]') as HTMLElement | null)?.hidden).toBe(true);
    expect((stackContainer.querySelector('[data-testid="workspace-main-pane"]') as HTMLElement | null)?.hidden).toBe(false);
    expect(stackContainer.textContent).toContain('返回列表');
    expect(stackContainer.querySelectorAll('main')).toHaveLength(1);
    await unmount(stackRoot);
  });

  test('opens the main pane for direct stack-mode child routes without reopening after pane back', async () => {
    installDom();
    globalThis.fetch = createFetch();
    const stackContainer = document.getElementById('root');
    if (!stackContainer) throw new Error('missing root');
    const stackRoot = createRoot(stackContainer);

    await act(async () => {
      stackRoot.render(
        <MemoryRouter initialEntries={['/services/logs']}>
          <Routes>
            <Route path="/services" element={<ServicesPage mode="stack" />}>
              <Route index element={<RuntimeProbe />} />
              <Route path="logs" element={<LogsProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect((stackContainer.querySelector('[data-testid="workspace-list-pane"]') as HTMLElement | null)?.hidden).toBe(true);
    expect((stackContainer.querySelector('[data-testid="workspace-main-pane"]') as HTMLElement | null)?.hidden).toBe(false);
    expect(stackContainer.textContent).toContain('Logs probe');

    const backButton = Array.from(stackContainer.querySelectorAll('button')).find((button) => button.textContent?.includes('返回列表'));
    await act(async () => {
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect((stackContainer.querySelector('[data-testid="workspace-list-pane"]') as HTMLElement | null)?.hidden).toBe(false);
    expect((stackContainer.querySelector('[data-testid="workspace-main-pane"]') as HTMLElement | null)?.hidden).toBe(true);
    await unmount(stackRoot);
  });

  test('checks public reachability against the resolved DDNS access URL', async () => {
    const fetchImpl = createFetch({}, {}, {
      enabled: true,
      allocated: true,
      fqdn: 'edge.example.test',
      baseUrl: 'https://edge.example.test/',
      mode: 'managed-ddns',
    });
    const { root } = await renderServices('/services', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/admin/public-ip?baseUrl=https%3A%2F%2Fedge.example.test%2F',
      expect.anything(),
    );
    await unmount(root);
  });

  test('shows lifecycle and configuration actions only when status capability supports them', async () => {
    const unsupported = await renderServices('/services/configuration', createFetch());
    expect(unsupported.container.textContent).toContain('Configuration changes are not supported');
    expect(Array.from(unsupported.container.querySelectorAll('button')).some((button) => button.textContent?.includes('保存配置'))).toBe(false);
    expect(Array.from(unsupported.container.querySelectorAll('button')).some((button) => button.textContent?.includes('保存并重启'))).toBe(false);
    await unmount(unsupported.root);

    const supported = await renderServices('/services/configuration', createFetch({
      capabilities: {
        services: {
          lifecycle: { restart: { supported: true } },
          configuration: { write: { supported: true } },
        },
      },
    }));
    expect(Array.from(supported.container.querySelectorAll('button')).some((button) => button.textContent?.includes('保存配置'))).toBe(true);
    expect(Array.from(supported.container.querySelectorAll('button')).some((button) => button.textContent?.includes('保存并重启'))).toBe(true);
    await unmount(supported.root);
  });

  test('owns one status poll, aborts pending status requests on exit, and ignores stale responses under StrictMode', async () => {
    installDom();
    const intervalIds: number[] = [];
    const clearedIds: number[] = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = originalSetInterval(handler, timeout, ...args) as unknown as number;
      intervalIds.push(id);
      return id as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: number | NodeJS.Timeout) => {
      clearedIds.push(id as number);
      return originalClearInterval(id);
    }) as typeof clearInterval;

    const abortSignals: AbortSignal[] = [];
    let resolveOld!: () => void;
    const staleFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) abortSignals.push(init.signal);
      if (String(input) === '/api/admin/status') {
        await new Promise<void>((resolve) => {
          resolveOld = resolve;
        });
        return jsonResponse(createAdminStatus({ pid: 999 }));
      }
      return createFetch()(input);
    }) as typeof fetch;
    globalThis.fetch = staleFetch;

    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <MemoryRouter initialEntries={['/services']}>
            <Routes>
              <Route path="/services" element={<ServicesPage />}>
                <Route index element={<RuntimeProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </StrictMode>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      root.unmount();
      resolveOld();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(intervalIds.length).toBeGreaterThanOrEqual(1);
    expect(clearedIds.length).toBe(intervalIds.length);
    expect(abortSignals.some((signal) => signal.aborted)).toBe(true);
    expect(container.textContent).not.toContain('999');

    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
});
