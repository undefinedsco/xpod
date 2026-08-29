import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import { XpodAuthContext, type XpodAuthValue } from '../../auth/useXpodAuth';
import ModelsPage from './ModelsPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const test = it;
const mock = vi.fn;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function installDom(fetchImpl: typeof fetch) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/models',
  });
  dom.window.fetch = fetchImpl;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.matchMedia = mock(() => ({
    matches: false,
    media: '(max-width: 767px)',
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
  })) as unknown as typeof window.matchMedia;
}

async function renderModelsPage(runtime: XpodSolidRuntimeValue) {
  installDom(runtime.fetch);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodAuthContext.Provider value={{ startLogin: mock(async () => undefined) } as XpodAuthValue}>
        <XpodSolidRuntimeContext.Provider value={runtime}>
          <ModelsPage />
        </XpodSolidRuntimeContext.Provider>
      </XpodAuthContext.Provider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

function runtimeWith(fetchImpl: typeof fetch): XpodSolidRuntimeValue {
  return {
    session: {
      fetch: fetchImpl,
      getSnapshot: () => ({ status: 'authenticated', webId: WEB_ID }),
      subscribe: () => () => undefined,
    } as unknown as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: fetchImpl,
    state: { status: 'authenticated', webId: WEB_ID, podUrl: POD_URL },
    webId: WEB_ID,
    podUrl: POD_URL,
    currentPod: {
      podUrl: POD_URL,
      webId: WEB_ID,
      database: createEmptyPodDatabase(),
    } as unknown as XpodSolidRuntimeValue['currentPod'],
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
  };
}

function createEmptyPodDatabase() {
  return {
    init: mock(async () => undefined),
    select: () => ({
      from: () => ({ execute: async () => [] }),
    }),
  } as never;
}
describe('ModelsPage AI Connection host', () => {
  test('mounts AI Connection with caller-owned Pod access and aligned slots', async () => {
    let serviceAccessCalls = 0;
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        serviceAccessCalls += 1;
        throw new Error('AI Connections settings must not request service access in an interactive browser session');
      }
      expect(new Headers(init?.headers).get('authorization')).not.toBe('Bearer xpod_inv_v1.page-token');
      if (url.endsWith('/api/ai/connections/providers')) {
        return new Response(JSON.stringify({
          data: [
            { provider: 'openai', status: 'connected', authMode: 'apiKey', connect: { modes: ['browserAssistedApiKey'], configured: true } },
            { provider: 'anthropic', status: 'connected', authMode: 'browserAssistedApiKey', connect: { modes: ['browserAssistedApiKey'], configured: true } },
            { provider: 'kimi', status: 'disconnected', connect: { modes: ['deviceCodeOAuth'], configured: true } },
            { provider: 'bailian', status: 'disconnected', connect: { modes: ['browserAssistedApiKey'], configured: true } },
            { provider: 'deepseek', status: 'disconnected', connect: { modes: ['connectUnsupported'], configured: false, message: 'unsupported' } },
          ],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const { container, root } = await renderModelsPage(runtimeWith(fetchImpl));

    expect(container.querySelector('[data-workspace-layout="two-pane"]')).toBeTruthy();
    expect(container.querySelector('[data-workspace-list-header="true"]')).toBeTruthy();
    expect(container.querySelector('[data-workspace-main-header="true"]')).toBeTruthy();
    expect(container.querySelector('[data-workspace-list-header="true"] input[aria-label="搜索 Provider"]')).toBeTruthy();
    expect(container.querySelector('[data-workspace-list-header="true"] button[aria-label="添加 AI Connection"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('OpenAI');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('Anthropic');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('Kimi');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('百炼');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('DeepSeek');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).toContain('API Keys');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).not.toContain('出口');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).not.toContain('客户端接入');
    expect(container.querySelector('[data-testid="workspace-list-pane"]')?.textContent).not.toContain('虚拟密钥');
    expect(container.querySelector('[data-testid="workspace-main-pane"]')?.textContent).toContain('创建并复制配置');
    expect(container.querySelector('[data-workspace-main-header="true"]')?.textContent).toContain('API KEYS');
    expect(serviceAccessCalls).toBe(0);
    await unmount(root);
  });
});
