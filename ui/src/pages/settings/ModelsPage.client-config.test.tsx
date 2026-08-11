import { JSDOM } from 'jsdom';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../../solid/XpodSolidRuntime';
import { createXpodAiClientConfigurationBridge } from '../../api/ai-connections';
import ModelsPage from './ModelsPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const POD_URL = 'https://pod.example/alice/';

describe('ModelsPage coding-client configuration capability', () => {
  it('uses the Xpod client-config API for preview, apply, and verification without exposing provider credentials', async () => {
    const calls: Array<{ path: string; method: string; authorization: string | null; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ path: url.pathname, method, authorization: new Headers(init?.headers).get('authorization'), body });
      if (url.pathname === '/.account/') {
        return json({ clientCredentials: {} });
      }
      if (url.pathname === '/.account/client-credentials/' && method === 'POST') {
        return json({
          id: 'cc_1',
          secret: 'cc_secret',
          resource: 'client-credentials/cc_1/',
        }, { status: 201 });
      }
      if (url.pathname === '/api/applets/service-access/ai-connections') {
        return json({
          appletId: 'co.undefineds.ai-connections',
          service: { webId: 'https://pod.example/service#me', label: 'Xpod AI Connection' },
          resources: [{
            id: 'providerCredentials',
            url: 'https://pod.example/alice/settings/credentials.ttl',
            mediaType: 'text/turtle',
            access: { read: true, append: true, write: true },
          }],
          invocation: {
            baseUrl: 'https://pod.example',
            token: 'xpod_inv_v1.client-config-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        });
      }
      if (url.pathname === '/api/ai/connections/providers') {
        return json({ data: [{ provider: 'openai', status: 'connected', connect: { modes: ['browserAssistedApiKey'], configured: true } }] });
      }
      if (url.pathname === '/v1/models') {
        return json({ data: [{ id: 'openai/gpt-5', object: 'model' }] });
      }
      if (url.pathname.startsWith('/api/ai/client-configuration/')) {
        if (url.pathname.endsWith('/plan')) {
          return json({
            planId: 'aicfg_plan_1',
            client: 'codex',
            changes: [{ target: '~/.codex/config.toml', action: 'update', backup: true }],
          });
        }
        if (url.pathname.endsWith('/apply')) {
          expect(body).toMatch(/"apiKey":"sk-[^"]+"/u);
          expect(body).not.toContain('sk-provider-secret');
          return json({ applied: true });
        }
        if (url.pathname.endsWith('/verify')) {
          return json({ status: 'configured', message: 'Codex verified' });
        }
        return json({ status: 'notConfigured', message: 'Codex detected' });
      }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    }) as typeof fetch;

    const { container, root } = await renderModelsPage(runtimeWith(fetchImpl, true));

    await waitForText(container, 'Codex');
    await act(async () => {
      clickButton(container, '配置', 1);
      await delay(30);
    });
    expect(container.textContent).toContain('~/.codex/config.toml');
    await act(async () => {
      clickButton(container, '应用更改');
      await delay(50);
    });

    const plannedClientPath = calls.find((call) => call.path.endsWith('/plan'))?.path.replace(/\/plan$/u, '');
    expect(plannedClientPath).toMatch(/^\/api\/ai\/client-configuration\/(codex|claude-code|pi|codebuddy)$/u);
    expect(calls.map((call) => [call.method, call.path])).toContainEqual(['POST', `${plannedClientPath}/plan`]);
    expect(calls.map((call) => [call.method, call.path])).toContainEqual(['POST', `${plannedClientPath}/apply`]);
    expect(calls.map((call) => [call.method, call.path])).toContainEqual(['POST', `${plannedClientPath}/verify`]);
    expect(calls.filter((call) => call.path.startsWith('/api/ai/client-configuration/')).every((call) => call.authorization === 'Bearer xpod_inv_v1.client-config-token')).toBe(true);
    expect(container.textContent).not.toContain('xpod_gw_once');
    expect(JSON.stringify(calls)).not.toContain('sk-provider-secret');
    await unmount(root);
  });

  it('shows the manual unavailable state when the host has no filesystem capability', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/applets/service-access/ai-connections') {
        return json({
          appletId: 'co.undefineds.ai-connections',
          service: { webId: 'https://pod.example/service#me', label: 'Xpod AI Connection' },
          resources: [{
            id: 'providerCredentials',
            url: 'https://pod.example/alice/settings/credentials.ttl',
            mediaType: 'text/turtle',
            access: { read: true, append: true, write: true },
          }],
          invocation: { token: 'xpod_inv_v1.no-filesystem' },
        });
      }
      if (url.pathname === '/api/ai/connections/providers') {
        return json({ data: [{ provider: 'openai', status: 'connected', connect: { modes: ['browserAssistedApiKey'], configured: true } }] });
      }
      if (url.pathname === '/v1/models') {
        return json({ data: [] });
      }
      if (url.pathname.startsWith('/api/ai/client-configuration/')) {
        return json({ error: 'Insufficient permissions' }, { status: 403 });
      }
      return json({ data: [] });
    }) as typeof fetch;

    const { container, root } = await renderModelsPage(runtimeWith(fetchImpl));

    await waitForText(container, 'Host does not support local client configuration');
    expect(container.textContent).not.toContain('应用 Codex 配置');
    await unmount(root);
  });

  it('preserves structured client-config errors for failed-and-restored recovery UI', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/applets/service-access/ai-connections') {
        return json({
          invocation: {
            baseUrl: 'https://pod.example',
            token: 'xpod_inv_v1.client-config-token',
          },
        });
      }
      if (url.pathname.endsWith('/apply')) {
        return json({
          code: 'verification_failed_restored',
          message: '配置验证失败，已自动恢复原配置。',
          details: { restored: true },
        }, { status: 502 });
      }
      return json({ status: 'notConfigured' });
    }) as typeof fetch;
    const bridge = createXpodAiClientConfigurationBridge({
      podUrl: POD_URL,
      authenticatedFetch: fetchImpl,
    });

    await expect(bridge.apply({
      client: 'codex',
      planId: 'plan-1',
      apiKey: 'xpod_gw_once',
    })).rejects.toMatchObject({
      code: 'verification_failed_restored',
      status: 502,
      details: { restored: true },
    });
  });
});

