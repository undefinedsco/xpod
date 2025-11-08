import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { NodesPage } from '../../ui/admin/src/pages/NodesPage';
import { AdminConfigContext, type AdminConfig } from '../../ui/admin/src/context/AdminConfigContext';
import { render, flushPromises } from './testUtils';

const baseConfig: AdminConfig = {
  edition: 'cluster',
  features: { quota: true, nodes: true },
  baseUrl: 'https://pods.example.com/',
  signalEndpoint: 'wss://signal.example/register',
};

const originalFetch = global.fetch;

function renderWithConfig(config: AdminConfig) {
  return render(
    <AdminConfigContext.Provider value={config}>
      <NodesPage />
    </AdminConfigContext.Provider>,
  );
}

async function settle(): Promise<void> {
  await flushPromises();
  await flushPromises();
}

describe('NodesPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // @ts-expect-error allow cleanup
      delete global.fetch;
    }
  });

  it('节点功能关闭时显示提示', async () => {
    const { container, unmount } = renderWithConfig({
      ...baseConfig,
      features: { quota: true, nodes: false },
    });

    try {
      await settle();
      expect(container.textContent).toContain('Edge node registry is disabled');
    } finally {
      unmount();
    }
  });

  it('成功加载节点列表', async () => {
    const nodesPayload = {
      nodes: [
        {
          nodeId: 'node-1',
          displayName: 'Shanghai Node',
          podCount: 3,
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSeen: '2024-01-02T00:00:00.000Z',
          metadata: {
            publicAddress: 'https://edge-1.example/',
            status: 'online',
            pods: [ 'https://pods.example.com/alice/' ],
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(nodesPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as any;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      const table = container.querySelector('table');
      expect(table).not.toBeNull();
      expect(table?.textContent).toContain('Shanghai Node');
      expect(table?.textContent).toContain('node-1');
      expect(table?.textContent).toContain('3');
      expect(table?.textContent).toContain('https://edge-1.example/');
      expect(table?.textContent).toContain('online');
    } finally {
      unmount();
    }
  });

  it('加载失败时显示错误', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('denied', { status: 403 })) as any;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      expect(container.textContent).toContain('Unauthorized. Please sign in with an administrator account.');
    } finally {
      unmount();
    }
  });

  it('提交创建请求并显示令牌', async () => {
    const now = '2024-02-01T12:00:00.000Z';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodeId: 'node-2', token: 'token-xyz', createdAt: now }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    global.fetch = fetchMock as any;

    const clipboardWrite = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
    });

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();

      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeTruthy();
      act(() => {
        input.value = '  Beijing Node  ';
        Simulate.change(input);
      });

      const form = container.querySelector('form');
      expect(form).toBeTruthy();

      act(() => {
        Simulate.submit(form!);
      });

      await settle();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const postInit = fetchMock.mock.calls[1][1] as RequestInit;
      expect(postInit.method).toBe('POST');
      expect(JSON.parse(postInit.body as string)).toEqual({ displayName: 'Beijing Node' });

      const tokenBlock = Array.from(container.querySelectorAll('dl')).find((element) =>
        element.textContent?.includes('Registration token'),
      );
      expect(tokenBlock?.textContent).toContain('node-2');
      expect(tokenBlock?.textContent).toContain('token-xyz');

      const copyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Copy'));
      expect(copyButton).toBeTruthy();
      act(() => {
        Simulate.click(copyButton!);
      });
      expect(clipboardWrite).toHaveBeenCalledWith('token-xyz');
    } finally {
      unmount();
      // @ts-expect-error cleanup clipboard mock
      delete navigator.clipboard;
    }
  });

  it('创建失败时显示错误信息', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'custom error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }));

    global.fetch = fetchMock as any;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      const form = container.querySelector('form');
      expect(form).toBeTruthy();
      act(() => {
        Simulate.submit(form!);
      });
      await settle();

      expect(container.textContent).toContain('custom error');
    } finally {
      unmount();
    }
  });

  it('创建失败返回无效 JSON 时显示默认提示', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));

    global.fetch = fetchMock as any;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      const form = container.querySelector('form');
      expect(form).toBeTruthy();
      act(() => {
        Simulate.submit(form!);
      });
      await settle();

      expect(container.textContent).toContain('Failed to create node (status 500).');
    } finally {
      unmount();
    }
  });

  it('加载节点时请求抛出异常', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('boom')) as any;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      expect(container.textContent).toContain('boom');
    } finally {
      unmount();
    }
  });

  it('复制按钮在剪贴板不可用时隐藏', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodeId: 'node-2', token: 'token-xyz', createdAt: '2024-02-01T12:00:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    global.fetch = fetchMock as any;

    const originalClipboard = navigator.clipboard;
    // @ts-expect-error override clipboard for test
    delete navigator.clipboard;

    const { container, unmount } = renderWithConfig(baseConfig);

    try {
      await settle();
      const form = container.querySelector('form');
      expect(form).toBeTruthy();
      act(() => {
        Simulate.submit(form!);
      });
      await settle();

      const copyButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Copy'));
      expect(copyButton).toBeUndefined();
    } finally {
      unmount();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', {
          value: originalClipboard,
          configurable: true,
        });
      }
    }
  });
});
