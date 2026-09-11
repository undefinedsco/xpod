import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createAiConnectionsController } from '@undefineds.co/ai-connections';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { createXpodAiConnectionsHost } from './ai-connections-host';

function installDom(url = 'https://app.example/settings/models') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  dom.window.fetch = vi.fn(async () => new Response('ok')) as unknown as typeof dom.window.fetch;
}

function runtimeWith(login: XpodSolidRuntimeValue['login']): XpodSolidRuntimeValue {
  return {
    session: {
      getSnapshot: () => ({ status: 'anonymous' }),
      subscribe: () => () => undefined,
      fetch: vi.fn(async () => new Response('ok')),
    } as XpodSolidRuntimeValue['session'],
    pod: {} as XpodSolidRuntimeValue['pod'],
    fetch: vi.fn(async () => new Response('ok')),
    state: { status: 'anonymous' },
    login,
    logout: vi.fn(async () => undefined),
  };
}

describe('Xpod AI Connections host', () => {
  afterEach(() => { delete globalThis.xpodDesktop; });

  test.each(['desktop', 'local-filesystem'] as const)('uses the host origin for the %s configuration capability without rewriting Pod requests', async (authority) => {
    installDom('http://localhost:49152/settings/models');
    if (authority === 'desktop') globalThis.xpodDesktop = { setIdentity: vi.fn() };
    const authenticatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      aiClientConfiguration: { invocation: { token: 'local-capability', expiresAt: '2099-01-01T00:10:00.000Z' } },
    }));
    const invocationFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      client: 'codex', planId: 'plan', changes: [], applied: true,
    }));
    window.fetch = invocationFetch;
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      fetch: authenticatedFetch,
      state: { status: 'authenticated' as const, webId: 'https://pod.example/alice/profile/card#me' },
      currentPod: {
        webId: 'https://pod.example/alice/profile/card#me', podUrl: 'https://pod.example/alice/',
        database: {} as never, collections: 'ready' as const,
      },
      aiClientConfiguration: { available: authority === 'local-filesystem', authority: authority === 'local-filesystem' ? 'local-filesystem' : 'unavailable' },
    } as XpodSolidRuntimeValue;
    const host = createXpodAiConnectionsHost(runtime);
    const bridge = host.capabilities.aiClientConfiguration!;

    await bridge.plan({ client: 'codex', endpoint: 'https://pod.example/v1' });
    await bridge.apply({ client: 'codex', planId: 'plan', apiKey: 'client-key' });
    await host.solid.session.fetch('https://pod.example/alice/private.ttl');

    expect(authenticatedFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://pod.example/api/applets/service-access/ai-connections',
      'https://pod.example/alice/private.ttl',
    ]);
    expect(invocationFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:49152/api/ai/client-configuration/codex/plan',
      'http://localhost:49152/api/ai/client-configuration/codex/apply',
    ]);
    expect(JSON.parse(String(invocationFetch.mock.calls[0]?.[1]?.body)).endpoint).toBe('http://localhost:49152');
  });

  test('starts the shared Xpod current-origin transaction without accepting an issuer', async () => {
    installDom();
    const login = vi.fn(async () => undefined);
    const host = createXpodAiConnectionsHost(runtimeWith(login));

    await host.solid.requireLogin();

    expect(login).toHaveBeenCalledTimes(1);
  });

  test('reuses the WebID session directly for interactive AI operations', async () => {
    installDom();
    const authenticatedFetch = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const invocationFetch = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    window.fetch = invocationFetch;
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      fetch: authenticatedFetch,
      state: { status: 'authenticated' as const, webId: 'https://pod.example/alice/profile/card#me' },
      currentPod: {
        webId: 'https://pod.example/alice/profile/card#me',
        podUrl: 'https://pod.example/alice/',
        database: {} as never,
        collections: 'ready' as const,
      },
    } as XpodSolidRuntimeValue;
    const host = createXpodAiConnectionsHost(runtime);

    await host.solid.session.fetch('https://pod.example/api/ai/providers/openai/credentials/local', {
      method: 'POST',
    });

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/providers/openai/credentials/local',
      { method: 'POST' },
    );
    expect(invocationFetch).not.toHaveBeenCalled();
  });

  test('keeps the applet session snapshot aligned with the authenticated Xpod runtime', () => {
    installDom();
    const webId = 'https://pod.example/alice/profile/card#me';
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      state: { status: 'authenticated' as const, webId },
      currentPod: {
        webId,
        podUrl: 'https://pod.example/alice/',
        database: {} as never,
        collections: 'ready' as const,
      },
    } as XpodSolidRuntimeValue;

    const host = createXpodAiConnectionsHost(runtime);
    const controller = createAiConnectionsController(host);

    expect(host.solid.session.getSnapshot()).toEqual({ status: 'authenticated', webId });
    expect(controller.client).not.toBeNull();
  });

  test('omits the desktop configuration bridge when the host can only support manual setup', () => {
    installDom();
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      state: { status: 'authenticated' as const, webId: 'https://pod.example/alice/profile/card#me' },
      currentPod: {
        webId: 'https://pod.example/alice/profile/card#me',
        podUrl: 'https://pod.example/alice/',
        database: {} as never,
        collections: 'ready' as const,
      },
      aiClientConfiguration: {
        available: false,
        authority: 'unavailable' as const,
      },
    } as XpodSolidRuntimeValue;

    const host = createXpodAiConnectionsHost(runtime);

    expect(host.capabilities.aiClientConfiguration).toBeUndefined();
  });

  test('provides the desktop configuration bridge while the selected Pod is still opening', () => {
    installDom();
    globalThis.xpodDesktop = { setIdentity: vi.fn() };
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      state: { status: 'authenticated' as const, webId: 'https://pod.example/alice/profile/card#me' },
      currentPod: undefined,
      selectedStorage: {
        webId: 'https://pod.example/alice/profile/card#me',
        storageUrl: 'https://pod.example/alice/',
      },
      aiClientConfiguration: {
        available: false,
        authority: 'unavailable' as const,
      },
    } as XpodSolidRuntimeValue;

    const host = createXpodAiConnectionsHost(runtime);

    expect(host.capabilities.aiClientConfiguration).toBeDefined();
    delete globalThis.xpodDesktop;
  });
});
