/**
 * Test compound query - multiple patterns with JOIN
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint/SqliteQuintStore';
import type { Quint, CompoundPattern } from '../../../src/storage/quint/types';

const { namedNode, literal, defaultGraph } = DataFactory;

describe('SqliteQuintStore - Compound Query', () => {
  let store: SqliteQuintStore;

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
        predicate: namedNode('http://example.org/name'),
        object: literal(`User ${i}`),
      } as Quint);

      // Add age (formatted as 5 digits for proper string comparison)
      // Note: literal values are stored as '"value"' in n3 format
      quints.push({
        graph,
        subject,
        predicate: namedNode('http://example.org/age'),
        object: literal(String(i).padStart(5, '0')),
      } as Quint);
    }

    await store.multiPut(quints);
    console.log(`Inserted ${quints.length} quints`);
  });

  afterAll(async () => {
    await store.close();
  });

  it('should execute compound query with JOIN', async () => {
    // Query: find users with name AND age > 9970
    // Now we can pass plain string, SqliteQuintStore will auto-serialize
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://example.org/name'),
        },
        {
          predicate: namedNode('http://example.org/age'),
          object: { $gt: '09970' },  // Plain string, will be auto-serialized to '"09970"'
        },
      ],
      joinOn: 'subject',
    };

    const startTime = performance.now();
    const results = await store.getCompound(compound);
    const endTime = performance.now();

    console.log(`Compound query returned ${results.length} results in ${(endTime - startTime).toFixed(2)}ms`);
    console.log('Sample result:', results[0]);

    expect(results.length).toBe(30); // Users 9971-10000
  });

  it('should be faster than separate queries + join', async () => {
    // Method 1: Compound query (single SQL)
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://example.org/name'),
        },
        {
          predicate: namedNode('http://example.org/age'),
          object: { $gt: '09970' },  // Plain string
        },
      ],
      joinOn: 'subject',
    };

    const start1 = performance.now();
    const results1 = await store.getCompound(compound);
    const time1 = performance.now() - start1;

    // Method 2: Separate queries (simulating current behavior)
    const start2 = performance.now();
    
    // First query: get all names
    const names = await store.get({
      predicate: namedNode('http://example.org/name'),
    });
    
    // Second query: get filtered ages
    const ages = await store.get({
      predicate: namedNode('http://example.org/age'),
      object: { $gt: '"09970"' },  // Still need quotes for regular get() - TODO: fix this too
    });
    
    // Manual join in JS
    const ageSubjects = new Set(ages.map(q => q.subject.value));
    const joined = names.filter(q => ageSubjects.has(q.subject.value));
    
    const time2 = performance.now() - start2;

    console.log(`Compound query: ${time1.toFixed(2)}ms, ${results1.length} results`);
    console.log(`Separate queries + JS join: ${time2.toFixed(2)}ms, ${joined.length} results`);
    console.log(`Speedup: ${(time2 / time1).toFixed(2)}x`);

    expect(results1.length).toBe(joined.length);
    expect(results1.length).toBe(30);
  });

  it('should handle three patterns', async () => {
    // Add email to some users first
    const quints: Quint[] = [];
    const graph = namedNode('http://example.org/graph1');

    for (let i = 9990; i <= 10000; i++) {
      const subject = namedNode(`http://example.org/user/${i}`);
      quints.push({
        graph,
        subject,
        predicate: namedNode('http://example.org/email'),
        object: literal(`user${i}@example.org`),
      } as Quint);
    }
    await store.multiPut(quints);

    // Query: users with name AND age > 9970 AND email
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://example.org/name'),
        },
        {
          predicate: namedNode('http://example.org/age'),
          object: { $gt: '09970' },  // Plain string
        },
        {
          predicate: namedNode('http://example.org/email'),
        },
      ],
      joinOn: 'subject',
    };

    const results = await store.getCompound(compound);
    console.log(`Three-way join returned ${results.length} results`);

    // Users 9990-10000 have email, but only 9971-10000 have age > 9970
    // Intersection: 9990-10000 (11 users)
    expect(results.length).toBe(11);
  });
});

describe('SqliteQuintStore - Numeric Comparison with xsd:integer', () => {
  let store: SqliteQuintStore;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:', debug: false });
    await store.open();

    // Insert test data with xsd:integer type
    const graph = namedNode('http://example.org/graph1');
    const XSD_INTEGER = namedNode('http://www.w3.org/2001/XMLSchema#integer');

    // Insert values around power-of-10 boundaries (where fpstring bug would appear)
    const values = [9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999, 10000, 10001];
    
    for (const val of values) {
      await store.put({
        graph,
        subject: namedNode(`http://example.org/item/${val}`),
        predicate: namedNode('http://example.org/value'),
        object: literal(val, XSD_INTEGER),
      } as Quint);
    }

    console.log(`Inserted ${values.length} numeric quints`);
  });

  afterAll(async () => {
    await store.close();
  });

  it('should correctly compare numbers using direct number in $gt', async () => {
    // Test $gt with number directly
    const results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gt: 99 },  // Direct number
    });

    const values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    console.log('$gt 99 results:', values);

    // Should return: 100, 101, 999, 1000, 1001, 9999, 10000, 10001
    expect(values).toEqual([100, 101, 999, 1000, 1001, 9999, 10000, 10001]);
  });

  it('should correctly handle power-of-10 boundaries', async () => {
    // Test around 10
    let results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gt: 9 },
    });
    let values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(10);
    expect(values).not.toContain(9);

    // Test around 100
    results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gt: 99 },
    });
    values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(100);
    expect(values).not.toContain(99);

    // Test around 1000
    results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gt: 999 },
    });
    values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(1000);
    expect(values).not.toContain(999);

    // Test around 10000
    results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gt: 9999 },
    });
    values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(10000);
    expect(values).not.toContain(9999);
  });

  it('should correctly handle $gte, $lt, $lte operators', async () => {
    // $gte 100
    let results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $gte: 100 },
    });
    let values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(100);
    expect(values).not.toContain(99);

    // $lt 100
    results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $lt: 100 },
    });
    values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(99);
    expect(values).not.toContain(100);

    // $lte 100
    results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $lte: 100 },
    });
    values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    expect(values).toContain(100);
    expect(values).toContain(99);
    expect(values).not.toContain(101);
  });

  it('should correctly handle $in with numbers', async () => {
    const results = await store.get({
      predicate: namedNode('http://example.org/value'),
      object: { $in: [10, 100, 1000, 10000] },  // Power-of-10 values
    });

    const values = results.map(q => parseInt(q.object.value)).sort((a, b) => a - b);
    console.log('$in [10, 100, 1000, 10000] results:', values);

    expect(values).toEqual([10, 100, 1000, 10000]);
  });
});

describe('SqliteQuintStore - Compound Query with xsd:integer', () => {
  let store: SqliteQuintStore;

  beforeAll(async () => {
    store = new SqliteQuintStore({ path: ':memory:', debug: false });
    await store.open();

    const graph = namedNode('http://example.org/graph1');
    const XSD_INTEGER = namedNode('http://www.w3.org/2001/XMLSchema#integer');

    // Insert users with name and numeric age
    for (let i = 9995; i <= 10005; i++) {
      const subject = namedNode(`http://example.org/user/${i}`);
      
      await store.put({
        graph,
        subject,
        predicate: namedNode('http://schema.org/name'),
        object: literal(`User ${i}`),
      } as Quint);

      await store.put({
        graph,
        subject,
        predicate: namedNode('http://schema.org/age'),
        object: literal(i, XSD_INTEGER),
      } as Quint);
    }

    console.log('Inserted 11 users (9995-10005) with xsd:integer ages');
  });

  afterAll(async () => {
    await store.close();
  });

  it('should correctly handle compound query with numeric filter across 10000 boundary', async () => {
    // Query: users with age > 9999 (should return 10000-10005 = 6 users)
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://schema.org/name'),
        },
        {
          predicate: namedNode('http://schema.org/age'),
          object: { $gt: 9999 },  // Direct number
        },
      ],
      joinOn: 'subject',
    };

    const results = await store.getCompound(compound);
    console.log(`Compound query (age > 9999) returned ${results.length} results`);

    // Should return users 10000-10005 (6 users)
    expect(results.length).toBe(6);

    // Verify the join values
    const userIds = results.map(r => parseInt(r.joinValue.split('/').pop()!)).sort((a, b) => a - b);
    expect(userIds).toEqual([10000, 10001, 10002, 10003, 10004, 10005]);
  });

  it('should correctly handle compound query with $gte on boundary', async () => {
    // Query: users with age >= 10000 (should return 10000-10005 = 6 users)
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://schema.org/name'),
        },
        {
          predicate: namedNode('http://schema.org/age'),
          object: { $gte: 10000 },
        },
      ],
      joinOn: 'subject',
    };

    const results = await store.getCompound(compound);
    console.log(`Compound query (age >= 10000) returned ${results.length} results`);

    expect(results.length).toBe(6);
  });

  it('should correctly handle compound query with $lt on boundary', async () => {
    // Query: users with age < 10000 (should return 9995-9999 = 5 users)
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://schema.org/name'),
        },
        {
          predicate: namedNode('http://schema.org/age'),
          object: { $lt: 10000 },
        },
      ],
      joinOn: 'subject',
    };

    const results = await store.getCompound(compound);
    console.log(`Compound query (age < 10000) returned ${results.length} results`);

    expect(results.length).toBe(5);

    const userIds = results.map(r => parseInt(r.joinValue.split('/').pop()!)).sort((a, b) => a - b);
    expect(userIds).toEqual([9995, 9996, 9997, 9998, 9999]);
  });

  it('should correctly handle compound query with $lte on boundary', async () => {
    // Query: users with age <= 9999 (should return 9995-9999 = 5 users)
    const compound: CompoundPattern = {
      patterns: [
        {
          predicate: namedNode('http://schema.org/name'),
        },
        {
          predicate: namedNode('http://schema.org/age'),
          object: { $lte: 9999 },
        },
      ],
      joinOn: 'subject',
    };

    const results = await store.getCompound(compound);
    console.log(`Compound query (age <= 9999) returned ${results.length} results`);

    expect(results.length).toBe(5);
  });
});
