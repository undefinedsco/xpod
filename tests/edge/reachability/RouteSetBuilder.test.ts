import { describe, expect, it } from 'vitest';
import { buildPublicAccessRoutes, buildRouteSet } from '../../../src/edge/reachability';

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

    // A managed client elsewhere never gets the loopback entry...
    expect(routeSet.routes.map((route) => route.kind)).toEqual([
      'lan',
      'public-direct',
    ]);
    expect(routeSet.routes.every((route) => route.canonicalUrl === 'https://node-1.pods.example/')).toBe(true);

    // ...while the node's own host does, ahead of everything else.
    const localRouteSet = buildRouteSet({
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
    }, { audience: 'local' });
    expect(localRouteSet.routes.map((route) => route.kind)).toEqual([
      'loopback',
      'lan',
      'public-direct',
    ]);
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

  it('ranks the reported access points for a same-machine client: loopback, then lan, then the tunnel', () => {
    // What the heartbeat reports for one node: the local runtime's own loopback
    // entry, the LAN entries other devices on the network can use, and the user's
    // tunnel. A client picks by where it is, and priority is what encodes that.
    const source = {
      nodeId: 'node-1',
      canonicalUrl: 'https://node-1.pods.example/',
      publicUrl: 'https://node-1.pods.example/',
      connectivityStatus: 'reachable',
      metadata: {
        routes: [
          {
            id: 'loopback',
            kind: 'loopback' as const,
            targetUrl: 'http://127.0.0.1:3000/',
            priority: 10,
            requiresManagedClient: true,
            visibility: 'local-only' as const,
            health: 'healthy' as const,
          },
          {
            id: 'lan-ipv4-http',
            kind: 'lan' as const,
            targetUrl: 'http://192.168.1.20:3000/',
            priority: 20,
            requiresManagedClient: true,
            visibility: 'authorized-client' as const,
            health: 'unknown' as const,
          },
        ],
        tunnel: { entrypoint: 'https://tunnel.example/', status: 'active' },
      },
    };

    // The node's own host gets every access point, loopback first.
    const local = buildRouteSet(source, { audience: 'local' });
    expect(local.routes.map((route) => route.kind)).toEqual([
      'loopback',
      'lan',
      'public-direct',
      'user-tunnel',
    ]);

    // A managed client on another machine never receives the loopback entry.
    const managed = buildRouteSet(source, { audience: 'managed' });
    expect(managed.routes.map((route) => route.kind)).toEqual([
      'lan',
      'public-direct',
      'user-tunnel',
    ]);

    // Public discovery never learns about a same-machine route.
    const published = buildRouteSet(source, { audience: 'public' });
    expect(published.routes.map((route) => route.kind)).toEqual(['public-direct', 'user-tunnel']);
  });
});

describe('buildPublicAccessRoutes', () => {
  it('reports the canonical URL with the health the node can actually prove', () => {
    const unavailable = buildPublicAccessRoutes({ canonicalUrl: 'https://node-1.pods.example/' });
    expect(unavailable).toEqual([{
      id: 'public-direct',
      kind: 'public-direct',
      canonicalUrl: 'https://node-1.pods.example/',
      targetUrl: 'https://node-1.pods.example/',
      priority: 30,
      requiresManagedClient: false,
      visibility: 'public',
      health: 'unknown',
    }]);

    const available = buildPublicAccessRoutes({
      canonicalUrl: 'https://node-1.pods.example/',
      publicRouteAvailable: true,
    });
    expect(available.map((route) => route.health)).toEqual(['healthy']);
  });

  it('adds the tunnel endpoint only when it is a different access point', () => {
    const routes = buildPublicAccessRoutes({
      canonicalUrl: 'https://node-1.pods.example/',
      publicRouteAvailable: true,
      tunnelEndpoint: 'https://ravioli-example.ngrok-free.dev/',
    });
    expect(routes.map((route) => [route.kind, route.targetUrl, route.priority])).toEqual([
      ['public-direct', 'https://node-1.pods.example/', 30],
      ['user-tunnel', 'https://ravioli-example.ngrok-free.dev/', 50],
    ]);

    // A tunnel that serves the canonical host is the same route, not a second one.
    expect(buildPublicAccessRoutes({
      canonicalUrl: 'https://node-1.pods.example/',
      tunnelEndpoint: 'https://node-1.pods.example/',
    }).map((route) => route.kind)).toEqual(['public-direct']);
  });

  it('reports no route at all rather than an unparseable target', () => {
    expect(buildPublicAccessRoutes({ canonicalUrl: 'not-a-url', tunnelEndpoint: '' })).toEqual([]);
  });
});
