/**
 * PgQuintStore Tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { PgQuintStore } from '../../../src/storage/quint/PgQuintStore';
import type { Quint } from '../../../src/storage/quint/types';

const { namedNode, literal, quad } = DataFactory;

interface PgExecutorProbe {
  executor: {
    query<TRow>(sql: string): Promise<TRow[]>;
  };
}

// Skip tests if no PostgreSQL connection string is provided
const PG_CONNECTION = process.env.PG_TEST_CONNECTION || process.env.DATABASE_URL;
const describePg = PG_CONNECTION ? describe : describe.skip;

describePg('PgQuintStore', () => {
  let store: PgQuintStore;

  beforeAll(async () => {
    store = new PgQuintStore({
      driver: 'pg',
      connectionString: PG_CONNECTION,
    });
    await store.open();
    // Clear any existing data
    await store.clear();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    await store.clear();
  });

  describe('Basic Operations', () => {
    it('should put and get a quint', async () => {
      const quint: Quint = quad(
        namedNode('http://example.org/subject'),
        namedNode('http://example.org/predicate'),
        literal('object'),
        namedNode('http://example.org/graph1'),
      ) as Quint;

      await store.put(quint);
      
      const results = await store.get({});
      expect(results).toHaveLength(1);
      expect(results[0].subject.value).toBe('http://example.org/subject');
      expect(results[0].predicate.value).toBe('http://example.org/predicate');
      expect(results[0].object.value).toBe('object');
      expect(results[0].graph.value).toBe('http://example.org/graph1');
    });

    it('should multiPut quints', async () => {
      const quints: Quint[] = [
        quad(
          namedNode('http://example.org/s1'),
          namedNode('http://example.org/p1'),
          literal('o1'),
          namedNode('http://example.org/g1'),
        ) as Quint,
        quad(
          namedNode('http://example.org/s2'),
          namedNode('http://example.org/p2'),
          literal('o2'),
          namedNode('http://example.org/g1'),
        ) as Quint,
        quad(
          namedNode('http://example.org/s3'),
          namedNode('http://example.org/p3'),
          literal('o3'),
          namedNode('http://example.org/g2'),
        ) as Quint,
      ];

      await store.multiPut(quints);
      
      const results = await store.get({});
      expect(results).toHaveLength(3);
    });

    it('should count quints', async () => {
      const quints: Quint[] = [
        quad(namedNode('http://s1'), namedNode('http://p'), literal('o1'), namedNode('http://g')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p'), literal('o2'), namedNode('http://g')) as Quint,
        quad(namedNode('http://s3'), namedNode('http://p'), literal('o3'), namedNode('http://g')) as Quint,
      ];

      await store.multiPut(quints);
      
      const count = await store.count({});
      expect(count).toBe(3);
    });

    it('should delete quints by pattern', async () => {
      const quints: Quint[] = [
        quad(namedNode('http://s1'), namedNode('http://p1'), literal('o1'), namedNode('http://g')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p2'), literal('o2'), namedNode('http://g')) as Quint,
      ];

      await store.multiPut(quints);
      
      const deleted = await store.del({ subject: namedNode('http://s1') });
      expect(deleted).toBe(1);
      
      const remaining = await store.count({});
      expect(remaining).toBe(1);
    });
  });

  describe('Pattern Matching', () => {
    beforeEach(async () => {
      const quints: Quint[] = [
        quad(namedNode('http://s1'), namedNode('http://p1'), literal('o1'), namedNode('http://g1')) as Quint,
        quad(namedNode('http://s1'), namedNode('http://p2'), literal('o2'), namedNode('http://g1')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p1'), literal('o3'), namedNode('http://g2')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p2'), literal('o4'), namedNode('http://g2')) as Quint,
      ];
      await store.multiPut(quints);
    });

    it('should match by subject', async () => {
      const results = await store.get({ subject: namedNode('http://s1') });
      expect(results).toHaveLength(2);
      expect(results.every(q => q.subject.value === 'http://s1')).toBe(true);
    });

    it('should match by predicate', async () => {
      const results = await store.get({ predicate: namedNode('http://p1') });
      expect(results).toHaveLength(2);
      expect(results.every(q => q.predicate.value === 'http://p1')).toBe(true);
    });

    it('should match by graph', async () => {
      const results = await store.get({ graph: namedNode('http://g1') });
      expect(results).toHaveLength(2);
      expect(results.every(q => q.graph.value === 'http://g1')).toBe(true);
    });

    it('should match by multiple conditions', async () => {
      const results = await store.get({
        subject: namedNode('http://s1'),
        predicate: namedNode('http://p1'),
      });
      expect(results).toHaveLength(1);
      expect(results[0].object.value).toBe('o1');
    });
  });

  describe('Graph Prefix Matching', () => {
    beforeEach(async () => {
      const quints: Quint[] = [
        quad(namedNode('http://s1'), namedNode('http://p'), literal('o1'), namedNode('http://example.org/pod1/data')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p'), literal('o2'), namedNode('http://example.org/pod1/meta')) as Quint,
        quad(namedNode('http://s3'), namedNode('http://p'), literal('o3'), namedNode('http://example.org/pod2/data')) as Quint,
        quad(namedNode('http://s4'), namedNode('http://p'), literal('o4'), namedNode('http://other.org/pod1/data')) as Quint,
      ];
      await store.multiPut(quints);
    });

    it('should match by graph prefix', async () => {
      const results = await store.get({ graph: { $startsWith: 'http://example.org/pod1/' } });
      expect(results).toHaveLength(2);
      expect(results.every(q => q.graph.value.startsWith('http://example.org/pod1/'))).toBe(true);
    });

    it('should use getByGraphPrefix helper', async () => {
      const results = await store.getByGraphPrefix('http://example.org/');
      expect(results).toHaveLength(3);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', async () => {
      const quints: Quint[] = [
        quad(namedNode('http://s1'), namedNode('http://p'), literal('o1'), namedNode('http://g1')) as Quint,
        quad(namedNode('http://s2'), namedNode('http://p'), literal('o2'), namedNode('http://g1')) as Quint,
        quad(namedNode('http://s3'), namedNode('http://p'), literal('o3'), namedNode('http://g2')) as Quint,
      ];
      await store.multiPut(quints);

      const stats = await store.stats();
      expect(stats.totalCount).toBe(3);
      expect(stats.graphCount).toBe(2);
      expect(stats.vectorCount).toBe(0); // No embeddings
    });
  });

  describe('Embedding Support', () => {
    it('should store and retrieve embeddings', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const quint: Quint = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('o'),
        namedNode('http://g'),
      ) as Quint;
      quint.vector = embedding;

      await store.put(quint);
      
      const results = await store.get({});
      expect(results).toHaveLength(1);
      expect(results[0].vector).toEqual(embedding);
    });

    it('should update embeddings', async () => {
      const quint: Quint = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('o'),
        namedNode('http://g'),
      ) as Quint;

      await store.put(quint);
      
      const newEmbedding = [1.0, 2.0, 3.0];
      await store.updateEmbedding(
        { subject: namedNode('http://s') },
        newEmbedding
      );
      
      const results = await store.get({});
      expect(results[0].vector).toEqual(newEmbedding);
    });
  });

  describe('Typed object query modes', () => {
    let typedStore: PgQuintStore;

    beforeAll(async () => {
      typedStore = new PgQuintStore({
        driver: 'pg',
        connectionString: PG_CONNECTION,
        textMaxBytes: 64,
        predicateObjectDataTypes: {
          'http://example.org/body': 'longText',
          'http://example.org/title': 'text',
          'http://example.org/link': 'iri',
        },
      });
      await typedStore.open();
    });

    afterAll(async () => {
      await typedStore.close();
    });

    beforeEach(async () => {
      await typedStore.clear();
    });

    it('should use indexed exact lookup for short text, longText, and IRI objects', async () => {
      const body = 'alpha ' + 'long body '.repeat(40) + 'needle omega';

      await typedStore.multiPut([
        quad(
          namedNode('http://example.org/doc/long'),
          namedNode('http://example.org/body'),
          literal(body),
          namedNode('http://example.org/g1'),
        ) as Quint,
        quad(
          namedNode('http://example.org/doc/title'),
          namedNode('http://example.org/title'),
          literal('Short title'),
          namedNode('http://example.org/g1'),
        ) as Quint,
        quad(
          namedNode('http://example.org/doc/link'),
          namedNode('http://example.org/link'),
          namedNode('http://example.org/resource/needle-link'),
          namedNode('http://example.org/g1'),
        ) as Quint,
      ]);

      await expect(typedStore.get({
        predicate: namedNode('http://example.org/title'),
        object: literal('Short title'),
      })).resolves.toHaveLength(1);
      await expect(typedStore.get({
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
      })).resolves.toHaveLength(1);
      await expect(typedStore.get({
        predicate: namedNode('http://example.org/link'),
        object: namedNode('http://example.org/resource/needle-link'),
      })).resolves.toHaveLength(1);

      const rows = await (typedStore as unknown as PgExecutorProbe).executor.query<{
        predicate: string;
        objectKind: string;
        objectKey: string | null;
        objectText: string | null;
        objectDigest: string | null;
      }>(`
        SELECT
          predicate,
          object_kind as "objectKind",
          object_key as "objectKey",
          object_text as "objectText",
          object_digest as "objectDigest"
        FROM quints
        ORDER BY predicate
      `);

      const bodyRow = rows.find((row) => row.predicate === 'http://example.org/body');
      const titleRow = rows.find((row) => row.predicate === 'http://example.org/title');
      const linkRow = rows.find((row) => row.predicate === 'http://example.org/link');

      expect(bodyRow).toMatchObject({
        objectKind: 'longText',
        objectKey: null,
        objectText: body,
      });
      expect(bodyRow?.objectDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(titleRow?.objectKind).toBe('text');
      expect(titleRow?.objectKey).toContain('Short title');
      expect(linkRow?.objectKind).toBe('iri');
      expect(linkRow?.objectKey).toBe('http://example.org/resource/needle-link');
    });

  });
});
