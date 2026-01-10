/**
 * VectorIndexingListener 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VectorIndexingListener } from '../../src/storage/vector/VectorIndexingListener';
import type { VectorStoreDefinition } from '../../src/storage/vector/VectorIndexingListener';
import type { ResourceChangeEvent } from '../../src/storage/ObservableResourceStore';
import type { VectorStore } from '../../src/storage/vector/VectorStore';
import type { EmbeddingService } from '../../src/embedding/EmbeddingService';
import type { SparqlEngine } from '../../src/storage/sparql/SubgraphQueryEngine';
import type { ResourceStore } from '@solid/community-server';
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

// Mock SparqlEngine
function createMockSparqlEngine(vectorStores: VectorStoreDefinition[], credential?: { apiKey: string }): SparqlEngine {
  return {
    queryBindings: vi.fn().mockImplementation(async (query: string) => {
      if (query.includes('VectorStore')) {
        return createMockBindingsStream(
          vectorStores.map((vs) => ({
            vs: vs.uri,
            scope: vs.scope,
            model: vs.model,
            status: vs.status,
          })),
        );
      }
      if (query.includes('Credential') && credential) {
        return createMockBindingsStream([{ apiKey: credential.apiKey }]);
      }
      return createMockBindingsStream([]);
    }),
  } as unknown as SparqlEngine;
}

// Mock VectorStore
function createMockVectorStore(): VectorStore {
  return {
    ensureVectorTable: vi.fn().mockResolvedValue(undefined),
    upsertVector: vi.fn().mockResolvedValue(undefined),
    deleteVector: vi.fn().mockResolvedValue(undefined),
  } as unknown as VectorStore;
}

// Mock EmbeddingService
function createMockEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([new Array(768).fill(0.1)]),
  } as unknown as EmbeddingService;
}

// Mock ResourceStore
function createMockResourceStore(content: string = 'Test content'): ResourceStore {
  return {
    getRepresentation: vi.fn().mockResolvedValue({
      data: Readable.from([content]),
      metadata: {},
    }),
  } as unknown as ResourceStore;
}

describe('VectorIndexingListener', () => {
  let listener: VectorIndexingListener;
  let mockSparqlEngine: SparqlEngine;
  let mockVectorStore: VectorStore;
  let mockEmbeddingService: EmbeddingService;
  let mockResourceStore: ResourceStore;

  const defaultVectorStore: VectorStoreDefinition = {
    uri: 'http://localhost/alice/settings/vector-stores.ttl#documents',
    scope: 'http://localhost/alice/documents/',
    model: 'text-embedding-004',
    status: 'active',
  };

  beforeEach(() => {
    mockVectorStore = createMockVectorStore();
    mockEmbeddingService = createMockEmbeddingService();
    mockResourceStore = createMockResourceStore();
    mockSparqlEngine = createMockSparqlEngine([defaultVectorStore], { apiKey: 'test-key' });

    listener = new VectorIndexingListener({
      sparqlEngine: mockSparqlEngine,
      vectorStore: mockVectorStore,
      embeddingService: mockEmbeddingService,
      resourceStore: mockResourceStore,
    });
  });

  describe('onResourceChanged', () => {
    it('should skip container changes', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/',
        action: 'create',
        isContainer: true,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockSparqlEngine.queryBindings).not.toHaveBeenCalled();
    });

    it('should skip unsupported file types', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/image.png',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockSparqlEngine.queryBindings).not.toHaveBeenCalled();
    });

    it('should index supported file types', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockEmbeddingService.embed).toHaveBeenCalled();
      expect(mockVectorStore.upsertVector).toHaveBeenCalled();
    });

    it('should delete vector on resource delete', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'delete',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockVectorStore.deleteVector).toHaveBeenCalled();
      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
    });

    it('should skip files outside VectorStore scope', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/photos/image.txt',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
    });

    it('should skip paused VectorStore', async () => {
      const pausedStore: VectorStoreDefinition = {
        ...defaultVectorStore,
        status: 'paused',
      };
      mockSparqlEngine = createMockSparqlEngine([pausedStore], { apiKey: 'test-key' });
      listener = new VectorIndexingListener({
        sparqlEngine: mockSparqlEngine,
        vectorStore: mockVectorStore,
        embeddingService: mockEmbeddingService,
        resourceStore: mockResourceStore,
      });

      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
    });

    it('should skip if no AI credential found', async () => {
      mockSparqlEngine = createMockSparqlEngine([defaultVectorStore]); // No credential
      listener = new VectorIndexingListener({
        sparqlEngine: mockSparqlEngine,
        vectorStore: mockVectorStore,
        embeddingService: mockEmbeddingService,
        resourceStore: mockResourceStore,
      });

      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
    });

    it('should skip empty content', async () => {
      mockResourceStore = createMockResourceStore('');
      listener = new VectorIndexingListener({
        sparqlEngine: mockSparqlEngine,
        vectorStore: mockVectorStore,
        embeddingService: mockEmbeddingService,
        resourceStore: mockResourceStore,
      });

      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      expect(mockEmbeddingService.embed).not.toHaveBeenCalled();
    });
  });

  describe('supported file types', () => {
    const supportedExtensions = ['.txt', '.md', '.html', '.json', '.ttl', '.jsonld'];

    for (const ext of supportedExtensions) {
      it(`should support ${ext} files`, async () => {
        const event: ResourceChangeEvent = {
          path: `http://localhost/alice/documents/file${ext}`,
          action: 'create',
          isContainer: false,
          timestamp: Date.now(),
        };

        await listener.onResourceChanged(event);

        expect(mockEmbeddingService.embed).toHaveBeenCalled();
      });
    }
  });

  describe('caching', () => {
    it('should cache VectorStore definitions', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note1.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);
      await listener.onResourceChanged({
        ...event,
        path: 'http://localhost/alice/documents/note2.md',
      });

      // VectorStore query should only be called once (cached)
      const calls = (mockSparqlEngine.queryBindings as any).mock.calls;
      const vectorStoreQueries = calls.filter((c: any) => c[0].includes('VectorStore'));
      expect(vectorStoreQueries.length).toBe(1);
    });

    it('should clear cache when requested', async () => {
      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);
      listener.clearCache();
      await listener.onResourceChanged(event);

      const calls = (mockSparqlEngine.queryBindings as any).mock.calls;
      const vectorStoreQueries = calls.filter((c: any) => c[0].includes('VectorStore'));
      expect(vectorStoreQueries.length).toBe(2);
    });
  });

  describe('multiple VectorStores', () => {
    it('should index to multiple VectorStores with same model only once', async () => {
      const stores: VectorStoreDefinition[] = [
        { ...defaultVectorStore, uri: 'store1' },
        { ...defaultVectorStore, uri: 'store2' },
      ];
      mockSparqlEngine = createMockSparqlEngine(stores, { apiKey: 'test-key' });
      listener = new VectorIndexingListener({
        sparqlEngine: mockSparqlEngine,
        vectorStore: mockVectorStore,
        embeddingService: mockEmbeddingService,
        resourceStore: mockResourceStore,
      });

      const event: ResourceChangeEvent = {
        path: 'http://localhost/alice/documents/note.md',
        action: 'create',
        isContainer: false,
        timestamp: Date.now(),
      };

      await listener.onResourceChanged(event);

      // Embedding should only be generated once for same model
      expect(mockEmbeddingService.embed).toHaveBeenCalledTimes(1);
      // But upsert should be called for each store
      expect(mockVectorStore.upsertVector).toHaveBeenCalledTimes(2);
    });
  });
});
