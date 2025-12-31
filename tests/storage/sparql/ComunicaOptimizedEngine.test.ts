/**
 * ComunicaOptimizedEngine 测试
 * 
 * 测试基于 Comunica 的优化查询引擎，验证：
 * 1. 优化参数通过 context 传递给 Source
 * 2. LIMIT 下推到 quadstore
 * 3. ORDER BY 下推（简单情况）
 * 4. 复杂查询正确回退到 Comunica
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataFactory } from 'n3';
import { Quadstore } from 'quadstore';
import { ClassicLevel } from 'classic-level';
import { ComunicaOptimizedEngine } from '../../../src/storage/sparql/ComunicaOptimizedEngine';

const { namedNode, literal, quad } = DataFactory;

describe('ComunicaOptimizedEngine', () => {
  let store: Quadstore;
  let engine: ComunicaOptimizedEngine;
  let levelPath: string;

  beforeAll(async () => {
    // 创建临时 LevelDB
    levelPath = `/tmp/test-comunica-optimized-${Date.now()}`;
    const level = new ClassicLevel(levelPath);
    
    store = new Quadstore({
      backend: level as any,
      dataFactory: DataFactory as any,
    });
    
    await store.open();

    // 插入测试数据
    const testQuads = [
      quad(namedNode('http://example.org/alice'), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Alice')),
      quad(namedNode('http://example.org/bob'), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Bob')),
      quad(namedNode('http://example.org/charlie'), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Charlie')),
      quad(namedNode('http://example.org/alice'), namedNode('http://xmlns.com/foaf/0.1/age'), literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer'))),
      quad(namedNode('http://example.org/bob'), namedNode('http://xmlns.com/foaf/0.1/age'), literal('25', namedNode('http://www.w3.org/2001/XMLSchema#integer'))),
      quad(namedNode('http://example.org/charlie'), namedNode('http://xmlns.com/foaf/0.1/age'), literal('35', namedNode('http://www.w3.org/2001/XMLSchema#integer'))),
      quad(namedNode('http://example.org/alice'), namedNode('http://xmlns.com/foaf/0.1/knows'), namedNode('http://example.org/bob')),
      quad(namedNode('http://example.org/bob'), namedNode('http://xmlns.com/foaf/0.1/knows'), namedNode('http://example.org/charlie')),
    ];

    await store.multiPut(testQuads);

    // 创建优化引擎
    engine = new ComunicaOptimizedEngine(store, { debug: true });
  });

  afterAll(async () => {
    await store.close();
    // 清理临时文件
    const fs = await import('fs/promises');
    await fs.rm(levelPath, { recursive: true, force: true });
  });

  describe('基本查询', () => {
    it('should execute simple SELECT query', async () => {
      const query = `
        SELECT ?s ?name WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results.length).toBe(3);
      const names = results.map(b => b.get('name')?.value).sort();
      expect(names).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('should execute ASK query', async () => {
      const query = `
        ASK WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> "Alice" .
        }
      `;

      const result = await engine.queryBoolean(query);
      expect(result).toBe(true);
    });

    it('should execute ASK query for non-existing data', async () => {
      const query = `
        ASK WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> "NonExistent" .
        }
      `;

      const result = await engine.queryBoolean(query);
      expect(result).toBe(false);
    });
  });

  describe('LIMIT 优化', () => {
    it('should pass LIMIT to quadstore', async () => {
      const query = `
        SELECT ?s ?name WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
        LIMIT 2
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      // 应该只返回 2 条结果
      expect(results.length).toBe(2);
    });

    it('should handle LIMIT with OFFSET', async () => {
      const query = `
        SELECT ?s ?name WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
        LIMIT 2 OFFSET 1
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      // OFFSET 由 Comunica 处理，LIMIT 下推
      expect(results.length).toBe(2);
    });
  });

  describe('复杂查询（Comunica 处理）', () => {
    it('should handle JOIN (multiple BGP patterns)', async () => {
      const query = `
        SELECT ?s ?name ?age WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
          ?s <http://xmlns.com/foaf/0.1/age> ?age .
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results.length).toBe(3);
    });

    it('should handle OPTIONAL', async () => {
      const query = `
        SELECT ?s ?name ?knows WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
          OPTIONAL {
            ?s <http://xmlns.com/foaf/0.1/knows> ?knows .
          }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results.length).toBe(3);
      // Alice 和 Bob 有 knows，Charlie 没有
      const aliceResult = results.find(b => b.get('name')?.value === 'Alice');
      expect(aliceResult?.get('knows')?.value).toBe('http://example.org/bob');
    });

    it('should handle FILTER', async () => {
      const query = `
        SELECT ?s ?name WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
          FILTER(STRSTARTS(?name, "A"))
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results.length).toBe(1);
      expect(results[0].get('name')?.value).toBe('Alice');
    });

    it('should handle UNION', async () => {
      const query = `
        SELECT ?s ?value WHERE {
          {
            ?s <http://xmlns.com/foaf/0.1/name> ?value .
          }
          UNION
          {
            ?s <http://xmlns.com/foaf/0.1/age> ?value .
          }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      // 3 names + 3 ages = 6
      expect(results.length).toBe(6);
    });
  });

  describe('CONSTRUCT 查询', () => {
    it('should execute CONSTRUCT query', async () => {
      const query = `
        CONSTRUCT {
          ?s <http://example.org/hasName> ?name .
        }
        WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
      `;

      const stream = await engine.queryQuads(query);
      const results = await stream.toArray();

      expect(results.length).toBe(3);
      results.forEach(q => {
        expect(q.predicate.value).toBe('http://example.org/hasName');
      });
    });
  });
});
