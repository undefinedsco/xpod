import { createServer, type Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  ProviderHttpTransport,
  normalizeProviderProxyUrl,
  type ProviderAddressResolver,
} from '../../../src/api/service/provider-http-transport';

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
}

function resolverFor(addresses: string[]): ProviderAddressResolver {
  return vi.fn(async () => addresses.map((address) => ({ address })));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('ProviderHttpTransport network policy', () => {
  it('rejects a private connection-time lookup after a public preflight without establishing a request', async () => {
    let requestCount = 0;
    let connectionCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.end(JSON.stringify({ ok: true }));
    });
    server.on('connection', () => {
      connectionCount += 1;
    });
    await listen(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test_server_not_listening');
    }
    const resolver = vi.fn<ProviderAddressResolver>()
      .mockResolvedValueOnce([{ address: '203.0.113.10' }])
      .mockResolvedValueOnce([{ address: '127.0.0.1' }]);
    const transport = new ProviderHttpTransport({ resolver, timeoutMs: 1_000 });

    try {
      await expect(transport.getJson({
        url: `http://rebind.provider.test:${address.port}/v1/models`,
      })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'unsafe_provider_target' }),
      });
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(connectionCount).toBe(0);
      expect(requestCount).toBe(0);
    } finally {
      await close(server);
    }
  });

  it('pins an explicitly allowed local provider to the connection-time address', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.end(JSON.stringify({ ok: true }));
    });
    await listen(server);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test_server_not_listening');
    }
    const resolver = resolverFor(['127.0.0.1']);
    const transport = new ProviderHttpTransport({ resolver, timeoutMs: 1_000 });

    try {
      await expect(transport.getJson({
        url: `http://ollama.local.test:${address.port}/v1/models`,
        allowPrivateNetwork: true,
      })).resolves.toEqual({ ok: true });
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(requestCount).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('allows only the exact private fixture origin injected by the acceptance harness', async () => {
    const fetch = okFetch();
    const transport = new ProviderHttpTransport({
      fetch,
      allowedPrivateOrigins: ['http://127.0.0.1:43123'],
    });

    await expect(transport.getJson({ url: 'http://127.0.0.1:43123/v1/models' }))
      .resolves.toEqual({ ok: true });
    await expect(transport.getJson({ url: 'http://127.0.0.1:43124/v1/models' }))
      .rejects.toThrow('unsafe_provider_target');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not follow redirects to an unchecked provider target', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    }) as unknown as typeof globalThis.fetch;
    const transport = new ProviderHttpTransport({
      fetch,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .rejects.toMatchObject({ status: 302 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['localhost', 'http://localhost:11434/v1/models', ['127.0.0.1']],
    ['loopback', 'http://127.0.0.1:11434/v1/models', []],
    ['private IPv4', 'http://10.0.0.4/v1/models', []],
    ['link-local', 'http://169.254.10.20/v1/models', []],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data', []],
    ['multicast', 'http://224.0.0.1/v1/models', []],
    ['private IPv6', 'http://[fd00::1]/v1/models', []],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/v1/models', []],
  ])('blocks %s targets by default', async (_label, url, addresses) => {
    const fetch = okFetch();
    const transport = new ProviderHttpTransport({
      fetch,
      resolver: resolverFor(addresses),
    });

    await expect(transport.getJson({ url })).rejects.toThrow('unsafe_provider_target');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a hostname when any resolved address is private to reduce DNS rebinding exposure', async () => {
    const fetch = okFetch();
    const resolver = resolverFor(['203.0.113.10', '127.0.0.1']);
    const transport = new ProviderHttpTransport({ fetch, resolver });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .rejects.toThrow('unsafe_provider_target');
    expect(resolver).toHaveBeenCalledWith('models.example');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows Ollama/local callers to opt into local targets explicitly', async () => {
    const fetch = okFetch();
    const transport = new ProviderHttpTransport({
      fetch,
      resolver: resolverFor(['127.0.0.1']),
    });

    await expect(transport.getJson({
      url: 'http://localhost:11434/v1/models',
      allowPrivateNetwork: true,
    })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects proxy URLs with embedded credentials', () => {
    expect(() => normalizeProviderProxyUrl('http://user:pass@proxy.example:8080'))
      .toThrow('invalid_proxy_url');
  });

  it('blocks private proxy endpoints before opening a server-side connection', async () => {
    const fetchMock = okFetch();
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({
      url: 'https://models.example/v1/models',
      proxy: 'http://127.0.0.1:8080',
    })).rejects.toThrow('unsafe_provider_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a private proxy connection-time lookup without opening the proxy socket', async () => {
    let connectionCount = 0;
    const proxy = createServer((_request, response) => {
      response.end();
    });
    proxy.on('connection', () => {
      connectionCount += 1;
    });
    await listen(proxy);

    const address = proxy.address();
    if (!address || typeof address === 'string') {
      throw new Error('test_proxy_not_listening');
    }
    const proxyAddresses = [
      [{ address: '203.0.113.11' }],
      [{ address: '127.0.0.1' }],
    ];
    const resolver = vi.fn(async (hostname: string) => {
      if (hostname === 'models.example') {
        return [{ address: '203.0.113.10' }];
      }
      if (hostname === 'proxy.rebind.test') {
        return proxyAddresses.shift() ?? [];
      }
      return [];
    });
    const transport = new ProviderHttpTransport({ resolver, timeoutMs: 1_000 });

    try {
      await expect(transport.getJson({
        url: 'https://models.example/v1/models',
        proxy: `http://proxy.rebind.test:${address.port}`,
      })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'unsafe_provider_target' }),
      });
      expect(resolver).toHaveBeenCalledWith('proxy.rebind.test');
      expect(connectionCount).toBe(0);
    } finally {
      await close(proxy);
    }
  });

  it('applies a default timeout signal to provider fetches', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof globalThis.fetch;
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      timeoutMs: 1,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the timeout active while reading a JSON response body', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch;
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      timeoutMs: 1,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .rejects.toBeInstanceOf(Error);
  }, 250);

  it('caps provider error bodies at 64KiB', async () => {
    const oversized = 'x'.repeat(70 * 1024);
    const fetchMock = vi.fn(async () => new Response(oversized, {
      status: 500,
      statusText: 'Provider Failed',
    })) as unknown as typeof globalThis.fetch;
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .rejects.toMatchObject({ status: 500, body: 'x'.repeat(64 * 1024) });
  });

  it('closes the per-request dispatcher after consuming a buffered response', async () => {
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      closeSpy = vi.spyOn((init as RequestInit & { dispatcher: { close: () => Promise<void> } }).dispatcher, 'close');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      resolver: resolverFor(['203.0.113.10']),
    });

    await expect(transport.getJson({ url: 'https://models.example/v1/models' }))
      .resolves.toEqual({ ok: true });
    expect(closeSpy).toBeDefined();
    expect(closeSpy).toHaveBeenCalled();
  });
});
