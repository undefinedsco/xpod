import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSolidAccessRouteFetch } from '@undefineds.co/solid-sdk/access-route';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { normalizeAdvertisedAccessRoutes, provisionLocalPodRoutes } from '../../ui/src/solid/xpod-local-route';
import { getFreePort } from '../../src/runtime/port-finder';

/**
 * The Local acceptance case recorded in `docs/testing/login-state-matrix.md`
 * ("真实托管 Local + Cloud Account"): the Gateway is on loopback, the node's
 * canonical domain has no ingress from this machine, and the canonical Pod is
 * still reached — over the Gateway's loopback transport, keeping the canonical
 * Pod URL as the resource identity (`login-audit-2026-09-15.md`: 本机最优路径
 * 与公网可达性需分别报告 / 请求走本机 Gateway，保留规范 Pod URL).
 *
 * It was only ever recorded as a manual acceptance on 2026-09-12/13. The route
 * ranking added on 2026-09-22 broke exactly this path and nothing re-ran the
 * case, so it is a lane now: canonical requests must travel over the node's own
 * origin, and an empty route set (what the shell had before it registered any)
 * must fail. Authentication itself stays with the other login lanes.
 */
const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const suite = shouldRunIntegration ? describe : describe.skip;

/** Reserved by RFC 2606: it can never resolve, so there is genuinely no ingress. */
const CANONICAL = 'http://canonical.invalid/';

suite('a Local Pod whose canonical URL has no ingress', () => {
  const stack = new XpodTestStack();
  let listenOrigin = '';
  let canonical = CANONICAL;
  let status: Record<string, unknown> = {};

  beforeAll(async () => {
    const port = await getFreePort(39601);
    listenOrigin = `http://127.0.0.1:${port}/`;
    // `hasFreshProvisionCode` only reads `exp`; a fresh one keeps the first-run
    // path from calling a Cloud that is not there.
    const provisionCode = `${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
      .toString('base64url')}.integration`;

    await stack.start('local', {
      transport: 'port',
      baseUrl: listenOrigin,
      gatewayPort: port,
      runtimeRoot: path.resolve('.test-data', 'local-canonical-route'),
      env: {
        // A different origin that is the same server. That is what puts the
        // runtime on the first-run registration branch — the only place the
        // canonical base URL is ever assigned — without needing a real Cloud.
        SOLID_OIDC_ISSUER: `http://localhost:${port}/`,
        XPOD_PUBLIC_URL: CANONICAL,
        XPOD_NODE_TOKEN: 'test-node-token',
        XPOD_SERVICE_TOKEN: 'test-service-token',
        XPOD_PROVISION_CODE: provisionCode,
        XPOD_TUNNEL_PROVIDER: 'none',
      },
    });

    status = await fetch(new URL('/provision/status', listenOrigin), {
      headers: { accept: 'application/json' },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);
  }, 180_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('advertises a canonical origin that this machine cannot reach', async () => {
    canonical = typeof status.publicUrl === 'string' ? status.publicUrl : '';
    expect(new URL(canonical).origin).not.toBe(new URL(listenOrigin).origin);
    await expect(fetch(canonical)).rejects.toThrow();
  });

  it('serves canonical requests over the node origin and keeps the canonical identity', async () => {
    const routes = provisionLocalPodRoutes(canonical, {
      managed: status.managed === true,
      storageRoot: canonical,
      routes: normalizeAdvertisedAccessRoutes(status.routes),
    }, listenOrigin);

    expect(routes[0]).toMatchObject({ kind: 'loopback', targetUrl: listenOrigin, health: 'healthy' });

    const sent: string[] = [];
    const routed = createSolidAccessRouteFetch({
      fetch: async (input, init) => {
        sent.push(String(input));
        return globalThis.fetch(input as RequestInfo, init);
      },
      routes: () => routes,
      allowLocalOnlyRoutes: true,
      managedClient: true,
    });

    const response = await routed(new URL('/', canonical).href, { headers: { accept: 'text/turtle' } });

    expect(response.status).toBeLessThan(500);
    expect(sent).toEqual([listenOrigin]);
    // The physical path changed; the identity did not.
    expect(new URL(response.url).origin).toBe(new URL(canonical).origin);
  });

  it('fails the same request when no route is registered first', async () => {
    // The shape both Local regressions produced: no route yet, so the request
    // leaves for the canonical origin and never arrives.
    const routed = createSolidAccessRouteFetch({
      fetch: globalThis.fetch,
      routes: () => [],
      allowLocalOnlyRoutes: true,
      managedClient: true,
    });

    await expect(routed(new URL('/', canonical).href)).rejects.toThrow();
  });
});
