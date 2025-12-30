/**
 * OPTIONAL 优化测试
 * 
 * 测试场景：查询包含多个 OPTIONAL 的情况
 * 优化策略：先执行核心条件获取 subjects，再批量获取属性
 * 
 * 用户洞察："OPTIONAL 不进 WHERE 条件的，其实就是 SELECT"
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SqliteQuintStore } from '../../../src/storage/quint/SQLiteQuintStore';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import { DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

describe('OPTIONAL Optimization', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:', debug: false });
    await store.open();
    engine = new ComunicaQuintEngine(store as any, { debug: false });
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.clear();
  });

  describe('Basic OPTIONAL functionality', () => {
    beforeEach(async () => {
      // 创建测试数据
      await store.multiPut([
        // Person 1: Alice - has name, age, email
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://example.org/Person'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://example.org/name'),
          literal('Alice'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://example.org/age'),
          literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://example.org/email'),
          literal('alice@example.org'),
          namedNode('http://example.org/graph')
        ),
        // Person 2: Bob - has name only
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://example.org/Person'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://example.org/name'),
          literal('Bob'),
          namedNode('http://example.org/graph')
        ),
        // Person 3: Charlie - has name and age
        quad(
          namedNode('http://example.org/charlie'),
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://example.org/Person'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/charlie'),
          namedNode('http://example.org/name'),
          literal('Charlie'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/charlie'),
          namedNode('http://example.org/age'),
          literal('25', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph')
        ),
      ]);
    });

    it('should handle query with 2 OPTIONALs', async () => {
      const query = `
        SELECT ?s ?name ?age WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
          OPTIONAL { ?s <http://example.org/name> ?name }
          OPTIONAL { ?s <http://example.org/age> ?age }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results).toHaveLength(3);

      // Alice has both name and age
      const alice = results.find(r => r.get('s')?.value === 'http://example.org/alice');
      expect(alice?.get('name')?.value).toBe('Alice');
      expect(alice?.get('age')?.value).toBe('30');

      // Bob has only name
      const bob = results.find(r => r.get('s')?.value === 'http://example.org/bob');
      expect(bob?.get('name')?.value).toBe('Bob');
      expect(bob?.get('age')).toBeUndefined();

      // Charlie has name and age
      const charlie = results.find(r => r.get('s')?.value === 'http://example.org/charlie');
      expect(charlie?.get('name')?.value).toBe('Charlie');
      expect(charlie?.get('age')?.value).toBe('25');
    });

    it('should handle query with 3 OPTIONALs', async () => {
      const query = `
        SELECT ?s ?name ?age ?email WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
          OPTIONAL { ?s <http://example.org/name> ?name }
          OPTIONAL { ?s <http://example.org/age> ?age }
          OPTIONAL { ?s <http://example.org/email> ?email }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results).toHaveLength(3);

      // Alice has all attributes
      const alice = results.find(r => r.get('s')?.value === 'http://example.org/alice');
      expect(alice?.get('name')?.value).toBe('Alice');
      expect(alice?.get('age')?.value).toBe('30');
      expect(alice?.get('email')?.value).toBe('alice@example.org');

      // Bob has only name
      const bob = results.find(r => r.get('s')?.value === 'http://example.org/bob');
      expect(bob?.get('name')?.value).toBe('Bob');
      expect(bob?.get('age')).toBeUndefined();
      expect(bob?.get('email')).toBeUndefined();
    });
  });

  describe('getAttributes batch query', () => {
    beforeEach(async () => {
      // 创建更多测试数据
      const triples: any[] = [];
      for (let i = 0; i < 10; i++) {
        const subject = namedNode(`http://example.org/person${i}`);
        const graph = namedNode('http://example.org/graph');
        
        // Type
        triples.push(quad(
          subject,
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://example.org/Person'),
          graph
        ));
        
        // Name (all have)
        triples.push(quad(
          subject,
          namedNode('http://example.org/name'),
          literal(`Person ${i}`),
          graph
        ));
        
        // Age (even numbers have)
        if (i % 2 === 0) {
          triples.push(quad(
            subject,
            namedNode('http://example.org/age'),
            literal(`${20 + i}`, namedNode('http://www.w3.org/2001/XMLSchema#integer')),
            graph
          ));
        }
        
        // Email (i >= 5 have)
        if (i >= 5) {
          triples.push(quad(
            subject,
            namedNode('http://example.org/email'),
            literal(`person${i}@example.org`),
            graph
          ));
        }
      }
      
      await store.multiPut(triples);
    });

    it('should batch query attributes efficiently', async () => {
      // 直接测试 getAttributes 方法
      const subjects = [
        'http://example.org/person0',
        'http://example.org/person1',
        'http://example.org/person2',
      ];
      const predicates = [
        'http://example.org/name',
        'http://example.org/age',
        'http://example.org/email',
      ];

      const result = await store.getAttributes(subjects, predicates);

      // person0 has name and age
      const person0 = result.get('http://example.org/person0');
      expect(person0).toBeDefined();
      expect(person0?.get('http://example.org/name')?.[0].value).toBe('Person 0');
      expect(person0?.get('http://example.org/age')?.[0].value).toBe('20');
      expect(person0?.has('http://example.org/email')).toBe(false);

      // person1 has only name
      const person1 = result.get('http://example.org/person1');
      expect(person1).toBeDefined();
      expect(person1?.get('http://example.org/name')?.[0].value).toBe('Person 1');
      expect(person1?.has('http://example.org/age')).toBe(false);
      expect(person1?.has('http://example.org/email')).toBe(false);

      // person2 has name and age
      const person2 = result.get('http://example.org/person2');
      expect(person2).toBeDefined();
      expect(person2?.get('http://example.org/name')?.[0].value).toBe('Person 2');
      expect(person2?.get('http://example.org/age')?.[0].value).toBe('22');
    });

    it('should handle many OPTIONALs with optimization', async () => {
      // 测试带有多个 OPTIONAL 的查询性能
      const query = `
        SELECT ?s ?name ?age ?email WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
          OPTIONAL { ?s <http://example.org/name> ?name }
          OPTIONAL { ?s <http://example.org/age> ?age }
          OPTIONAL { ?s <http://example.org/email> ?email }
        }
      `;

      const start = Date.now();
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(10);
      
      // 验证数据正确性
      // person0: has name, age, no email
      const person0 = results.find(r => r.get('s')?.value === 'http://example.org/person0');
      expect(person0?.get('name')?.value).toBe('Person 0');
      expect(person0?.get('age')?.value).toBe('20');
      expect(person0?.get('email')).toBeUndefined();

      // person5: has name, no age (odd), has email (>=5)
      const person5 = results.find(r => r.get('s')?.value === 'http://example.org/person5');
      expect(person5?.get('name')?.value).toBe('Person 5');
      expect(person5?.get('age')).toBeUndefined();
      expect(person5?.get('email')?.value).toBe('person5@example.org');

      // person6: has name, age (even), email (>=5)
      const person6 = results.find(r => r.get('s')?.value === 'http://example.org/person6');
      expect(person6?.get('name')?.value).toBe('Person 6');
      expect(person6?.get('age')?.value).toBe('26');
      expect(person6?.get('email')?.value).toBe('person6@example.org');

      console.log(`Query with 3 OPTIONALs completed in ${elapsed}ms`);
    });
  });

  describe('Optimization edge cases', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://example.org/Person'),
          namedNode('http://example.org/graph')
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://example.org/name'),
          literal('Alice'),
          namedNode('http://example.org/graph')
        ),
      ]);
    });

    it('should optimize even with 1 OPTIONAL', async () => {
      // 1 个 OPTIONAL 也应该优化
      const query = `
        SELECT ?s ?name WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
          OPTIONAL { ?s <http://example.org/name> ?name }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results).toHaveLength(1);
      expect(results[0].get('name')?.value).toBe('Alice');
    });

    it('should handle empty result set', async () => {
      const query = `
        SELECT ?s ?name ?age WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/NonExistent> .
          OPTIONAL { ?s <http://example.org/name> ?name }
          OPTIONAL { ?s <http://example.org/age> ?age }
        }
      `;

      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();

      expect(results).toHaveLength(0);
    });
  });
});
