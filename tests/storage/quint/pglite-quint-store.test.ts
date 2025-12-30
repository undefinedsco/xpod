/**
 * PostgreSQL QuintStore Integration Tests (using PGLite)
 * 
 * Tests the PgQuintStore implementation with PGLite backend to verify:
 * 1. Basic CRUD operations work with PostgreSQL syntax
 * 2. Complex queries (getCompound, getAttributes) work correctly
 * 3. Behavior is consistent with SQLite implementation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DataFactory } from 'rdf-data-factory';
import { PgQuintStore } from '../../../src/storage/quint/PgQuintStore.js';
import type { Quint, Term } from '../../../src/storage/quint/types.js';

const DF = new DataFactory();

// Helper to create a named node
function namedNode(value: string): Term {
  return DF.namedNode(value);
}

// Helper to create a literal
function literal(value: string): Term {
  return DF.literal(value);
}

// Helper to create a blank node
function blankNode(value?: string): Term {
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
    it('should store and retrieve a quint', async () => {
      const quint: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
        version: 1
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
      const quints: Quint[] = [
        {
          subject: namedNode('http://example.org/s1'),
          predicate: namedNode('http://example.org/name'),
          object: literal('Alice'),
          graph: namedNode('http://example.org/g1'),
          version: 1
        },
        {
          subject: namedNode('http://example.org/s1'),
          predicate: namedNode('http://example.org/age'),
          object: literal('30'),
          graph: namedNode('http://example.org/g1'),
          version: 1
        },
        {
          subject: namedNode('http://example.org/s2'),
          predicate: namedNode('http://example.org/name'),
          object: literal('Bob'),
          graph: namedNode('http://example.org/g1'),
          version: 1
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
      const quint: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
        version: 1
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
      const quint1: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),
        graph: namedNode('http://example.org/g1'),
        version: 1,
        vector: [0.1, 0.2, 0.3]
      };

      const quint2: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value1'),  // Same object (UPSERT key includes object)
        graph: namedNode('http://example.org/g1'),
        version: 2,  // Higher version
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
  });

  describe('Query Operations', () => {
    beforeEach(async () => {
      // Setup test data
      const quints: Quint[] = [
        // Person 1: Alice
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/age'), object: literal('30'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/email'), object: literal('alice@example.org'), graph: namedNode('http://example.org/g1'), version: 1 },
        
        // Person 2: Bob
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/age'), object: literal('25'), graph: namedNode('http://example.org/g1'), version: 1 },
        // Bob has no email
        
        // Person 3: Charlie
        { subject: namedNode('http://example.org/person/3'), predicate: namedNode('http://example.org/name'), object: literal('Charlie'), graph: namedNode('http://example.org/g1'), version: 1 },
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
      const quints: Quint[] = [
        // Person 1
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/age'), object: literal('30'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/email'), object: literal('alice@example.org'), graph: namedNode('http://example.org/g1'), version: 1 },
        
        // Person 2
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/age'), object: literal('25'), graph: namedNode('http://example.org/g1'), version: 1 },
        
        // Person 3
        { subject: namedNode('http://example.org/person/3'), predicate: namedNode('http://example.org/name'), object: literal('Charlie'), graph: namedNode('http://example.org/g1'), version: 1 },
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
      const quints: Quint[] = [
        // Person 1 with type
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Person'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/1'), predicate: namedNode('http://example.org/name'), object: literal('Alice'), graph: namedNode('http://example.org/g1'), version: 1 },
        
        // Person 2 with type
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Person'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/person/2'), predicate: namedNode('http://example.org/name'), object: literal('Bob'), graph: namedNode('http://example.org/g1'), version: 1 },
        
        // Non-person entity
        { subject: namedNode('http://example.org/org/1'), predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: namedNode('http://example.org/Organization'), graph: namedNode('http://example.org/g1'), version: 1 },
        { subject: namedNode('http://example.org/org/1'), predicate: namedNode('http://example.org/name'), object: literal('Acme Corp'), graph: namedNode('http://example.org/g1'), version: 1 },
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
      const quint: Quint = {
        subject: namedNode('http://example.org/subject'),
        predicate: namedNode('http://example.org/predicate'),
        object: namedNode('http://example.org/object'),
        graph: namedNode('http://example.org/graph'),
        version: 1
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/subject') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('NamedNode');
      expect(results[0].object.value).toBe('http://example.org/object');
    });

    it('should handle literals with language tags', async () => {
      const quint: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/label'),
        object: DF.literal('Hello', 'en'),
        graph: namedNode('http://example.org/g1'),
        version: 1
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/s1') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('Literal');
      expect(results[0].object.value).toBe('Hello');
      expect((results[0].object as any).language).toBe('en');
    });

    it('should handle literals with datatypes', async () => {
      const quint: Quint = {
        subject: namedNode('http://example.org/s1'),
        predicate: namedNode('http://example.org/count'),
        object: DF.literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        graph: namedNode('http://example.org/g1'),
        version: 1
      };

      await store.put(quint);
      const results = await store.get({ subject: namedNode('http://example.org/s1') });

      expect(results.length).toBe(1);
      expect(results[0].object.termType).toBe('Literal');
      expect(results[0].object.value).toBe('42');
      expect((results[0].object as any).datatype.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
    });

    it('should handle blank nodes', async () => {
      const quint: Quint = {
        subject: blankNode('b1'),
        predicate: namedNode('http://example.org/p1'),
        object: literal('value'),
        graph: namedNode('http://example.org/g1'),
        version: 1
      };

      await store.put(quint);
      const results = await store.get({ predicate: namedNode('http://example.org/p1') });

      expect(results.length).toBe(1);
      expect(results[0].subject.termType).toBe('BlankNode');
    });
  });
});
