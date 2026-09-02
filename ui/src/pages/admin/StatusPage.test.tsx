import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { ServicesStatusSnapshot } from '../../api/admin';
import { ServicesStatusContext, type ServicesStatusContextValue } from '../settings/services-status-context';
import { StatusPage } from './StatusPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/services/runtime',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.open = mock(() => null) as unknown as typeof window.open;
  Object.assign(globalThis.navigator, {
    clipboard: {
      writeText: mock(async () => undefined),
    },
  });
}

function createSnapshot(): ServicesStatusSnapshot {
  return {
    servicesData: [
      { name: 'css', status: 'running', pid: 10, uptime: 65_000, restartCount: 0 },
      { name: 'api', status: 'running', pid: 11, uptime: 61_000, restartCount: 0 },
    ],
    adminData: {
      status: 'running',
      pid: 123,
      ppid: 1,
      uptime: 120_000,
      env: { CSS_BASE_URL: 'https://pod.example/', XPOD_EDITION: 'local', CSS_PORT: '3000' },
      configs: [{ name: '.env.local', path: '/xpod/.env.local', exists: true }],
    },
    configData: {
      env: {
        CSS_BASE_URL: 'https://pod.example/',
        CSS_PORT: '3000',
        XPOD_TUNNEL_PROVIDER: 'frp',
        FRP_TUNNEL_URL: 'https://tunnel.example/',
      },
      secrets: {},
      configFiles: [{ name: '.env.local', path: '/xpod/.env.local', exists: true }],
    },
    ddnsData: {
      enabled: true,
      allocated: true,
      fqdn: 'pod.example',
      baseUrl: 'https://pod.example/',
      mode: 'tunnel',
      tunnelProvider: 'frp',
      ipv4: '192.168.1.24',
      ipv6: null,
      detail: 'tunnel active',
    },
    publicCheck: {
      status: 'pass',
      publicIp: '203.0.113.10',
      baseUrl: 'https://pod.example/',
      detail: 'reachable',
    },
    checkedAt: new Date('2026-08-12T00:00:00.000Z'),
  };
}

function createLocalOnlySnapshot(): ServicesStatusSnapshot {
  const snapshot = createSnapshot();
  return {
    ...snapshot,
    adminData: snapshot.adminData ? {
      ...snapshot.adminData,
      env: { ...snapshot.adminData.env, CSS_BASE_URL: 'http://127.0.0.1:3000/' },
    } : null,
    configData: snapshot.configData ? {
      ...snapshot.configData,
      env: { ...snapshot.configData.env, CSS_BASE_URL: 'http://127.0.0.1:3000/' },
    } : null,
    ddnsData: null,
    publicCheck: {
      status: 'fail',
      publicIp: '203.0.113.10',
      baseUrl: 'http://127.0.0.1:3000/',
      detail: 'Base URL 为本地/内网地址，默认不可直连。',
    },
  };
}

function createExternalFailureSnapshot(): ServicesStatusSnapshot {
  const snapshot = createSnapshot();
  return {
    ...snapshot,
    publicCheck: {
      status: 'fail',
      publicIp: '203.0.113.10',
      baseUrl: 'https://pod.example/',
      detail: '公网入口探测失败。',
    },
  };
}

function createServiceFailureSnapshot(): ServicesStatusSnapshot {
  const snapshot = createSnapshot();
  return {
    ...snapshot,
    servicesData: snapshot.servicesData?.map((service) => (
      service.name === 'api' ? { ...service, status: 'stopped' } : service
    )) ?? null,
  };
}

