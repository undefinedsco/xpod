import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Quadstore } from 'quadstore';
import { DataFactory } from 'n3';
import { getBackend } from '../../src/libs/backends';

const { namedNode, literal, quad } = DataFactory;

describe('Quadstore + SQLUp Integration', () => {
  const testDir = path.join(__dirname, '../../data/test/quadstore_sqlup');
  const dbPath = path.join(testDir, 'test.sqlite');
  const endpoint = `sqlite:${dbPath}`;

  beforeEach(async () => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    // In a real scenario we might need to wait for connections to close
    // to delete files, but we clean up in beforeEach.
  });

  it('should store and retrieve quads', async () => {
    const backend = getBackend(endpoint, { tableName: 'quadstore_test_basic' });
    const store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });

    await store.open();

    const q = quad(
      namedNode('http://example.org/subject'),
      namedNode('http://example.org/predicate'),
      literal('object')
    );

    await store.put(q);

    const { items } = await store.get({});
    expect(items).toHaveLength(1);
    expect(items[0].subject.value).toBe('http://example.org/subject');
    expect(items[0].predicate.value).toBe('http://example.org/predicate');
    expect(items[0].object.value).toBe('object');

    await store.close();
  });

  it('should delete quads', async () => {
    const backend = getBackend(endpoint, { tableName: 'quadstore_test_delete' });
    const store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });

    await store.open();

    const q = quad(
      namedNode('http://example.org/s'),
      namedNode('http://example.org/p'),
      literal('o')
    );

    await store.put(q);
    let result = await store.get({});
    expect(result.items).toHaveLength(1);

    await store.del(q);
    result = await store.get({});
    expect(result.items).toHaveLength(0);

    await store.close();
  });

  it('should match quads', async () => {
     const backend = getBackend(endpoint, { tableName: 'quadstore_test_match' });
     const store = new Quadstore({
       backend,
       dataFactory: DataFactory,
     });
 
     await store.open();
 
     const q1 = quad(
       namedNode('http://example.org/s1'),
       namedNode('http://example.org/p'),
       literal('o1')
     );
     const q2 = quad(
       namedNode('http://example.org/s2'),
       namedNode('http://example.org/p'),
       literal('o2')
     );
 
     await store.put(q1);
     await store.put(q2);
 
     const { items } = await store.get({ subject: namedNode('http://example.org/s1') });
     expect(items).toHaveLength(1);
     expect(items[0].object.value).toBe('o1');
 
     await store.close();
   });

   it('should handle concurrent writes (simulated)', async () => {
    const backend1 = getBackend(endpoint, { tableName: 'quadstore_test_concurrent' });
    const store1 = new Quadstore({
      backend: backend1,
      dataFactory: DataFactory,
    });
    
    // Create a second store instance accessing the same table?
    // Quadstore might lock or SQLUp might handle it.
    // But SQLUp shares state by URL.
    
    // Let's use same backend instance for concurrency simulation via Promise.all
    // Actually, let's create two stores pointing to same DB but different instances.
    const backend2 = getBackend(endpoint, { tableName: 'quadstore_test_concurrent' });
    const store2 = new Quadstore({
        backend: backend2,
        dataFactory: DataFactory,
    });

    await store1.open();
    await store2.open();

    const q1 = quad(namedNode('http://ex/s1'), namedNode('http://ex/p'), literal('o1'));
    const q2 = quad(namedNode('http://ex/s2'), namedNode('http://ex/p'), literal('o2'));

    await Promise.all([
        store1.put(q1),
        store2.put(q2)
    ]);

    const { items } = await store1.get({});
    expect(items).toHaveLength(2);

    await store1.close();
    await store2.close();
   });
});
