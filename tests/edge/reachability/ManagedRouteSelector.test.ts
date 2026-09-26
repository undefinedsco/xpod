import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessRoute, RouteSet } from '../../../src/edge/reachability';
import { chooseAccessRoute } from '../../../src/edge/reachability';

function route(kind: AccessRoute['kind'], priority: number, targetUrl: string, requiresManagedClient: boolean): AccessRoute {
  return {
    id: kind,
    nodeId: 'node-1',
    canonicalUrl: 'https://node-1.pods.example/',
    kind,
    targetUrl,
    priority,
    requiresManagedClient,
    visibility: requiresManagedClient ? 'authorized-client' : 'public',
    health: 'unknown',
  };
}

function routeSet(routes: AccessRoute[]): RouteSet {
  return {
    nodeId: 'node-1',
    canonicalUrl: 'https://node-1.pods.example/',
    generatedAt: '2026-06-19T00:00:00.000Z',
    routes,
  };
}

describe('chooseAccessRoute', () => {
  it('chooses the highest-priority healthy route even when a lower-priority route probes faster', async () => {
    const selected = await chooseAccessRoute(routeSet([
      route('public-direct', 30, 'https://node-1.pods.example/', false),
      route('loopback', 10, 'http://127.0.0.1:5737/', true),
    ]), {
      managedClient: true,
      timeoutMs: 100,
      probe: async (candidate) => candidate.kind === 'public-direct' || candidate.kind === 'loopback',
    });

    expect(selected?.kind).toBe('loopback');
  });

  it('does not offer managed-client-only routes to public clients', async () => {
    const selected = await chooseAccessRoute(routeSet([
      route('loopback', 10, 'http://127.0.0.1:5737/', true),
      route('public-direct', 30, 'https://node-1.pods.example/', false),
    ]), {
      managedClient: false,
      timeoutMs: 100,
      probe: async () => true,
    });

    expect(selected?.kind).toBe('public-direct');
  });

  it('returns null when all probe attempts fail or routes are unreachable', async () => {
    const selected = await chooseAccessRoute(routeSet([
      { ...route('loopback', 10, 'http://127.0.0.1:5737/', true), health: 'unreachable' },
      route('public-direct', 30, 'https://node-1.pods.example/', false),
    ]), {
      managedClient: true,
      timeoutMs: 100,
      probe: async () => false,
    });

    expect(selected).toBeNull();
  });
});

/**
 * N06: the chooser must validate the advertised list locally (expiry, loopback-only) and must
 * not accept an unrelated HTTP service as an access point.
 */
describe('chooseAccessRoute route validation (N06)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // What a running Community Solid Server answers on HEAD /.well-known/solid.
  const solidAnswer = (): Response => new Response('', {
    status: 405,
    headers: {
      link: '<https://node-1.pods.example/.well-known/solid.acr>; rel="acl", '
        + '<https://node-1.pods.example/.well-known/solid.meta>; rel="describedby"',
      'x-powered-by': 'Community Solid Server',
    },
  });

  it('skips an expired access point even when it has the best priority', async () => {
    const fetchImpl = vi.fn(async () => solidAnswer());
    vi.stubGlobal('fetch', fetchImpl);

    const selected = await chooseAccessRoute(routeSet([
      { ...route('public-direct', 10, 'https://expired.example/', false), expiresAt: '2026-06-18T00:00:00.000Z' },
      { ...route('public-direct', 30, 'https://fresh.example/', false), expiresAt: '2026-06-20T00:00:00.000Z' },
    ]), {
      managedClient: true,
      timeoutMs: 100,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(selected?.targetUrl).toBe('https://fresh.example/');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not accept an unrelated service answering 200 without Solid identity', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('unrelated')
      ? new Response('<html>hello</html>', { status: 200 })
      : solidAnswer());
    vi.stubGlobal('fetch', fetchImpl);

    const selected = await chooseAccessRoute(routeSet([
      route('public-direct', 10, 'https://unrelated.example/', false),
      route('public-direct', 30, 'https://node-1.pods.example/', false),
    ]), {
      managedClient: true,
      timeoutMs: 100,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(selected?.targetUrl).toBe('https://node-1.pods.example/');
  });

  it('never offers a loopback-only access point to a remote client', async () => {
    const fetchImpl = vi.fn(async () => solidAnswer());
    vi.stubGlobal('fetch', fetchImpl);

    const selected = await chooseAccessRoute(routeSet([
      { ...route('loopback', 10, 'http://127.0.0.1:5737/', false), visibility: 'local-only' },
    ]), {
      managedClient: true,
      timeoutMs: 100,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(selected).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
