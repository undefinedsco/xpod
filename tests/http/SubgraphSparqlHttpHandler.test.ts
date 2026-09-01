import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { DataFactory } from 'n3';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import type { HttpRequest, HttpResponse } from '@solid/community-server';
import { ForbiddenHttpError, NotImplementedHttpError, IdentifierSetMultiMap } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import { DisabledSparqlFeatureError, NativeSparqlExecutionError, UnsupportedSparqlQueryError } from '../../src/storage/rdf';

// Mock SubgraphQueryEngine
const mockQueryEngine = {
  queryBindings: vi.fn(),
  queryQuads: vi.fn(),
  queryBoolean: vi.fn(),
  queryVoid: vi.fn(),
  listGraphs: vi.fn(),
  constructGraph: vi.fn(),
};

// Mock CredentialsExtractor
const mockCredentialsExtractor = {
  handleSafe: vi.fn().mockResolvedValue({ agent: { webId: 'https://example.org/alice#me' } }),
};

// Mock PermissionReader
const mockPermissionReader = {
  handleSafe: vi.fn().mockResolvedValue(new IdentifierSetMultiMap()),
};

// Mock Authorizer
const mockAuthorizer = {
  handleSafe: vi.fn().mockResolvedValue(undefined),
};

function createMockRequest(url: string, method = 'GET', headers: Record<string, string> = {}): HttpRequest {
  return {
    url,
    method,
    headers: { host: 'localhost:3000', ...headers },
    setEncoding: vi.fn(),
    on: vi.fn((event, cb) => {
      if (event === 'end') setTimeout(cb, 0);
    }),
  } as unknown as HttpRequest;
}

function createMockResponse(): HttpResponse {
  // Create a real writable stream for pipeline compatibility
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  const response = Object.assign(writable, {
    statusCode: 200,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    removeHeader: vi.fn(),
    hasHeader: vi.fn(),
    headersSent: false,
    sendDate: true,
    getHeaderNames: vi.fn(() => []),
    getHeaders: vi.fn(() => ({})),
    flushHeaders: vi.fn(),
    writeHead: vi.fn(),
    bodyText: () => Buffer.concat(chunks).toString('utf8'),
  }) as unknown as HttpResponse;

  return response;
}

