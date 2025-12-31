import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import type { HttpRequest, HttpResponse } from '@solid/community-server';
import { NotImplementedHttpError, IdentifierSetMultiMap } from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';

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
  }) as unknown as HttpResponse;

  return response;
}

describe('SubgraphSparqlHttpHandler', () => {
  let handler: SubgraphSparqlHttpHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new SubgraphSparqlHttpHandler(
      mockQueryEngine as any,
      mockCredentialsExtractor as any,
      mockPermissionReader as any,
      mockAuthorizer as any,
      {},
    );
  });

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
  });

  describe('permission mapping', () => {
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
