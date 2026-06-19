import { describe, expect, it } from 'vitest';
import { buildRouteSet } from '../../../src/edge/reachability';

describe('buildRouteSet', () => {
  it('keeps canonicalUrl stable and filters private routes from public browser output', () => {
    const routeSet = buildRouteSet({
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      publicUrl: 'https://node-1.pods.example/',
      ipv4: '203.0.113.10',
      publicPort: 443,
      connectivityStatus: 'reachable',
      metadata: {
        baseUrl: 'http://127.0.0.1:5737/',
        routes: [
          {
            id: 'loopback-main',
            kind: 'loopback',
            targetUrl: 'http://127.0.0.1:5737/',
            priority: 10,
            requiresManagedClient: true,
            visibility: 'local-only',
            health: 'healthy',
          },
          {
            id: 'lan-main',
            kind: 'lan',
            targetUrl: 'http://192.168.1.20:5737/',
            priority: 20,
            requiresManagedClient: true,
            visibility: 'authorized-client',
            health: 'healthy',
          },
        ],
        directCandidates: ['https://node-1.pods.example/'],
        tunnel: {
          status: 'active',
          entrypoint: 'https://node-1-tunnel.example/',
        },
      },
    }, {
      audience: 'public',
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(routeSet).toEqual({
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      generatedAt: '2026-06-19T00:00:00.000Z',
      routes: [
        expect.objectContaining({
          kind: 'public-direct',
          targetUrl: 'https://node-1.pods.example/',
          requiresManagedClient: false,
          visibility: 'public',
          priority: 30,
        }),
        expect.objectContaining({
          kind: 'user-tunnel',
          targetUrl: 'https://node-1-tunnel.example/',
          requiresManagedClient: false,
          visibility: 'public',
          priority: 50,
        }),
      ],
    });
    expect(routeSet.routes.map((route) => route.kind)).not.toContain('loopback');
    expect(routeSet.routes.map((route) => route.kind)).not.toContain('lan');
  });

  it('returns private and public routes for managed clients ordered by priority', () => {
    const routeSet = buildRouteSet({
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      publicUrl: 'https://node-1.pods.example/',
      metadata: {
        routes: [
          {
            id: 'lan-main',
            kind: 'lan',
            targetUrl: 'http://192.168.1.20:5737/',
            priority: 20,
            requiresManagedClient: true,
            visibility: 'authorized-client',
            health: 'healthy',
          },
          {
            id: 'loopback-main',
            kind: 'loopback',
            targetUrl: 'http://127.0.0.1:5737/',
            priority: 10,
            requiresManagedClient: true,
            visibility: 'local-only',
            health: 'healthy',
          },
        ],
        directCandidates: ['https://node-1.pods.example/'],
      },
    }, {
      audience: 'managed',
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(routeSet.routes.map((route) => route.kind)).toEqual([
      'loopback',
      'lan',
      'public-direct',
    ]);
    expect(routeSet.routes.every((route) => route.canonicalUrl === 'https://node-1.pods.example/')).toBe(true);
  });

  it('drops invalid runtime route endpoints instead of leaking malformed data', () => {
    const routeSet = buildRouteSet({
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      metadata: {
        routes: [
          {
            id: 'bad-route',
            kind: 'lan',
            targetUrl: 'not a url',
            priority: 20,
            requiresManagedClient: true,
            visibility: 'authorized-client',
            health: 'healthy',
          },
        ],
        directCandidates: ['not a url'],
      },
    }, {
      audience: 'managed',
      now: new Date('2026-06-19T00:00:00.000Z'),
    });

    expect(routeSet.routes).toEqual([]);
  });
});