describe('SubgraphSparqlHttpHandler', () => {
  let handler: SubgraphSparqlHttpHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryEngine.listGraphs.mockResolvedValue(new Set());
    handler = new SubgraphSparqlHttpHandler(
      mockQueryEngine as any,
      mockCredentialsExtractor as any,
      mockPermissionReader as any,
      mockAuthorizer as any,
      {},
    );
  });

  async function postUpdate(update: string, path = '/alice/-/sparql'): Promise<HttpResponse> {
    const request = createMockRequest(path, 'POST', {
      'content-type': 'application/sparql-update',
    });
    const response = createMockResponse();
    let dataCallback: (chunk: string) => void;
    let endCallback: () => void;
    (request as any).on = vi.fn((event: string, cb: any) => {
      if (event === 'data') dataCallback = cb;
      if (event === 'end') endCallback = cb;
    });

    const handlePromise = handler.handle({ request, response });

    await new Promise(resolve => setTimeout(resolve, 0));
    dataCallback!(update);
    endCallback!();

    await handlePromise;
    return response;
  }

  describe('URL routing (canHandle) - sidecar /-/sparql pattern', () => {
    it('should accept container sidecar endpoint /alice/-/sparql', async () => {
      const request = createMockRequest('/alice/-/sparql');
      await expect(handler.canHandle({ request, response: createMockResponse() })).resolves.toBeUndefined();
    });

    it('should accept nested path sidecar endpoint /alice/photos/-/sparql', async () => {
      const request = createMockRequest('/alice/photos/-/sparql');
      await expect(handler.canHandle({ request, response: createMockResponse() })).resolves.toBeUndefined();
    });

    it('should accept root sidecar endpoint /-/sparql', async () => {
      const request = createMockRequest('/-/sparql');
      await expect(handler.canHandle({ request, response: createMockResponse() })).resolves.toBeUndefined();
    });

    it('should reject non-sidecar endpoints', async () => {
      const request = createMockRequest('/alice/profile.ttl');
      await expect(handler.canHandle({ request, response: createMockResponse() })).rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject random paths', async () => {
      const request = createMockRequest('/alice/foo/bar');
      await expect(handler.canHandle({ request, response: createMockResponse() })).rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject old .sparql suffix', async () => {
      const request = createMockRequest('/alice/profile.ttl.sparql');
      await expect(handler.canHandle({ request, response: createMockResponse() })).rejects.toThrow(NotImplementedHttpError);
    });

    it('should reject old /sparql container suffix', async () => {
      const request = createMockRequest('/alice/sparql');
      await expect(handler.canHandle({ request, response: createMockResponse() })).rejects.toThrow(NotImplementedHttpError);
    });
  });

  describe('basePath extraction', () => {
    it('should extract basePath with trailing slash from /-/sparql', async () => {
      // We test this indirectly via authorization calls
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      // Setup mock to return empty bindings
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      // Check that authorizeFor was called with container path (ending with /)
      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const identifiers = [...authCall.requestedModes.keys()];
      expect(identifiers[0].path).toBe('http://localhost:3000/alice/');
    });

    it('should extract nested basePath correctly', async () => {
      const request = createMockRequest('/alice/photos/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const identifiers = [...authCall.requestedModes.keys()];
      expect(identifiers[0].path).toBe('http://localhost:3000/alice/photos/');
    });

    it('should treat hidden .data sidecar base as a container', async () => {
      const request = createMockRequest('/alice/.data/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/.data/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/.data/',
          mode: 'read',
        }),
        { defaultDataset: 'scopedUnion' },
      );
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const identifiers = [...authCall.requestedModes.keys()];
      expect(identifiers[0].path).toBe('http://localhost:3000/alice/.data/');
    });

    it('should keep file sidecar base exact', async () => {
      const request = createMockRequest('/alice/profile/card.ttl/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/profile/card.ttl',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/profile/card.ttl',
          mode: 'read',
        }),
        {
          sourceUri: 'http://localhost:3000/alice/profile/card.ttl',
          defaultDataset: 'exactSource',
        },
      );
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const identifiers = [...authCall.requestedModes.keys()];
      expect(identifiers[0].path).toBe('http://localhost:3000/alice/profile/card.ttl');
    });

    it('should pass an exact document source to ASK execution', async () => {
      const query = 'ASK { ?s ?p ?o }';
      const request = createMockRequest(`/alice/profile/card.ttl/-/sparql?query=${encodeURIComponent(query)}`);
      const response = createMockResponse();
      mockQueryEngine.queryBoolean.mockResolvedValue(true);

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryBoolean).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/profile/card.ttl',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/profile/card.ttl',
          mode: 'read',
        }),
        {
          sourceUri: 'http://localhost:3000/alice/profile/card.ttl',
          defaultDataset: 'exactSource',
        },
      );
    });

    it('should pass an exact document source to CONSTRUCT execution', async () => {
      const query = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
      const request = createMockRequest(`/alice/profile/card.ttl/-/sparql?query=${encodeURIComponent(query)}`);
      const response = createMockResponse();
      mockQueryEngine.queryQuads.mockResolvedValue((async function*() {
        yield DataFactory.quad(
          DataFactory.namedNode('https://example.org/s'),
          DataFactory.namedNode('https://example.org/p'),
          DataFactory.literal('o'),
        );
      })());

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryQuads).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/profile/card.ttl',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/profile/card.ttl',
          mode: 'read',
        }),
        {
          sourceUri: 'http://localhost:3000/alice/profile/card.ttl',
          defaultDataset: 'exactSource',
        },
      );
    });
  });

  describe('trusted internal model collection bridge', () => {
    it('executes a validated owner SELECT without invoking external credentials authorization', async () => {
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: ['id'] }),
      });
      const owner = 'http://localhost:3000/alice/profile/card#me';
      const query = 'SELECT ?id WHERE { ?id ?p ?o }';
      const endpoint = `http://localhost:3000/alice/settings/providers/-/sparql?query=${encodeURIComponent(query)}`;
      const response = createMockResponse();

      await handler.handleTrustedInternalSelect({
        ownerWebId: owner,
        endpointUrl: endpoint,
        query,
        request: createMockRequest('/.internal/pod-data'),
        response,
      });

      expect(response.statusCode).toBe(200);
      expect((response as any).bodyText()).toContain('bindings');
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
      expect(mockAuthorizer.handleSafe).not.toHaveBeenCalled();
      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/settings/providers/',
        {
          basePath: 'http://localhost:3000/alice/settings/providers/',
          mode: 'read',
          principal: 'trusted:http://localhost:3000/alice/settings/providers/',
          version: 'trusted-owner:http://localhost:3000/alice/settings/providers/',
        },
        { defaultDataset: 'scopedUnion' },
      );
    });

    it('accepts an owner-locked endpoint without a query string for POST delegation', async () => {
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: ['id'] }),
      });
      const query = 'SELECT ?id WHERE { ?id ?p ?o }';
      const response = createMockResponse();

      await handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/providers/-/sparql',
        query,
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response,
      });

      expect(response.statusCode).toBe(200);
      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/settings/providers/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/settings/providers/',
          mode: 'read',
        }),
        { defaultDataset: 'scopedUnion' },
      );
    });

    it('keeps the trusted gateway access-key document sidecar scoped to the exact Turtle file', async () => {
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: ['id'] }),
      });
      const query = 'SELECT ?id WHERE { ?id ?p ?o }';
      const endpoint = 'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl/-/sparql';
      const response = createMockResponse();

      await handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: endpoint,
        query,
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response,
      });

      expect(response.statusCode).toBe(200);
      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl',
        {
          basePath: 'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl',
          mode: 'read',
          principal: 'trusted:http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl',
          version: 'trusted-owner:http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl',
        },
        {
          sourceUri: 'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl',
          defaultDataset: 'exactSource',
        },
      );
    });

    it.each([
      'http://localhost:3000/bob/.data/ai/gateway/access-keys.ttl/-/sparql',
      'http://localhost:3000/alice/.data/ai/gateway/other.ttl/-/sparql',
      'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl/-/sparql?query=SELECT%20*%20WHERE%20%7B%7D&format=json',
      'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl/-/sparql#fragment',
    ])('rejects a non-exact trusted gateway access-key document endpoint: %s', async (endpoint) => {
      await expect(handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: endpoint,
        query: 'SELECT * WHERE {}',
        request: createMockRequest('/.internal/pod-data'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryBindings).not.toHaveBeenCalled();
    });

    it.each([
      'http://localhost:3000/bob/settings/providers/-/sparql?query=SELECT%20%2A%20WHERE%20%7B%7D',
      'http://localhost:3000/alice/settings/providers/secret/-/sparql?query=SELECT%20%2A%20WHERE%20%7B%7D',
      'http://localhost:3000/alice/settings/providers/-/sparql?query=SELECT%20%2A%20WHERE%20%7B%7D&format=json',
    ])('rejects trusted endpoint outside exact owner collection: %s', async (endpoint) => {
      await expect(handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: endpoint,
        query: 'SELECT * WHERE {}',
        request: createMockRequest('/.internal/pod-data'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
    });

    it('rejects a query that does not match the signed endpoint query', async () => {
      const endpointQuery = 'SELECT * WHERE {}';
      await expect(handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: `http://localhost:3000/alice/settings/providers/-/sparql?query=${encodeURIComponent(endpointQuery)}`,
        query: 'SELECT ?id WHERE { ?id ?p ?o }',
        request: createMockRequest('/.internal/pod-data'),
        response: createMockResponse(),
      })).rejects.toThrow();
    });

    it('executes a validated owner settings SELECT without invoking external credentials authorization', async () => {
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: ['id'] }),
      });
      const query = 'SELECT ?id WHERE { ?id ?p ?o }';
      const response = createMockResponse();

      await handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/-/sparql',
        query,
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response,
      });

      expect(response.statusCode).toBe(200);
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
      expect(mockAuthorizer.handleSafe).not.toHaveBeenCalled();
      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        query,
        'http://localhost:3000/alice/settings/',
        {
          basePath: 'http://localhost:3000/alice/settings/',
          mode: 'read',
          principal: 'trusted:http://localhost:3000/alice/settings/',
          version: 'trusted-owner:http://localhost:3000/alice/settings/',
        },
        { defaultDataset: 'scopedUnion' },
      );
    });

    it('executes a validated owner settings UPDATE with a trusted read scope', async () => {
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);
      const update = `
        INSERT { <#s> <#p> ?o }
        WHERE { BIND("trusted" AS ?o) }
      `;
      const response = createMockResponse();

      await handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/-/sparql',
        query: update,
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response,
      });

      expect(response.statusCode).toBe(204);
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
      expect(mockAuthorizer.handleSafe).not.toHaveBeenCalled();
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        expect.stringContaining('GRAPH <http://localhost:3000/alice/settings/>'),
        'http://localhost:3000/alice/settings/',
        {
          basePath: 'http://localhost:3000/alice/settings/',
          mode: 'read',
          principal: 'trusted:http://localhost:3000/alice/settings/',
          version: 'trusted-owner:http://localhost:3000/alice/settings/',
        },
        undefined,
      );
    });

    it('rejects trusted UPDATE against the model collection endpoint', async () => {
      await expect(handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/providers/-/sparql',
        query: 'INSERT DATA { <#s> <#p> <#o> }',
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
    });

    it('rejects trusted UPDATE against the gateway access-key document endpoint', async () => {
      await expect(handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/.data/ai/gateway/access-keys.ttl/-/sparql',
        query: 'INSERT DATA { <#s> <#p> <#o> }',
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
    });

    it('rejects mismatched trusted SELECT and UPDATE operation kinds by parsed AST', async () => {
      await expect(handler.handleTrustedInternalSelect({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/-/sparql',
        query: 'INSERT DATA { <#s> <#p> <#o> }',
        request: createMockRequest('/.internal/pod-data'),
        response: createMockResponse(),
      })).rejects.toThrow();

      await expect(handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/-/sparql',
        query: 'SELECT * WHERE { ?s ?p ?o }',
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryBindings).not.toHaveBeenCalled();
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
    });

    it.each([
      'http://localhost:3000/bob/settings/-/sparql',
      'http://localhost:3000/alice/settings/providers/-/sparql',
      'http://localhost:3000/alice/settings/near/-/sparql',
      'http://localhost:3000/alice/settings/-/sparql?query=INSERT%20DATA%20%7B%7D',
      'http://localhost:3000/alice/settings/-/sparql#fragment',
    ])('rejects trusted settings UPDATE outside the exact owner endpoint: %s', async (endpoint) => {
      await expect(handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: endpoint,
        query: 'INSERT DATA { <#s> <#p> <#o> }',
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
    });

    it('rejects trusted settings UPDATE graphs outside the settings base path', async () => {
      await expect(handler.handleTrustedInternalUpdate({
        ownerWebId: 'http://localhost:3000/alice/profile/card#me',
        endpointUrl: 'http://localhost:3000/alice/settings/-/sparql',
        query: 'INSERT DATA { GRAPH <http://localhost:3000/alice/profile/card> { <#s> <#p> <#o> } }',
        request: createMockRequest('/.internal/pod-data', 'POST'),
        response: createMockResponse(),
      })).rejects.toThrow();
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
      expect(mockCredentialsExtractor.handleSafe).not.toHaveBeenCalled();
    });
  });

  describe('permission mapping', () => {
    it('routes an authorized update through the configured RDF file authority', async () => {
      const updateAuthority = {
        executeSparqlUpdate: vi.fn().mockResolvedValue(undefined),
      };
      handler = new SubgraphSparqlHttpHandler(
        mockQueryEngine as any,
        mockCredentialsExtractor as any,
        mockPermissionReader as any,
        mockAuthorizer as any,
        {},
        updateAuthority as any,
      );

      const response = await postUpdate(`
        INSERT DATA {
          <#s> <#p> <#o>
        }
      `, '/alice/note.ttl/-/sparql');

      expect(response.statusCode).toBe(204);
      expect(updateAuthority.executeSparqlUpdate).toHaveBeenCalledWith(
        expect.stringContaining('GRAPH <http://localhost:3000/alice/note.ttl>'),
        'http://localhost:3000/alice/note.ttl',
        undefined,
      );
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
    });

    it('should require append for INSERT only', async () => {
      const request = createMockRequest('/alice/-/sparql', 'POST', {
        'content-type': 'application/sparql-update',
      });
      const response = createMockResponse();

      // Mock the request body
      let dataCallback: (chunk: string) => void;
      let endCallback: () => void;
      (request as any).on = vi.fn((event: string, cb: any) => {
        if (event === 'data') dataCallback = cb;
        if (event === 'end') endCallback = cb;
      });

      mockQueryEngine.queryVoid.mockResolvedValue(undefined);
      mockQueryEngine.listGraphs.mockResolvedValue(new Set());

      const handlePromise = handler.handle({ request, response });

      // Simulate body data
      await new Promise(resolve => setTimeout(resolve, 0));
      dataCallback!('INSERT DATA { <http://localhost:3000/alice/s> <http://localhost:3000/alice/p> <http://localhost:3000/alice/o> }');
      endCallback!();

      await handlePromise;

      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const modes = [...authCall.requestedModes.values()].flat();
      expect(modes).toContain(PERMISSIONS.Append);
      expect(modes).not.toContain(PERMISSIONS.Modify);
    });

    it('should require delete for DELETE only', async () => {
      const request = createMockRequest('/alice/-/sparql', 'POST', {
        'content-type': 'application/sparql-update',
      });
      const response = createMockResponse();

      let dataCallback: (chunk: string) => void;
      let endCallback: () => void;
      (request as any).on = vi.fn((event: string, cb: any) => {
        if (event === 'data') dataCallback = cb;
        if (event === 'end') endCallback = cb;
      });

      mockQueryEngine.queryVoid.mockResolvedValue(undefined);
      mockQueryEngine.listGraphs.mockResolvedValue(new Set());

      const handlePromise = handler.handle({ request, response });

      await new Promise(resolve => setTimeout(resolve, 0));
      dataCallback!('DELETE DATA { <http://localhost:3000/alice/s> <http://localhost:3000/alice/p> <http://localhost:3000/alice/o> }');
      endCallback!();

      await handlePromise;

      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const modes = [...authCall.requestedModes.values()].flat();
      expect(modes).toContain(PERMISSIONS.Delete);
      expect(modes).not.toContain(PERMISSIONS.Append);
    });

    it('should require both append and delete for INSERT + DELETE', async () => {
      const request = createMockRequest('/alice/-/sparql', 'POST', {
        'content-type': 'application/sparql-update',
      });
      const response = createMockResponse();

      let dataCallback: (chunk: string) => void;
      let endCallback: () => void;
      (request as any).on = vi.fn((event: string, cb: any) => {
        if (event === 'data') dataCallback = cb;
        if (event === 'end') endCallback = cb;
      });

      mockQueryEngine.queryVoid.mockResolvedValue(undefined);
      mockQueryEngine.listGraphs.mockResolvedValue(new Set());

      const handlePromise = handler.handle({ request, response });

      await new Promise(resolve => setTimeout(resolve, 0));
      dataCallback!('DELETE { ?s ?p ?o } INSERT { <http://localhost:3000/alice/s> <http://localhost:3000/alice/p> <http://localhost:3000/alice/o> } WHERE { ?s ?p ?o }');
      endCallback!();

      await handlePromise;

      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const modes = [...authCall.requestedModes.values()].flat();
      expect(modes).toContain(PERMISSIONS.Append);
      expect(modes).toContain(PERMISSIONS.Delete);
    });

    it('should require read for SELECT', async () => {
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockAuthorizer.handleSafe).toHaveBeenCalled();
      const authCall = mockAuthorizer.handleSafe.mock.calls[0][0];
      const modes = [...authCall.requestedModes.values()].flat();
      expect(modes).toContain(PERMISSIONS.Read);
    });

    it('should pass denied child graphs as an ACL/ACR access scope for SELECT', async () => {
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();
      const privateGraph = 'http://localhost:3000/alice/private.ttl';

      mockQueryEngine.listGraphs.mockResolvedValue(new Set([
        'http://localhost:3000/alice/public.ttl',
        privateGraph,
      ]));
      mockAuthorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
        const identifier = [...requestedModes.keys()][0];
        if (identifier.path === privateGraph) {
          throw new Error('child graph read denied');
        }
      });
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
          principal: 'https://example.org/alice#me',
          deniedGraphUrls: [privateGraph],
        }),
        { defaultDataset: 'scopedUnion' },
      );
      expect(mockAuthorizer.handleSafe).toHaveBeenCalledTimes(3);
    });

    it('should authorize prefixed metadata graphs against their source resource', async () => {
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20GRAPH%20%3Fg%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20%7D');
      const response = createMockResponse();
      const privateResource = 'http://localhost:3000/alice/private.png';
      const privateMetaGraph = `meta:${privateResource}`;

      mockQueryEngine.listGraphs.mockResolvedValue(new Set([
        privateMetaGraph,
      ]));
      mockAuthorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
        const identifier = [...requestedModes.keys()][0];
        if (identifier.path === privateResource) {
          throw new Error('source resource read denied');
        }
      });
      mockQueryEngine.queryBindings.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true }),
        }),
        metadata: () => Promise.resolve({ variables: [] }),
      });

      await handler.handle({ request, response });

      expect(mockQueryEngine.queryBindings).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/',
        expect.objectContaining({
          deniedGraphUrls: [privateMetaGraph],
        }),
        { defaultDataset: 'scopedUnion' },
      );
      const checkedIdentifiers = mockAuthorizer.handleSafe.mock.calls.map((call) => [...call[0].requestedModes.keys()][0].path);
      expect(checkedIdentifiers).toContain(privateResource);
    });

    it('should reject UPDATE when a target child graph denies the write mode', async () => {
      const privateGraph = 'http://localhost:3000/alice/private.ttl';
      mockAuthorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
        const identifier = [...requestedModes.keys()][0];
        const modes = [...requestedModes.values()].flat();
        if (identifier.path === privateGraph && modes.includes(PERMISSIONS.Append)) {
          throw new ForbiddenHttpError('child graph append denied');
        }
      });
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`
        INSERT DATA { GRAPH <${privateGraph}> { <#s> <#p> <#o> } }
      `);

      expect(response.statusCode).toBe(403);
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
    });

    it('should route CREATE GRAPH through UPDATE execution as an authorized no-op', async () => {
      const graph = 'http://localhost:3000/alice/created.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`CREATE GRAPH <${graph}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        expect.stringContaining(`CREATE GRAPH <${graph}>`),
        'http://localhost:3000/alice/',
        undefined,
        undefined,
      );
      const appendChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === graph))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(appendChecks).toContain(PERMISSIONS.Append);
    });

    it('should rewrite CLEAR GRAPH to a bounded DELETE WHERE update', async () => {
      const graph = 'http://localhost:3000/alice/target.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`CLEAR GRAPH <${graph}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
      const deleteChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === graph))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(deleteChecks).toContain(PERMISSIONS.Delete);
    });

    it('should rewrite DROP GRAPH to a bounded DELETE WHERE update', async () => {
      const graph = 'http://localhost:3000/alice/drop-target.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`DROP GRAPH <${graph}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
      const deleteChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === graph))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(deleteChecks).toContain(PERMISSIONS.Delete);
    });

    it('should rewrite ADD GRAPH to a bounded INSERT WHERE update', async () => {
      const source = 'http://localhost:3000/alice/source.ttl';
      const target = 'http://localhost:3000/alice/add-target.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`ADD GRAPH <${source}> TO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `INSERT { GRAPH <${target}> { ?s ?p ?o } } WHERE { GRAPH <${source}> { ?s ?p ?o } }`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
      const sourceChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === source))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      const targetChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === target))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(sourceChecks).toContain(PERMISSIONS.Read);
      expect(targetChecks).toContain(PERMISSIONS.Append);
    });

    it('should rewrite COPY GRAPH to clear the destination before inserting source triples', async () => {
      const source = 'http://localhost:3000/alice/source.ttl';
      const target = 'http://localhost:3000/alice/copy-target.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`COPY GRAPH <${source}> TO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `DELETE WHERE { GRAPH <${target}> { ?s ?p ?o } }; INSERT { GRAPH <${target}> { ?s ?p ?o } } WHERE { GRAPH <${source}> { ?s ?p ?o } }`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
      const sourceChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === source))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      const targetChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === target))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(sourceChecks).toContain(PERMISSIONS.Read);
      expect(targetChecks).toContain(PERMISSIONS.Delete);
      expect(targetChecks).toContain(PERMISSIONS.Append);
    });

    it('should rewrite MOVE GRAPH to copy source triples and then clear source', async () => {
      const source = 'http://localhost:3000/alice/source.ttl';
      const target = 'http://localhost:3000/alice/move-target.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`MOVE GRAPH <${source}> TO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `DELETE WHERE { GRAPH <${target}> { ?s ?p ?o } }; INSERT { GRAPH <${target}> { ?s ?p ?o } } WHERE { GRAPH <${source}> { ?s ?p ?o } }; DELETE WHERE { GRAPH <${source}> { ?s ?p ?o } }`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
      const sourceChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === source))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      const targetChecks = mockAuthorizer.handleSafe.mock.calls
        .map((call) => call[0].requestedModes)
        .filter((requestedModes) => [...requestedModes.keys()].some((identifier: any) => identifier.path === target))
        .flatMap((requestedModes) => [...requestedModes.values()].flat());
      expect(sourceChecks).toContain(PERMISSIONS.Read);
      expect(sourceChecks).toContain(PERMISSIONS.Delete);
      expect(targetChecks).toContain(PERMISSIONS.Delete);
      expect(targetChecks).toContain(PERMISSIONS.Append);
    });

    it('should keep same-source MOVE GRAPH as a no-op instead of clearing the graph', async () => {
      const graph = 'http://localhost:3000/alice/same.ttl';
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`MOVE GRAPH <${graph}> TO GRAPH <${graph}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `CREATE SILENT GRAPH <${graph}>`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
    });

    it('should route LOAD through product-authorized document content into native SPARQL', async () => {
      const source = 'http://localhost:3000/alice/source.nt';
      const target = 'http://localhost:3000/alice/target.ttl';
      mockQueryEngine.constructGraph.mockResolvedValue([
        DataFactory.quad(
          DataFactory.namedNode('http://localhost:3000/alice/s'),
          DataFactory.namedNode('http://localhost:3000/alice/p'),
          DataFactory.namedNode('http://localhost:3000/alice/o'),
        ),
      ]);
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`LOAD <${source}> INTO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.constructGraph).toHaveBeenCalledWith(
        source,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
      );
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `LOAD <${source}> INTO GRAPH <${target}>`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        expect.objectContaining({
          loadDocument: expect.objectContaining({
            sourceUri: source,
            mediaType: 'application/n-triples',
            body: expect.stringContaining('<http://localhost:3000/alice/s> <http://localhost:3000/alice/p> <http://localhost:3000/alice/o> .'),
          }),
        }),
      );
      const checked = mockAuthorizer.handleSafe.mock.calls.map((call) => ({
        paths: [...call[0].requestedModes.keys()].map((identifier: any) => identifier.path),
        modes: [...call[0].requestedModes.values()].flat(),
      }));
      expect(checked).toContainEqual(expect.objectContaining({
        paths: [source],
        modes: expect.arrayContaining([PERMISSIONS.Read]),
      }));
      expect(checked).toContainEqual(expect.objectContaining({
        paths: [target],
        modes: expect.arrayContaining([PERMISSIONS.Append]),
      }));
    });

    it('materializes authorized LOAD content before handing it to the RDF file authority', async () => {
      const source = 'http://localhost:3000/alice/source.nt';
      const target = 'http://localhost:3000/alice/target.ttl';
      const updateAuthority = {
        executeSparqlUpdate: vi.fn().mockResolvedValue(undefined),
      };
      handler = new SubgraphSparqlHttpHandler(
        mockQueryEngine as any,
        mockCredentialsExtractor as any,
        mockPermissionReader as any,
        mockAuthorizer as any,
        {},
        updateAuthority as any,
      );
      mockQueryEngine.constructGraph.mockResolvedValue([
        DataFactory.quad(
          DataFactory.namedNode('http://localhost:3000/alice/s'),
          DataFactory.namedNode('http://localhost:3000/alice/p'),
          DataFactory.literal('loaded'),
        ),
      ]);

      const response = await postUpdate(`LOAD <${source}> INTO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(updateAuthority.executeSparqlUpdate).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(
          `^INSERT DATA \\{ GRAPH <${target}> \\{[\\s\\S]*"loaded"[\\s\\S]*\\} \\}$`,
        )),
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
      );
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
    });

    it('should rewrite LOAD without INTO GRAPH to the product default graph', async () => {
      const source = 'http://localhost:3000/alice/source.nt';
      mockQueryEngine.constructGraph.mockResolvedValue([
        DataFactory.quad(
          DataFactory.namedNode('http://localhost:3000/alice/s'),
          DataFactory.namedNode('http://localhost:3000/alice/p'),
          DataFactory.namedNode('http://localhost:3000/alice/o'),
        ),
      ]);
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`LOAD <${source}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `LOAD <${source}> INTO GRAPH <http://localhost:3000/alice/>`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        expect.objectContaining({
          loadDocument: expect.objectContaining({
            sourceUri: source,
          }),
        }),
      );
    });

    it('should let native SPARQL handle LOAD SILENT when the authorized source cannot be loaded', async () => {
      const source = 'http://localhost:3000/alice/missing-source.nt';
      const target = 'http://localhost:3000/alice/target.ttl';
      mockQueryEngine.constructGraph.mockRejectedValueOnce(new Error('source not found'));
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`LOAD SILENT <${source}> INTO GRAPH <${target}>`);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.constructGraph).toHaveBeenCalledWith(
        source,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
      );
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        `LOAD SILENT <${source}> INTO GRAPH <${target}>`,
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
        }),
        undefined,
      );
    });

    it('should pass ACL/ACR read scope into UPDATE WHERE execution', async () => {
      const privateGraph = 'http://localhost:3000/alice/private.ttl';
      mockQueryEngine.listGraphs.mockResolvedValue(new Set([
        'http://localhost:3000/alice/public.ttl',
        privateGraph,
      ]));
      mockAuthorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
        const identifier = [...requestedModes.keys()][0];
        const modes = [...requestedModes.values()].flat();
        if (identifier.path === privateGraph && modes.includes(PERMISSIONS.Read)) {
          throw new Error('child graph read denied');
        }
      });
      mockQueryEngine.queryVoid.mockResolvedValue(undefined);

      const response = await postUpdate(`
        DELETE { GRAPH <${privateGraph}> { ?s ?p ?o } }
        WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }
      `);

      expect(response.statusCode).toBe(204);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
          deniedGraphUrls: [privateGraph],
        }),
        undefined,
      );
    });

    it('passes ACL/ACR read scope into RDF file-authority UPDATE WHERE execution', async () => {
      const privateGraph = 'http://localhost:3000/alice/private.ttl';
      const updateAuthority = {
        executeSparqlUpdate: vi.fn().mockResolvedValue(undefined),
      };
      handler = new SubgraphSparqlHttpHandler(
        mockQueryEngine as any,
        mockCredentialsExtractor as any,
        mockPermissionReader as any,
        mockAuthorizer as any,
        {},
        updateAuthority as any,
      );
      mockQueryEngine.listGraphs.mockResolvedValue(new Set([
        'http://localhost:3000/alice/public.ttl',
        privateGraph,
      ]));
      mockAuthorizer.handleSafe.mockImplementation(async ({ requestedModes }: any) => {
        const identifier = [...requestedModes.keys()][0];
        const modes = [...requestedModes.values()].flat();
        if (identifier.path === privateGraph && modes.includes(PERMISSIONS.Read)) {
          throw new Error('child graph read denied');
        }
      });

      const response = await postUpdate(`
        INSERT { GRAPH <http://localhost:3000/alice/public.ttl> { <urn:copy> <urn:p> ?o } }
        WHERE { GRAPH <${privateGraph}> { ?s <urn:p> ?o } }
      `);

      expect(response.statusCode).toBe(204);
      expect(updateAuthority.executeSparqlUpdate).toHaveBeenCalledWith(
        expect.any(String),
        'http://localhost:3000/alice/',
        expect.objectContaining({
          basePath: 'http://localhost:3000/alice/',
          mode: 'read',
          deniedGraphUrls: [privateGraph],
        }),
      );
      expect(mockQueryEngine.queryVoid).not.toHaveBeenCalled();
    });
  });

  describe('RDF engine error mapping', () => {
    it('should return 400 when the embedded engine cannot execute a query without compatibility fallback', async () => {
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockRejectedValueOnce(
        new UnsupportedSparqlQueryError('No compatibility SPARQL fallback configured for queryBindings: unsupported shape'),
      );

      await expect(handler.handle({ request, response })).resolves.toBeUndefined();

      expect(response.statusCode).toBe(400);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
      expect((response as unknown as { bodyText: () => string }).bodyText()).toBe(
        'Embedded SPARQL engine cannot execute queryBindings: Query shape is not supported by the embedded RDF engine',
      );
      expect((response as unknown as { bodyText: () => string }).bodyText()).not.toMatch(/compatibility|fallback/i);
    });

    it('should return structured unsupported query details when JSON is accepted', async () => {
      const request = createMockRequest(
        '/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D',
        'GET',
        { accept: 'application/json' },
      );
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockRejectedValueOnce(
        new UnsupportedSparqlQueryError('Embedded SPARQL engine cannot execute queryBindings: Subqueries is not supported by the embedded RDF engine'),
      );

      await expect(handler.handle({ request, response })).resolves.toBeUndefined();

      expect(response.statusCode).toBe(400);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
      expect(JSON.parse((response as unknown as { bodyText: () => string }).bodyText())).toEqual({
        error: {
          code: 'rdf.sparql.unsupported_query_shape',
          message: 'Embedded SPARQL engine cannot execute queryBindings: Subqueries is not supported by the embedded RDF engine',
          capability: 'sparql.query.subquery',
          hint: expect.stringContaining('Flatten the subquery'),
          correction: {
            capability: 'sparql.query.subquery',
            primaryAction: 'materialize_intermediate',
            availableActions: [ 'materialize_intermediate', 'rewrite_query', 'route_external_executor' ],
            target: 'embedded_rdf_engine',
            message: expect.stringContaining('Materialize the unsupported intermediate result'),
          },
        },
      });
    });

    it('should return 403 when a disabled SPARQL feature is requested', async () => {
      const request = createMockRequest('/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20SERVICE%20%3Chttps%3A%2F%2Fremote.example%2Fsparql%3E%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20%7D');
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockRejectedValueOnce(
        new DisabledSparqlFeatureError('SPARQL SERVICE federation is disabled for server-owned Pod queries'),
      );

      await expect(handler.handle({ request, response })).resolves.toBeUndefined();

      expect(response.statusCode).toBe(403);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    });

    it('should return structured federation correction details when JSON is accepted', async () => {
      const request = createMockRequest(
        '/alice/-/sparql?query=SELECT%20*%20WHERE%20%7B%20SERVICE%20%3Chttps%3A%2F%2Fremote.example%2Fsparql%3E%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20%7D',
        'GET',
        { accept: 'application/json' },
      );
      const response = createMockResponse();

      mockQueryEngine.queryBindings.mockRejectedValueOnce(
        new DisabledSparqlFeatureError('SPARQL SERVICE federation is disabled for server-owned Pod queries'),
      );

      await expect(handler.handle({ request, response })).resolves.toBeUndefined();

      expect(response.statusCode).toBe(403);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
      expect(JSON.parse((response as unknown as { bodyText: () => string }).bodyText())).toEqual({
        error: {
          code: 'rdf.sparql.disabled_feature',
          message: 'SPARQL SERVICE federation is disabled for server-owned Pod queries',
          capability: 'sparql.federation.service',
          hint: expect.stringContaining('trusted client-side/federated query layer'),
          correction: {
            capability: 'sparql.federation.service',
            primaryAction: 'route_external_executor',
            availableActions: [ 'route_external_executor' ],
            target: 'trusted_client_or_federated_engine',
            message: expect.stringContaining('trusted client-side or federated query layer'),
          },
        },
      });
    });

    it('should return 500 when native SPARQL update execution returns error status', async () => {
      mockQueryEngine.queryVoid.mockRejectedValueOnce(
        new NativeSparqlExecutionError('adapter-create-failed'),
      );

      const response = await postUpdate(`
        INSERT DATA {
          GRAPH <http://localhost:3000/alice/native-error.ttl> {
            <#s> <#p> <#o>
          }
        }
      `);

      expect(response.statusCode).toBe(500);
      expect(mockQueryEngine.queryVoid).toHaveBeenCalledOnce();
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
      expect((response as unknown as { bodyText: () => string }).bodyText()).toBe(
        'Native SPARQL engine failed: adapter-create-failed',
      );
    });
  });

  describe('custom sidecarPath', () => {
    it('should support custom sidecarPath', async () => {
      const customHandler = new SubgraphSparqlHttpHandler(
        mockQueryEngine as any,
        mockCredentialsExtractor as any,
        mockPermissionReader as any,
        mockAuthorizer as any,
        { sidecarPath: '/-/query' },
      );

      const request = createMockRequest('/alice/-/query');
      await expect(customHandler.canHandle({ request, response: createMockResponse() })).resolves.toBeUndefined();
    });

    it('should reject default path when custom sidecarPath is set', async () => {
      const customHandler = new SubgraphSparqlHttpHandler(
        mockQueryEngine as any,
        mockCredentialsExtractor as any,
        mockPermissionReader as any,
        mockAuthorizer as any,
        { sidecarPath: '/-/query' },
      );

      const request = createMockRequest('/alice/-/sparql');
      await expect(customHandler.canHandle({ request, response: createMockResponse() })).rejects.toThrow(NotImplementedHttpError);
    });
  });
});
