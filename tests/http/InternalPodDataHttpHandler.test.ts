import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BasicRepresentation,
  NotImplementedHttpError,
  RepresentationMetadata,
  type HttpRequest,
  type HttpResponse,
  type ResourceStore,
} from '@solid/community-server';
import { InternalPodDataHttpHandler } from '../../src/http/InternalPodDataHttpHandler';
import { createGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';

const SECRET = 'test-runtime-gateway-admin-secret';
const OWNER = 'https://pod.example/alice/profile/card#me';
const CREDENTIAL_RESOURCE = 'https://pod.example/alice/settings/credentials.ttl';
const PROVIDER_RESOURCE = 'https://pod.example/alice/settings/providers/__service_access__.ttl';
const GATEWAY_KEY_RESOURCE = 'https://pod.example/alice/.data/ai/gateway/access-keys.ttl';
const QUOTA_RESOURCE = 'https://pod.example/alice/.data/ai/gateway/quota.ttl';
const SECRET_BODY = '{"secretPayload":{"apiKey":"sk-test-canary"}}';

class MockResponse extends Writable {
  public statusCode = 200;
  public readonly headers: Record<string, string> = {};
  public readonly chunks: Buffer[] = [];
  public finished = false;

  public setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  public override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  public override end(chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): this {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    this.finished = true;
    return super.end(undefined, encoding as BufferEncoding, callback);
  }

  public bodyText(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function createRequest(
  method: string,
  path: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest & {
    socket: { remoteAddress?: string };
  };
  request.method = method;
  request.url = path;
  request.headers = { host: 'localhost:3001', ...options.headers };
  request.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  const setEncoding = stream.setEncoding.bind(stream);
  request.setEncoding = ((encoding: BufferEncoding) => {
    setEncoding(encoding);
    return request;
  }) as HttpRequest['setEncoding'];
  if (options.body) {
    stream.end(options.body);
  } else {
    stream.end();
  }
  return request;
}

function createStore(): ResourceStore & {
  getRepresentation: ReturnType<typeof vi.fn>;
  setRepresentation: ReturnType<typeof vi.fn>;
  modifyResource: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
} {
  return {
    getRepresentation: vi.fn(async (identifier) => new BasicRepresentation(
      Readable.from([`stored:${identifier.path}`]),
      new RepresentationMetadata(identifier, { 'content-type': 'text/turtle' }),
    )),
    setRepresentation: vi.fn(async () => new Map()),
    modifyResource: vi.fn(async () => new Map()),
    deleteResource: vi.fn(async () => new Map()),
  } as unknown as ReturnType<typeof createStore>;
}

function createHandler(store = createStore()): InternalPodDataHttpHandler {
  return new InternalPodDataHttpHandler({
    resourceStore: store,
    gatewayAdminProxyAuthSecret: SECRET,
  });
}

function signedHeaders(input: {
  method?: 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  ownerWebId?: string;
  resourceUrl?: string;
  principalKind?: 'solid-user' | 'gateway-key';
  scopes?: string[];
  nonce?: string;
  issuedAt?: number;
  secret?: string;
} = {}): Record<string, string> {
  return createGatewayAdminProxyHeaders({
    secret: input.secret ?? SECRET,
    method: input.method ?? 'GET',
    url: input.path ?? '/.internal/pod-data',
    originalClientLoopback: true,
    issuedAt: input.issuedAt,
    intent: {
      ownerWebId: input.ownerWebId ?? OWNER,
      method: input.method ?? 'GET',
      resourceUrl: input.resourceUrl ?? CREDENTIAL_RESOURCE,
      principalKind: input.principalKind ?? 'solid-user',
      scopes: input.scopes ?? [ 'ai:credentials:read' ],
    },
    nonce: input.nonce ?? `nonce-${Math.random()}`,
  }) as Record<string, string>;
}

async function handle(
  handler: InternalPodDataHttpHandler,
  request: HttpRequest,
): Promise<MockResponse> {
  const response = new MockResponse();
  await handler.handle({ request, response: response as unknown as HttpResponse });
  return response;
}

describe('InternalPodDataHttpHandler', () => {
  it('ignores non-internal paths so public CSS handlers keep ownership', async () => {
    const handler = createHandler();
    const request = createRequest('GET', '/alice/profile/card');

    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it.each([
    ['missing marker', {}],
    ['forged marker', signedHeaders({ secret: 'wrong-secret' })],
    ['expired marker', signedHeaders({ issuedAt: Date.now() - 120_000 })],
  ])('returns 404 for %s without echoing request body', async (_name, headers) => {
    const handler = createHandler();
    const request = createRequest('PUT', '/.internal/pod-data', {
      headers: { ...headers, 'content-type': 'application/json' },
      body: SECRET_BODY,
    });

    const response = await handle(handler, request);

    expect(response.statusCode).toBe(404);
    expect(response.bodyText()).not.toContain('secretPayload');
    expect(response.bodyText()).not.toContain('sk-test-canary');
  });

  it('returns 404 when the same signed nonce is replayed', async () => {
    const store = createStore();
    const handler = createHandler(store);
    const headers = signedHeaders({ nonce: 'replayed-nonce' });

    const first = await handle(handler, createRequest('GET', '/.internal/pod-data', { headers }));
    const second = await handle(handler, createRequest('GET', '/.internal/pod-data', { headers }));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(store.getRepresentation).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for non-loopback transport before touching ResourceStore', async () => {
    const store = createStore();
    const handler = createHandler(store);
    const request = createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders(),
      remoteAddress: '203.0.113.10',
    });

    const response = await handle(handler, request);

    expect(response.statusCode).toBe(404);
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });

  it('delegates valid exact allowlisted resources to ResourceStore', async () => {
    const store = createStore();
    const handler = createHandler(store);

    for (const resourceUrl of [ CREDENTIAL_RESOURCE, PROVIDER_RESOURCE, GATEWAY_KEY_RESOURCE, QUOTA_RESOURCE ]) {
      const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
        headers: signedHeaders({ resourceUrl, nonce: resourceUrl }),
      }));

      expect(response.statusCode).toBe(200);
      expect(response.bodyText()).toBe(`stored:${resourceUrl}`);
    }

    expect(store.getRepresentation).toHaveBeenCalledTimes(4);
  });

  it('rejects owner mismatches, non-hosted paths, non-model resources, and signature-bound intent tampering', async () => {
    const store = createStore();
    const handler = createHandler(store);
    const rejected = [
      signedHeaders({ ownerWebId: 'https://pod.example/bob/profile/card#me', resourceUrl: CREDENTIAL_RESOURCE }),
      signedHeaders({ resourceUrl: 'https://pod.example/bob/settings/credentials.ttl' }),
      signedHeaders({ resourceUrl: 'https://pod.example/alice/settings/credentials-copy.ttl' }),
      { ...signedHeaders(), 'x-xpod-admin-proxy-intent': JSON.stringify({
        ownerWebId: OWNER,
        method: 'GET',
        resourceUrl: PROVIDER_RESOURCE,
        principalKind: 'solid-user',
        scopes: [ 'ai:credentials:read' ],
      }) },
    ];

    for (const headers of rejected) {
      const response = await handle(handler, createRequest('GET', '/.internal/pod-data', { headers }));
      expect(response.statusCode).toBe(404);
    }
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });
});
