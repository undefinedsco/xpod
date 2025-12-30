/**
 * Test SPARQL multi-pattern query with compound query optimization
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint/SqliteQuintStore';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import type { Quint } from '../../../src/storage/quint/types';

const { namedNode, literal } = DataFactory;

describe('SPARQL Multi-Pattern Query with Compound Optimization', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:', debug: true });
    await store.open();

    // Insert test data: 10000 users with name and age
    const quints: Quint[] = [];
    const graph = namedNode('http://example.org/graph1');

    for (let i = 1; i <= 10000; i++) {
      const subject = namedNode(`http://example.org/user/${i}`);
      
      // Add name
      quints.push({
        graph,
        subject,
        predicate: namedNode('http://schema.org/name'),
        object: literal(`User ${i}`),
      } as Quint);

      // Add age as xsd:integer
      quints.push({
        graph,
        subject,
        predicate: namedNode('http://schema.org/age'),
        object: literal(i, namedNode('http://www.w3.org/2001/XMLSchema#integer')),
      } as Quint);
    }

    await store.multiPut(quints);
    console.log(`Inserted ${quints.length} quints`);

    // Create engine with debug enabled
    engine = new ComunicaQuintEngine(store, { debug: true });
  });

  afterAll(async () => {
    await store.close();
  });

  it('should execute multi-pattern SPARQL query', async () => {
    // This query has two patterns with the same subject variable
    const query = `
      PREFIX schema: <http://schema.org/>
      SELECT ?s ?name ?age WHERE {
        ?s schema:name ?name .
        ?s schema:age ?age .
        FILTER(?age > 9970)
      }
    `;

    console.log('Executing SPARQL query:', query);
    
    const startTime = performance.now();
    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    
    for await (const binding of stream) {
      results.push({
        s: binding.get('s')?.value,
        name: binding.get('name')?.value,
        age: binding.get('age')?.value,
      });
    }
    const endTime = performance.now();

    console.log(`Query returned ${results.length} results in ${(endTime - startTime).toFixed(2)}ms`);
    console.log('Sample results:', results.slice(0, 3));

    expect(results.length).toBe(30); // Users 9971-10000
    
    // Verify the results are correct
    for (const r of results) {
      const age = parseInt(r.age);
      expect(age).toBeGreaterThan(9970);
      expect(r.name).toMatch(/^User \d+$/);
    }
  });

  it('should be faster with compound query optimization', async () => {
    const query = `
      PREFIX schema: <http://schema.org/>
      SELECT ?s ?name ?age WHERE {
        ?s schema:name ?name .
        ?s schema:age ?age .
        FILTER(?age > 9970)
      }
    `;

    // Run multiple times to get stable timing
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const stream = await engine.queryBindings(query);
      const results: any[] = [];
      for await (const binding of stream) {
        results.push(binding);
      }
      times.push(performance.now() - start);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`Average query time: ${avgTime.toFixed(2)}ms (over ${times.length} runs)`);
    
    // The query should be reasonably fast with compound optimization
    // Without optimization, it would query 10000 names then 10000 ages then join
    // With optimization, it's a single SQL JOIN
    expect(avgTime).toBeLessThan(500); // Should be well under 500ms
  });
});
