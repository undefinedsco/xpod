/**
 * ORDER BY 下推测试
 * 
 * 验证任意变量的 ORDER BY 都能正确下推到数据库
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataFactory } from 'rdf-data-factory';
import { SqliteQuintStore } from '../../../src/storage/quint/SqliteQuintStore';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';

const df = new DataFactory();

describe('ORDER BY Pushdown', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    engine = new ComunicaQuintEngine(store, { debug: true });

    // 插入测试数据
    const graph = df.namedNode('http://example.org/graph');
    const nameType = df.namedNode('http://schema.org/name');
    const ageType = df.namedNode('http://schema.org/age');

    const people = [
      { id: 'alice', name: 'Alice', age: 30 },
      { id: 'bob', name: 'Bob', age: 25 },
      { id: 'charlie', name: 'Charlie', age: 35 },
      { id: 'david', name: 'David', age: 28 },
      { id: 'eve', name: 'Eve', age: 22 },
    ];

    for (const p of people) {
      const subject = df.namedNode(`http://example.org/${p.id}`);
      await store.put({
        graph,
        subject,
        predicate: nameType,
        object: df.literal(p.name),
      });
      await store.put({
        graph,
        subject,
        predicate: ageType,
        object: df.literal(p.age.toString(), df.namedNode('http://www.w3.org/2001/XMLSchema#integer')),
      });
    }
  });

  afterAll(async () => {
    await store.close();
  });

  it('should pushdown ORDER BY ?name (bound to object)', async () => {
    const query = `
      SELECT ?s ?name WHERE {
        GRAPH <http://example.org/graph> {
          ?s <http://schema.org/name> ?name
        }
      }
      ORDER BY ?name
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        s: binding.get(df.variable('s'))?.value,
        name: binding.get(df.variable('name'))?.value,
      });
    }

    console.log('Results:', results);

    expect(results.length).toBe(5);
    // 验证排序顺序：Alice, Bob, Charlie, David, Eve
    expect(results[0].name).toBe('Alice');
    expect(results[1].name).toBe('Bob');
    expect(results[2].name).toBe('Charlie');
    expect(results[3].name).toBe('David');
    expect(results[4].name).toBe('Eve');
  });

  it('should pushdown ORDER BY DESC ?name', async () => {
    const query = `
      SELECT ?s ?name WHERE {
        GRAPH <http://example.org/graph> {
          ?s <http://schema.org/name> ?name
        }
      }
      ORDER BY DESC(?name)
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        name: binding.get(df.variable('name'))?.value,
      });
    }

    expect(results.length).toBe(5);
    // 验证降序排序：Eve, David, Charlie, Bob, Alice
    expect(results[0].name).toBe('Eve');
    expect(results[4].name).toBe('Alice');
  });

  it('should pushdown ORDER BY ?s (standard variable)', async () => {
    const query = `
      SELECT ?s ?name WHERE {
        GRAPH <http://example.org/graph> {
          ?s <http://schema.org/name> ?name
        }
      }
      ORDER BY ?s
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        s: binding.get(df.variable('s'))?.value,
      });
    }

    expect(results.length).toBe(5);
    // 验证按 subject 排序：alice, bob, charlie, david, eve
    expect(results[0].s).toContain('alice');
    expect(results[4].s).toContain('eve');
  });

  it('should pushdown ORDER BY with LIMIT', async () => {
    const query = `
      SELECT ?s ?name WHERE {
        GRAPH <http://example.org/graph> {
          ?s <http://schema.org/name> ?name
        }
      }
      ORDER BY ?name
      LIMIT 3
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        name: binding.get(df.variable('name'))?.value,
      });
    }

    expect(results.length).toBe(3);
    // 前 3 个：Alice, Bob, Charlie
    expect(results[0].name).toBe('Alice');
    expect(results[1].name).toBe('Bob');
    expect(results[2].name).toBe('Charlie');
  });
});

describe('ORDER BY with OPTIONAL', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    engine = new ComunicaQuintEngine(store, { debug: true });

    // 模拟 contact 数据
    const graph = df.namedNode('http://example.org/contacts');
    const rdfType = df.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const vcardIndividual = df.namedNode('http://www.w3.org/2006/vcard/ns#Individual');
    const vcardFn = df.namedNode('http://www.w3.org/2006/vcard/ns#fn');
    const vcardNote = df.namedNode('http://www.w3.org/2006/vcard/ns#note');

    const contacts = [
      { id: 'contact1', name: 'Zoe', note: 'Friend' },
      { id: 'contact2', name: 'Alice', note: null },
      { id: 'contact3', name: 'Bob', note: 'Colleague' },
      { id: 'contact4', name: 'Charlie', note: null },
    ];

    for (const c of contacts) {
      const subject = df.namedNode(`http://example.org/${c.id}`);
      await store.put({ graph, subject, predicate: rdfType, object: vcardIndividual });
      await store.put({ graph, subject, predicate: vcardFn, object: df.literal(c.name) });
      if (c.note) {
        await store.put({ graph, subject, predicate: vcardNote, object: df.literal(c.note) });
      }
    }
  });

  afterAll(async () => {
    await store.close();
  });

  it('should sort OPTIONAL query results by name ASC', async () => {
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
      
      SELECT ?s ?name ?note WHERE {
        GRAPH <http://example.org/contacts> {
          ?s rdf:type vcard:Individual .
          ?s vcard:fn ?name .
          OPTIONAL { ?s vcard:note ?note . }
        }
      }
      ORDER BY ?name
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        name: binding.get(df.variable('name'))?.value,
        note: binding.get(df.variable('note'))?.value,
      });
    }

    console.log('OPTIONAL + ORDER BY results:', results);

    expect(results.length).toBe(4);
    // 验证按 name 升序：Alice, Bob, Charlie, Zoe
    expect(results[0].name).toBe('Alice');
    expect(results[1].name).toBe('Bob');
    expect(results[2].name).toBe('Charlie');
    expect(results[3].name).toBe('Zoe');
  });

  it('should sort OPTIONAL query results by name DESC', async () => {
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
      
      SELECT ?s ?name ?note WHERE {
        GRAPH <http://example.org/contacts> {
          ?s rdf:type vcard:Individual .
          ?s vcard:fn ?name .
          OPTIONAL { ?s vcard:note ?note . }
        }
      }
      ORDER BY DESC(?name)
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        name: binding.get(df.variable('name'))?.value,
      });
    }

    expect(results.length).toBe(4);
    // 验证按 name 降序：Zoe, Charlie, Bob, Alice
    expect(results[0].name).toBe('Zoe');
    expect(results[3].name).toBe('Alice');
  });

  it('should apply LIMIT after ORDER BY', async () => {
    const query = `
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
      
      SELECT ?s ?name WHERE {
        GRAPH <http://example.org/contacts> {
          ?s rdf:type vcard:Individual .
          ?s vcard:fn ?name .
          OPTIONAL { ?s vcard:note ?note . }
        }
      }
      ORDER BY ?name
      LIMIT 2
    `;

    const stream = await engine.queryBindings(query);
    const results: any[] = [];
    for await (const binding of stream) {
      results.push({
        name: binding.get(df.variable('name'))?.value,
      });
    }

    expect(results.length).toBe(2);
    // 前 2 个：Alice, Bob
    expect(results[0].name).toBe('Alice');
    expect(results[1].name).toBe('Bob');
  });
});
