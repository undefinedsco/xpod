import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import ModelsPage from './ModelsPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const test = it;
const mock = vi.fn;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/models',
  });
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
  installDom();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <ModelsPage />
      </XpodSolidRuntimeContext.Provider>,
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
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: fetchImpl,
    state: { status: 'authenticated', webId: WEB_ID, podUrl: POD_URL },
    webId: WEB_ID,
    podUrl: POD_URL,
    currentPod: { podUrl: POD_URL } as XpodSolidRuntimeValue['currentPod'],
    login: mock(async () => undefined),
    logout: mock(async () => undefined),
  };
}

function serviceAccessPayload() {
  return {
    appletId: 'co.undefineds.ai-connection',
    service: {
      webId: 'https://pod.example/service/profile/card#me',
      label: 'Xpod AI Connection',
    },
    resources: [
      {
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      },
    ],
    invocation: {
      gatewayKey: 'xpod_inv_v1.page-token',
    },
  };
}

describe('ModelsPage AI Connection host', () => {
  test('mounts AI Connection into aligned list and main header slots', async () => {
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/applets/service-access/ai-connection')) {
        return new Response(JSON.stringify(serviceAccessPayload()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xpod_inv_v1.page-token');
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
    expect(container.querySelector('[data-testid="workspace-main-pane"]')?.textContent).toContain('服务访问已授权');
    expect(container.querySelector('[data-workspace-main-header="true"]')?.textContent).toContain('OpenAI');
    await unmount(root);
  });
});
