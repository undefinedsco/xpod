import { PassThrough, Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BasicRepresentation,
  NotImplementedHttpError,
  RepresentationMetadata,
  SparqlUpdateBodyParser,
  type BodyParser,
  type HttpRequest,
  type HttpResponse,
  type Patch,
  type ResourceStore,
} from '@solid/community-server';
import { InternalPodDataHttpHandler } from '../../src/http/InternalPodDataHttpHandler';
import { createGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';

const SECRET = 'test-runtime-gateway-admin-secret';
const OWNER = 'https://pod.example/alice/profile/card#me';
const CREDENTIAL_RESOURCE = 'https://pod.example/alice/settings/credentials.ttl';
const PROVIDER_RESOURCE = 'https://pod.example/alice/settings/providers/__service_access__.ttl';
const QUOTA_RESOURCE = 'https://pod.example/alice/.data/ai/gateway/quota.ttl';
const MODEL_QUERY = 'SELECT ?id WHERE { ?id ?predicate ?value }';
const MODEL_SPARQL_RESOURCE = `https://pod.example/alice/settings/providers/-/sparql?query=${encodeURIComponent(MODEL_QUERY)}`;
const SECRET_BODY = '{"secretPayload":{"apiKey":"sk-test-canary"}}';

type TestOnlyInternalPodDataOptions = ConstructorParameters<typeof InternalPodDataHttpHandler>[0] & {
  nonceTtlMs?: number;
  nonceMaxEntries?: number;
  now?: () => number;
};

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

class BackpressureResponse extends MockResponse {
  public waitedForDrain = false;
  private firstWrite = true;

  public override write(chunk: any, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    super.write(chunk, encoding as BufferEncoding, callback);
    if (!this.firstWrite) {
      return true;
    }
    this.firstWrite = false;
    setImmediate(() => {
      this.waitedForDrain = true;
      this.emit('drain');
    });
    return false;
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
  request.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' } as HttpRequest['socket'];
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

function createHandler(
  store = createStore(),
  options: Partial<TestOnlyInternalPodDataOptions> = {},
): InternalPodDataHttpHandler {
  return new InternalPodDataHttpHandler({
    resourceStore: store,
    gatewayAdminProxyAuthSecret: SECRET,
    baseUrl: 'https://pod.example/',
    ...options,
  });
}

function signedHeaders(input: {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  ownerWebId?: string;
  resourceUrl?: string;
  principalKind?: 'solid-user';
  scopes?: string[];
  nonce?: string;
  issuedAt?: number;
  secret?: string;
  bodyDigest?: string;
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
      ...(input.bodyDigest ? { bodyDigest: input.bodyDigest } : {}),
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

async function handleWithResponse(
  handler: InternalPodDataHttpHandler,
  request: HttpRequest,
  response: MockResponse,
): Promise<MockResponse> {
  await handler.handle({ request, response: response as unknown as HttpResponse });
  return response;
}

describe('InternalPodDataHttpHandler', () => {
  it('ignores non-internal paths so public CSS handlers keep ownership', async () => {
    const handler = createHandler();
    const request = createRequest('GET', '/alice/profile/card');

    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('claims the reserved internal path without depending on the forwarded Host header', async () => {
    const handler = createHandler();
    const request = createRequest('GET', '/.internal/pod-data', {
      headers: { host: '[malformed-forwarded-host' },
    });

    await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
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

  it('expires replay markers and fails closed when the nonce cache reaches its hard max', async () => {
    let now = 0;
    const store = createStore();
    const handler = createHandler(store, {
      nonceTtlMs: 10,
      nonceMaxEntries: 1,
      now: () => now,
    });

    const nonceA = signedHeaders({ nonce: 'nonce-a' });
    expect((await handle(handler, createRequest('GET', '/.internal/pod-data', { headers: nonceA }))).statusCode).toBe(200);
    expect((await handle(handler, createRequest('GET', '/.internal/pod-data', { headers: nonceA }))).statusCode).toBe(404);

    now = 11;
    expect((await handle(handler, createRequest('GET', '/.internal/pod-data', { headers: nonceA }))).statusCode).toBe(200);

    const nonceB = signedHeaders({ nonce: 'nonce-b' });
    expect((await handle(handler, createRequest('GET', '/.internal/pod-data', { headers: nonceB }))).statusCode).toBe(404);
    expect((await handle(handler, createRequest('GET', '/.internal/pod-data', { headers: nonceA }))).statusCode).toBe(404);
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

    for (const resourceUrl of [ CREDENTIAL_RESOURCE, PROVIDER_RESOURCE, QUOTA_RESOURCE ]) {
      const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
        headers: signedHeaders({ resourceUrl, nonce: resourceUrl }),
      }));

      expect(response.statusCode).toBe(200);
      expect(response.bodyText()).toBe(`stored:${resourceUrl}`);
    }

    expect(store.getRepresentation).toHaveBeenCalledTimes(3);
  });

  it('delegates the exact owner model collection query to the trusted SPARQL handler', async () => {
    const store = createStore();
    const trustedSparqlHandler = {
      handleTrustedInternalSelect: vi.fn(async ({ response }: { response: HttpResponse }) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/sparql-results+json');
        response.end('{"head":{"vars":["id"]},"results":{"bindings":[]}}');
      }),
    };
    const handler = createHandler(store, { sparqlHandler: trustedSparqlHandler as any });

    const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders({ resourceUrl: MODEL_SPARQL_RESOURCE, nonce: 'model-query' }),
    }));

    expect(response.statusCode).toBe(200);
    expect(response.getHeader('content-type')).toBe('application/sparql-results+json');
    expect(response.bodyText()).toContain('bindings');
    expect(trustedSparqlHandler.handleTrustedInternalSelect).toHaveBeenCalledWith(expect.objectContaining({
      ownerWebId: OWNER,
      endpointUrl: MODEL_SPARQL_RESOURCE,
      query: MODEL_QUERY,
    }));
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });

  it('delegates a signed owner model collection POST with the exact body digest', async () => {
    const store = createStore();
    const trustedSparqlHandler = {
      handleTrustedInternalSelect: vi.fn(async ({ response }: { response: HttpResponse }) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/sparql-results+json');
        response.end('{"head":{"vars":["id"]},"results":{"bindings":[]}}');
      }),
    };
    const handler = createHandler(store, { sparqlHandler: trustedSparqlHandler as any });
    const body = new URLSearchParams({ query: MODEL_QUERY }).toString();
    const digest = createHash('sha256').update(body).digest('hex');

    const response = await handle(handler, createRequest('POST', '/.internal/pod-data', {
      headers: {
        ...signedHeaders({
          method: 'POST',
          resourceUrl: 'https://pod.example/alice/settings/providers/-/sparql',
          bodyDigest: digest,
          nonce: 'model-post-query',
        }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    }));

    expect(response.statusCode).toBe(200);
    expect(trustedSparqlHandler.handleTrustedInternalSelect).toHaveBeenCalledWith(expect.objectContaining({
      ownerWebId: OWNER,
      endpointUrl: 'https://pod.example/alice/settings/providers/-/sparql',
      query: MODEL_QUERY,
    }));
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });

  it('returns 404 when a signed model POST body digest does not match', async () => {
    const trustedSparqlHandler = {
      handleTrustedInternalSelect: vi.fn(),
    };
    const handler = createHandler(createStore(), { sparqlHandler: trustedSparqlHandler as any });
    const body = new URLSearchParams({ query: MODEL_QUERY }).toString();

    const response = await handle(handler, createRequest('POST', '/.internal/pod-data', {
      headers: {
        ...signedHeaders({
          method: 'POST',
          resourceUrl: 'https://pod.example/alice/settings/providers/-/sparql',
          bodyDigest: 'a'.repeat(64),
          nonce: 'model-post-tampered',
        }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    }));

    expect(response.statusCode).toBe(404);
    expect(trustedSparqlHandler.handleTrustedInternalSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['missing query', 'https://pod.example/alice/settings/providers/-/sparql'],
    ['extra query parameter', `${MODEL_SPARQL_RESOURCE}&format=json`],
    ['fragment', `${MODEL_SPARQL_RESOURCE}#fragment`],
    ['foreign collection', `https://pod.example/bob/settings/providers/-/sparql?query=${encodeURIComponent(MODEL_QUERY)}`],
    ['POST query URL', MODEL_SPARQL_RESOURCE],
  ])('returns 404 for %s on the trusted model collection capability', async (_name, resourceUrl) => {
    const trustedSparqlHandler = {
      handleTrustedInternalSelect: vi.fn(),
    };
    const handler = createHandler(createStore(), { sparqlHandler: trustedSparqlHandler as any });

    const method = _name === 'POST query URL' ? 'POST' : 'GET';
    const response = await handle(handler, createRequest(method, '/.internal/pod-data', {
      headers: signedHeaders({ method, resourceUrl, nonce: `invalid-model-query-${_name}` }),
    }));

    expect(response.statusCode).toBe(404);
    expect(trustedSparqlHandler.handleTrustedInternalSelect).not.toHaveBeenCalled();
  });

  it('serves signed HEAD probes as read-only existence checks without a response body', async () => {
    const store = createStore();
    const handler = createHandler(store);

    const response = await handle(handler, createRequest('HEAD', '/.internal/pod-data', {
      headers: signedHeaders({ method: 'HEAD', nonce: 'head-existing' }),
    }));

    expect(response.statusCode).toBe(200);
    expect(response.bodyText()).toBe('');
    expect(store.getRepresentation).toHaveBeenCalledWith(
      { path: CREDENTIAL_RESOURCE },
      { type: { 'text/turtle': 1, '*/*': 0.1 } },
    );
  });

  it('returns 404 for a signed HEAD probe when the allowlisted document does not exist', async () => {
    const store = createStore();
    store.getRepresentation.mockRejectedValueOnce({ statusCode: 404 });
    const handler = createHandler(store);

    const response = await handle(handler, createRequest('HEAD', '/.internal/pod-data', {
      headers: signedHeaders({ method: 'HEAD', nonce: 'head-missing' }),
    }));

    expect(response.statusCode).toBe(404);
    expect(response.bodyText()).toBe('Not Found');
  });

  it('represents a missing allowlisted AI document as an empty Turtle graph', async () => {
    const store = createStore();
    store.getRepresentation.mockRejectedValueOnce({ statusCode: 404 });
    const handler = createHandler(store);

    const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders({ nonce: 'missing-ai-document' }),
    }));

    expect(response.statusCode).toBe(200);
    expect(response.getHeader('content-type')).toBe('text/turtle');
    expect(response.bodyText()).toBe('');
  });

  it('rejects removed gateway-key verification pre-auth scope', async () => {
    const store = createStore();
    const handler = createHandler(store);

    const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders({
        resourceUrl: CREDENTIAL_RESOURCE,
        principalKind: 'solid-user',
        scopes: [ 'ai:gateway-key:verify' ],
      }),
    }));

    expect(response.statusCode).toBe(404);
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });

  it('respects GET response backpressure while streaming ResourceStore data', async () => {
    const store = createStore();
    store.getRepresentation.mockResolvedValueOnce(new BasicRepresentation(
      Readable.from([ 'chunk-1', 'chunk-2' ]),
      new RepresentationMetadata({ path: CREDENTIAL_RESOURCE }, { 'content-type': 'text/turtle' }),
    ));
    const handler = createHandler(store);
    const response = new BackpressureResponse();

    await handleWithResponse(handler, createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders({ nonce: 'backpressure' }),
    }), response);

    expect(response.waitedForDrain).toBe(true);
    expect(response.bodyText()).toBe('chunk-1chunk-2');
  });

  it('parses PATCH through the injected CSS PatchBodyParser before calling ResourceStore.modifyResource', async () => {
    const store = createStore();
    const patchBodyParser = new SparqlUpdateBodyParser();
    const handler = createHandler(store, { patchBodyParser });
    const sparql = `INSERT DATA { <${CREDENTIAL_RESOURCE}#s> <https://schema.org/name> "Alice" . }`;

    const response = await handle(handler, createRequest('PATCH', '/.internal/pod-data', {
      headers: {
        ...signedHeaders({
          method: 'PATCH',
          scopes: [ 'ai:credentials:write' ],
          nonce: 'patch-real-parser',
        }),
        'content-type': 'application/sparql-update',
      },
      body: sparql,
    }));

    expect(response.statusCode).toBe(204);
    const patch = store.modifyResource.mock.calls[0][1] as Patch & { algebra?: unknown };
    expect(patch).not.toBeInstanceOf(BasicRepresentation);
    expect(patch.metadata.contentType).toBe('application/sparql-update');
    expect(patch.algebra).toEqual(expect.objectContaining({ type: expect.any(String) }));
  });

  it('passes PATCH metadata and request body to the injected parser', async () => {
    const store = createStore();
    const parsedPatch = { metadata: new RepresentationMetadata({ path: CREDENTIAL_RESOURCE }), data: Readable.from([]), binary: true, isEmpty: false } as Patch;
    const patchBodyParser = {
      handleSafe: vi.fn(async ({ request, metadata }) => {
        expect(request.method).toBe('PATCH');
        expect(metadata.identifier.value).toBe(CREDENTIAL_RESOURCE);
        expect(metadata.contentType).toBe('application/sparql-update');
        return parsedPatch;
      }),
    } as unknown as BodyParser;
    const handler = createHandler(store, { patchBodyParser });

    const response = await handle(handler, createRequest('PATCH', '/.internal/pod-data', {
      headers: {
        ...signedHeaders({
          method: 'PATCH',
          scopes: [ 'ai:credentials:write' ],
          nonce: 'patch-injected-parser',
        }),
        'content-type': 'application/sparql-update',
      },
      body: 'INSERT DATA {}',
    }));

    expect(response.statusCode).toBe(204);
    expect(patchBodyParser.handleSafe).toHaveBeenCalledTimes(1);
    expect(store.modifyResource).toHaveBeenCalledWith({ path: CREDENTIAL_RESOURCE }, parsedPatch);
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

  it('rejects remote third-party owners even when the resource matches their model allowlist', async () => {
    const store = createStore();
    const handler = createHandler(store);
    const response = await handle(handler, createRequest('GET', '/.internal/pod-data', {
      headers: signedHeaders({
        ownerWebId: 'https://remote.example/alice/profile/card#me',
        resourceUrl: 'https://remote.example/alice/settings/credentials.ttl',
      }),
    }));

    expect(response.statusCode).toBe(404);
    expect(store.getRepresentation).not.toHaveBeenCalled();
  });
});
