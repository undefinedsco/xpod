import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import { createCanonicalFetch } from '../../../src/edge/reachability';

const route: AccessRoute = {
  id: 'loopback',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'loopback',
  targetUrl: 'http://127.0.0.1:5737/',
  priority: 10,
  requiresManagedClient: true,
  visibility: 'local-only',
  health: 'healthy',
};

describe('createCanonicalFetch', () => {
  it('sends requests to the selected target route while preserving canonical semantics in headers', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const canonicalFetch = createCanonicalFetch({ route, fetchImpl });

    const response = await canonicalFetch('https://node-1.pods.example/alice/file.txt?download=1', {
      method: 'PUT',
      headers: {
        authorization: 'DPoP token',
      },
      body: 'hello',
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchImpl.mock.calls[0];
    expect(targetUrl).toBe('http://127.0.0.1:5737/alice/file.txt?download=1');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('DPoP token');
    expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/file.txt?download=1');
    expect(headers.get('x-xpod-canonical-origin')).toBe('https://node-1.pods.example');
    expect(headers.get('x-xpod-canonical-host')).toBe('node-1.pods.example');
  });

  it('rejects requests outside the route canonical origin', async () => {
    const canonicalFetch = createCanonicalFetch({
      route,
      fetchImpl: vi.fn(async () => new Response('ok')),
    });

    await expect(canonicalFetch('https://other.example/file.txt')).rejects.toThrow('outside canonical origin');
  });
});
