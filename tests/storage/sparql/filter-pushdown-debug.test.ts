/**
 * Debug test for FILTER pushdown with multi-pattern BGP
 * 
 * This test investigates why FILTER is not being pushed down
 * when the query has multiple triple patterns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';

const { namedNode, literal, quad } = DataFactory;

describe('FILTER pushdown with multi-pattern BGP', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeEach(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    // Enable debug mode to see what's happening
    engine = new ComunicaQuintEngine(store, { debug: true });

    // Create test data similar to the bug report
    // 100 items with type and value
    const quads = [];
    for (let i = 0; i < 100; i++) {
      quads.push(
        quad(
          namedNode(`http://example.org/item${i}`),
          namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          namedNode('http://schema.org/BenchItem'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode(`http://example.org/item${i}`),
          namedNode('http://schema.org/value'),
          literal(String(i), namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph'),
        ),
      );
    }
    await store.multiPut(quads);
  });

  afterEach(async () => {
    await store.close();
  });

  it('should pushdown FILTER with single pattern', async () => {
    // Single pattern - FILTER should be pushed down
    const query = `
      SELECT ?s ?value WHERE {
        ?s <http://schema.org/value> ?value .
        FILTER(?value > 95)
      }
    `;
    
    console.log('\n=== Single pattern query ===');
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    
    console.log(`Results: ${results.length}`);
    expect(results).toHaveLength(4); // 96, 97, 98, 99
  });

  it('should pushdown FILTER with multi-pattern BGP (the bug case)', async () => {
    // Multi-pattern BGP - this is the problematic case
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?subject ?value WHERE {
        ?subject rdf:type <http://schema.org/BenchItem> .
        ?subject <http://schema.org/value> ?value .
        FILTER(?value > 95)
      }
    `;
    
    console.log('\n=== Multi-pattern BGP query (the bug case) ===');
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    
    console.log(`Results: ${results.length}`);
    // Should return 4 items (value 96, 97, 98, 99)
    expect(results).toHaveLength(4);
    
    // Verify values
    const values = results.map(r => parseInt(r.get('value')?.value ?? '0')).sort((a, b) => a - b);
    expect(values).toEqual([96, 97, 98, 99]);
  });

  it('should measure performance difference', async () => {
    // Single pattern with FILTER
    const singlePatternQuery = `
      SELECT ?s ?value WHERE {
        ?s <http://schema.org/value> ?value .
        FILTER(?value > 95)
      }
    `;

    // Multi-pattern BGP with FILTER
    const multiPatternQuery = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?subject ?value WHERE {
        ?subject rdf:type <http://schema.org/BenchItem> .
        ?subject <http://schema.org/value> ?value .
        FILTER(?value > 95)
      }
    `;

    // All records (no FILTER)
    const allQuery = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      SELECT ?subject ?value WHERE {
        ?subject rdf:type <http://schema.org/BenchItem> .
        ?subject <http://schema.org/value> ?value .
      }
    `;

    console.log('\n=== Performance comparison ===');
    
    // Warm up
    await (await engine.queryBindings(singlePatternQuery)).toArray();
    await (await engine.queryBindings(multiPatternQuery)).toArray();
    await (await engine.queryBindings(allQuery)).toArray();

    // Single pattern
    const start1 = performance.now();
    const result1 = await (await engine.queryBindings(singlePatternQuery)).toArray();
    const time1 = performance.now() - start1;
    console.log(`Single pattern FILTER: ${result1.length} results in ${time1.toFixed(2)}ms`);

    // Multi-pattern
    const start2 = performance.now();
    const result2 = await (await engine.queryBindings(multiPatternQuery)).toArray();
    const time2 = performance.now() - start2;
    console.log(`Multi-pattern FILTER: ${result2.length} results in ${time2.toFixed(2)}ms`);

    // All records
    const start3 = performance.now();
    const result3 = await (await engine.queryBindings(allQuery)).toArray();
    const time3 = performance.now() - start3;
    console.log(`All records (no FILTER): ${result3.length} results in ${time3.toFixed(2)}ms`);

    console.log(`\nRatio (multi-pattern FILTER / all records): ${(time2 / time3).toFixed(2)}`);
    console.log(`If FILTER is pushed down, this ratio should be << 1`);
  });
});
