import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import App from '../../ui/admin/src/App';
import { render, flushPromises } from './testUtils';

const originalFetch = global.fetch;

describe('App', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // @ts-expect-error allow undefined restoration
      delete global.fetch;
    }
  });

  it('加载配置后展示节点导航', async () => {
    const payload = {
      edition: 'cluster',
      features: { quota: true, nodes: true },
      baseUrl: 'https://pods.example.com/',
      signalEndpoint: 'wss://signal.example/register',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;

    const { container, unmount } = render(<App />);
    await flushPromises();

    try {
      const nav = Array.from(container.querySelectorAll('nav a'));
      const texts = nav.map((item) => item.textContent ?? '');
      expect(texts).toContainEqual(expect.stringContaining('Edge Nodes'));
    } finally {
      unmount();
    }
  });

  it('请求失败时不展示节点导航', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('error', { status: 500 })) as any;

    const { container, unmount } = render(<App />);
    await flushPromises();

    try {
      const nav = Array.from(container.querySelectorAll('nav a'));
      const texts = nav.map((item) => item.textContent ?? '');
      expect(texts.some((text) => text.includes('Edge Nodes'))).toBe(false);
    } finally {
      unmount();
    }
  });

  it('本地模式下清除空白字段并保留节点路由', async () => {
    const payload = {
      edition: 'local',
      features: { quota: false, nodes: true },
      baseUrl: '   ',
      signalEndpoint: '',
    };

    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;

    const { container, unmount } = render(<App />);
    await flushPromises();

    try {
      const nav = Array.from(container.querySelectorAll('nav a'));
      const texts = nav.map((item) => item.textContent ?? '');
      expect(texts.some((text) => text.includes('Edge Nodes'))).toBe(true);
      expect(container.textContent).toContain('Local Edition');
      expect(container.textContent).toContain('Cluster-only feature');
    } finally {
      unmount();
    }
  });
});
