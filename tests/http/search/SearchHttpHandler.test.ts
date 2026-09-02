/**
 * SearchHttpHandler 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchHttpHandler } from '../../../src/http/search/SearchHttpHandler';
import type { VectorStore } from '../../../src/storage/vector/VectorStore';
import type { EmbeddingService } from '../../../src/ai/service/EmbeddingService';
import type { SparqlEngine } from '../../../src/storage/sparql/SubgraphQueryEngine';
import type { HttpRequest, HttpResponse, CredentialsExtractor, PermissionReader, Authorizer } from '@solid/community-server';
import { Readable } from 'node:stream';

// Mock SPARQL bindings stream
function createMockBindingsStream(bindings: Record<string, string>[]): AsyncIterable<Map<string, { value: string }>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const binding of bindings) {
        const map = new Map<string, { value: string }>();
        for (const [key, value] of Object.entries(binding)) {
          map.set(key, { value });
        }
        yield map;
      }
    },
  };
}

// Mock factories
function createMockVectorStore(): VectorStore {
  return {
    search: vi.fn().mockResolvedValue([
      { id: 123, score: 0.95, distance: 0.05 },
      { id: 456, score: 0.85, distance: 0.15 },
    ]),
    ensureVectorTable: vi.fn().mockResolvedValue(undefined),
  } as unknown as VectorStore;
}

function createMockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  } as unknown as EmbeddingService;
}

function createMockSparqlEngine(hasCredential = true): SparqlEngine {
  return {
    queryBindings: vi.fn().mockImplementation(async () => {
      if (hasCredential) {
        return createMockBindingsStream([{ apiKey: 'test-api-key', provider: 'google' }]);
      }
      return createMockBindingsStream([]);
    }),
  } as unknown as SparqlEngine;
}

function createMockCredentialsExtractor(): CredentialsExtractor {
  return {
    handleSafe: vi.fn().mockResolvedValue({
      agent: { webId: 'http://localhost/alice/profile/card#me' },
    }),
  } as unknown as CredentialsExtractor;
}

function createMockPermissionReader(): PermissionReader {
  return {
    handleSafe: vi.fn().mockResolvedValue(new Map()),
  } as unknown as PermissionReader;
}

function createMockAuthorizer(): Authorizer {
  return {
    handleSafe: vi.fn().mockResolvedValue(undefined),
  } as unknown as Authorizer;
}

function createMockRequest(options: {
  method?: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): HttpRequest {
  const { method = 'GET', url = '/', body = '', headers = {} } = options;

  // 创建一个可以被异步迭代的 readable
  const chunks = body ? [Buffer.from(body)] : [];
  let index = 0;

  const readable = {
    method,
    url,
    headers: {
      host: 'localhost',
      ...headers,
    },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };

  return readable as unknown as HttpRequest;
}

function createMockResponse(): HttpResponse & { _data: string; _status: number; _headers: Record<string, string> } {
  const response = {
    _data: '',
    _status: 200,
    _headers: {} as Record<string, string>,
    writeHead: vi.fn().mockImplementation(function (this: any, status: number, headers: Record<string, string>) {
      this._status = status;
      this._headers = headers;
    }),
    end: vi.fn().mockImplementation(function (this: any, data: string) {
      this._data = data;
    }),
    setHeader: vi.fn(),
  };
  return response as any;
}

describe('SearchHttpHandler', () => {
  let handler: SearchHttpHandler;
  let mockVectorStore: VectorStore;
  let mockEmbeddingService: EmbeddingService;
  let mockSparqlEngine: SparqlEngine;

  beforeEach(() => {
    mockVectorStore = createMockVectorStore();
    mockEmbeddingService = createMockEmbeddingService();
    mockSparqlEngine = createMockSparqlEngine();

    handler = new SearchHttpHandler(
      mockVectorStore,
      mockEmbeddingService,
      mockSparqlEngine,
      createMockCredentialsExtractor(),
      createMockPermissionReader(),
      createMockAuthorizer(),
    );
  });

  describe('canHandle', () => {
    it('should handle /-/search requests', async () => {
      const request = createMockRequest({ url: '/alice/-/search?q=test' });
      await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
    });

    it('should reject non-search requests', async () => {
      const request = createMockRequest({ url: '/alice/documents/file.txt' });
      await expect(handler.canHandle({ request } as any)).rejects.toThrow();
    });
  });

  describe('handle GET', () => {
    it('should search with query parameter', async () => {
      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=machine%20learning',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(mockEmbeddingService.embed).toHaveBeenCalledWith(
        'machine learning',
        expect.any(Object),
        'text-embedding-004',
      );
      expect(mockVectorStore.search).toHaveBeenCalled();
      expect(response._status).toBe(200);

      const data = JSON.parse(response._data);
      expect(data.results).toHaveLength(2);
      expect(data.model).toBe('text-embedding-004');
      expect(data.took_ms).toBeGreaterThanOrEqual(0);
    });

    it('should return error for missing query', async () => {
      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(400);
      const data = JSON.parse(response._data);
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('should support limit parameter', async () => {
      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=test&limit=5',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(mockVectorStore.search).toHaveBeenCalledWith(
        'text-embedding-004',
        expect.any(Array),
        expect.objectContaining({ limit: 5 }),
      );
    });

    it('should support model parameter', async () => {
      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=test&model=custom-model',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(mockEmbeddingService.embed).toHaveBeenCalledWith(
        'test',
        expect.any(Object),
        'custom-model',
      );
    });
  });

  describe('handle POST', () => {
    it('should search with JSON body', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: '/alice/-/search',
        body: JSON.stringify({ query: 'semantic search' }),
        headers: { 'content-type': 'application/json' },
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(mockEmbeddingService.embed).toHaveBeenCalledWith(
        'semantic search',
        expect.any(Object),
        'text-embedding-004',
      );
      expect(response._status).toBe(200);
    });

    it('should accept pre-computed vector', async () => {
      const vector = new Array(768).fill(0.5);
      const request = createMockRequest({
        method: 'POST',
        url: '/alice/-/search',
        body: JSON.stringify({ vector }),
        headers: { 'content-type': 'application/json' },
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      // Should not call embedding service when vector is provided
      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
      expect(mockVectorStore.search).toHaveBeenCalledWith(
        'text-embedding-004',
        vector,
        expect.any(Object),
      );
    });

    it('should return error for missing query and vector', async () => {
      const request = createMockRequest({
        method: 'POST',
        url: '/alice/-/search',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(400);
      const data = JSON.parse(response._data);
      expect(data.code).toBe('INVALID_REQUEST');
    });
  });

  describe('credential handling', () => {
    it('should return error when no credential found', async () => {
      mockSparqlEngine = createMockSparqlEngine(false);
      handler = new SearchHttpHandler(
        mockVectorStore,
        mockEmbeddingService,
        mockSparqlEngine,
        createMockCredentialsExtractor(),
        createMockPermissionReader(),
        createMockAuthorizer(),
      );

      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=test',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(400);
      const data = JSON.parse(response._data);
      expect(data.code).toBe('NO_CREDENTIAL');
    });
  });

  describe('OPTIONS', () => {
    it('should handle OPTIONS request', async () => {
      const request = createMockRequest({
        method: 'OPTIONS',
        url: '/alice/-/search',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(204);
      expect(response._headers['Access-Control-Allow-Methods']).toContain('GET');
      expect(response._headers['Access-Control-Allow-Methods']).toContain('POST');
    });
  });

  describe('error handling', () => {
    it('should handle embedding service errors', async () => {
      (mockEmbeddingService.embed as any).mockRejectedValue(new Error('API rate limit'));

      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=test',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(502);
      const data = JSON.parse(response._data);
      expect(data.code).toBe('EMBEDDING_ERROR');
    });

    it('should handle vector store errors', async () => {
      (mockVectorStore.search as any).mockRejectedValue(new Error('Database error'));

      const request = createMockRequest({
        method: 'GET',
        url: '/alice/-/search?q=test',
      });
      const response = createMockResponse();

      await handler.handle({ request, response } as any);

      expect(response._status).toBe(500);
      const data = JSON.parse(response._data);
      expect(data.code).toBe('SEARCH_ERROR');
    });
  });
});
