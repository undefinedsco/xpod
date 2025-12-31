import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';

const { namedNode, literal, quad } = DataFactory;

describe('ComunicaQuintEngine FILTER pushdown', () => {
  let store: SqliteQuintStore;
  let engine: ComunicaQuintEngine;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
    await store.multiPut([
      quad(namedNode('http://s1'), namedNode('http://p'), literal('100'), namedNode('http://g/1')),
      quad(namedNode('http://s2'), namedNode('http://p'), literal('200'), namedNode('http://g/2')),
      quad(namedNode('http://s3'), namedNode('http://p'), literal('300'), namedNode('http://g/3')),
    ]);
    engine = new ComunicaQuintEngine(store, { debug: true });
  });

  afterAll(async () => {
    await store.close();
  });

  it('should show what happens with FILTER on object', async () => {
    console.log('\n\n========== FILTER ?o > "150" ==========');
    const query = `SELECT ?s ?o WHERE { ?s <http://p> ?o FILTER(?o > "150") }`;
    console.log('Query:', query);
    
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    
    console.log('Results count:', results.length);
    for (const binding of results) {
      console.log('  s:', binding.get('s')?.value, 'o:', binding.get('o')?.value);
    }
  });

  it('should show what happens with FILTER STRSTARTS on graph', async () => {
    console.log('\n\n========== FILTER STRSTARTS(?g, "http://g/") ==========');
    const query = `SELECT ?s ?o ?g WHERE { GRAPH ?g { ?s <http://p> ?o } FILTER(STRSTARTS(STR(?g), "http://g/")) }`;
    console.log('Query:', query);
    
    const stream = await engine.queryBindings(query);
    const results = await stream.toArray();
    
    console.log('Results count:', results.length);
  });
});
