/**
 * PostgreSQL QuintStore Integration Tests (using PGLite)
 * 
 * Tests the PgQuintStore implementation with PGLite backend to verify:
 * 1. Basic CRUD operations work with PostgreSQL syntax
 * 2. Complex queries (getCompound, getAttributes) work correctly
 * 3. Behavior is consistent with SQLite implementation
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataFactory } from 'rdf-data-factory';
import { PgQuintStore } from '../../../src/storage/quint/PgQuintStore.js';
import { ComunicaQuintEngine } from '../../../src/storage/sparql/ComunicaQuintEngine.js';
import type { Quint } from '../../../src/storage/quint/types.js';
import { arrayFromStream } from '../../helpers/arrayFromStream.js';

const DF = new DataFactory();

// Helper to create a named node
function namedNode(value: string): any {
  return DF.namedNode(value);
}

// Helper to create a literal
function literal(value: string): any {
  return DF.literal(value);
}

// Helper to create a blank node
function blankNode(value?: string): any {
  return DF.blankNode(value);
}

describe('PgQuintStore (PGLite backend)', () => {
  let store: PgQuintStore;

  beforeAll(async () => {
    // Use PGLite (in-memory) for testing PostgreSQL implementation
    store = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined  // undefined = in-memory
    });
    await store.open();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    // Clear all data before each test
    await store.clear();
  });

  describe('Basic Operations', () => {
    it('should not expose the store as open until schema initialization is complete', async () => {
      const concurrentStore = new PgQuintStore({
        driver: 'pglite',
        dataDir: undefined,
      });

      try {
        await Promise.all([
          concurrentStore.open(),
          concurrentStore.open(),
          concurrentStore.open(),
        ]);

        await expect(concurrentStore.get({})).resolves.toEqual([]);
        const rows = await (concurrentStore as any).executor.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = 'quints'
          ) as exists
        `);
        expect(rows[0].exists).toBe(true);
      } finally {
        await concurrentStore.close();
      }
    });

    it('should store and retrieve a quint', async () => {
      const quint: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
      };

      await store.put(quint);
      
      const results = await store.get({
        subject: namedNode('http://example.org/s1')
      });

      expect(results.length).toBe(1);
      expect(results[0].subject.value).toBe('http://example.org/s1');
      expect(results[0].predicate.value).toBe('http://example.org/p1');
      expect(results[0].object.value).toBe('value1');
    });

    it('should handle multiPut correctly', async () => {
      const quints: any[] = [
        {
          subject: namedNode('http://example.org/s1'),
          predicate: namedNode('http://example.org/name'),
          object: literal('Alice'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/s1'),
          predicate: namedNode('http://example.org/age'),
          object: literal('30'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/s2'),
          predicate: namedNode('http://example.org/name'),
          object: literal('Bob'),
          graph: namedNode('http://example.org/g1'),
        }
      ];

      await store.multiPut(quints);

      const allResults = await store.get({});
      expect(allResults.length).toBe(3);

      const s1Results = await store.get({
        subject: namedNode('http://example.org/s1')
      });
      expect(s1Results.length).toBe(2);
    });

    it('should delete quints correctly', async () => {
      const quint: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
      };

      await store.put(quint);
      
      let results = await store.get({ subject: namedNode('http://example.org/s1') });
      expect(results.length).toBe(1);

      await store.del({
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1')
      });

      results = await store.get({ subject: namedNode('http://example.org/s1') });
      expect(results.length).toBe(0);
    });

    it('should update existing quint with put (upsert)', async () => {
      const quint1: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
        vector: [0.1, 0.2, 0.3]
      };

      const quint2: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),  // Same object (UPSERT key includes object)
        graph: namedNode('http://example.org/g1'),
        vector: [0.4, 0.5, 0.6]  // Different vector
      };

      await store.put(quint1);
      await store.put(quint2);

      const results = await store.get({
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1')
      });

      // Should have updated, not inserted (same GSPO key)
      expect(results.length).toBe(1);
      expect(results[0].object.value).toBe('value1');
      // Vector should be updated to the new value
      expect(results[0].vector).toEqual([0.4, 0.5, 0.6]);
    });

    it('should store long literal objects without indexing the raw GSPO tuple', async () => {
      const longLiteral = 'audit-context:'.repeat(500);
      const quint: any = {
        subject: namedNode('http://example.org/audit/entry'),
        predicate: namedNode('http://example.org/context'),
        object: literal(longLiteral),
        graph: namedNode('http://example.org/.data/audits/2026/05/07.ttl'),
      };

      await store.put(quint);
      await store.put(quint);

      const results = await store.get({
        graph: namedNode('http://example.org/.data/audits/2026/05/07.ttl'),
        subject: namedNode('http://example.org/audit/entry'),
        predicate: namedNode('http://example.org/context'),
        object: literal(longLiteral),
      });

      expect(results).toHaveLength(1);
      expect(results[0].object.value).toBe(longLiteral);
    });
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Setup test data
      const quints: any[] = [
        // Person 1: Alice
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/age'), object: literal('30'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/email'), object: literal('alice@example.org'), graph: namedNode('http://example.org/g1') },
        
        // Person 2: Bob
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/age'), object: literal('25'), graph: namedNode('http://example.org/g1') },
        // Bob has no email
        
        // Person 3: Charlie
        { subject: namedNode('http://example.org/person/3'), predicate: namedNode('http://example.org/name'), object: literal('Charlie'), graph: namedNode('http://example.org/g1') },
        // Charlie has no age or email
      ];

      await store.multiPut(quints);
    });

    it('should query by predicate', async () => {
      const results = await store.get({
        predicate: namedNode('http://example.org/name')
      });

      expect(results.length).toBe(3);
      const names = results.map(r => r.object.value).sort();
      expect(names).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('should query with multiple conditions', async () => {
      const results = await store.get({
        subject: namedNode('http://example.org/person/1'),
        predicate: namedNode('http://example.org/name')
      });

      expect(results.length).toBe(1);
      expect(results[0].object.value).toBe('Alice');
    });
  });

  describe('getAttributes (Batch Query)', () => {
    beforeEach(async () => {
      const quints: any[] = [
        // Person 1
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/age'), object: literal('30'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/email'), object: literal('alice@example.org'), graph: namedNode('http://example.org/g1') },
        
        // Person 2
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/age'), object: literal('25'), graph: namedNode('http://example.org/g1') },
        
        // Person 3
        { subject: namedNode('http://example.org/person/3'), predicate: namedNode('http://example.org/name'), object: literal('Charlie'), graph: namedNode('http://example.org/g1') },
      ];

      await store.multiPut(quints);
    });

    it('should batch fetch attributes for multiple subjects', async () => {
      const subjects = [
        'http://example.org/person/1',
        'http://example.org/person/2',
        'http://example.org/person/3'
      ];
      const predicates = [
        'http://example.org/name',
        'http://example.org/age',
        'http://example.org/email'
      ];

      const attrMap = await store.getAttributes(subjects, predicates, namedNode('http://example.org/g1'));

      // Check person 1 - has all attributes
      const person1Attrs = attrMap.get('http://example.org/person/1');
      expect(person1Attrs).toBeDefined();
      expect(person1Attrs!.get('http://example.org/name')?.[0]?.value).toBe('Alice');
      expect(person1Attrs!.get('http://example.org/age')?.[0]?.value).toBe('30');
      expect(person1Attrs!.get('http://example.org/email')?.[0]?.value).toBe('alice@example.org');

      // Check person 2 - missing email
      const person2Attrs = attrMap.get('http://example.org/person/2');
      expect(person2Attrs).toBeDefined();
      expect(person2Attrs!.get('http://example.org/name')?.[0]?.value).toBe('Bob');
      expect(person2Attrs!.get('http://example.org/age')?.[0]?.value).toBe('25');
      expect(person2Attrs!.get('http://example.org/email')).toBeUndefined();

      // Check person 3 - only has name
      const person3Attrs = attrMap.get('http://example.org/person/3');
      expect(person3Attrs).toBeDefined();
      expect(person3Attrs!.get('http://example.org/name')?.[0]?.value).toBe('Charlie');
      expect(person3Attrs!.get('http://example.org/age')).toBeUndefined();
      expect(person3Attrs!.get('http://example.org/email')).toBeUndefined();
    });

    it('should handle empty subjects array', async () => {
      const attrMap = await store.getAttributes([], ['http://example.org/name']);
      expect(attrMap.size).toBe(0);
    });

    it('should handle empty predicates array', async () => {
      const attrMap = await store.getAttributes(['http://example.org/person/1'], []);
      expect(attrMap.size).toBe(0);
    });
  });

  describe('getCompound (Complex Query)', () => {
    beforeEach(async () => {
      const quints: any[] = [
        // Person 1 with type
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Person'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1') },
        
        // Person 2 with type
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Person'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1') },
        
        // Non-person entity
        { subject: namedNode('http://example.org/org/1'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Organization'), graph: namedNode('http://example.org/g1') },
        { subject: namedNode('http://example.org/org/1'), predicate: namedNode('http://example.org/name'), object: literal('Acme Corp'), graph: namedNode('http://example.org/g1') },
      ];

      await store.multiPut(quints);
    });

    it('should execute compound query with type filter', async () => {
      const results = await store.getCompound!({
        patterns: [
          // Pattern 0: type = Person
          {
            predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
            object: namedNode('http://example.org/Person'),
            graph: namedNode('http://example.org/g1')
          },
          // Pattern 1: name predicate
          {
            predicate: namedNode('http://example.org/name'),
            graph: namedNode('http://example.org/g1')
          }
        ],
        joinOn: 'subject',
        select: [
          { pattern: 1, field: 'object', alias: 'name' }
        ]
      });

      expect(results.length).toBe(2);
      
      const names = results.map(r => r.bindings['name']).sort();
      // Note: bindings contain serialized values, need to handle accordingly
      expect(names.some(n => n.includes('Alice'))).toBe(true);
      expect(names.some(n => n.includes('Bob'))).toBe(true);
    });
  });

  describe('Term Serialization', () => {
    it('should handle named nodes correctly', async () => {
      const quint: any = {
        subject: namedNode('http://example.org/subject'),
        predicate: namedNode('http://example.org/predicate'),
        object: namedNode('http://example.org/object'),
        graph: namedNode('http://example.org/graph'),
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/subject') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('NamedNode');
      expect(results[0].object.value).toBe('http://example.org/object');
    });

    it('should handle literals with language tags', async () => {
      const quint: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/label'),
        object: DF.literal('Hello', 'en'),
        graph: namedNode('http://example.org/g1'),
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/s1') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('Literal');
      expect(results[0].object.value).toBe('Hello');
      expect((results[0].object as any).language).toBe('en');
    });

    it('should handle literals with datatypes', async () => {
      const quint: any = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/count'),
        object: DF.literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        graph: namedNode('http://example.org/g1'),
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/s1') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('Literal');
      expect(results[0].object.value).toBe('42');
      expect((results[0].object as any).datatype.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
    });

    it('should handle blank nodes', async () => {
      const quint: any = {
        subject: blankNode('b1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value'),
        graph: namedNode('http://example.org/g1'),
      };

      await store.put(quint);
      const results = await store.get({ predicate: namedNode('http://example.org/p1') });

      expect(results.length).toBe(1);
      expect(results[0].subject.termType).toBe('BlankNode');
    });
  });
});

describe('PgQuintStore schema migration', () => {
  it('should replace legacy raw GSPO indexes before accepting long literals', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-quints-'));
    const legacy = new PGlite(dataDir);
    await legacy.waitReady;

    await legacy.exec(`
      CREATE TABLE quints (
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT,
        PRIMARY KEY (graph, subject, predicate, object)
      );

      CREATE INDEX idx_gspo ON quints (graph, subject, predicate, object);
    `);
    await legacy.close();

    const store = new PgQuintStore({
      driver: 'pglite',
      dataDir,
    });

    try {
      await store.open();

      const indexes = await (store as any).executor.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'quints'
      `);
      const indexNames = indexes.map((row) => row.indexname);

      expect(indexNames).not.toContain('quints_pkey');
      expect(indexNames).not.toContain('idx_gspo');
      expect(indexNames).not.toContain('idx_quints_predicate_object_text');
      expect(indexNames).not.toContain('idx_quints_quint_hash');
      expect(indexNames).toContain('idx_quints_predicate_object_key');
      expect(indexNames).toContain('idx_quints_predicate_object_digest');
      expect(indexNames).toContain('idx_quints_gspo_digest');

      const longLiteral = 'migrated-audit-context:'.repeat(500);
      const quint: any = {
        subject: namedNode('http://example.org/audit/migrated-entry'),
        predicate: namedNode('http://example.org/context'),
        object: literal(longLiteral),
        graph: namedNode('http://example.org/.data/audits/2026/05/07.ttl'),
      };

      await store.put(quint);

      const results = await store.get({
        subject: namedNode('http://example.org/audit/migrated-entry'),
        predicate: namedNode('http://example.org/context'),
        object: literal(longLiteral),
      });

      expect(results).toHaveLength(1);
      expect(results[0].object.value).toBe(longLiteral);
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('should drop legacy hash indexes and avoid recreating hash storage paths', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-pg-quints-hash-'));
    const legacy = new PGlite(dataDir);
    await legacy.waitReady;

    await legacy.exec(`
      CREATE TABLE quints (
        quint_hash TEXT,
        graph_hash TEXT,
        subject_hash TEXT,
        predicate_hash TEXT,
        object_hash TEXT,
        object_kind TEXT,
        object_key TEXT,
        object_text TEXT,
        graph TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        vector TEXT
      );

      CREATE UNIQUE INDEX idx_quints_quint_hash ON quints (quint_hash);
      CREATE INDEX idx_quints_graph_hash ON quints (graph_hash);
      CREATE INDEX idx_quints_gsp_hash ON quints (graph_hash, subject_hash, predicate_hash);
    `);
    await legacy.close();

    const store = new PgQuintStore({
      driver: 'pglite',
      dataDir,
    });

    try {
      await store.open();

      const indexes = await (store as any).executor.query<{ indexname: string }>(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'quints'
      `);
      const indexNames = indexes.map((row) => row.indexname);

      expect(indexNames).not.toContain('idx_quints_quint_hash');
      expect(indexNames).not.toContain('idx_quints_graph_hash');
      expect(indexNames).not.toContain('idx_quints_gsp_hash');
      expect(indexNames).toContain('idx_quints_gsp');
      expect(indexNames).toContain('idx_quints_predicate_object_key');
      expect(indexNames).toContain('idx_quints_predicate_object_digest');

      const columns = await (store as any).executor.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'quints'
      `);
      const columnNames = columns.map((row) => row.column_name);

      expect(columnNames).not.toContain('quint_hash');
      expect(columnNames).not.toContain('graph_hash');
      expect(columnNames).not.toContain('subject_hash');
      expect(columnNames).not.toContain('predicate_hash');
      expect(columnNames).not.toContain('object_hash');
      expect(columnNames).toContain('object_digest');
    } finally {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('PgQuintStore object data types', () => {
  it('should support text exact, prefix, range, and ordering through object_key', async () => {
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/title': 'text',
      },
    });

    try {
      await typedStore.open();
      await typedStore.multiPut([
        {
          subject: namedNode('http://example.org/doc/a'),
          predicate: namedNode('http://example.org/title'),
          object: literal('Alpha'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/b'),
          predicate: namedNode('http://example.org/title'),
          object: literal('Beta'),
          graph: namedNode('http://example.org/g1'),
        },
      ] as any[]);

      const exactResults = await typedStore.get({
        predicate: namedNode('http://example.org/title'),
        object: literal('Alpha'),
      });
      expect(exactResults.map((row) => row.subject.value)).toEqual(['http://example.org/doc/a']);

      const prefixResults = await typedStore.get({
        predicate: namedNode('http://example.org/title'),
        object: { $startsWith: '"A' },
      });
      expect(prefixResults.map((row) => row.subject.value)).toEqual(['http://example.org/doc/a']);

      const rangeResults = await typedStore.get({
        predicate: namedNode('http://example.org/title'),
        object: { $gt: literal('Alpha') },
      });
      expect(rangeResults.map((row) => row.subject.value)).toEqual(['http://example.org/doc/b']);

      const orderedResults = await typedStore.get({
        predicate: namedNode('http://example.org/title'),
      }, { order: ['object'] });
      expect(orderedResults.map((row) => row.object.value)).toEqual(['Alpha', 'Beta']);
    } finally {
      await typedStore.close();
    }
  });

  it('should store text in object_key and longText in object_text', async () => {
    const body = 'long body '.repeat(80);
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/title': 'text',
        'http://example.org/body': 'longText',
      },
    });

    try {
      await typedStore.open();
      await typedStore.multiPut([
        {
          subject: namedNode('http://example.org/doc/1'),
          predicate: namedNode('http://example.org/title'),
          object: literal('Short title'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/1'),
          predicate: namedNode('http://example.org/body'),
          object: literal(body),
          graph: namedNode('http://example.org/g1'),
        },
      ] as any[]);

      const rows = await (typedStore as any).executor.query<{
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

      expect(bodyRow?.objectKind).toBe('longText');
      expect(bodyRow?.objectKey).toBeNull();
      expect(bodyRow?.objectText).toBe(body);
      expect(bodyRow?.objectDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(titleRow?.objectKind).toBe('text');
      expect(titleRow?.objectKey).toContain('Short title');
      expect(titleRow?.objectText).toBe('Short title');
      expect(titleRow?.objectDigest).toBeNull();
    } finally {
      await typedStore.close();
    }
  });

  it('should query longText with DB-side contains and reject range/order semantics', async () => {
    const body = 'alpha '.repeat(40) + 'needle ' + 'omega '.repeat(40);
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/body': 'longText',
      },
    });

    try {
      await typedStore.open();
      await typedStore.put({
        subject: namedNode('http://example.org/doc/contains'),
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
        graph: namedNode('http://example.org/g1'),
      } as any);

      const containsResults = await typedStore.get({
        predicate: namedNode('http://example.org/body'),
        object: { $contains: 'needle' },
      });

      expect(containsResults).toHaveLength(1);
      expect(containsResults[0].subject.value).toBe('http://example.org/doc/contains');

      await expect(typedStore.get({
        predicate: namedNode('http://example.org/body'),
        object: { $gt: literal('alpha') },
      })).rejects.toThrow(/not supported for longText/);

      await expect(typedStore.get({
        predicate: namedNode('http://example.org/body'),
      }, { order: ['object'] })).rejects.toThrow(/ORDER BY object is not supported for longText/);
    } finally {
      await typedStore.close();
    }
  });

  it('should push down SPARQL string filters over longText object_text', async () => {
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/body': 'longText',
        'http://example.org/title': 'text',
        'http://example.org/link': 'iri',
      },
    });
    const engine = new ComunicaQuintEngine(typedStore as any, { debug: true });
    const body = 'alpha ' + 'long body '.repeat(40) + 'needle ' + 'omega';

    try {
      await typedStore.open();
      await typedStore.multiPut([
        {
          subject: namedNode('http://example.org/doc/long'),
          predicate: namedNode('http://example.org/body'),
          object: literal(body),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/other'),
          predicate: namedNode('http://example.org/body'),
          object: literal('alpha without the target suffix ' + 'other '.repeat(40)),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/title'),
          predicate: namedNode('http://example.org/title'),
          object: literal('short title needle'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/link'),
          predicate: namedNode('http://example.org/link'),
          object: namedNode('http://example.org/resource/needle-link'),
          graph: namedNode('http://example.org/g1'),
        },
      ] as any[]);

      const subjectsFor = async (filter: string): Promise<string[]> => {
        const stream = await engine.queryBindings(`
          SELECT ?subject WHERE {
            GRAPH <http://example.org/g1> {
              ?subject <http://example.org/body> ?body .
              FILTER(${filter})
            }
          }
        `);
        const bindings = await arrayFromStream(stream);
        return bindings.map(binding => binding.get('subject')?.value).sort();
      };

      await expect(subjectsFor('CONTAINS(STR(?body), "needle")')).resolves.toEqual([
        'http://example.org/doc/long',
      ]);
      await expect(subjectsFor('STRSTARTS(STR(?body), "alpha")')).resolves.toEqual([
        'http://example.org/doc/long',
        'http://example.org/doc/other',
      ]);
      await expect(subjectsFor('STRENDS(STR(?body), "omega")')).resolves.toEqual([
        'http://example.org/doc/long',
      ]);
      await expect(subjectsFor('REGEX(STR(?body), "needle\\\\s+omega$")')).resolves.toEqual([
        'http://example.org/doc/long',
      ]);

      const titleStream = await engine.queryBindings(`
        SELECT ?subject WHERE {
          GRAPH <http://example.org/g1> {
            ?subject <http://example.org/title> ?title .
            FILTER(CONTAINS(STR(?title), "needle"))
          }
        }
      `);
      const titleBindings = await arrayFromStream(titleStream);
      expect(titleBindings.map(binding => binding.get('subject')?.value)).toEqual([
        'http://example.org/doc/title',
      ]);

      const iriStream = await engine.queryBindings(`
        SELECT ?subject WHERE {
          GRAPH <http://example.org/g1> {
            ?subject <http://example.org/link> ?link .
            FILTER(STRENDS(STR(?link), "/needle-link"))
          }
        }
      `);
      const iriBindings = await arrayFromStream(iriStream);
      expect(iriBindings.map(binding => binding.get('subject')?.value)).toEqual([
        'http://example.org/doc/link',
      ]);
    } finally {
      await typedStore.close();
    }
  });

  it('should keep SPARQL exact object matching distinct from lexical filters', async () => {
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/body': 'longText',
        'http://example.org/title': 'text',
        'http://example.org/link': 'iri',
      },
    });
    const engine = new ComunicaQuintEngine(typedStore as any, { debug: true });
    const body = 'alpha ' + 'exact long body '.repeat(40) + 'omega';

    try {
      await typedStore.open();
      await typedStore.multiPut([
        {
          subject: namedNode('http://example.org/doc/long-exact'),
          predicate: namedNode('http://example.org/body'),
          object: literal(body),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/title-exact'),
          predicate: namedNode('http://example.org/title'),
          object: literal('Exact short title'),
          graph: namedNode('http://example.org/g1'),
        },
        {
          subject: namedNode('http://example.org/doc/link-exact'),
          predicate: namedNode('http://example.org/link'),
          object: namedNode('http://example.org/resource/exact-link'),
          graph: namedNode('http://example.org/g1'),
        },
      ] as any[]);

      const subjectsFor = async (predicate: string, filter: string): Promise<string[]> => {
        const stream = await engine.queryBindings(`
          SELECT ?subject WHERE {
            GRAPH <http://example.org/g1> {
              ?subject <${predicate}> ?object .
              FILTER(?object = ${filter})
            }
          }
        `);
        const bindings = await arrayFromStream(stream);
        return bindings.map(binding => binding.get('subject')?.value).sort();
      };

      await expect(subjectsFor('http://example.org/body', JSON.stringify(body))).resolves.toEqual([
        'http://example.org/doc/long-exact',
      ]);
      await expect(subjectsFor('http://example.org/title', '"Exact short title"')).resolves.toEqual([
        'http://example.org/doc/title-exact',
      ]);
      await expect(subjectsFor('http://example.org/link', '<http://example.org/resource/exact-link>')).resolves.toEqual([
        'http://example.org/doc/link-exact',
      ]);
    } finally {
      await typedStore.close();
    }
  });

  it('should use object_digest only for longText upsert identity', async () => {
    const body = 'digest body '.repeat(100);
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 64,
      predicateObjectDataTypes: {
        'http://example.org/body': 'longText',
      },
    });

    try {
      await typedStore.open();
      await typedStore.put({
        subject: namedNode('http://example.org/doc/digest'),
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
        graph: namedNode('http://example.org/g1'),
        vector: [0.1],
      } as any);
      await typedStore.put({
        subject: namedNode('http://example.org/doc/digest'),
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
        graph: namedNode('http://example.org/g1'),
        vector: [0.9],
      } as any);

      const results = await typedStore.get({
        subject: namedNode('http://example.org/doc/digest'),
        predicate: namedNode('http://example.org/body'),
        object: literal(body),
      });

      expect(results).toHaveLength(1);
      expect(results[0].vector).toEqual([0.9]);

      const rows = await (typedStore as any).executor.query<{
        objectKey: string | null;
        objectDigest: string | null;
      }>(`
        SELECT object_key as "objectKey", object_digest as "objectDigest"
        FROM quints
        WHERE subject = 'http://example.org/doc/digest'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0].objectKey).toBeNull();
      expect(rows[0].objectDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await typedStore.close();
    }
  });

  it('should reject values that violate a declared text predicate type', async () => {
    const typedStore = new PgQuintStore({
      driver: 'pglite',
      dataDir: undefined,
      textMaxBytes: 32,
      predicateObjectDataTypes: {
        'http://example.org/title': 'text',
      },
    });

    try {
      await typedStore.open();
      await expect(typedStore.put({
        subject: namedNode('http://example.org/doc/too-long'),
        predicate: namedNode('http://example.org/title'),
        object: literal('this title is intentionally longer than the declared short text limit'),
        graph: namedNode('http://example.org/g1'),
      } as any)).rejects.toThrow(/declared as text/);
    } finally {
      await typedStore.close();
    }
  });
});
