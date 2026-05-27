import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', () => ({
  Agent: class MockAgent {},
  fetch: fetchMock,
}));

describe('SubdomainClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends node auth using the XpodNode scheme', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        subdomain: 'node-1',
        domain: 'nodes.undefineds.co',
        fqdn: 'node-1.nodes.undefineds.co',
        createdAt: new Date().toISOString(),
      }),
    });

    const { SubdomainClient } = await import('../../src/subdomain/SubdomainClient');
    const client = new SubdomainClient({
      cloudApiEndpoint: 'https://api.undefineds.co',
      nodeId: 'node-1',
      nodeToken: 'raw-node-token',
    });

    await client.allocateDdns({
      subdomain: 'node-1',
      mode: 'tunnel',
      tunnelProvider: 'cloudflare',
      localPort: 5737,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe('XpodNode node-1:raw-node-token');
    expect(options.headers['X-Node-Id']).toBeUndefined();
    expect(JSON.parse(options.body).localPort).toBe(5737);
  });
});
