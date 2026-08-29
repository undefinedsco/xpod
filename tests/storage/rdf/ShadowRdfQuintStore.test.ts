import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import {
  RdfQuadIndex,
  ShadowRdfQuintStore,
  SolidRdfEngine,
  runRdfModelsBenchmark,
} from '../../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;

describe('ShadowRdfQuintStore', () => {
  let compatibilityStore: SqliteQuintStore;
  let index: RdfQuadIndex;
  let store: ShadowRdfQuintStore;

  beforeEach(async () => {
    compatibilityStore = new SqliteQuintStore({ path: ':memory:' });
    await compatibilityStore.open();
    index = new RdfQuadIndex({ path: ':memory:' });
    store = new ShadowRdfQuintStore({
      compatibilityStore,
      index,
    });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
  });

  it('mirrors writes into the term-id RDF index while keeping reads on the compatibility store', async () => {
    const q = quad(
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
      namedNode('https://undefineds.co/ns#status'),
      literal('active'),
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
    );

    await store.put(q);

    await expect(store.get({ predicate: namedNode('https://undefineds.co/ns#status') }))
      .resolves.toHaveLength(1);
    expect(index.scan({ predicate: namedNode('https://undefineds.co/ns#status') }).quads)
      .toHaveLength(1);
  });

  it('runs a shadow compare against the mirrored RDF index', async () => {
    const q = quad(
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
      namedNode('https://undefineds.co/ns#status'),
      literal('active'),
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
    );

    await store.put(q);

    const result = await store.shadowGet({
      predicate: namedNode('https://undefineds.co/ns#status'),
    });

    expect(result.matched).toBe(true);
    expect(result.orderedMatch).toBe(true);
    expect(result.diff).toEqual({
      missingFromPrimary: [],
      extraInPrimary: [],
    });
  });

  it('replaces a source in both compatibility rows and the term-id source index', async () => {
    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const source = {
        source: graph,
      workspace: 'https://pod.example/alice/.data/chat/default/',
      localPath: '.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };

    await store.replaceSource([
      quad(namedNode(`${graph}#msg_1`), namedNode('http://rdfs.org/sioc/ns#content'), literal('stale'), namedNode(graph)),
      quad(namedNode(`${graph}#msg_2`), namedNode('http://rdfs.org/sioc/ns#content'), literal('kept'), namedNode(graph)),
    ], source);
    await store.replaceSource([
      quad(namedNode(`${graph}#msg_2`), namedNode('http://rdfs.org/sioc/ns#content'), literal('fresh'), namedNode(graph)),
    ], { ...source, sourceVersion: 'v2' });

    await expect(store.get({ graph: namedNode(graph) })).resolves.toMatchObject([
      { object: { value: 'fresh' } },
    ]);
    expect(index.scan({ graph: namedNode(graph) }).quads.map((q) => q.object.value)).toEqual(['fresh']);
    expect(index.stats()).toMatchObject({
      quadCount: 1,
      sourceCount: 1,
    });

    const shadow = await store.shadowGet({ graph: namedNode(graph) });
    expect(shadow.matched).toBe(true);
  });

  it('backfills the term-id shadow index from existing compatibility-store rows', async () => {
    await compatibilityStore.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://undefineds.co/ns#status'),
        literal('active'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        namedNode('https://undefineds.co/ns#status'),
        literal('open'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode('https://undefineds.co/ns#status'),
        literal('queued'),
        namedNode('https://pod.example/alice/.data/task/index.ttl'),
      ),
    ]);

    expect(index.stats().quadCount).toBe(0);

    const result = await store.backfillShadowIndex({
      clear: true,
      batchSize: 2,
    });

    expect(result).toMatchObject({
      scannedRows: 3,
      indexedRows: 3,
      batchCount: 2,
    });
    expect(index.stats().quadCount).toBe(3);

    const shadow = await store.shadowGet({
      graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
    }, { order: ['subject'] });
    expect(shadow.matched).toBe(true);
    expect(shadow.orderedMatch).toBe(true);
    expect(shadow.primary.map((q) => q.object.value)).toEqual(['active', 'open']);
  });

  it('can auto-backfill once when opened so durable query paths see existing rows', async () => {
    await store.close();

    await compatibilityStore.open();
    await compatibilityStore.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://undefineds.co/ns#status'),
        literal('active'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/index.ttl#task_1'),
        namedNode('https://undefineds.co/ns#status'),
        literal('queued'),
        namedNode('https://pod.example/alice/.data/task/index.ttl'),
      ),
    ]);

    index = new RdfQuadIndex({ path: ':memory:' });
    store = new ShadowRdfQuintStore({
      compatibilityStore,
      index,
      autoBackfill: {
        clear: true,
        batchSize: 1,
      },
    });

    await store.open();
    expect(index.stats().quadCount).toBe(2);

    await store.open();
    expect(index.stats().quadCount).toBe(2);

    await store.put(quad(
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
      namedNode('https://undefineds.co/ns#status'),
      literal('open'),
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
    ));
    expect(index.stats().quadCount).toBe(3);
  });

  it('shares concurrent open work across compatibility store, index open, and backfill', async () => {
    await store.close();

    await compatibilityStore.open();
    await compatibilityStore.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        namedNode('https://undefineds.co/ns#status'),
        literal('active'),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      ),
    ]);

    index = new RdfQuadIndex({ path: ':memory:' });
    store = new ShadowRdfQuintStore({
      compatibilityStore,
      index,
      autoBackfill: {
        clear: true,
        batchSize: 1,
      },
    });

    await Promise.all([store.open(), store.open(), store.open()]);

    expect(index.stats().quadCount).toBe(1);
    await expect(store.get({
      predicate: namedNode('https://undefineds.co/ns#status'),
    })).resolves.toHaveLength(1);
  });

  it.each([false, true])('does not auto-backfill a previously used primary index (empty=%s)', async (empty) => {
    const graph = namedNode('https://pod.example/alice/data.ttl');
    const oldQuad = quad(graph, namedNode('https://schema.org/name'), literal('old'), graph);
    const newQuad = quad(graph, namedNode('https://schema.org/name'), literal('new'), graph);
    await compatibilityStore.put(oldQuad);
    index.put(newQuad);
    if (empty) index.delete({});
    const reader = vi.spyOn(compatibilityStore, 'get');
    store = new ShadowRdfQuintStore({ compatibilityStore, index, autoBackfill: { clear: true } });

    await store.open();

    expect(reader).not.toHaveBeenCalled();
    expect(index.scan({}).quads.map((entry) => entry.object.value)).toEqual(empty ? [] : ['new']);
  });

  it('does not expose a half-loaded index to a concurrent opener', async () => {
    const graph = namedNode('https://pod.example/alice/.acr');
    await compatibilityStore.put(quad(graph, namedNode('https://schema.org/name'), literal('owner policy'), graph));
    const get = compatibilityStore.get.bind(compatibilityStore);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(compatibilityStore, 'get').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return get(...args);
    });
    store = new ShadowRdfQuintStore({ compatibilityStore, index, autoBackfill: true });
    const first = store.open();
    await started;
    let secondReady = false;
    const second = store.open().then(() => { secondReady = true; });
    await Promise.resolve();
    try {
      expect(secondReady).toBe(false);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(index.scan({}).quads).toHaveLength(1);
  });

  it('resumes an interrupted automatic backfill instead of accepting a partial primary index', async () => {
    const graph = namedNode('https://pod.example/alice/.acr');
    await compatibilityStore.multiPut(['first', 'second'].map((id) =>
      quad(namedNode(`${graph.value}#${id}`), namedNode('https://schema.org/name'), literal(id), graph)));
    const get = compatibilityStore.get.bind(compatibilityStore);
    vi.spyOn(compatibilityStore, 'get')
      .mockImplementationOnce(get)
      .mockRejectedValueOnce(new Error('temporary legacy read failure'));
    store = new ShadowRdfQuintStore({ compatibilityStore, index, autoBackfill: { batchSize: 1 } });
    await expect(store.open()).rejects.toThrow('temporary legacy read failure');
    expect(index.scan({}).quads).toHaveLength(1);

    // A new owner must see the persisted pending state, not just an in-memory flag.
    store = new ShadowRdfQuintStore({ compatibilityStore, index, autoBackfill: { batchSize: 1 } });
    await store.open();
    expect(index.scan({}).quads).toHaveLength(2);
  });

  it('keeps a runnable benchmark baseline report available from the RDF engine layer', async () => {
    await store.put(quad(
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
      namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
      namedNode('http://www.w3.org/ns/pim/meeting#LongChat'),
      namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
    ));

    const engine = new SolidRdfEngine({ index });
    const report = runRdfModelsBenchmark(engine, {
      scale: 'small',
      iterations: 1,
    });
    const listChats = report.cases.find((testCase) => testCase.name === 'list chats');

    expect(report.engine).toBe('solid-rdf');
    expect(listChats).toMatchObject({
      returnedRows: 1,
      metrics: { indexChoice: 'GPOS', matchedRows: 1, returnedRows: 1 },
    });
  });
});
