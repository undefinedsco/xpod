import { describe, expect, it } from 'vitest';
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
