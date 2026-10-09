import { createServer, type Server } from 'node:http';

import { describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  closeProviderDispatcher,
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
  it('preserves raw form requests and non-success responses without retrying or adding credentials', async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'fixture-only' });
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(body);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
      return new Response('{"error":"invalid_grant"}', {
        status: 400, statusText: 'Bad Request', headers: { 'x-fixture': 'oauth-error' },
      });
    }) as unknown as typeof fetch;
    const transport = new ProviderHttpTransport({ fetch: fetchMock, resolver: resolverFor(['203.0.113.10']) });

    const response = await transport.request({
      url: 'https://auth.provider.test/oauth/token', method: 'POST', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', timeoutMs: 10_000,
    });
    expect(response.status).toBe(400);
    expect(response.statusText).toBe('Bad Request');
    expect(response.headers.get('x-fixture')).toBe('oauth-error');
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns manual redirects without following them and rejects a follow policy', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/metadata' } });
    }) as unknown as typeof fetch;
    const transport = new ProviderHttpTransport({ fetch: fetchMock, resolver: resolverFor(['203.0.113.10']) });
    expect((await transport.request({ url: 'https://auth.provider.test/oauth/token' })).status).toBe(302);
    await expect(transport.request({ url: 'https://auth.provider.test/oauth/token', redirect: 'follow' as never }))
      .rejects.toThrow('invalid_provider_redirect_policy');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps raw response body reads bounded and cleans up their dispatcher', async () => {
    let destroy: MockInstance | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      destroy = vi.spyOn((init as RequestInit & { dispatcher: { destroy: () => Promise<void> } }).dispatcher, 'destroy');
      return new Response(new ReadableStream(), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new ProviderHttpTransport({ fetch: fetchMock, resolver: resolverFor(['203.0.113.10']) });
    const response = await transport.request({ url: 'https://auth.provider.test/oauth/token', timeoutMs: 5 });
    await expect(response.text()).rejects.toThrow('provider_request_timeout');
    expect(destroy).toHaveBeenCalled();
  });

  it('times out raw target DNS before any fetch and preserves upstream cancellation', async () => {
    const fetchMock = okFetch();
    const resolver = vi.fn(async () => new Promise<never>(() => undefined));
    const transport = new ProviderHttpTransport({ fetch: fetchMock, resolver });
    await expect(transport.request({ url: 'https://auth.provider.test/oauth/token', timeoutMs: 5 }))
      .rejects.toThrow('provider_request_timeout');
    const controller = new AbortController();
    controller.abort(new Error('upstream_cancelled'));
    await expect(transport.request({ url: 'https://auth.provider.test/oauth/token', signal: controller.signal }))
      .rejects.toThrow('upstream_cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('rejects raw private targets before fetch even with a trusted system proxy', async () => {
    const fetchMock = okFetch();
    const transport = new ProviderHttpTransport({ fetch: fetchMock, systemProxy: 'http://127.0.0.1:7897' });
    await expect(transport.request({ url: 'http://169.254.169.254/token' })).rejects.toThrow('unsafe_provider_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pins raw Node proxy targets while retaining their HTTP host', async () => {
    const proxy = createServer();
    const destinations: string[] = [];
    const requests: string[] = [];
    proxy.on('connect', (request, socket) => {
      destinations.push(request.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        requests.push(data.toString());
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
      });
    });
    await listen(proxy);
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('test_proxy_not_listening');
    const transport = new ProviderHttpTransport({
      resolver: resolverFor(['203.0.113.10']), systemProxy: `http://127.0.0.1:${address.port}`, timeoutMs: 1_000,
    });
    try {
      const response = await transport.request({ url: 'http://models.example/oauth/token', method: 'POST', body: 'fixture' });
      expect(await response.json()).toEqual({});
      expect(destinations).toEqual(['203.0.113.10:80']);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatch(/host: models\.example\r\n/iu);
      expect(requests[0]).toContain('fixture');
    } finally {
      await close(proxy);
    }
  });

  it('aborts a raw connection-time DNS lookup before it can open a socket', async () => {
    let connections = 0;
    const server = createServer();
    server.on('connection', () => { connections += 1; });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_server_not_listening');
    let finishLookup: ((records: { address: string }[]) => void) | undefined;
    const resolver = vi.fn<Parameters<ProviderAddressResolver>, ReturnType<ProviderAddressResolver>>()
      .mockResolvedValueOnce([{ address: '127.0.0.1' }])
      .mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    const origin = `http://slow.provider.test:${address.port}`;
    const transport = new ProviderHttpTransport({ resolver, allowedPrivateOrigins: [origin] });
    try {
      await expect(transport.request({ url: origin, timeoutMs: 30 })).rejects.toThrow('provider_request_timeout');
      expect(resolver).toHaveBeenCalledTimes(2);
      finishLookup?.([{ address: '127.0.0.1' }]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(connections).toBe(0);
    } finally {
      await close(server);
    }
  });

  it('tolerates Bun dispatcher shims that expose neither close nor destroy', async () => {
    await expect(closeProviderDispatcher({} as never)).resolves.toBeUndefined();
    const destroy = vi.fn();
    await closeProviderDispatcher({ destroy } as never);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not mask an abort error by closing an already destroyed dispatcher', async () => {
    const close = vi.fn().mockRejectedValue(new Error('UND_ERR_DESTROYED'));
    await expect(closeProviderDispatcher({ destroyed: true, close } as never)).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

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
    const resolver = vi.fn<Parameters<ProviderAddressResolver>, ReturnType<ProviderAddressResolver>>()
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

  it('allows the trusted local system proxy supplied by the local host', async () => {
    const fetchMock = okFetch();
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      resolver: async (hostname) => [{ address: hostname === 'models.example' ? '203.0.113.10' : '127.0.0.1' }],
      systemProxy: 'http://127.0.0.1:7890',
    });

    await expect(transport.getJson({
      url: 'https://models.example/v1/models',
    })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows an explicit proxy matching the trusted system proxy but rejects other private proxies', async () => {
    const fetchMock = okFetch();
    const transport = new ProviderHttpTransport({
      fetch: fetchMock,
      resolver: resolverFor(['203.0.113.10']),
      systemProxy: 'http://127.0.0.1:7897',
    });

    await expect(transport.getJson({
      url: 'https://models.example/v1/models',
      proxy: 'http://127.0.0.1:7897/',
    })).resolves.toEqual({ ok: true });
    await expect(transport.getJson({
      url: 'https://models.example/v1/models',
      proxy: 'http://127.0.0.1:7898',
    })).rejects.toThrow('unsafe_provider_target');
    expect(fetchMock).toHaveBeenCalledOnce();
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
    let closeSpy: MockInstance<[], Promise<void>> | undefined;
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