function installDom(fetchImpl: typeof fetch) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://pod.example/dashboard/models',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  window.fetch = fetchImpl;
  globalThis.fetch = fetchImpl;
  window.matchMedia = vi.fn(() => ({
    matches: false,
    media: '(max-width: 767px)',
    addEventListener: vi.fn(() => undefined),
    removeEventListener: vi.fn(() => undefined),
  })) as unknown as typeof window.matchMedia;
}

async function renderModelsPage(runtime: XpodSolidRuntimeValue) {
  installDom(runtime.fetch);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <XpodSolidRuntimeContext.Provider value={runtime}>
        <ModelsPage />
      </XpodSolidRuntimeContext.Provider>,
    );
    await delay(30);
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

function runtimeWith(fetchImpl: typeof fetch, clientConfigAvailable = false): XpodSolidRuntimeValue {
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
    currentPod: { podUrl: POD_URL, webId: WEB_ID } as XpodSolidRuntimeValue['currentPod'],
    aiClientConfiguration: clientConfigAvailable
      ? { available: true, authority: 'local-filesystem' }
      : undefined,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  } as XpodSolidRuntimeValue;
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForText(container: Element, text: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => { await delay(25); });
  }
  throw new Error(`Missing text: ${text}\n${container.textContent}`);
}

function clickButton(container: Element, label: string, index = 0): void {
  const button = Array.from(container.querySelectorAll('button')).filter((candidate) => candidate.textContent?.includes(label))[index];
  if (!button) {
    throw new Error(`Missing button ${label}\n${container.textContent}`);
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
