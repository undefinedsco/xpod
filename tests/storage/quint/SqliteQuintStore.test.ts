import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import type { Quint } from '../../../src/storage/quint';

const { namedNode, literal, defaultGraph, quad } = DataFactory;

describe('SqliteQuintStore', () => {
  let store: SqliteQuintStore;

  beforeEach(async () => {
    store = new SqliteQuintStore({ path: ':memory:' });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('basic CRUD', () => {
    it('should put and get a quad', async () => {
      const q = quad(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        literal('hello'),
        namedNode('http://example.org/g'),
      );

      await store.put(q);

      const results = await store.get({});
      expect(results).toHaveLength(1);
      expect(results[0].subject.value).toBe('http://example.org/s');
      expect(results[0].predicate.value).toBe('http://example.org/p');
      expect(results[0].object.value).toBe('hello');
      expect(results[0].graph.value).toBe('http://example.org/g');
    });

    it('should put quad with vector', async () => {
      const q: Quint = quad(
        namedNode('http://example.org/s'),
        namedNode('http://example.org/p'),
        literal('hello'),
        namedNode('http://example.org/g'),
      ) as Quint;
      q.vector = [0.1, 0.2, 0.3];

      await store.put(q);

      const results = await store.get({});
      expect(results).toHaveLength(1);
      expect(results[0].vector).toEqual([0.1, 0.2, 0.3]);
    });

    it('should delete by pattern', async () => {
      await store.multiPut([
        quad(namedNode('http://s1'), namedNode('http://p'), literal('v1'), namedNode('http://g')),
        quad(namedNode('http://s2'), namedNode('http://p'), literal('v2'), namedNode('http://g')),
      ]);

      const deleted = await store.del({ subject: namedNode('http://s1') });
      expect(deleted).toBe(1);

      const results = await store.get({});
      expect(results).toHaveLength(1);
      expect(results[0].subject.value).toBe('http://s2');
    });
  });

  describe('query by pattern', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(namedNode('http://s1'), namedNode('http://p1'), literal('v1'), namedNode('http://g1')),
        quad(namedNode('http://s1'), namedNode('http://p2'), literal('v2'), namedNode('http://g1')),
        quad(namedNode('http://s2'), namedNode('http://p1'), literal('v3'), namedNode('http://g2')),
      ]);
    });

    it('should query by subject', async () => {
      const results = await store.get({ subject: namedNode('http://s1') });
      expect(results).toHaveLength(2);
    });

    it('should query by predicate', async () => {
      const results = await store.get({ predicate: namedNode('http://p1') });
      expect(results).toHaveLength(2);
    });

    it('should query by graph', async () => {
      const results = await store.get({ graph: namedNode('http://g1') });
      expect(results).toHaveLength(2);
    });

    it('should query by multiple conditions', async () => {
      const results = await store.get({
        subject: namedNode('http://s1'),
        predicate: namedNode('http://p1'),
      });
      expect(results).toHaveLength(1);
      expect(results[0].object.value).toBe('v1');
    });
  });

  describe('graph prefix matching', () => {
    beforeEach(async () => {
      await store.multiPut([
        quad(namedNode('http://s'), namedNode('http://p'), literal('v1'), namedNode('http://pod/user0/doc1')),
        quad(namedNode('http://s'), namedNode('http://p'), literal('v2'), namedNode('http://pod/user0/doc2')),
        quad(namedNode('http://s'), namedNode('http://p'), literal('v3'), namedNode('http://pod/user1/doc1')),
        quad(namedNode('http://s'), namedNode('http://p'), literal('v4'), namedNode('http://other/graph')),
      ]);
    });

    it('should match by graph prefix', async () => {
      const results = await store.get({ graph: { $startsWith: 'http://pod/user0/' } });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.graph.value.startsWith('http://pod/user0/'))).toBe(true);
    });

    it('should match broader prefix', async () => {
      const results = await store.get({ graph: { $startsWith: 'http://pod/' } });
      expect(results).toHaveLength(3);
    });

    it('should use getByGraphPrefix convenience method', async () => {
      const results = await store.getByGraphPrefix('http://pod/user1/');
      expect(results).toHaveLength(1);
      expect(results[0].object.value).toBe('v3');
    });
  });

  // Note: vector search not yet implemented for SQLite
  // describe('vector search', () => { ... });

  describe('stats', () => {
    it('should return correct stats', async () => {
      const q1: Quint = quad(
        namedNode('http://s1'),
        namedNode('http://p'),
        literal('v1'),
        namedNode('http://g1'),
      ) as Quint;
      q1.vector = [0.1, 0.2];

      const q2 = quad(
        namedNode('http://s2'),
        namedNode('http://p'),
        literal('v2'),
        namedNode('http://g2'),
      );

      await store.multiPut([q1, q2]);

      const stats = await store.stats();
      expect(stats.totalCount).toBe(2);
      expect(stats.vectorCount).toBe(1);
      expect(stats.graphCount).toBe(2);
      expect(stats.databaseBytes).toBeGreaterThan(0);
      expect(stats.tableBytes).toBeGreaterThan(0);
      expect(stats.indexBytes).toBeGreaterThan(0);
      expect(stats.spaceObjects?.some((object) => object.name === 'quints' && object.kind === 'table')).toBe(true);
      expect(stats.spaceObjects?.some((object) => object.kind === 'index' && object.tableName === 'quints')).toBe(true);
    });
  });

  describe('literal types', () => {
    it('should handle plain literal', async () => {
      const q = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('hello'),
        defaultGraph(),
      );
      await store.put(q);

      const results = await store.get({});
      expect(results[0].object.value).toBe('hello');
      expect(results[0].object.termType).toBe('Literal');
    });

    it('should handle language-tagged literal', async () => {
      const q = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('hello', 'en'),
        defaultGraph(),
      );
      await store.put(q);

      const results = await store.get({});
      const obj = results[0].object as any;
      expect(obj.value).toBe('hello');
      expect(obj.language).toBe('en');
    });

    it('should handle datatyped literal', async () => {
      const q = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        defaultGraph(),
      );
      await store.put(q);

      const results = await store.get({});
      const obj = results[0].object as any;
      expect(obj.value).toBe('42');
      expect(obj.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
    });
  });

  describe('object data types', () => {
    beforeEach(async () => {
      await store.close();
      store = new SqliteQuintStore({
        path: ':memory:',
        textMaxBytes: 64,
        predicateObjectDataTypes: {
          'http://example.org/title': 'text',
          'http://example.org/body': 'longText',
          'http://example.org/link': 'iri',
        },
      });
      await store.open();
    });

    it('should store text in object_key and longText in object_text', async () => {
      const body = 'long body '.repeat(80);

      await store.multiPut([
        quad(
          namedNode('http://example.org/doc/1'),
          namedNode('http://example.org/title'),
          literal('Short title'),
          namedNode('http://example.org/g1'),
        ),
        quad(
          namedNode('http://example.org/doc/1'),
          namedNode('http://example.org/body'),
          literal(body),
          namedNode('http://example.org/g1'),
        ),
      ]);

      const rows = (store as any).sqlite.prepare<{
        predicate: string;
        objectKind: string;
        objectKey: string | null;
        objectText: string | null;
        objectDigest: string | null;
      }>(`
        SELECT
          predicate,
          object_kind AS objectKind,
          object_key AS objectKey,
          object_text AS objectText,
          object_digest AS objectDigest
        FROM quints
        ORDER BY predicate
      `).all();

      const bodyRow = rows.find(row => row.predicate === 'http://example.org/body');
      const titleRow = rows.find(row => row.predicate === 'http://example.org/title');

      expect(bodyRow?.objectKind).toBe('longText');
      expect(bodyRow?.objectKey).toBeNull();
      expect(bodyRow?.objectText).toBe(body);
      expect(bodyRow?.objectDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(titleRow?.objectKind).toBe('text');
      expect(titleRow?.objectKey).toContain('Short title');
      expect(titleRow?.objectText).toBe('Short title');
      expect(titleRow?.objectDigest).toBeNull();
    });

    it('should query longText with DB-side contains and reject range/order semantics', async () => {
      const body = 'alpha '.repeat(40) + 'needle ' + 'omega '.repeat(40);
      await store.put(
        quad(
          namedNode('http://example.org/doc/contains'),
          namedNode('http://example.org/body'),
          literal(body),
          namedNode('http://example.org/g1'),
        ),
      );

      const containsResults = await store.get({
        predicate: namedNode('http://example.org/body'),
        object: { $contains: 'needle' },
      });

      expect(containsResults).toHaveLength(1);
      expect(containsResults[0].subject.value).toBe('http://example.org/doc/contains');

      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
        object: { $gt: literal('alpha') },
      })).rejects.toThrow(/not supported for longText/);

      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
      }, { order: ['object'] })).rejects.toThrow(/ORDER BY object is not supported for longText/);
    });

    it('should push string filters over longText object_text and keep exact matching distinct', async () => {
      const body = 'alpha ' + 'long body '.repeat(40) + 'needle omega';
      await store.multiPut([
        quad(
          namedNode('http://example.org/doc/long'),
          namedNode('http://example.org/body'),
          literal(body),
          namedNode('http://example.org/g1'),
        ),
        quad(
          namedNode('http://example.org/doc/other'),
          namedNode('http://example.org/body'),
          literal('alpha without the target suffix ' + 'other '.repeat(40)),
          namedNode('http://example.org/g1'),
        ),
        quad(
          namedNode('http://example.org/doc/title'),
          namedNode('http://example.org/title'),
          literal('short title needle'),
          namedNode('http://example.org/g1'),
        ),
        quad(
          namedNode('http://example.org/doc/link'),
          namedNode('http://example.org/link'),
          namedNode('http://example.org/resource/needle-link'),
          namedNode('http://example.org/g1'),
        ),
      ]);

      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
        object: { $strContains: 'needle' },
      })).resolves.toHaveLength(1);
      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
        object: { $strStartsWith: 'alpha' },
      })).resolves.toHaveLength(2);
      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
        object: { $strEndsWith: 'omega' },
      })).resolves.toHaveLength(1);
      await expect(store.get({
        predicate: namedNode('http://example.org/title'),
        object: { $strContains: 'needle' },
      })).resolves.toHaveLength(1);
      await expect(store.get({
        predicate: namedNode('http://example.org/link'),
        object: { $strEndsWith: '/needle-link' },
      })).resolves.toHaveLength(1);
      await expect(store.get({
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
      })).resolves.toHaveLength(1);
    });

    it('should use object_digest only for longText upsert identity', async () => {
      const body = 'digest body '.repeat(100);
      const q = quad(
        namedNode('http://example.org/doc/digest'),
        namedNode('http://example.org/body'),
        literal(body),
        namedNode('http://example.org/g1'),
      ) as Quint;
      q.vector = [0.1];

      const updated = quad(
        namedNode('http://example.org/doc/digest'),
        namedNode('http://example.org/body'),
        literal(body),
        namedNode('http://example.org/g1'),
      ) as Quint;
      updated.vector = [0.9];

      await store.put(q);
      await store.put(updated);

      const results = await store.get({
        subject: namedNode('http://example.org/doc/digest'),
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
      });

      expect(results).toHaveLength(1);
      expect(results[0].vector).toEqual([0.9]);

      const rows = (store as any).sqlite.prepare<{ objectKey: string | null; objectDigest: string | null }>(`
        SELECT object_key AS objectKey, object_digest AS objectDigest
        FROM quints
        WHERE subject = 'http://example.org/doc/digest'
      `).all();

      expect(rows).toHaveLength(1);
      expect(rows[0].objectKey).toBeNull();
      expect(rows[0].objectDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should reject values that violate a declared text predicate type', async () => {
      await expect(store.put(
        quad(
          namedNode('http://example.org/doc/too-long'),
          namedNode('http://example.org/title'),
          literal('this title is intentionally longer than the declared short text limit'),
          namedNode('http://example.org/g1'),
        ),
      )).rejects.toThrow(/declared as text/);
    });
  });

  describe('pagination', () => {
    beforeEach(async () => {
      const quads = [];
      for (let i = 0; i < 10; i++) {
        quads.push(
          quad(namedNode(`http://s${i}`), namedNode('http://p'), literal(`v${i}`), namedNode('http://g')),
        );
      }
      await store.multiPut(quads);
    });

    it('should limit results', async () => {
      const results = await store.get({}, { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('should offset results', async () => {
      const all = await store.get({});
      const offset = await store.get({}, { offset: 5 });
      expect(offset).toHaveLength(5);
    });

    it('should combine limit and offset', async () => {
      const results = await store.get({}, { limit: 3, offset: 2 });
      expect(results).toHaveLength(3);
    });
  });

  describe('fpstring numeric encoding', () => {
    it('should store numeric literals with fpstring encoding', async () => {
      // Insert numbers in random order
      const numbers = [100, -5, 0, 42, 3.14, -100, 1000];
      for (const num of numbers) {
        await store.put(
          quad(
            namedNode(`http://s${num}`),
            namedNode('http://p'),
            literal(String(num), namedNode('http://www.w3.org/2001/XMLSchema#integer')),
            namedNode('http://g'),
          ),
        );
      }

      // Verify all values are preserved correctly
      const results = await store.get({});
      const values = results.map(r => parseFloat(r.object.value)).sort((a, b) => a - b);
      expect(values).toEqual([-100, -5, 0, 3.14, 42, 100, 1000]);
    });

    it('should preserve numeric literal datatype', async () => {
      const q = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('3.14159', namedNode('http://www.w3.org/2001/XMLSchema#double')),
        namedNode('http://g'),
      );
      await store.put(q);

      const results = await store.get({});
      const obj = results[0].object as any;
      expect(obj.value).toBe('3.14159');
      expect(obj.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#double');
    });

    it('should store dateTime with fpstring encoding', async () => {
      const q = quad(
        namedNode('http://s'),
        namedNode('http://p'),
        literal('2024-01-15T10:30:00Z', namedNode('http://www.w3.org/2001/XMLSchema#dateTime')),
        namedNode('http://g'),
      );
      await store.put(q);

      const results = await store.get({});
      const obj = results[0].object as any;
      expect(obj.value).toBe('2024-01-15T10:30:00Z');
      expect(obj.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#dateTime');
    });
  });
});
