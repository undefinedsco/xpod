import { describe, expect, test } from 'vitest';
import { provisionLocalPodRoutes, type XpodProvisionRouteStatus } from './xpod-local-route';

/**
 * A route set is ranked, best first: the page's own origin when the Pod is served
 * by the Xpod this page came from, then every access point the runtime reports.
 * Only the client knows which of those paths it is standing on.
 */

const CANONICAL = 'https://7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co';
const STORAGE = `${CANONICAL}/glocal/`;
const LOOPBACK_PAGE = 'http://127.0.0.1:3000/ai-connections';
const LAN_PAGE = 'http://192.168.3.50:3000/ai-connections';
const TUNNEL = 'https://ravioli-basics-throbbing.ngrok-free.dev/';

const MANAGED: XpodProvisionRouteStatus = {
  managed: true,
  storageRoot: `${CANONICAL}/`,
  routes: [
    {
      id: 'public-direct',
      kind: 'public-direct',
      targetUrl: `${CANONICAL}/`,
      priority: 30,
      requiresManagedClient: false,
      visibility: 'public',
      health: 'unknown',
    },
    {
      id: 'user-tunnel',
      kind: 'user-tunnel',
      targetUrl: TUNNEL,
      priority: 50,
      requiresManagedClient: false,
      visibility: 'public',
      health: 'healthy',
    },
  ],
};

type Routes = ReturnType<typeof provisionLocalPodRoutes>;

/** The ranking the SDK walks, best first. */
function rankedKinds(routes: Routes): string[] {
  return [...new Set(routes.map((route) => route.kind))];
}

/** What the set maps, so no route silently disappears or changes target. */
function mappings(routes: Routes): string[] {
  return routes.map((route) => `${route.canonicalUrl} -> ${route.targetUrl}`).sort();
}

describe('provisionLocalPodRoutes', () => {
  test('ranks this page own origin above every advertised access point', () => {
    const routes = provisionLocalPodRoutes(STORAGE, MANAGED, LOOPBACK_PAGE);

    // Loopback first, then the node's canonical URL, then the tunnel.
    expect(rankedKinds(routes)).toEqual(['loopback', 'public-direct', 'user-tunnel']);
    // One route per access point: the path is preserved, so the Pod, the service
    // APIs beside it and the notification channels all travel over the same one.
    expect(mappings(routes)).toEqual([
      `${CANONICAL}/ -> ${CANONICAL}/`,
      `${CANONICAL}/ -> ${TUNNEL}`,
      `${CANONICAL}/ -> http://127.0.0.1:3000/`,
    ].sort());
    expect(routes.map((route) => route.priority)).toEqual([10, 30, 50]);
  });

  test('classifies the page origin by where the page is', () => {
    const [first] = provisionLocalPodRoutes(STORAGE, MANAGED, LAN_PAGE);
    expect(first).toMatchObject({
      kind: 'lan',
      canonicalUrl: `${CANONICAL}/`,
      targetUrl: 'http://192.168.3.50:3000/',
      priority: 20,
      visibility: 'same-account',
    });

    // Served from the canonical domain the page is already on the public route,
    // so the advertised one is what remains.
    const [publicFirst] = provisionLocalPodRoutes(STORAGE, MANAGED, `${CANONICAL}/ai-connections`);
    expect(publicFirst).toMatchObject({
      kind: 'public-direct',
      targetUrl: `${CANONICAL}/`,
      priority: 30,
      requiresManagedClient: false,
    });
  });

  test('routes only a Pod this page own Xpod serves', () => {
    // Another node's Pod keeps its public route: this page is not its host.
    expect(rankedKinds(provisionLocalPodRoutes(
      'https://other.example/alice/',
      MANAGED,
      LOOPBACK_PAGE,
    ))).toEqual(['public-direct', 'user-tunnel']);

    // Standalone (unmanaged) runtimes report no canonical URL to trust.
    expect(provisionLocalPodRoutes(STORAGE, {}, LOOPBACK_PAGE)).toEqual([]);
  });

  test('is empty until a canonical URL is known, and skips unusable routes', () => {
    expect(provisionLocalPodRoutes(undefined, MANAGED, LOOPBACK_PAGE)).toEqual([]);
    expect(provisionLocalPodRoutes(STORAGE, MANAGED, 'not-a-url')).toEqual([]);

    const routes = provisionLocalPodRoutes(STORAGE, {
      managed: true,
      storageRoot: `${CANONICAL}/`,
      routes: [
        { id: 'broken', kind: 'public-direct', targetUrl: 'not-a-url', priority: 30 },
      ],
    }, LOOPBACK_PAGE);
    expect(rankedKinds(routes)).toEqual(['loopback']);
    expect(routes).toHaveLength(1);
  });
});
