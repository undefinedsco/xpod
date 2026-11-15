/**
 * Cloud idle-session semantics: with Inrupt's proactive refresh timer suspended,
 * the first request whose access token already expired must renew BEFORE it is
 * dispatched, and it must renew only once.
 *
 * This binds the REAL shipped dependency (`@inrupt/solid-client-authn-core`,
 * already patched by `scripts/patch-inrupt-authn-refresh.js` during postinstall),
 * not a local re-implementation. The ordering is asserted from the OBSERVED EVENT
 * SEQUENCE at the server, never from `Date.now()` subtraction: a renewal and the
 * request it unblocks routinely land in the same millisecond, so a millisecond
 * comparison is a flake rather than a discriminator.
 */
import { describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const core = require('@inrupt/solid-client-authn-core') as {
  buildAuthenticatedFetch: (accessToken: string, options: Record<string, unknown>) => (url: string) => Promise<Response>;
};

type Observation = {
  readonly kind: 'refresh' | 'resource';
  /** Monotonic arrival index at the server: the order the events actually happened. */
  readonly seq: number;
  readonly authorization?: string;
};

describe('idle cloud session renews before the first expired dispatch', () => {
  test('suspended proactive timer still renews once, before the expired request', async () => {
    const observations: Observation[] = [];
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const seq = observations.length;
      if (url.pathname === '/token') {
        observations.push({ kind: 'refresh', seq });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: 'FRESH', refresh_token: 'r2', expires_in: 30, token_type: 'Bearer' }));
        return;
      }
      observations.push({ kind: 'resource', seq,
        authorization: new Headers(request.headers as Record<string, string>).get('authorization') ?? '<none>' });
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('private-bytes');
    });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Exactly what the idle E2E case installs: hold ONLY Inrupt's proactive
    // callback (identified by its own terminal-error classification), leaving
    // Date.now and every other timer real.
    const realSetTimeout = globalThis.setTimeout;
    let suppressed = 0;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const source = typeof handler === 'function' ? Function.prototype.toString.call(handler) : '';
      if (source.includes('temporarily_unavailable') && source.includes('server_error')) { suppressed++; return 1; }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof globalThis.setTimeout;

    try {
      const authenticatedFetch = core.buildAuthenticatedFetch('STALE', {
        expiresIn: 1,
        dpopKey: undefined,
        eventEmitter: { emit: () => undefined },
        fetch: (url: string, init?: RequestInit) => fetch(url, init),
        refreshOptions: {
          sessionId: 'session', refreshToken: 'r1',
          tokenRefresher: { refresh: async () => {
            const body = await (await fetch(`${origin}/token`, { method: 'POST' })).json() as {
              access_token: string; refresh_token: string; expires_in: number;
            };
            return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
          } },
        },
      });
      // Let the 1s access token expire while the proactive callback stays held.
      await new Promise(resolve => realSetTimeout(resolve, 1_200));
      const response = await authenticatedFetch(`${origin}/private.txt`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('private-bytes');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }

    // The timer really was suppressed, so the renewal below is request-driven
    // rather than the proactive callback firing on its own.
    expect(suppressed).toBeGreaterThan(0);
    const refresh = observations.filter(row => row.kind === 'refresh');
    const resource = observations.find(row => row.kind === 'resource');
    // Exactly one renewal for the whole exchange.
    expect(refresh).toHaveLength(1);
    expect(resource).toBeDefined();
    // Renew-before-dispatch, by ACTUAL observed order: the renewal reached the
    // server before the request it unblocks did. Indices cannot tie, so this
    // holds whether or not both events share a millisecond.
    expect(resource!.seq).toBeGreaterThan(refresh[0]!.seq);
    // The request after renewal carries the renewed credential, never the stale one.
    expect(resource!.authorization).toBe('Bearer FRESH');
  }, 20_000);
});
