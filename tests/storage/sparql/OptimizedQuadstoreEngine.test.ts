import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClassicLevel } from 'classic-level';
import { Quadstore } from 'quadstore';
import { DataFactory } from 'n3';
import { OptimizedQuadstoreEngine, SimpleBindings } from '../../../src/storage/sparql/OptimizedQuadstoreEngine';
import * as path from 'path';
import * as fs from 'fs';

const { namedNode, literal, defaultGraph } = DataFactory;

describe('OptimizedQuadstoreEngine', () => {
  let store: Quadstore;
  let engine: OptimizedQuadstoreEngine;
  let backend: ClassicLevel;
  let testDir: string;

  beforeAll(async () => {
    testDir = path.join('/tmp', `quadstore-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    backend = new ClassicLevel(path.join(testDir, 'db'));
    store = new Quadstore({ backend, dataFactory: DataFactory });
    await store.open();

    // 添加测试数据
    const quads = [
      // Alice
      DataFactory.quad(
        namedNode('http://example.org/alice'),
        namedNode('http://xmlns.com/foaf/0.1/name'),
        literal('Alice'),
        defaultGraph(),
      ),
      DataFactory.quad(
        namedNode('http://example.org/alice'),
        namedNode('http://example.org/age'),
        literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        defaultGraph(),
      ),
      DataFactory.quad(
        namedNode('http://example.org/alice'),
        namedNode('http://xmlns.com/foaf/0.1/knows'),
        namedNode('http://example.org/bob'),
        defaultGraph(),
      ),
      // Bob
      DataFactory.quad(
        namedNode('http://example.org/bob'),
        namedNode('http://xmlns.com/foaf/0.1/name'),
        literal('Bob'),
        defaultGraph(),
      ),
      DataFactory.quad(
        namedNode('http://example.org/bob'),
        namedNode('http://example.org/age'),
        literal('25', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        defaultGraph(),
      ),
      // Charlie
      DataFactory.quad(
        namedNode('http://example.org/charlie'),
        namedNode('http://xmlns.com/foaf/0.1/name'),
        literal('Charlie'),
        defaultGraph(),
      ),
      DataFactory.quad(
        namedNode('http://example.org/charlie'),
        namedNode('http://example.org/age'),
        literal('35', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        defaultGraph(),
      ),
      // Named graphs
      DataFactory.quad(
        namedNode('http://example.org/doc1'),
        namedNode('http://purl.org/dc/terms/title'),
        literal('Document 1'),
        namedNode('http://example.org/graphs/public/doc1'),
      ),
      DataFactory.quad(
        namedNode('http://example.org/doc2'),
        namedNode('http://purl.org/dc/terms/title'),
        literal('Document 2'),
        namedNode('http://example.org/graphs/private/doc2'),
      ),
    ];

    await store.multiPut(quads);
    engine = new OptimizedQuadstoreEngine(store, true);
  });

  afterAll(async () => {
    await store.close();
    await backend.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('优化路径 - 单 BGP 查询', () => {
    it('should execute simple SELECT with LIMIT', async () => {
      const query = `SELECT ?s ?name WHERE { ?s <http://xmlns.com/foaf/0.1/name> ?name } LIMIT 2`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(SimpleBindings);
    });

    it('should execute SELECT with fixed predicate', async () => {
      const query = `SELECT ?s ?name WHERE { ?s <http://xmlns.com/foaf/0.1/name> ?name }`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(3); // Alice, Bob, Charlie
    });

    it('should filter with >= comparison (via Comunica)', async () => {
      // FILTER 查询走 Comunica
      // 使用正确的 xsd:integer 类型
      const query = `
        PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
        SELECT ?s ?age WHERE { 
          ?s <http://example.org/age> ?age 
          FILTER(?age >= "30"^^xsd:integer) 
        }`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(2); // Alice(30) and Charlie(35)
    }, 30000);

    it('should handle ASK query for existing data', async () => {
      const query = `ASK { ?s <http://xmlns.com/foaf/0.1/name> "Alice" }`;
      const result = await engine.queryBoolean(query);
      expect(result).toBe(true);
    });

    it('should handle ASK query for non-existing data', async () => {
      const query = `ASK { ?s <http://xmlns.com/foaf/0.1/name> "NonExistent" }`;
      const result = await engine.queryBoolean(query);
      expect(result).toBe(false);
    });

    it('should handle DISTINCT', async () => {
      const query = `SELECT DISTINCT ?p WHERE { ?s ?p ?o }`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      // 应该去重谓词
      const predicates = results.map((r: SimpleBindings) => r.get('p')?.value);
      const uniquePredicates = [...new Set(predicates)];
      expect(predicates.length).toBe(uniquePredicates.length);
    });
  });

  describe('Comunica 回退 - 复杂查询', () => {
    it('should handle multiple triple patterns via Comunica', async () => {
      const query = `SELECT ?s ?name ?age WHERE { 
        ?s <http://xmlns.com/foaf/0.1/name> ?name .
        ?s <http://example.org/age> ?age 
      }`;

      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(3); // Alice, Bob, Charlie
    }, 30000);

    it('should handle OPTIONAL via Comunica', async () => {
      const query = `SELECT ?s ?name ?knows WHERE {
        ?s <http://xmlns.com/foaf/0.1/name> ?name
        OPTIONAL { ?s <http://xmlns.com/foaf/0.1/knows> ?knows }
      }`;

      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(3); // 所有人都有 name
    }, 30000);

    it('should handle UNION via Comunica', async () => {
      const query = `SELECT ?s ?value WHERE {
        { ?s <http://xmlns.com/foaf/0.1/name> ?value }
        UNION
        { ?s <http://example.org/age> ?value }
      }`;

      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(6); // 3 names + 3 ages
    }, 30000);
  });

  describe('Named Graph 查询', () => {
    it('should query specific named graph', async () => {
      const query = `SELECT ?s ?title WHERE { 
        GRAPH <http://example.org/graphs/public/doc1> { 
          ?s <http://purl.org/dc/terms/title> ?title 
        } 
      }`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(1);
      expect(results[0].get('title')?.value).toBe('Document 1');
    }, 30000);

    it('should query with graph variable', async () => {
      const query = `SELECT ?g ?s ?title WHERE { 
        GRAPH ?g { 
          ?s <http://purl.org/dc/terms/title> ?title 
        } 
      }`;
      const stream = await engine.queryBindings(query);
      const results = await (stream as any).toArray();

      expect(results.length).toBe(2); // doc1 and doc2
    }, 30000);
  });
});
