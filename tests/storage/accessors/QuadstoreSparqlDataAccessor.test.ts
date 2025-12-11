import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import { Readable } from 'stream';
import {
  RepresentationMetadata,
  IdentifierStrategy,
  INTERNAL_QUADS,
  BasicRepresentation,
  NotFoundHttpError
} from '@solid/community-server';
import { QuadstoreSparqlDataAccessor } from '../../../src/storage/accessors/QuadstoreSparqlDataAccessor';
import { Quadstore } from 'quadstore';
import { Engine } from 'quadstore-comunica';
import { getBackend } from '../../../src/libs/backends';
import arrayifyStream from 'arrayify-stream';

const { namedNode, quad, literal, variable } = DataFactory;

describe('QuadstoreSparqlDataAccessor', () => {
  const testDir = path.join(__dirname, '../../../data/test/quadstore_accessor');
  
  const mockIdentifierStrategy = {
    isRootContainer: vi.fn(),
    getParentContainer: vi.fn(),
  } as unknown as IdentifierStrategy;

  let accessor: QuadstoreSparqlDataAccessor;
  let dbPath: string;

  beforeEach(async () => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    // Use unique DB for each test to avoid locking and state pollution
    dbPath = path.join(testDir, `test_accessor_${Math.random().toString(36).substring(7)}.sqlite`);
    const endpoint = `sqlite:${dbPath}`;

    // Setup identifier strategy mocks
    (mockIdentifierStrategy.isRootContainer as any).mockImplementation((id: any) => id.path === '/');
    (mockIdentifierStrategy.getParentContainer as any).mockImplementation((id: any) => {
      const url = new URL(id.path);
      if (url.pathname === '/') throw new Error('Root has no parent');
      const parentPath = url.pathname.substring(0, url.pathname.lastIndexOf('/', url.pathname.length - 2) + 1);
      return { path: new URL(parentPath, url.origin).href };
    });

    accessor = new QuadstoreSparqlDataAccessor(endpoint, mockIdentifierStrategy);
  });

  afterEach(async () => {
    await accessor.close();
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
  });

  it('should support writing and reading a document', async () => {
    const identifier = { path: 'http://example.org/resource' };
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = INTERNAL_QUADS;
    
    const quads = [
      quad(namedNode('http://example.org/resource'), namedNode('http://example.org/p'), literal('value'))
    ];
    const dataStream = Readable.from(quads);

    await accessor.writeDocument(identifier, dataStream as any, metadata);

    // Read back
    const resultStream = await accessor.getData(identifier);
    const resultQuads = await arrayifyStream(resultStream);

    expect(resultQuads).toHaveLength(1);
    expect(resultQuads[0].subject.value).toBe('http://example.org/resource');
    expect(resultQuads[0].object.value).toBe('value');
  });

  it('should support writing and reading metadata', async () => {
    const identifier = { path: 'http://example.org/resource' };
    const metadata = new RepresentationMetadata(identifier);
    metadata.add(namedNode('http://example.org/meta'), literal('meta-value'));

    await accessor.writeMetadata(identifier, metadata);

    const resultMetadata = await accessor.getMetadata(identifier);
    const metaQuads = resultMetadata.quads();
    
    const found = metaQuads.find(q => q.predicate.value === 'http://example.org/meta');
    expect(found).toBeDefined();
    expect(found?.object.value).toBe('meta-value');
  });

  it('should delete a resource', async () => {
    const identifier = { path: 'http://example.org/resource-to-delete' };
    const metadata = new RepresentationMetadata(identifier);
    metadata.contentType = INTERNAL_QUADS;
    const quads = [
        quad(namedNode('http://example.org/resource-to-delete'), namedNode('http://example.org/p'), literal('value'))
    ];
    await accessor.writeDocument(identifier, Readable.from(quads) as any, metadata);

    // Verify it exists
    const result1 = await arrayifyStream(await accessor.getData(identifier));
    expect(result1).toHaveLength(1);

    // Delete
    await accessor.deleteResource(identifier);

    // Verify it's gone
    const result2 = await arrayifyStream(await accessor.getData(identifier));
    expect(result2).toHaveLength(0);
    
    // getMetadata should throw NotFound
    await expect(accessor.getMetadata(identifier)).rejects.toThrow(NotFoundHttpError);
  });
});

