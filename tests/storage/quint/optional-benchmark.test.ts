/**
 * OPTIONAL 优化性能基准测试
 * 
 * 对比 Comunica 默认行为（多次 LEFT JOIN）和优化后的批量获取方式
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SqliteQuintStore } from '../../../src/storage/quint/SQLiteQuintStore';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import { DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

describe('OPTIONAL Performance Benchmark', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  const NUM_PERSONS = 100;  // 测试人数
  const NUM_OPTIONAL = 5;   // OPTIONAL 数量

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:', debug: false });
    await store.open();
    engine = new ComunicaQuintEngine(store as any, { debug: false });

    // 创建大量测试数据
    const triples: any[] = [];
    const graph = namedNode('http://example.org/graph');
    const predicates = [
      'http://example.org/name',
      'http://example.org/age',
      'http://example.org/email',
      'http://example.org/phone',
      'http://example.org/address',
    ];

    for (let i = 0; i < NUM_PERSONS; i++) {
      const subject = namedNode(`http://example.org/person${i}`);
      
      // Type
      triples.push(quad(
        subject,
        namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        namedNode('http://example.org/Person'),
        graph
      ));
      
      // 每个人有不同数量的属性
      for (let j = 0; j < predicates.length; j++) {
        // 随机决定是否有这个属性（约 70% 概率）
        if ((i + j) % 10 < 7) {
          triples.push(quad(
            subject,
            namedNode(predicates[j]),
            literal(`Value ${j} for person ${i}`),
            graph
          ));
        }
      }
    }
    
    await store.multiPut(triples);
    console.log(`Created ${triples.length} triples for ${NUM_PERSONS} persons`);
  });

  afterAll(async () => {
    await store.close();
  });

  it('should complete query with 2 OPTIONALs quickly', async () => {
    const query = `
      SELECT ?s ?name ?age WHERE {
        ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
        OPTIONAL { ?s <http://example.org/name> ?name }
        OPTIONAL { ?s <http://example.org/age> ?age }
      }
    `;

    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(NUM_PERSONS);
    console.log(`2 OPTIONALs: ${elapsed}ms for ${results.length} results`);
    
    // 应该在合理时间内完成
    expect(elapsed).toBeLessThan(5000);
  });

  it('should complete query with 3 OPTIONALs quickly', async () => {
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

    expect(results).toHaveLength(NUM_PERSONS);
    console.log(`3 OPTIONALs: ${elapsed}ms for ${results.length} results`);
    
    // 应该在合理时间内完成
    expect(elapsed).toBeLessThan(5000);
  });

  it('should complete query with 4 OPTIONALs quickly', async () => {
    const query = `
      SELECT ?s ?name ?age ?email ?phone WHERE {
        ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
        OPTIONAL { ?s <http://example.org/name> ?name }
        OPTIONAL { ?s <http://example.org/age> ?age }
        OPTIONAL { ?s <http://example.org/email> ?email }
        OPTIONAL { ?s <http://example.org/phone> ?phone }
      }
    `;

    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(NUM_PERSONS);
    console.log(`4 OPTIONALs: ${elapsed}ms for ${results.length} results`);
    
    // 应该在合理时间内完成
    expect(elapsed).toBeLessThan(5000);
  });

  it('should complete query with 5 OPTIONALs quickly', async () => {
    const query = `
      SELECT ?s ?name ?age ?email ?phone ?address WHERE {
        ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
        OPTIONAL { ?s <http://example.org/name> ?name }
        OPTIONAL { ?s <http://example.org/age> ?age }
        OPTIONAL { ?s <http://example.org/email> ?email }
        OPTIONAL { ?s <http://example.org/phone> ?phone }
        OPTIONAL { ?s <http://example.org/address> ?address }
      }
    `;

    const start = Date.now();
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(NUM_PERSONS);
    console.log(`5 OPTIONALs: ${elapsed}ms for ${results.length} results`);
    
    // 应该在合理时间内完成
    expect(elapsed).toBeLessThan(5000);
  });

  it('should demonstrate linear scaling with OPTIONAL count', async () => {
    const timings: { optionals: number; elapsed: number }[] = [];

    for (let numOptionals = 2; numOptionals <= 5; numOptionals++) {
      const predicates = [
        '<http://example.org/name>',
        '<http://example.org/age>',
        '<http://example.org/email>',
        '<http://example.org/phone>',
        '<http://example.org/address>',
      ].slice(0, numOptionals);

      const vars = ['?name', '?age', '?email', '?phone', '?address'].slice(0, numOptionals);

      const optionalClauses = predicates.map((pred, i) => 
        `OPTIONAL { ?s ${pred} ${vars[i]} }`
      ).join('\n          ');

      const query = `
        SELECT ?s ${vars.join(' ')} WHERE {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
          ${optionalClauses}
        }
      `;

      const start = Date.now();
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      const elapsed = Date.now() - start;

      timings.push({ optionals: numOptionals, elapsed });
      expect(results).toHaveLength(NUM_PERSONS);
    }

    console.log('\n=== OPTIONAL Scaling Performance ===');
    console.log('| OPTIONALs | Time (ms) |');
    console.log('|-----------|-----------|');
    for (const t of timings) {
      console.log(`| ${t.optionals}         | ${t.elapsed.toString().padStart(9)} |`);
    }

    // 验证线性或亚线性增长（不是指数级）
    // 从 2 到 5 个 OPTIONAL，时间增长应该是可控的
    const maxIncrease = timings[timings.length - 1].elapsed / Math.max(1, timings[0].elapsed);
    console.log(`\nScaling factor (5 vs 2 OPTIONALs): ${maxIncrease.toFixed(2)}x`);
    
    // 优化后，增长因子应该很小（理想情况下接近 1）
    // 没有优化时，可能会是指数级增长
    expect(maxIncrease).toBeLessThan(10);
  });
});
