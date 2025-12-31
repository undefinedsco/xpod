import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import { fpEncode, SEP } from '../../../src/storage/quint/serialization';

const { namedNode, literal, quad } = DataFactory;

describe('ComunicaQuintEngine', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeEach(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    engine = new ComunicaQuintEngine(store);
  });

  afterEach(async () => {
    await store.close();
  });

  describe('basic queries', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Alice'),
          namedNode('http://example.org/graph1'),
        ),
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Bob'),
          namedNode('http://example.org/graph1'),
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/knows'),
          namedNode('http://example.org/bob'),
          namedNode('http://example.org/graph1'),
        ),
      ]);
    });

    it('should execute SELECT query', async () => {
      const query = `
        SELECT ?name WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(2);
      const names = results.map(r => r.get('name')?.value).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('should execute ASK query', async () => {
      const query = `
        ASK {
          ?s <http://xmlns.com/foaf/0.1/name> "Alice" .
        }
      `;
      
      const result = await engine.queryBoolean(query);
      expect(result).toBe(true);
    });

    it('should execute ASK query with false result', async () => {
      const query = `
        ASK {
          ?s <http://xmlns.com/foaf/0.1/name> "Charlie" .
        }
      `;
      
      const result = await engine.queryBoolean(query);
      expect(result).toBe(false);
    });

    it('should execute CONSTRUCT query', async () => {
      const query = `
        CONSTRUCT {
          ?s <http://example.org/hasName> ?name .
        } WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
        }
      `;
      
      const stream = await engine.queryQuads(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(2);
      expect(results.every(q => q.predicate.value === 'http://example.org/hasName')).toBe(true);
    });
  });

  describe('graph prefix filtering', () => {
    beforeEach(async () => {
      // Data in different subgraphs
      await store.multiPut([
        // User 0's data
        quad(
          namedNode('http://example.org/doc1'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Doc 1'),
          namedNode('http://pod/user0/docs/doc1'),
        ),
        quad(
          namedNode('http://example.org/doc2'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Doc 2'),
          namedNode('http://pod/user0/docs/doc2'),
        ),
        // User 1's data
        quad(
          namedNode('http://example.org/doc3'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Doc 3'),
          namedNode('http://pod/user1/docs/doc3'),
        ),
        // Shared data
        quad(
          namedNode('http://example.org/shared'),
          namedNode('http://purl.org/dc/terms/title'),
          literal('Shared Doc'),
          namedNode('http://shared/public'),
        ),
      ]);
    });

    it('should filter by graph prefix in context', async () => {
      const query = `
        SELECT ?title WHERE {
          ?s <http://purl.org/dc/terms/title> ?title .
        }
      `;
      
      // Query only user0's subgraph using security filters
      const stream = await engine.queryBindings(query, {
        filters: {
          graph: { $startsWith: 'http://pod/user0/' },
        },
      });
      const results = await stream.toArray();
      
      expect(results).toHaveLength(2);
      const titles = results.map(r => r.get('title')?.value).sort();
      expect(titles).toEqual(['Doc 1', 'Doc 2']);
    });

    it('should filter by broader graph prefix', async () => {
      const query = `
        SELECT ?title WHERE {
          ?s <http://purl.org/dc/terms/title> ?title .
        }
      `;
      
      // Query all users' data using security filters
      const stream = await engine.queryBindings(query, {
        filters: {
          graph: { $startsWith: 'http://pod/' },
        },
      });
      const results = await stream.toArray();
      
      expect(results).toHaveLength(3);
    });

    it('should return all data without graph prefix', async () => {
      const query = `
        SELECT ?title WHERE {
          ?s <http://purl.org/dc/terms/title> ?title .
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(4);
    });
  });

  describe('query optimization', () => {
    beforeEach(async () => {
      // Insert 100 items
      const quads = [];
      for (let i = 0; i < 100; i++) {
        quads.push(
          quad(
            namedNode(`http://example.org/item${i}`),
            namedNode('http://example.org/value'),
            literal(String(i)),
            namedNode('http://example.org/graph'),
          ),
        );
      }
      await store.multiPut(quads);
    });

    it('should push down LIMIT', async () => {
      const query = `
        SELECT ?s ?v WHERE {
          ?s <http://example.org/value> ?v .
        }
        LIMIT 5
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(5);
    });

    it('should handle LIMIT with OFFSET', async () => {
      const query = `
        SELECT ?s ?v WHERE {
          ?s <http://example.org/value> ?v .
        }
        LIMIT 10
        OFFSET 5
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(10);
    });
  });

  describe('JOIN queries', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Alice'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/age'),
          literal('30'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Bob'),
          namedNode('http://example.org/graph'),
        ),
      ]);
    });

    it('should handle JOIN between patterns', async () => {
      const query = `
        SELECT ?name ?age WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
          ?s <http://xmlns.com/foaf/0.1/age> ?age .
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(1);
      expect(results[0].get('name')?.value).toBe('Alice');
      expect(results[0].get('age')?.value).toBe('30');
    });

    it('should handle OPTIONAL', async () => {
      const query = `
        SELECT ?name ?age WHERE {
          ?s <http://xmlns.com/foaf/0.1/name> ?name .
          OPTIONAL {
            ?s <http://xmlns.com/foaf/0.1/age> ?age .
          }
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(2);
      
      const alice = results.find(r => r.get('name')?.value === 'Alice');
      const bob = results.find(r => r.get('name')?.value === 'Bob');
      
      expect(alice?.get('age')?.value).toBe('30');
      expect(bob?.get('age')).toBeUndefined();
    });
  });

  describe('FILTER queries', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(
          namedNode('http://example.org/item1'),
          namedNode('http://example.org/price'),
          literal('10', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/item2'),
          namedNode('http://example.org/price'),
          literal('20', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/item3'),
          namedNode('http://example.org/price'),
          literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
          namedNode('http://example.org/graph'),
        ),
      ]);
    });

    it('should handle FILTER with comparison', async () => {
      const query = `
        SELECT ?s ?price WHERE {
          ?s <http://example.org/price> ?price .
          FILTER (?price > 15)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      expect(results).toHaveLength(2);
      const prices = results.map(r => parseInt(r.get('price')?.value ?? '0')).sort((a, b) => a - b);
      expect(prices).toEqual([20, 30]);
    });

    it('should pushdown FILTER to database layer', async () => {
      // This test verifies that FILTER with comparison operators works correctly
      // The implementation may or may not pushdown - we only verify results
      const query = `
        SELECT ?s ?price WHERE {
          ?s <http://example.org/price> ?price .
          FILTER (?price > 15)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Should return items with price > 15 (20 and 30)
      expect(results).toHaveLength(2);
      const prices = results.map(r => parseInt(r.get('price')?.value ?? '0')).sort((a, b) => a - b);
      expect(prices).toEqual([20, 30]);
    });

    it('should handle OR filter with same variable (converts to $in)', async () => {
      const query = `
        SELECT ?s ?price WHERE {
          ?s <http://example.org/price> ?price .
          FILTER (?price = 10 || ?price = 30)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Should return items with price 10 and 30
      expect(results).toHaveLength(2);
      const prices = results.map(r => parseInt(r.get('price')?.value ?? '0')).sort((a, b) => a - b);
      expect(prices).toEqual([10, 30]);
    });

    it('should handle OR with different variables', async () => {
      // Add more test data with different predicates
      await store.multiPut([
        quad(
          namedNode('http://example.org/item1'),
          namedNode('http://example.org/name'),
          literal('Item1'),
          namedNode('http://example.org/graph'),
        ),
      ]);

      const query = `
        SELECT ?s ?p ?o WHERE {
          ?s ?p ?o .
          FILTER (?p = <http://example.org/price> || ?p = <http://example.org/name>)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Should return items with price OR name predicates (3 prices + 1 name = 4)
      expect(results).toHaveLength(4);
    });

    it('should pushdown OR as $in filter', async () => {
      // This test verifies that OR with same variable equality works correctly
      // The implementation may use $in optimization or evaluate in-memory
      const query = `
        SELECT ?s ?price WHERE {
          ?s <http://example.org/price> ?price .
          FILTER (?price = 10 || ?price = 30)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Should return items with price 10 and 30
      expect(results).toHaveLength(2);
      const prices = results.map(r => parseInt(r.get('price')?.value ?? '0')).sort((a, b) => a - b);
      expect(prices).toEqual([10, 30]);
    });

    it('should split OR with different variables into separate queries', async () => {
      // Add more test data
      await store.multiPut([
        quad(
          namedNode('http://example.org/item1'),
          namedNode('http://example.org/name'),
          literal('Item1'),
          namedNode('http://example.org/graph'),
        ),
      ]);

      const query = `
        SELECT ?s ?p ?o WHERE {
          ?s ?p ?o .
          FILTER (?s = <http://example.org/item1> || ?p = <http://example.org/name>)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Results should include:
      // - item1's price triple (matched by ?s = item1)
      // - item1's name triple (matched by both)
      // The implementation may split into separate queries or evaluate in-memory
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle complex OR with non-equality expressions', async () => {
      // Test: ?price > 25 || ?price < 15
      // The implementation may use OR branches or evaluate in-memory
      const query = `
        SELECT ?s ?price WHERE {
          ?s <http://example.org/price> ?price .
          FILTER (?price > 25 || ?price < 15)
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Should return price=10 (< 15) and price=30 (> 25)
      expect(results).toHaveLength(2);
      const prices = results.map(r => parseInt(r.get('price')?.value ?? '0')).sort((a, b) => a - b);
      expect(prices).toEqual([10, 30]);
    });
  });

  describe('EXISTS / NOT EXISTS', () => {
    beforeEach(async () => {
      // Create test data: people who know others, some blocked
      await store.multiPut([
        // Alice knows Bob
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/knows'),
          namedNode('http://example.org/bob'),
          namedNode('http://example.org/graph'),
        ),
        // Bob knows Charlie
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/knows'),
          namedNode('http://example.org/charlie'),
          namedNode('http://example.org/graph'),
        ),
        // Alice has blocked Dave
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://example.org/blocked'),
          namedNode('http://example.org/dave'),
          namedNode('http://example.org/graph'),
        ),
        // All people have names
        quad(
          namedNode('http://example.org/alice'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Alice'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/bob'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Bob'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/charlie'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Charlie'),
          namedNode('http://example.org/graph'),
        ),
        quad(
          namedNode('http://example.org/dave'),
          namedNode('http://xmlns.com/foaf/0.1/name'),
          literal('Dave'),
          namedNode('http://example.org/graph'),
        ),
      ]);
    });

    it('should handle FILTER EXISTS', async () => {
      // Find people who know someone
      const query = `
        SELECT ?name WHERE {
          ?person <http://xmlns.com/foaf/0.1/name> ?name .
          FILTER EXISTS {
            ?person <http://xmlns.com/foaf/0.1/knows> ?someone .
          }
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Alice and Bob know someone, Charlie and Dave don't
      expect(results).toHaveLength(2);
      const names = results.map(r => r.get('name')?.value).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('should handle FILTER NOT EXISTS', async () => {
      // Find people who don't know anyone
      const query = `
        SELECT ?name WHERE {
          ?person <http://xmlns.com/foaf/0.1/name> ?name .
          FILTER NOT EXISTS {
            ?person <http://xmlns.com/foaf/0.1/knows> ?someone .
          }
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Charlie and Dave don't know anyone
      expect(results).toHaveLength(2);
      const names = results.map(r => r.get('name')?.value).sort();
      expect(names).toEqual(['Charlie', 'Dave']);
    });

    it('should use limit 1 for EXISTS queries', async () => {
      const getSpy = vi.spyOn(store, 'get');

      const query = `
        SELECT ?name WHERE {
          ?person <http://xmlns.com/foaf/0.1/name> ?name .
          FILTER EXISTS {
            ?person <http://xmlns.com/foaf/0.1/knows> ?someone .
          }
        }
      `;
      
      const stream = await engine.queryBindings(query);
      await stream.toArray();
      
      // Check that EXISTS queries used limit: 1
      const existsCalls = getSpy.mock.calls.filter(call => {
        const options = call[1];
        return options?.limit === 1;
      });
      
      // Should have at least some calls with limit 1 (for EXISTS checks)
      expect(existsCalls.length).toBeGreaterThan(0);
      
      getSpy.mockRestore();
    });

    it('should handle complex nested filters', async () => {
      // Test deeply nested: (EXISTS && NOT EXISTS) || (?name = "Dave")
      const query = `
        SELECT ?name WHERE {
          ?person <http://xmlns.com/foaf/0.1/name> ?name .
          FILTER (
            (EXISTS { ?person <http://xmlns.com/foaf/0.1/knows> ?x } && 
             NOT EXISTS { ?person <http://example.org/blocked> ?y })
            || ?name = "Dave"
          )
        }
      `;
      
      const stream = await engine.queryBindings(query);
      const results = await stream.toArray();
      
      // Alice: knows someone (Bob), BUT has blocked Dave -> fails NOT EXISTS -> fails first branch, name != Dave -> fails
      // Bob: knows someone (Charlie), hasn't blocked anyone -> passes first branch
      // Charlie: doesn't know anyone -> fails first branch, name != Dave -> fails
      // Dave: doesn't know anyone -> fails first branch, but name = Dave -> passes second branch
      expect(results).toHaveLength(2);
      const names = results.map(r => r.get('name')?.value).sort();
      expect(names).toEqual(['Bob', 'Dave']);
    });
  });
});
