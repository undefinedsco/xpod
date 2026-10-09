import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fetchCurrentProvisionRouteStatus,
  provisionLocalPodRoutes,
  type XpodProvisionRouteStatus,
} from './xpod-local-route';

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
  test('never maps a managed external IdP onto the node, including refreshed status', () => {
    expect(provisionLocalPodRoutes('https://id.undefineds.co/alice/', {
      managed: true, storageRoot: 'https://id.undefineds.co/', oidcIssuer: 'https://id.undefineds.co/',
      routes: MANAGED.routes,
    }, LOOPBACK_PAGE)).toEqual([]);
  });
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

/**
 * The provisioning status endpoint is optional. A host that never answers it
 * must not hold the caller's identity open forever: the probe settles at its
 * own transport budget and reports no routes, and a torn-down owner (a changed
 * session, an unmounted shell) can cancel it immediately. Neither outcome may
 * invent a route the runtime never advertised.
 */
describe('fetchCurrentProvisionRouteStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('returns no routes without fetching when the page has an opaque origin', async () => {
    const originalWindow = globalThis.window;
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('window', { location: { origin: 'null' } });
    try {
      await expect(fetchCurrentProvisionRouteStatus(fetch)).resolves.toEqual({});
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('window', originalWindow);
    }
  });

  test('settles an indefinitely pending probe instead of holding identity open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const probe = fetchCurrentProvisionRouteStatus(abortableHangingFetch());

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(probe).resolves.toEqual({});
  });

  test('cancels an in-flight probe as soon as its owning session ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const controller = new AbortController();
    const probe = fetchCurrentProvisionRouteStatus(abortableHangingFetch(), {
      signal: controller.signal,
    });

    controller.abort();

    await expect(probe).resolves.toEqual({});
  });

  test('settles at the deadline even when the fetch adapter ignores abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const probe = fetchCurrentProvisionRouteStatus(unreactingHangingFetch());

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(probe).resolves.toEqual({});
  });

  test('bounds a response body that stalls after its headers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const probe = fetchCurrentProvisionRouteStatus(stalledBodyFetch());

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(probe).resolves.toEqual({});
  });

  test('settles on caller abort even when the fetch adapter ignores it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const controller = new AbortController();
    const probe = fetchCurrentProvisionRouteStatus(unreactingHangingFetch(), {
      signal: controller.signal,
    });

    controller.abort();

    await expect(probe).resolves.toEqual({});
  });

  test('keeps the original HTTP and content-type normalization', async () => {
    await expect(fetchCurrentProvisionRouteStatus(
      vi.fn(async () => new Response('plain text', { status: 200 })) as unknown as typeof fetch,
    )).resolves.toEqual({});

    await expect(fetchCurrentProvisionRouteStatus(
      vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    )).resolves.toEqual({});
  });
});

/**
 * A real fetch rejects an aborted request; this double does the same, so a
 * probe that never gets bytes back fails exactly the way a live one would.
 */
function abortableHangingFetch(): typeof fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    const signal = init?.signal;
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  })) as unknown as typeof fetch;
}

/** A host that never answers and never reacts to the abort signal. */
function unreactingHangingFetch(): typeof fetch {
  return vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
}

/** A host that sends headers and then stalls while its JSON body is read. */
function stalledBodyFetch(): typeof fetch {
  return vi.fn(async () => {
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'json', {
      value: () => new Promise<never>(() => undefined),
      configurable: true,
    });
    return response;
  }) as unknown as typeof fetch;
}
