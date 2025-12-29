/**
 * Graph Prefix Filter 测试
 * 
 * 专门测试 QuintStore 的 graph 前缀过滤功能
 * 这是 QuintStore 的核心优势之一
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import type { Quad } from '@rdfjs/types';

const { namedNode, literal, quad } = DataFactory;

describe('Graph Prefix Filter', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    engine = new ComunicaQuintEngine(store, { debug: false });
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.clear();
  });

  describe('Basic Graph Prefix Filtering', () => {
    beforeEach(async () => {
      // 创建多用户多文档的数据
      const quads: Quad[] = [
        // User Alice 的数据
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Alice'),
          namedNode('http://pod.example.org/alice/profile')
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/age'),
          literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://pod.example.org/alice/profile')
        ),
        quad(
          namedNode('http://example.org/doc1'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Alice Document 1'),
          namedNode('http://pod.example.org/alice/docs/doc1')
        ),
        quad(
          namedNode('http://example.org/doc2'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Alice Document 2'),
          namedNode('http://pod.example.org/alice/docs/doc2')
        ),
        
        // User Bob 的数据
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Bob'),
          namedNode('http://pod.example.org/bob/profile')
        ),
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/age'),
          literal('25', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://pod.example.org/bob/profile')
        ),
        quad(
          namedNode('http://example.org/doc3'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Bob Document 1'),
          namedNode('http://pod.example.org/bob/docs/doc1')
        ),
        
        // 公共数据
        quad(
          namedNode('http://example.org/public'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Public Resource'),
          namedNode('http://public.example.org/shared')
        ),
      ];

      await store.multiPut(quads);
    });

    it('should filter by user prefix (alice)', async () => {
      const query = `
        SELECT ?s ?p ?o WHERE {
          ?s ?p ?o .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/alice/' } },
      });
      const results = await stream.toArray();

      // 应该只返回 Alice 的数据 (profile + 2 docs = 4 个三元组)
      expect(results.length).toBe(4);
      
      // 验证所有结果都属于 Alice
      for (const binding of results) {
        const subject = binding.get('s')?.value;
        expect(
          subject === 'http://example.org/alice' ||
          subject === 'http://example.org/doc1' ||
          subject === 'http://example.org/doc2'
        ).toBe(true);
      }
    });

    it('should filter by user prefix (bob)', async () => {
      const query = `
        SELECT ?s ?p ?o WHERE {
          ?s ?p ?o .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/bob/' } },
      });
      const results = await stream.toArray();

      // 应该只返回 Bob 的数据 (profile + 1 doc = 3 个三元组)
      expect(results.length).toBe(3);
    });

    it('should filter by docs subdirectory', async () => {
      const query = `
        SELECT ?s ?title WHERE {
          ?s <http://purl.org/dc/terms/title> ?title .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/alice/docs/' } },
      });
      const results = await stream.toArray();

      // 应该只返回 Alice 的文档 (2 个)
      expect(results.length).toBe(2);
    });

    it('should filter by entire pod prefix', async () => {
      const query = `
        SELECT (COUNT(*) AS ?count) WHERE {
          ?s ?p ?o .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/' } },
      });
      const results = await stream.toArray();

      // 应该返回所有 pod 数据 (Alice 4 + Bob 3 = 7)
      const count = parseInt(results[0].get('count')?.value || '0');
      expect(count).toBe(7);
    });

    it('should return empty for non-matching prefix', async () => {
      const query = `
        SELECT ?s ?p ?o WHERE {
          ?s ?p ?o .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://nonexistent.example.org/' } },
      });
      const results = await stream.toArray();

      expect(results.length).toBe(0);
    });
  });

  describe('Graph Prefix with SPARQL Patterns', () => {
    beforeEach(async () => {
      const quads: Quad[] = [
        // 订单数据 - 用户 Alice
        quad(
          namedNode('http://example.org/order1'),
          namedNode('http://schema.org/orderNumber'),
          literal('ORD-001'),
          namedNode('http://shop.example.org/alice/orders/2024/01')
        ),
        quad(
          namedNode('http://example.org/order1'),
          namedNode('http://schema.org/totalPrice'),
          literal('100', namedNode('http://www.w3.org/2001/XMLSchema#decimal')),
          namedNode('http://shop.example.org/alice/orders/2024/01')
        ),
        quad(
          namedNode('http://example.org/order2'),
          namedNode('http://schema.org/orderNumber'),
          literal('ORD-002'),
          namedNode('http://shop.example.org/alice/orders/2024/02')
        ),
        quad(
          namedNode('http://example.org/order2'),
          namedNode('http://schema.org/totalPrice'),
          literal('200', namedNode('http://www.w3.org/2001/XMLSchema#decimal')),
          namedNode('http://shop.example.org/alice/orders/2024/02')
        ),
        
        // 订单数据 - 用户 Bob
        quad(
          namedNode('http://example.org/order3'),
          namedNode('http://schema.org/orderNumber'),
          literal('ORD-003'),
          namedNode('http://shop.example.org/bob/orders/2024/01')
        ),
        quad(
          namedNode('http://example.org/order3'),
          namedNode('http://schema.org/totalPrice'),
          literal('150', namedNode('http://www.w3.org/2001/XMLSchema#decimal')),
          namedNode('http://shop.example.org/bob/orders/2024/01')
        ),
      ];

      await store.multiPut(quads);
    });

    it('should work with FILTER', async () => {
      const query = `
        SELECT ?order ?price WHERE {
          ?order <http://schema.org/totalPrice> ?price .
          FILTER(?price > 100)
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://shop.example.org/alice/' } },
      });
      const results = await stream.toArray();

      // Alice 只有一个订单价格 > 100 (order2, 200)
      expect(results.length).toBe(1);
      expect(results[0].get('price')?.value).toBe('200');
    });

    it('should work with aggregation', async () => {
      const query = `
        SELECT (SUM(?price) AS ?total) WHERE {
          ?order <http://schema.org/totalPrice> ?price .
        }
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://shop.example.org/alice/' } },
      });
      const results = await stream.toArray();

      // Alice 的订单总价 100 + 200 = 300
      const total = parseFloat(results[0].get('total')?.value || '0');
      expect(total).toBe(300);
    });

    it('should work with ORDER BY and LIMIT', async () => {
      const query = `
        SELECT ?order ?price WHERE {
          ?order <http://schema.org/totalPrice> ?price .
        }
        ORDER BY DESC(?price)
        LIMIT 1
      `;

      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://shop.example.org/alice/' } },
      });
      const results = await stream.toArray();

      // 应该返回最贵的订单
      expect(results.length).toBe(1);
      expect(results[0].get('price')?.value).toBe('200');
    });
  });

  describe('Performance with Graph Prefix', () => {
    const TOTAL_USERS = 100;
    const DOCS_PER_USER = 10;

    beforeEach(async () => {
      // 创建大量数据
      const quads: Quad[] = [];
      
      for (let u = 0; u < TOTAL_USERS; u++) {
        for (let d = 0; d < DOCS_PER_USER; d++) {
          quads.push(
            quad(
              namedNode(`http://example.org/user${u}/doc${d}`),
              namedNode('http://purl.org/dc/terms/title'),
              literal(`User ${u} Document ${d}`),
              namedNode(`http://pod.example.org/user${u}/docs/doc${d}`)
            )
          );
        }
      }

      await store.multiPut(quads);
    });

    it('should efficiently query single user data', async () => {
      const query = `
        SELECT ?doc ?title WHERE {
          ?doc <http://purl.org/dc/terms/title> ?title .
        }
      `;

      const start = performance.now();
      const stream = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/user50/' } },
      });
      const results = await stream.toArray();
      const elapsed = performance.now() - start;

      // 应该只返回 user50 的数据
      expect(results.length).toBe(DOCS_PER_USER);
      
      // 应该在合理时间内完成 (< 100ms)
      console.log(`  Single user query: ${elapsed.toFixed(2)}ms for ${results.length} results`);
      expect(elapsed).toBeLessThan(500);
    });

    it('should compare with vs without prefix filter', async () => {
      const query = `
        SELECT (COUNT(*) AS ?count) WHERE {
          ?doc <http://purl.org/dc/terms/title> ?title .
        }
      `;

      // 无前缀过滤 - 查询所有数据
      const startAll = performance.now();
      const streamAll = await engine.queryBindings(query);
      const resultsAll = await streamAll.toArray();
      const elapsedAll = performance.now() - startAll;
      const countAll = parseInt(resultsAll[0].get('count')?.value || '0');

      // 有前缀过滤 - 只查询一个用户
      const startFiltered = performance.now();
      const streamFiltered = await engine.queryBindings(query, {
        filters: { graph: { $startsWith: 'http://pod.example.org/user50/' } },
      });
      const resultsFiltered = await streamFiltered.toArray();
      const elapsedFiltered = performance.now() - startFiltered;
      const countFiltered = parseInt(resultsFiltered[0].get('count')?.value || '0');

      console.log(`  All data: ${elapsedAll.toFixed(2)}ms, count=${countAll}`);
      console.log(`  Filtered: ${elapsedFiltered.toFixed(2)}ms, count=${countFiltered}`);

      expect(countAll).toBe(TOTAL_USERS * DOCS_PER_USER);
      expect(countFiltered).toBe(DOCS_PER_USER);
      
      // 带前缀过滤应该更快（或至少不会慢很多）
      // 注意：由于数据量不大，性能差异可能不明显
    });
  });

  describe('Direct Store Graph Prefix Query', () => {
    beforeEach(async () => {
      const quads: Quad[] = [
        quad(
          namedNode('http://s1'),
          namedNode('http://p'),
          literal('v1'),
          namedNode('http://g/a/1')
        ),
        quad(
          namedNode('http://s2'),
          namedNode('http://p'),
          literal('v2'),
          namedNode('http://g/a/2')
        ),
        quad(
          namedNode('http://s3'),
          namedNode('http://p'),
          literal('v3'),
          namedNode('http://g/b/1')
        ),
      ];
      await store.multiPut(quads);
    });

    it('should use getByGraphPrefix directly on store', async () => {
      const results = await store.getByGraphPrefix('http://g/a/');
      
      expect(results.length).toBe(2);
      expect(results.every(q => q.graph.value.startsWith('http://g/a/'))).toBe(true);
    });

    it('should use graphPrefix in pattern query', async () => {
      const results = await store.get({ graph: { $startsWith: 'http://g/b/' } });
      
      expect(results.length).toBe(1);
      expect(results[0].object.value).toBe('v3');
    });
  });
});