async function renderStatusPage(snapshot = createSnapshot()) {
  installDom();
  const context: ServicesStatusContextValue = {
    snapshot,
    loading: false,
    refreshing: false,
    refresh: mock(() => undefined),
    restartCapability: { supported: false },
    configurationWriteCapability: { supported: false },
  };
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ServicesStatusContext.Provider value={context}>
          <StatusPage />
        </ServicesStatusContext.Provider>
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe('StatusPage overview runtime layout', () => {
  test('treats a local-only installation as usable instead of asking the user to repair Public access', async () => {
    const { container, root } = await renderStatusPage(createLocalOnlySnapshot());

    expect(container.textContent).toContain('Xpod runtime');
    expect(container.textContent).toContain('目前可以在本机或局域网使用');
    expect(container.textContent).not.toContain('需要处理');
    expect(container.textContent).not.toContain('Public 当前不可用');
    expect(container.textContent).not.toContain('Base URL 为本地/内网地址');
    expect(container.textContent).not.toContain('打开日志');

    await unmount(root);
  });

  test('explains a configured external route failure and sends the user to Network settings', async () => {
    const { container, root } = await renderStatusPage(createExternalFailureSnapshot());

    expect(container.textContent).toContain('外部访问异常');
    expect(container.textContent).toContain('Xpod 在本机运行正常，但从外网暂时无法访问');
    expect(container.textContent).toContain('打开网络设置');
    expect(container.textContent).not.toContain('打开日志');

    await unmount(root);
  });

  test('reserves the log action for an actual core service failure', async () => {
    const { container, root } = await renderStatusPage(createServiceFailureSnapshot());

    expect(container.textContent).toContain('服务异常');
    expect(container.textContent).toContain('Solid Server 或 API Server 未运行');
    expect(container.textContent).toContain('查看日志');

    await unmount(root);
  });

  test('keeps only global icon actions in the header and colocates entry actions with its URL', async () => {
    const { container, root } = await renderStatusPage();

    const actions = container.querySelector('[data-testid="status-page-actions"]');
    expect(actions?.className).toContain('items-center');
    expect(actions?.className).toContain('lg:shrink-0');

    const buttons = Array.from(actions?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '刷新状态',
      '复制状态 JSON',
    ]);
    expect(buttons.every((button) => button.textContent?.trim() === '')).toBe(true);
    expect(buttons.every((button) => button.className.includes('h-9'))).toBe(true);
    expect(buttons.every((button) => button.className.includes('w-9'))).toBe(true);

    const entryRow = container.querySelector('[data-testid="stable-entry-row"]');
    expect(entryRow?.textContent).toContain('https://pod.example/');
    const entryButtons = Array.from(entryRow?.querySelectorAll('button') ?? []);
    expect(entryButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '复制入口 URL',
      '打开入口',
    ]);
    expect(entryButtons.every((button) => button.textContent?.trim() === '')).toBe(true);
    expect(container.querySelectorAll('button[aria-label="打开入口"]')).toHaveLength(1);

    await unmount(root);
  });

  test('renders services as three vertical service rows and keeps tunnel out of services', async () => {
    const { container, root } = await renderStatusPage();

    const servicesList = container.querySelector('[data-testid="runtime-services-list"]');
    expect(servicesList?.className).toContain('divide-y');
    expect(servicesList?.className).not.toContain('grid-cols');

    const serviceRows = Array.from(container.querySelectorAll('[data-testid="runtime-service-row"]'));
    expect(serviceRows).toHaveLength(3);
    expect(serviceRows.map((row) => row.getAttribute('data-service-name'))).toEqual([
      'Gateway',
      'Solid Server',
      'API Server',
    ]);
    expect(servicesList?.textContent).not.toContain('Tunnel');
    expect(container.querySelector('[data-testid="runtime-access-paths"]')?.textContent).toContain('用户隧道');

    await unmount(root);
  });

  test('renders all access paths as one vertical row list', async () => {
    const { container, root } = await renderStatusPage();

    const pathList = container.querySelector('[data-testid="runtime-access-path-list"]');
    expect(pathList?.className).toContain('divide-y');
    expect(pathList?.className).not.toContain('grid-cols');

    const pathRows = Array.from(container.querySelectorAll('[data-testid="runtime-access-path-row"]'));
    expect(pathRows).toHaveLength(5);
    expect(pathRows.map((row) => row.getAttribute('data-route-name'))).toEqual([
      'Loopback',
      'LAN',
      'Public',
      'User tunnel',
      'P2P backup',
    ]);
    expect(pathRows.every((row) => row.className.includes('sm:flex-row'))).toBe(true);

    await unmount(root);
  });
});
