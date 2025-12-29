import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteQuintStore } from '../src/storage/quint';
import { ComunicaQuintEngine } from '../src/storage/sparql/ComunicaQuintEngine';
import { DataFactory } from 'n3';

const { namedNode, literal, quad } = DataFactory;

describe('Pushdown Debug', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    
    await store.multiPut([
      quad(namedNode('http://ex/s1'), namedNode('http://ex/p'), literal('10', namedNode('http://www.w3.org/2001/XMLSchema#integer')), namedNode('http://ex/g')),
      quad(namedNode('http://ex/s2'), namedNode('http://ex/p'), literal('20', namedNode('http://www.w3.org/2001/XMLSchema#integer')), namedNode('http://ex/g')),
      quad(namedNode('http://ex/s3'), namedNode('http://ex/p'), literal('30', namedNode('http://www.w3.org/2001/XMLSchema#integer')), namedNode('http://ex/g')),
      quad(namedNode('http://ex/s1'), namedNode('http://ex/name'), literal('Alice'), namedNode('http://ex/g')),
      quad(namedNode('http://ex/s2'), namedNode('http://ex/name'), literal('Bob'), namedNode('http://ex/g')),
    ]);

    engine = new ComunicaQuintEngine(store, { debug: true });
  });

  afterAll(async () => {
    await store.close();
  });

  it('Simple equality - should pushdown', async () => {
    console.log('\n=== Simple equality ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/p> ?o FILTER(?o = 20) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(1);
  });

  it('Greater than - should pushdown', async () => {
    console.log('\n=== Greater than ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/p> ?o FILTER(?o > 15) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(2);
  });

  it('OR same var - should convert to $in', async () => {
    console.log('\n=== OR same var ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/p> ?o FILTER(?o = 10 || ?o = 30) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(2);
  });

  it('OR diff var - should use OR branches', async () => {
    console.log('\n=== OR diff var ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s ?p ?o FILTER(?s = <http://ex/s1> || ?p = <http://ex/name>) }');
    const results = await stream.toArray();
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('AND - should pushdown both', async () => {
    console.log('\n=== AND ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/p> ?o FILTER(?o > 10 && ?o < 30) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(1);
  });

  it('STRSTARTS - should pushdown', async () => {
    console.log('\n=== STRSTARTS ===');
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/name> ?n FILTER(STRSTARTS(?n, "A")) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(1);
  });

  it('STRLEN - NOT pushdownable, should use in-memory', async () => {
    console.log('\n=== STRLEN (not pushdownable) ===');
    // Alice = 5 chars, Bob = 3 chars
    // STRLEN > 3 means only Alice passes (5 > 3 = true, 3 > 3 = false)
    const stream = await engine.queryBindings('SELECT * WHERE { ?s <http://ex/name> ?n FILTER(STRLEN(?n) > 3) }');
    const results = await stream.toArray();
    expect(results).toHaveLength(1);
  });
});
