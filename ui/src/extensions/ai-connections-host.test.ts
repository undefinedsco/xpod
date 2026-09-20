import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { EVENTS } from '@inrupt/solid-client-authn-browser';
import { createSolidSessionRuntime } from '@undefineds.co/solid-sdk';
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

  test('reads the authenticated SDK session as the applet snapshot authority', () => {
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

    vi.spyOn(runtime.session, 'getSnapshot').mockReturnValue({ status: 'authenticated', webId });
    const host = createXpodAiConnectionsHost(runtime);
    const controller = createAiConnectionsController(host);

    expect(host.solid.session.getSnapshot()).toEqual({ status: 'authenticated', webId });
    expect(controller.client).not.toBeNull();
  });

  test.each([EVENTS.LOGOUT, EVENTS.SESSION_EXPIRED])('stops notifications on %s before React replaces the host and does not reopen stale watches', async (event) => {
    installDom();
    const webId = 'https://pod.example/alice/profile/card#me';
    const topic = 'https://pod.example/alice/settings/credentials.ttl';
    const events = new EventEmitter();
    const authenticatedFetch = vi.fn(async () => Response.json({
      id: 'https://pod.example/.notifications/channel-1',
      receiveFrom: 'wss://pod.example/.notifications/channel-1',
    }));
    const session = createSolidSessionRuntime({ session: {
      info: { isLoggedIn: true, webId },
      events: events as never,
      fetch: authenticatedFetch,
      login: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      handleIncomingRedirect: async () => ({ isLoggedIn: true, webId }),
    } });
    await session.initialize();
    const close = vi.fn();
    class RecordingSocket {
      readyState = 1;
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
      close() { close(); this.readyState = 3; }
    }
    const createSocket = vi.fn(function () { return new RecordingSocket(); });
    vi.stubGlobal('WebSocket', createSocket);
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      session, fetch: authenticatedFetch,
      state: { status: 'authenticated' as const, webId },
    };
    const host = createXpodAiConnectionsHost(runtime);
    const listener = vi.fn();
    const unsubscribe = host.solid.session.subscribe(listener);
    const notifications = host.capabilities.solidNotifications!;
    let release = notifications.watch(topic, vi.fn());
    try {
      await settle();
      expect(createSocket).toHaveBeenCalledTimes(1);
      events.emit(event);
      await settle();
      expect(listener).toHaveBeenLastCalledWith(session.getSnapshot());
      expect(host.solid.session.getSnapshot()).toEqual(session.getSnapshot());
      expect(close).toHaveBeenCalledTimes(1);
      release();
      release = notifications.watch(topic, vi.fn());
      await settle();
      expect(createSocket).toHaveBeenCalledTimes(1);
      unsubscribe();
      listener.mockClear();
      events.emit(EVENTS.LOGOUT);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      release(); unsubscribe(); session.dispose(); vi.unstubAllGlobals();
    }
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

  test('keeps the subscription canonical and routes the socket through the runtime resolver', async () => {
    installDom();
    const requests: string[] = [];
    const socketUrls: string[] = [];
    const channelId = 'https://pod.example/.notifications/WebSocketChannel2023/channel-1';
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        id: channelId,
        type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
        receiveFrom: channelId.replace('https://', 'wss://'),
      });
    }) as unknown as typeof fetch;
    class RecordingSocket {
      readyState = 0;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { code?: number }) => void) | null = null;
      constructor(url: string) {
        socketUrls.push(url);
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal('WebSocket', RecordingSocket);
    const webId = 'https://pod.example/alice/profile/card#me';
    const runtime = {
      ...runtimeWith(vi.fn(async () => undefined)),
      fetch: authenticatedFetch,
      resolveLocalUrl: (url: string) => url.replace('https://pod.example/', 'http://127.0.0.1:3000/'),
      state: { status: 'authenticated' as const, webId },
      currentPod: {
        webId,
        podUrl: 'https://pod.example/alice/',
        database: {} as never,
        collections: 'ready' as const,
      },
    } as XpodSolidRuntimeValue;
    vi.spyOn(runtime.session, 'getSnapshot').mockReturnValue({ status: 'authenticated', webId });
    const host = createXpodAiConnectionsHost(runtime);

    const release = host.capabilities.solidNotifications!.watch(
      'https://pod.example/alice/settings/credentials.ttl',
      vi.fn(),
    );
    await settle();

    // The subscription is signed by the session, so it must stay canonical and
    // travel through the session's canonical-route transport.
    expect(requests).toEqual(['https://pod.example/.notifications/WebSocketChannel2023/']);
    expect(JSON.parse(String(vi.mocked(authenticatedFetch).mock.calls[0]?.[1]?.body))).toMatchObject({
      topic: 'https://pod.example/alice/settings/credentials.ttl',
    });
    // The raw socket cannot use that transport, so it takes the local origin.
    expect(socketUrls).toEqual(['ws://127.0.0.1:3000/.notifications/WebSocketChannel2023/channel-1']);

    release();
    await settle();
    vi.unstubAllGlobals();
  });
});

/** Let the subscription POST and its failure path settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

test('binds Account credential operations to the host Account session', async () => {
  installDom();
  let active = true;
  const assertCurrent = vi.fn(() => { if (!active) throw new Error('old account'); });
  const account = {
    idpIndex: 'https://app.example/.account/',
    controls: { account: { clientCredentials: 'https://app.example/.account/account/alice/client-credentials/' } },
    bindAccountCapability: vi.fn(() => assertCurrent),
  };
  const host = createXpodAiConnectionsHost(runtimeWith(vi.fn()), account);
  expect(account.bindAccountCapability).toHaveBeenCalledTimes(1);
  active = false;
  await expect(host.capabilities.aiClientCredentials!.list!()).rejects.toThrow('old account');
  expect(window.fetch).not.toHaveBeenCalled();
  expect(createXpodAiConnectionsHost(runtimeWith(vi.fn()), { ...account, bindAccountCapability: undefined }).capabilities.aiClientCredentials).toBeUndefined();
});
