import { describe, expect, it, vi } from 'vitest';
import { createHostedPodRouteTransport, resolveHostedPodRoute } from '../../../src/api/ai-gateway/pod/HostedPodRoute';

describe('resolveHostedPodRoute', () => {
  it('names the gateway route for a canonical deployment URL', () => {
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayHost: 'localhost',
      gatewayPort: 5737,
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://localhost:5737/',
    });
    expect(resolveHostedPodRoute({
      canonicalBaseUrl: 'https://node.example/',
      gatewayPort: '5737',
    })).toEqual({
      canonicalBaseUrl: 'https://node.example/',
      localBaseUrl: 'http://127.0.0.1:5737/',
    });
  });

  it('connects to the address the gateway bound rather than a guess', () => {
    // A wildcard bind is not connectable everywhere, and `localhost` may be IPv6-only.
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '0.0.0.0', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://127.0.0.1:1/' });
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayHost: '::', gatewayPort: 1 }))
      .toMatchObject({ localBaseUrl: 'http://[::1]:1/' });
  });

  it('has no route to offer without a canonical URL or a gateway port', () => {
    expect(resolveHostedPodRoute({ gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/' })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: '  ', gatewayPort: 5737 })).toBeUndefined();
    expect(resolveHostedPodRoute({ canonicalBaseUrl: 'https://node.example/', gatewayPort: 'not-a-port' }))
      .toBeUndefined();
  });

  it('loads the SDK transport and preserves canonical identity and proof headers over the numeric route', async () => {
    const wireFetch = vi.fn(async (input: string | URL | Request) => {
      const response = new Response('ok');
      Object.defineProperty(response, 'url', { value: input instanceof Request ? input.url : String(input), configurable: true });
      return response;
    });
    const transport = await createHostedPodRouteTransport(wireFetch as typeof fetch, resolveHostedPodRoute({
      canonicalBaseUrl: 'http://localhost:5737/', gatewayHost: '127.0.0.1', gatewayPort: 5737,
    }));
    const canonical = 'http://localhost:5737/pod/resource?view=1';
    const response = await transport(new Request(canonical, {
      headers: { authorization: 'DPoP synthetic-token', dpop: 'synthetic-proof' },
    }));
    const [request] = wireFetch.mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe('http://127.0.0.1:5737/pod/resource?view=1');
    expect((request as Request).headers.get('x-xpod-canonical-url')).toBe(canonical);
    expect((request as Request).headers.get('authorization')).toBe('DPoP synthetic-token');
    expect((request as Request).headers.get('dpop')).toBe('synthetic-proof');
    expect(response.url).toBe(canonical);
    expect(response.clone().url).toBe(canonical);

    await transport('https://unrelated.example/resource');
    expect(wireFetch.mock.calls[1]![0]).toBe('https://unrelated.example/resource');
  });
});
