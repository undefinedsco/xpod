import { describe, expect, it } from 'bun:test';
import {
  LOCAL_ROUTE_CANONICAL_HOST_HEADER,
  LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER,
  LOCAL_ROUTE_CANONICAL_URL_HEADER,
  LOCAL_ROUTE_LOCAL_URL_HEADER,
  refreshLocalProvisionRoute,
} from '../src/local-provision-route';

const LOCAL_ORIGIN = 'http://127.0.0.1:3000';
const PUBLIC_ORIGIN = 'https://node-0000.undefineds.co';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function createHarness(options: { publicRouteAvailable: boolean; publicUrl?: string }) {
  const requests: CapturedRequest[] = [];
  let handler: ((request: Request) => Promise<Response>) | undefined;

  const session = {
    protocol: {
      handle(_scheme: 'https', next: (request: Request) => Promise<Response>) {
        handler = next;
      },
    },
  };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${LOCAL_ORIGIN}/provision/status`) throw new Error(`unexpected status fetch ${url}`);
    return new Response(JSON.stringify({
      registered: true,
      publicUrl: options.publicUrl ?? PUBLIC_ORIGIN,
      publicRoute: { configured: options.publicRouteAvailable, available: options.publicRouteAvailable },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const createClientRequest = async ({ url, method }: { url: string; method: string }) => {
    const headers: Record<string, string> = {};
    const captured: CapturedRequest = { url, method, headers };
    requests.push(captured);
    const listeners = new Map<string, (...args: any[]) => void>();
    return {
      on(event: string, listener: (...args: any[]) => void) {
        listeners.set(event, listener);
        return this;
      },
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
      write() {},
      end() {
        const responseListeners = new Map<string, (...args: any[]) => void>();
        const response = {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          on(event: string, listener: (...args: any[]) => void) {
            responseListeners.set(event, listener);
            return this;
          },
        };
        listeners.get('response')?.(response);
        responseListeners.get('data')?.(new TextEncoder().encode('ok'));
        responseListeners.get('end')?.();
      },
      abort() {},
    };
  };

  return {
    requests,
    session,
    fetchImpl,
    createClientRequest,
    route: async (): Promise<((request: Request) => Promise<Response>)> => {
      const installed = await refreshLocalProvisionRoute({
        session: session as never,
        targetOrigin: LOCAL_ORIGIN,
        fetchImpl,
        createClientRequest: createClientRequest as never,
      });
      expect(installed).toBe(true);
      if (!handler) throw new Error('handler was not installed');
      return handler;
    },
  };
}

describe('local canonical access route', () => {
  it('serves the canonical origin from this machine while no public route is available', async () => {
    const harness = createHarness({ publicRouteAvailable: false });
    const handler = await harness.route();

    const response = await handler(new Request(`${PUBLIC_ORIGIN}/.account/`, { headers: { accept: 'application/json' } }));

    expect(response.status).toBe(200);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].url).toBe(`${LOCAL_ORIGIN}/.account/`);
    // Canonical semantics survive the access route: the runtime still sees which
    // identity origin the caller asked for.
    expect(harness.requests[0].headers[LOCAL_ROUTE_CANONICAL_URL_HEADER.toLowerCase()]).toBe(`${PUBLIC_ORIGIN}/.account/`);
    expect(harness.requests[0].headers[LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER.toLowerCase()]).toBe(PUBLIC_ORIGIN);
    expect(harness.requests[0].headers[LOCAL_ROUTE_CANONICAL_HOST_HEADER.toLowerCase()]).toBe('node-0000.undefineds.co');
    expect(harness.requests[0].headers[LOCAL_ROUTE_LOCAL_URL_HEADER.toLowerCase()]).toBe(`${LOCAL_ORIGIN}/.account/`);
  });

  it('keeps provisioning on the local origin even when a public route exists', async () => {
    const harness = createHarness({ publicRouteAvailable: true });
    const handler = await harness.route();

    await handler(new Request(`${PUBLIC_ORIGIN}/provision/pods`, { method: 'POST', body: '{"podName":"alice"}' }));

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].url).toBe(`${LOCAL_ORIGIN}/provision/pods`);
    expect(harness.requests[0].headers[LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER.toLowerCase()]).toBe(PUBLIC_ORIGIN);
  });

  it('leaves canonical requests on their public path once the tunnel is connected', async () => {
    const harness = createHarness({ publicRouteAvailable: true });
    const handler = await harness.route();

    await handler(new Request(`${PUBLIC_ORIGIN}/alice/notes.ttl`));

    // Pass-through keeps streaming and long-lived routes intact; the tunnel is
    // the access route for this node at that point.
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].url).toBe(`${PUBLIC_ORIGIN}/alice/notes.ttl`);
    expect(harness.requests[0].headers[LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('never intercepts a different origin', async () => {
    const harness = createHarness({ publicRouteAvailable: false });
    const handler = await harness.route();

    await handler(new Request('https://registry.npmjs.org/@undefineds.co%2fxpod'));

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].url).toBe('https://registry.npmjs.org/@undefineds.co%2fxpod');
  });
});
