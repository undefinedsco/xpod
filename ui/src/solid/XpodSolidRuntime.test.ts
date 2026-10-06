import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AccessRoute } from '@undefineds.co/solid-sdk/access-route';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { createXpodSolidRuntimeValue, XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, type XpodSolidRuntimeCore } from './XpodSolidRuntime';
import { provisionLocalPodRoutes } from './xpod-local-route';
import { withRequestPodAuthorization } from '../auth/session-request-credential';

/**
 * `resolveLocalUrl` is the one rewrite rule for the places a request leaves the
 * app without passing through the session's fetch transport: the canonical Pod
 * origin must become the Gateway origin this host actually serves, and nothing
 * else may move.
 */

const CANONICAL = 'https://7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co';
const LOOPBACK = 'http://127.0.0.1:3000';

function podRoute(
  canonicalBaseUrl = `${CANONICAL}/glocal/`,
  localBaseUrl = `${LOOPBACK}/glocal/`,
): AccessRoute {
  return {
    id: `${canonicalBaseUrl}->${localBaseUrl}`,
    kind: 'loopback',
    canonicalUrl: canonicalBaseUrl,
    targetUrl: localBaseUrl,
    priority: 10,
    requiresManagedClient: true,
    visibility: 'local-only',
    health: 'healthy',
  };
}

