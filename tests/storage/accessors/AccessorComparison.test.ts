/**
 * AccessorComparison.test.ts
 * 
 * 对比 QuadstoreSparqlDataAccessor 和 QuintStoreSparqlDataAccessor 的功能和性能
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import { Readable } from 'stream';
import {
  RepresentationMetadata,
  IdentifierStrategy,
  INTERNAL_QUADS,
  NotFoundHttpError,
  LDP,
} from '@solid/community-server';
import { QuadstoreSparqlDataAccessor } from '../../../src/storage/accessors/QuadstoreSparqlDataAccessor';
import { QuintStoreSparqlDataAccessor } from '../../../src/storage/accessors/QuintStoreSparqlDataAccessor';
import { SqliteQuintStore } from '../../../src/storage/quint/SqliteQuintStore';
import arrayifyStream from 'arrayify-stream';
import { getTestDataPath } from '../../utils/sqlite';

const { namedNode, quad, literal, defaultGraph } = DataFactory;

// 通用测试用例，两个 accessor 都应该通过
interface AccessorFactory {
  name: string;
  create: (dbPath: string) => Promise<{
    accessor: any;
    cleanup: () => Promise<void>;
  }>;
}

const mockIdentifierStrategy = {
  isRootContainer: vi.fn(),
  getParentContainer: vi.fn(),
} as unknown as IdentifierStrategy;

// Setup identifier strategy mocks
(mockIdentifierStrategy.isRootContainer as any).mockImplementation((id: any) => id.path === 'http://example.org/');
(mockIdentifierStrategy.getParentContainer as any).mockImplementation((id: any) => {
  const url = new URL(id.path);
  if (url.pathname === '/') throw new Error('Root has no parent');
  const parentPath = url.pathname.substring(0, url.pathname.lastIndexOf('/', url.pathname.length - 2) + 1);
  return { path: new URL(parentPath, url.origin).href };
});

const runQuadstoreComparison = process.env.XPOD_RUN_QUADSTORE_TESTS === 'true';

const hasBetterSqlite3Binding = (() => {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const accessorFactories: AccessorFactory[] = [
  {
    name: 'QuadstoreSparqlDataAccessor',
    create: async (dbPath: string) => {
      const accessor = new QuadstoreSparqlDataAccessor(`sqlite:${dbPath}`, mockIdentifierStrategy);
      return {
        accessor,
        cleanup: async () => {
          await accessor.close();
        },
      };
    },
  },
  {
    name: 'QuintStoreSparqlDataAccessor',
    create: async (dbPath: string) => {
      const store = new SqliteQuintStore({ path: dbPath });
      await store.open();
      const accessor = new QuintStoreSparqlDataAccessor(
        store,
        mockIdentifierStrategy,
      );
      return {
        accessor,
        cleanup: async () => {
          await store.close();
        },
      };
    },
  },
];

const enabledAccessorFactories = accessorFactories.filter((factory) => runQuadstoreComparison || factory.name !== 'QuadstoreSparqlDataAccessor');

const dataAccessorSuite = hasBetterSqlite3Binding ? describe : describe.skip;

dataAccessorSuite.each(enabledAccessorFactories)('DataAccessor Comparison: $name', ({ name, create }) => {
  const testDir = getTestDataPath(`accessor_comparison_${name.toLowerCase()}`);
  let accessor: any;
  let cleanup: () => Promise<void>;
  let dbPath: string;

  beforeEach(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    dbPath = path.join(testDir, `test_${Math.random().toString(36).substring(7)}.sqlite`);
    const result = await create(dbPath);
    accessor = result.accessor;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  });

  describe('Basic Document Operations', () => {
    it('should write and read a document', async () => {
      const identifier = { path: 'http://example.org/resource' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p'), literal('value')),
      ];
      const dataStream = Readable.from(quads);

      await accessor.writeDocument(identifier, dataStream, metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads).toHaveLength(1);
      expect(resultQuads[0].subject.value).toBe('http://example.org/resource');
      expect(resultQuads[0].object.value).toBe('value');
    });

    it('should overwrite existing document', async () => {
      const identifier = { path: 'http://example.org/resource' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      // Write first version
      const quads1 = [
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p'), literal('v1')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads1), metadata);

      // Write second version
      const quads2 = [
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p'), literal('v2')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads2), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads).toHaveLength(1);
      expect(resultQuads[0].object.value).toBe('v2');
    });

    it('should handle multiple triples in document', async () => {
      const identifier = { path: 'http://example.org/resource' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p1'), literal('v1')),
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p2'), literal('v2')),
        quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p3'), literal('v3')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads).toHaveLength(3);
    });
  });

  describe('Metadata Operations', () => {
    it('should write and read metadata', async () => {
      const identifier = { path: 'http://example.org/resource' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.add(namedNode('http://example.org/meta'), literal('meta-value'));

      await accessor.writeMetadata(identifier, metadata);

      const resultMetadata = await accessor.getMetadata(identifier);
      const metaQuads = resultMetadata.quads();
      
      const found = metaQuads.find((q: any) => q.predicate.value === 'http://example.org/meta');
      expect(found).toBeDefined();
      expect(found?.object.value).toBe('meta-value');
    });

    it('should update metadata', async () => {
      const identifier = { path: 'http://example.org/resource' };
      
      // Write first metadata
      const metadata1 = new RepresentationMetadata(identifier);
      metadata1.add(namedNode('http://example.org/meta'), literal('v1'));
      await accessor.writeMetadata(identifier, metadata1);

      // Write second metadata
      const metadata2 = new RepresentationMetadata(identifier);
      metadata2.add(namedNode('http://example.org/meta'), literal('v2'));
      await accessor.writeMetadata(identifier, metadata2);

      const resultMetadata = await accessor.getMetadata(identifier);
      const metaQuads = resultMetadata.quads();
      
      const found = metaQuads.filter((q: any) => q.predicate.value === 'http://example.org/meta');
      expect(found).toHaveLength(1);
      expect(found[0].object.value).toBe('v2');
    });
  });

  describe('Delete Operations', () => {
    it('should delete a resource', async () => {
      const identifier = { path: 'http://example.org/resource-to-delete' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(namedNode('http://example.org/resource-to-delete'), namedNode('http://example.org/p'), literal('value')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      // Verify it exists
      const result1 = await arrayifyStream(await accessor.getData(identifier));
      expect(result1).toHaveLength(1);

      // Delete
      await accessor.deleteResource(identifier);

      // Verify data is gone
      const result2 = await arrayifyStream(await accessor.getData(identifier));
      expect(result2).toHaveLength(0);
      
      // getMetadata should throw NotFound
      await expect(accessor.getMetadata(identifier)).rejects.toThrow(NotFoundHttpError);
    });

    it('should delete resource with metadata', async () => {
      const identifier = { path: 'http://example.org/resource-with-meta' };
      
      // Write document
      const docMetadata = new RepresentationMetadata(identifier);
      docMetadata.contentType = INTERNAL_QUADS;
      const quads = [
        quad(namedNode('http://example.org/resource-with-meta'), namedNode('http://example.org/p'), literal('value')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), docMetadata);

      // Write additional metadata
      const metadata = new RepresentationMetadata(identifier);
      metadata.add(namedNode('http://example.org/meta'), literal('meta-value'));
      await accessor.writeMetadata(identifier, metadata);

      // Delete
      await accessor.deleteResource(identifier);

      // Both should be gone
      const dataResult = await arrayifyStream(await accessor.getData(identifier));
      expect(dataResult).toHaveLength(0);
      await expect(accessor.getMetadata(identifier)).rejects.toThrow(NotFoundHttpError);
    });
  });

  describe('Container Operations', () => {
    it('should write a container', async () => {
      const identifier = { path: 'http://example.org/' };
      const metadata = new RepresentationMetadata(identifier);

      await accessor.writeContainer(identifier, metadata);

      const resultMetadata = await accessor.getMetadata(identifier);
      expect(resultMetadata).toBeDefined();
      
      // Should have RDF type Container
      const typeQuads = resultMetadata.quads().filter(
        (q: any) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      );
      const isContainer = typeQuads.some(
        (q: any) => q.object.value.includes('Container') || q.object.value.includes('BasicContainer'),
      );
      expect(isContainer).toBe(true);
    });
  });

  describe('Literal Types', () => {
    it('should handle plain literal', async () => {
      const identifier = { path: 'http://example.org/plain-literal' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(namedNode('http://example.org/s'), namedNode('http://example.org/p'), literal('hello')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads[0].object.value).toBe('hello');
      expect(resultQuads[0].object.termType).toBe('Literal');
    });

    it('should handle language-tagged literal', async () => {
      const identifier = { path: 'http://example.org/lang-literal' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(namedNode('http://example.org/s'), namedNode('http://example.org/p'), literal('hello', 'en')),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads[0].object.value).toBe('hello');
      expect((resultQuads[0].object as any).language).toBe('en');
    });

    it('should handle datatyped literal', async () => {
      const identifier = { path: 'http://example.org/typed-literal' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [
        quad(
          namedNode('http://example.org/s'),
          namedNode('http://example.org/p'),
          literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        ),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads[0].object.value).toBe('42');
      expect((resultQuads[0].object as any).datatype.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty document', async () => {
      const identifier = { path: 'http://example.org/empty' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      await accessor.writeDocument(identifier, Readable.from([]), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads).toHaveLength(0);
    });

    it('should handle special characters in literal', async () => {
      const identifier = { path: 'http://example.org/special-chars' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const specialValue = 'Line1\nLine2\tTab"Quote\'Single\\Backslash';
      const quads = [
        quad(namedNode('http://example.org/s'), namedNode('http://example.org/p'), literal(specialValue)),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads[0].object.value).toBe(specialValue);
    });

    it('should handle unicode in literal', async () => {
      const identifier = { path: 'http://example.org/unicode' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const unicodeValue = '你好世界 🌍 Привет мир';
      const quads = [
        quad(namedNode('http://example.org/s'), namedNode('http://example.org/p'), literal(unicodeValue)),
      ];
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);

      const resultStream = await accessor.getData(identifier);
      const resultQuads = await arrayifyStream(resultStream);

      expect(resultQuads[0].object.value).toBe(unicodeValue);
    });
  });
});

// 性能对比测试
(hasBetterSqlite3Binding ? describe : describe.skip)('Performance Comparison', () => {
  const testDir = getTestDataPath('accessor_perf');
  const results: Record<string, Record<string, number>> = {};

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // 输出性能结果
    console.log('\n=== Performance Results ===');
    for (const [test, accessorResults] of Object.entries(results)) {
      console.log(`\n${test}:`);
      for (const [accessor, time] of Object.entries(accessorResults)) {
        console.log(`  ${accessor}: ${time.toFixed(2)}ms`);
      }
    }
  });

  it('should compare write performance (100 documents)', async () => {
    const testName = 'Write 100 documents';
    results[testName] = {};

    for (const factory of enabledAccessorFactories) {
      const dbPath = path.join(testDir, `perf_write_${factory.name}_${Date.now()}.sqlite`);
      const { accessor, cleanup } = await factory.create(dbPath);

      const start = performance.now();

      for (let i = 0; i < 100; i++) {
        const identifier = { path: `http://example.org/doc${i}` };
        const metadata = new RepresentationMetadata(identifier);
        metadata.contentType = INTERNAL_QUADS;
        
        const quads = [
          quad(namedNode(`http://example.org/doc${i}`), namedNode('http://example.org/p'), literal(`value${i}`)),
        ];
        await accessor.writeDocument(identifier, Readable.from(quads), metadata);
      }

      const elapsed = performance.now() - start;
      results[testName][factory.name] = elapsed;

      await cleanup();
      fs.rmSync(dbPath, { force: true });
    }

    expect(true).toBe(true); // 确保测试通过
  });

  it('should compare read performance (100 reads)', async () => {
    const testName = 'Read 100 documents';
    results[testName] = {};

    for (const factory of enabledAccessorFactories) {
      const dbPath = path.join(testDir, `perf_read_${factory.name}_${Date.now()}.sqlite`);
      const { accessor, cleanup } = await factory.create(dbPath);

      // Setup: write 100 documents
      for (let i = 0; i < 100; i++) {
        const identifier = { path: `http://example.org/doc${i}` };
        const metadata = new RepresentationMetadata(identifier);
        metadata.contentType = INTERNAL_QUADS;
        
        const quads = [
          quad(namedNode(`http://example.org/doc${i}`), namedNode('http://example.org/p'), literal(`value${i}`)),
        ];
        await accessor.writeDocument(identifier, Readable.from(quads), metadata);
      }

      // Measure reads
      const start = performance.now();

      for (let i = 0; i < 100; i++) {
        const identifier = { path: `http://example.org/doc${i}` };
        const stream = await accessor.getData(identifier);
        await arrayifyStream(stream);
      }

      const elapsed = performance.now() - start;
      results[testName][factory.name] = elapsed;

      await cleanup();
      fs.rmSync(dbPath, { force: true });
    }

    expect(true).toBe(true);
  });

  it('should compare bulk write performance (1000 triples in one document)', async () => {
    const testName = 'Write 1000 triples';
    results[testName] = {};

    for (const factory of enabledAccessorFactories) {
      const dbPath = path.join(testDir, `perf_bulk_${factory.name}_${Date.now()}.sqlite`);
      const { accessor, cleanup } = await factory.create(dbPath);

      const identifier = { path: 'http://example.org/bulk' };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = INTERNAL_QUADS;
      
      const quads = [];
      for (let i = 0; i < 1000; i++) {
        quads.push(
          quad(namedNode('http://example.org/bulk'), namedNode(`http://example.org/p${i}`), literal(`value${i}`)),
        );
      }

      const start = performance.now();
      await accessor.writeDocument(identifier, Readable.from(quads), metadata);
      const elapsed = performance.now() - start;

      results[testName][factory.name] = elapsed;

      await cleanup();
      fs.rmSync(dbPath, { force: true });
    }

    expect(true).toBe(true);
  });
});
