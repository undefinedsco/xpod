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

describe('ProviderHttpTransport network policy', () => {
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
});
