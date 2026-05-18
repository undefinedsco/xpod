import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine';
import { arrayFromStream } from '../../helpers/arrayFromStream';

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
      quad(namedNode('http://localhost/chat-1/messages.ttl#msg-123'), namedNode('http://schema.org/text'), literal('hello short id'), namedNode('http://localhost/chat-1/messages.ttl')),
      quad(namedNode('http://localhost/chat-1/messages.ttl#msg-123'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://example.org/Message'), namedNode('http://localhost/chat-1/messages.ttl')),
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
    const results = await arrayFromStream(stream);

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
    const results = await arrayFromStream(stream);

    console.log('Results count:', results.length);
    expect(results).toHaveLength(3);
  });

  it('matches STRENDS(STR(?subject), suffix) against raw IRI values', async () => {
    const query = `
      SELECT DISTINCT ?subject WHERE {
        GRAPH ?g {
          ?subject ?typePredicate ?typeObject .
          FILTER(
            ?typePredicate = <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> &&
            ?typeObject = <http://example.org/Message> &&
            STRENDS(STR(?subject), "/messages.ttl#msg-123")
          )
        }
      }
    `;

    const stream = await engine.queryBindings(query);
    const results = await arrayFromStream(stream);

    expect(results.map(binding => binding.get('subject')?.value)).toEqual([
      'http://localhost/chat-1/messages.ttl#msg-123',
    ]);
  });

  it('evaluates string filters on literal objects without literal-serialization pushdown', async () => {
    const query = `
      SELECT ?subject WHERE {
        GRAPH ?g {
          ?subject <http://schema.org/text> ?text .
          FILTER(STRENDS(STR(?text), "id"))
        }
      }
    `;

    const stream = await engine.queryBindings(query);
    const results = await arrayFromStream(stream);

    expect(results.map(binding => binding.get('subject')?.value)).toEqual([
      'http://localhost/chat-1/messages.ttl#msg-123',
    ]);
  });
});
