import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SolidSessionAdapter } from '@undefineds.co/solid-sdk';
import { createXpodSolidRuntimeValue, type XpodSolidRuntimeCore } from './XpodSolidRuntime';

/**
 * `resolveLocalUrl` is the one rewrite rule for the places a request leaves the
 * app without passing through the session's fetch transport: the canonical Pod
 * origin must become the Gateway origin this host actually serves, and nothing
 * else may move.
 */

const CANONICAL = 'https://7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co';
const LOOPBACK = 'http://127.0.0.1:3000';

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

describe('Xpod local URL resolution', () => {
  test('rewrites the Pod path and the service prefixes to the local gateway', () => {
    const runtime = createRuntime();
    runtime.setLocalPodRoute({
      canonicalBaseUrl: `${CANONICAL}/glocal/`,
      localBaseUrl: `${LOOPBACK}/glocal/`,
    });

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
    runtime.setLocalPodRoute({
      canonicalBaseUrl: `${CANONICAL}/glocal/`,
      localBaseUrl: `${LOOPBACK}/glocal/`,
    });

    expect(runtime.resolveLocalUrl(`${CANONICAL}/glocal/settings/credentials.ttl?rev=2#openai`))
      .toBe(`${LOOPBACK}/glocal/settings/credentials.ttl?rev=2#openai`);
  });

  test('prefers the longest canonical prefix over the Pod route that also covers it', () => {
    const runtime = createRuntime();
    runtime.setLocalPodRoute({
      canonicalBaseUrl: `${CANONICAL}/`,
      localBaseUrl: `${LOOPBACK}/pods/alice/`,
    });

    // The Pod route matches too, and would produce `/pods/alice/api/...`.
    expect(runtime.resolveLocalUrl(`${CANONICAL}/api/models`)).toBe(`${LOOPBACK}/api/models`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/v1/chat/completions`)).toBe(`${LOOPBACK}/v1/chat/completions`);
    expect(runtime.resolveLocalUrl(`${CANONICAL}/.notifications/WebSocketChannel2023/`))
      .toBe(`${LOOPBACK}/.notifications/WebSocketChannel2023/`);
  });

  test('passes unrelated origins and already-local URLs through unchanged', () => {
    const runtime = createRuntime();
    runtime.setLocalPodRoute({
      canonicalBaseUrl: `${CANONICAL}/glocal/`,
      localBaseUrl: `${LOOPBACK}/glocal/`,
    });

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

    runtime.setLocalPodRoute({
      canonicalBaseUrl: `${CANONICAL}/glocal/`,
      localBaseUrl: `${LOOPBACK}/glocal/`,
    });
    const once = runtime.resolveLocalUrl(url);
    expect(once).toBe(`${LOOPBACK}/glocal/settings/credentials.ttl`);
    expect(runtime.resolveLocalUrl(once)).toBe(once);

    runtime.setLocalPodRoute(undefined);
    expect(runtime.resolveLocalUrl(url)).toBe(url);
    expect(runtime.resolveLocalUrl(once)).toBe(once);
  });
});