function createRuntime(): XpodSolidRuntimeCore {
  const adapter: SolidSessionAdapter = {
    info: { isLoggedIn: false },
    fetch: vi.fn(async () => new Response(null, { status: 205 })),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    handleIncomingRedirect: vi.fn(async () => undefined),
    events: { on: vi.fn(), off: vi.fn() } as unknown as SolidSessionAdapter['events'],
  };
  return createXpodSolidRuntimeValue({ sessionFactory: () => adapter });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Xpod restore authority', () => {
  const issuer = 'https://id.undefineds.co/';
  const currentKey = 'solidClientAuthn:currentSession';
  const recordKey = 'xpod.inrupt.insecure:solidClientAuthenticationUser:active';

  function fixture(activeIssuer: string | undefined) {
    window.localStorage.clear();
    window.localStorage.setItem(currentKey, 'active');
    window.localStorage.setItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, issuer);
    window.localStorage.setItem(recordKey, JSON.stringify({ issuer: activeIssuer, redirectUrl: `${LOOPBACK}/auth/callback` }));
    window.localStorage.setItem('xpod.inrupt.insecure:solidClientAuthenticationUser:other', JSON.stringify({ issuer }));
    const adapter: SolidSessionAdapter = {
      info: { isLoggedIn: false },
      fetch: vi.fn(), login: vi.fn(), logout: vi.fn(),
      handleIncomingRedirect: vi.fn(async () => undefined),
      events: { on: vi.fn(), off: vi.fn() } as unknown as SolidSessionAdapter['events'],
    };
    const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      managed: true, oidcIssuer: issuer, provisionCode: 'test-scope',
    }));
    const runtime = createXpodSolidRuntimeValue({ sessionFactory: () => adapter });
    return { runtime, adapter, network };
  }

  test.each([`${LOOPBACK}/`, undefined])('does not restore active issuer %s just because the display hint matches', async (activeIssuer) => {
    const { runtime, adapter, network } = fixture(activeIssuer);
    const before = { ...window.localStorage };
    expect(runtime.getExpectedIssuer()).toBeUndefined();
    await expect(runtime.session.initialize()).resolves.toEqual({ status: 'anonymous' });
    expect(network).toHaveBeenCalledWith('/provision/status', expect.any(Object));
    expect(adapter.handleIncomingRedirect).toHaveBeenCalledWith({ restorePreviousSession: false });
    expect(runtime.getExpectedIssuer()).toBe(issuer);
    expect(adapter.logout).not.toHaveBeenCalled();
    expect({ ...window.localStorage }).toEqual(before);
    runtime.session.dispose();
  });

  test('restores only the active record matching the Gateway authority', async () => {
    const { runtime, adapter } = fixture(issuer);
    await runtime.session.initialize();
    expect(adapter.handleIncomingRedirect).toHaveBeenCalledWith({ restorePreviousSession: true });
    runtime.session.dispose();
  });

  test('passes a callback to the SDK validator even when old restore metadata disagrees', async () => {
    const { runtime, adapter } = fixture(`${LOOPBACK}/`);
    const callback = `${LOOPBACK}/auth/callback?code=test-code&state=test-state`;
    await runtime.session.handleIncomingRedirect!(callback);
    expect(adapter.handleIncomingRedirect).toHaveBeenCalledWith(callback);
    expect(runtime.getExpectedIssuer()).toBe(issuer);
    runtime.session.dispose();
  });

  test('bounds authority discovery and lets a failed attempt retry without reading the old issuer', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, adapter, network } = fixture(`${LOOPBACK}/`);
      network.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      let result: unknown;
      void runtime.session.initialize().then((value) => { result = value; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(result).toMatchObject({ status: 'error' });
      expect(adapter.handleIncomingRedirect).not.toHaveBeenCalled();
      expect(runtime.getExpectedIssuer()).toBeUndefined();
      await expect(runtime.session.initialize()).resolves.toEqual({ status: 'anonymous' });
      expect(adapter.handleIncomingRedirect).toHaveBeenCalledWith({ restorePreviousSession: false });
      runtime.session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Xpod bootstrap access routes', () => {
  test('routes the first restore request through loopback while keeping the central IdP separate', async () => {
    const issuer = 'https://id.undefineds.co/';
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/provision/status') return Response.json({
        managed: true, oidcIssuer: issuer, provisionCode: 'test-scope', publicUrl: `${CANONICAL}/`,
        routes: [{ id: 'public', kind: 'public-direct', targetUrl: `${CANONICAL}/`, priority: 30, health: 'unreachable' }],
      });
      if (new URL(String(input)).origin === CANONICAL) throw new Error('public path unavailable');
      return new Response(null, { status: 200 });
    });
    const runtime = createXpodSolidRuntimeValue({ sessionFactory: ({ fetch: transport }) => ({
      info: { isLoggedIn: false }, fetch: transport, login: vi.fn(), logout: vi.fn(),
      events: { on: vi.fn(), off: vi.fn() } as unknown as SolidSessionAdapter['events'],
      handleIncomingRedirect: async () => {
        expect((await transport(`${CANONICAL}/glocal/profile/card`)).status).toBe(200);
        expect((await transport(`${issuer}.account/`)).status).toBe(200);
      },
    }) });
    await expect(runtime.session.initialize()).resolves.toEqual({ status: 'anonymous' });
    const profileCall = network.mock.calls.find(([input]) => String(input) === `${window.location.origin}/glocal/profile/card`);
    expect(profileCall).toBeDefined();
    expect(new Headers(profileCall?.[1]?.headers).get('x-xpod-canonical-url')).toBe(`${CANONICAL}/glocal/profile/card`);
    expect(network).toHaveBeenCalledWith(`${issuer}.account/`);
    expect(network.mock.calls.filter(([input]) => String(input) === '/provision/status')).toHaveLength(1);
    runtime.session.dispose();
  });

  test('routes a service-key retry without signing over its authorization or losing the request body', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${LOOPBACK}/v1/chat/completions`);
      expect(await request.text()).toBe('request-body');
      expect(request.headers.get('x-xpod-canonical-url')).toBe(`${CANONICAL}/v1/chat/completions`);
      return request.headers.get('authorization') === 'Bearer session-key'
        ? new Response(null, { status: 200 })
        : Response.json({ error: 'service_access_missing' }, { status: 403 });
    });
    let transport!: typeof fetch;
    const runtime = createXpodSolidRuntimeValue({ sessionFactory: ({ fetch: routed }) => {
      transport = routed;
      return { info: { isLoggedIn: false }, fetch: routed, login: vi.fn(), logout: vi.fn(),
        handleIncomingRedirect: vi.fn(), events: { on: vi.fn(), off: vi.fn() } as unknown as SolidSessionAdapter['events'] };
    } });
    runtime.setLocalPodRoutes([podRoute(`${CANONICAL}/`, `${LOOPBACK}/`)]);
    const signedFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('authorization', 'DPoP browser-session');
      return transport(input, { ...init, headers });
    };
    const request = new Request(`${CANONICAL}/v1/chat/completions`, { method: 'POST', body: 'request-body' });
    const response = await withRequestPodAuthorization(signedFetch, async () => 'Bearer session-key', runtime.transportFetch, CANONICAL)(request);
    expect(response.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(2);
    runtime.session.dispose();
  });
});

describe('Xpod local URL resolution', () => {
  test('rewrites the Pod path and the service prefixes to the local gateway', () => {
    const runtime = createRuntime();
    // The route set carries the Pod path and the service prefixes beside it.
    runtime.setLocalPodRoutes(provisionLocalPodRoutes(
      `${CANONICAL}/glocal/`,
      {
        managed: true,
        storageRoot: `${CANONICAL}/`,
        routes: [{ id: 'public-direct', kind: 'public-direct', targetUrl: `${CANONICAL}/`, priority: 30 }],
      },
      `${LOOPBACK}/ai-connections`,
    ));

    expect(runtime.resolveLocalUrl(`${CANONICAL}/glocal/settings/credentials.ttl`))
      .toBe(`${LOOPBACK}/glocal/settings/credentials.ttl`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/api/applets/service-access/ai-connections`))
      .toBe(`${LOOPBACK}/api/applets/service-access/ai-connections`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/v1/models`)).toBe(`${LOOPBACK}/v1/models`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/.notifications/WebSocketChannel2023/`))
      .toBe(`${LOOPBACK}/.notifications/WebSocketChannel2023/`);
  });

  test('keeps the query and the fragment of the canonical resource', () => {
    const runtime = createRuntime();
    runtime.setLocalPodRoutes([podRoute()]);

    expect(runtime.resolveLocalUrl(`${CANONICAL}/glocal/settings/credentials.ttl?rev=2#openai`))
      .toBe(`${LOOPBACK}/glocal/settings/credentials.ttl?rev=2#openai`);
  });

  test('sends service APIs to their own prefix route, not through the Pod that contains them', () => {
    const runtime = createRuntime();
    // The Pod route ranks first and covers every canonical URL, but it would map
    // `/api/models` to `/pods/alice/api/models`, which is not a service endpoint.
    runtime.setLocalPodRoutes([
      podRoute(`${CANONICAL}/`, `${LOOPBACK}/pods/alice/`),
      ...['/api/', '/v1/', '/.notifications/'].map((prefix) => podRoute(
        `${CANONICAL}${prefix}`,
        `${LOOPBACK}${prefix}`,
      )),
    ]);

    expect(runtime.resolveLocalUrl(`${CANONICAL}/api/models`)).toBe(`${LOOPBACK}/api/models`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/v1/chat/completions`)).toBe(`${LOOPBACK}/v1/chat/completions`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/.notifications/WebSocketChannel2023/`))
      .toBe(`${LOOPBACK}/.notifications/WebSocketChannel2023/`);
  });

  test('uses the best-ranked route when several cover the same canonical URL', () => {
    const runtime = createRuntime();
    // Same canonical prefix, two physical paths: the ranked-first loopback route
    // is the one a request on this host travels over.
    runtime.setLocalPodRoutes([
      podRoute(),
      {
        ...podRoute(),
        id: 'public-direct',
        kind: 'public-direct',
        priority: 30,
        visibility: 'public',
        requiresManagedClient: false,
        targetUrl: 'https://edge.example/glocal/',
      },
    ]);

    expect(runtime.resolveLocalUrl(`${CANONICAL}/glocal/settings/credentials.ttl`))
      .toBe(`${LOOPBACK}/glocal/settings/credentials.ttl`);
  });

  test('passes unrelated origins and already-local URLs through unchanged', () => {
    const runtime = createRuntime();
    runtime.setLocalPodRoutes([podRoute()]);

    // Another Pod, an IdP endpoint, a prefix the route does not cover, and the
    // local URL itself all stay where they are.
    expect(runtime.resolveLocalUrl('https://other.example/alice/settings/credentials.ttl'))
      .toBe('https://other.example/alice/settings/credentials.ttl');
    expect(runtime.resolveLocalUrl('https://id.undefineds.co/.well-known/openid-configuration'))
      .toBe('https://id.undefineds.co/.well-known/openid-configuration');
    expect(runtime.resolveLocalUrl(`${CANONICAL}/other-service/thing`))
      .toBe(`${CANONICAL}/other-service/thing`);
    expect(runtime.resolveLocalUrl(`${LOOPBACK}/glocal/settings/credentials.ttl`))
      .toBe(`${LOOPBACK}/glocal/settings/credentials.ttl`);
    expect(runtime.resolveLocalUrl('not a url')).toBe('not a url');
  });

  test('is idempotent and has no effect before a route is known', () => {
    const runtime = createRuntime();
    const url = `${CANONICAL}/glocal/settings/credentials.ttl`;

    // No route yet: a canonical URL must not be rewritten into a guess.
    expect(runtime.resolveLocalUrl(url)).toBe(url);

    runtime.setLocalPodRoutes([podRoute()]);
    const once = runtime.resolveLocalUrl(url);
    expect(once).toBe(`${LOOPBACK}/glocal/settings/credentials.ttl`);
    expect(runtime.resolveLocalUrl(once)).toBe(once);

    runtime.setLocalPodRoutes(undefined);
    expect(runtime.resolveLocalUrl(url)).toBe(url);
    expect(runtime.resolveLocalUrl(once)).toBe(once);
  });
});