describe('Quadstore Engine Direct SPARQL Capability', () => {
    const testDir = path.join(__dirname, '../../../data/test/quadstore_engine');
    
    let store: Quadstore;
    let engine: Engine;
    let dbPath: string;

    beforeEach(async () => {
        if (!fs.existsSync(testDir)) {
          fs.mkdirSync(testDir, { recursive: true });
        }
        
        dbPath = path.join(testDir, `test_engine_${Math.random().toString(36).substring(7)}.sqlite`);
        const endpoint = `sqlite:${dbPath}`;

        const backend = getBackend(endpoint, { tableName: 'quadstore' });
        store = new Quadstore({
            backend,
            dataFactory: DataFactory,
        });
        await store.open();
        engine = new Engine(store);
    });

    afterEach(async () => {
        await store.close();
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { force: true });
        }
    });

    it('should execute SPARQL INSERT DATA', async () => {
        const query = `
            INSERT DATA {
                <http://ex.org/s> <http://ex.org/p> "test-value" .
            }
        `;
        await engine.queryVoid(query);

        const items = await store.get({});
        expect(items.items).toHaveLength(1);
        expect(items.items[0].object.value).toBe('test-value');
    });

    it('should execute SPARQL DELETE DATA', async () => {
        // Setup data
        await store.put(quad(namedNode('http://ex.org/s'), namedNode('http://ex.org/p'), literal('delete-me')));
        
        const query = `
            DELETE DATA {
                <http://ex.org/s> <http://ex.org/p> "delete-me" .
            }
        `;
        await engine.queryVoid(query);

        const items = await store.get({});
        expect(items.items).toHaveLength(0);
    });

    it('should execute SPARQL DELETE/INSERT (Patch pattern)', async () => {
        // Setup data
        await store.put(quad(namedNode('http://ex.org/s'), namedNode('http://ex.org/p'), literal('old-value')));

        const query = `
            DELETE {
                <http://ex.org/s> <http://ex.org/p> ?o .
            }
            INSERT {
                <http://ex.org/s> <http://ex.org/p> "new-value" .
            }
            WHERE {
                <http://ex.org/s> <http://ex.org/p> ?o .
            }
        `;
        await engine.queryVoid(query);

        const items = await store.get({});
        expect(items.items).toHaveLength(1);
        expect(items.items[0].object.value).toBe('new-value');
    });

    it('should execute SPARQL SELECT', async () => {
        await store.put(quad(namedNode('http://ex.org/s1'), namedNode('http://ex.org/p'), literal('v1')));
        await store.put(quad(namedNode('http://ex.org/s2'), namedNode('http://ex.org/p'), literal('v2')));

        const query = `
            SELECT ?s ?o WHERE {
                ?s <http://ex.org/p> ?o .
            } ORDER BY ?o
        `;
        
        const result = await engine.queryBindings(query);
        const bindings = await arrayifyStream(result);

        expect(bindings).toHaveLength(2);
        expect(bindings[0].get('o')?.value).toBe('v1');
        expect(bindings[1].get('o')?.value).toBe('v2');
    });

    it('should execute N3 Patch-like logical update', async () => {
        // N3 Patch often involves conditions. 
        // e.g., If <condition> then delete X and insert Y.
        
        await store.put(quad(namedNode('http://ex.org/ticket'), namedNode('http://ex.org/status'), literal('open')));

        // "Patch": If status is open, change to closed.
        const query = `
            DELETE {
                <http://ex.org/ticket> <http://ex.org/status> "open" .
            }
            INSERT {
                <http://ex.org/ticket> <http://ex.org/status> "closed" .
                <http://ex.org/ticket> <http://ex.org/closedAt> "${new Date().toISOString()}" .
            }
            WHERE {
                <http://ex.org/ticket> <http://ex.org/status> "open" .
            }
        `;

        await engine.queryVoid(query);
        
        const items = await store.get({});
        // Should have status=closed and closedAt
        const status = items.items.find(q => q.predicate.value === 'http://ex.org/status');
        expect(status?.object.value).toBe('closed');
        
        const closedAt = items.items.find(q => q.predicate.value === 'http://ex.org/closedAt');
                expect(closedAt).toBeDefined();
            });
        
                it('should not duplicate triples on sequential INSERT DELETE WHERE', async () => {
                    // First patch
                    const query1 = `
                        DELETE {}
                        INSERT {
                            <http://ex.org/s> <http://ex.org/p1> "v1" .
                            <http://ex.org/s> <http://ex.org/p2> "v2" .
                            <http://ex.org/s> <http://ex.org/p3> "v3" .
                            <http://ex.org/s> <http://ex.org/p4> "v4" .
                        }
                        WHERE {}
                    `;
                    await engine.queryVoid(query1);
            
                    // Second patch
                    const query2 = `
                        DELETE {}
                        INSERT {
                            <http://ex.org/s> <http://ex.org/p5> "v5" .
                            <http://ex.org/s> <http://ex.org/p6> "v6" .
                            <http://ex.org/s> <http://ex.org/p7> "v7" .
                            <http://ex.org/s> <http://ex.org/p8> "v8" .
                        }
                        WHERE {}
                    `;
                    await engine.queryVoid(query2);
            
                    const { items } = await store.get({});
                    expect(items).toHaveLength(8);
                    
                    const unique = new Set(items.map(i => `${i.subject.value} ${i.predicate.value} ${i.object.value}`));
                    expect(unique.size).toBe(8);
                });        });
        