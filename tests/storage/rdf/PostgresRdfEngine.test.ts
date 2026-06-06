import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import { PGlite } from '@electric-sql/pglite';
import {
  PostgresRdfEngine,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  rdfModelsBenchmarkSyntheticPodCount,
  runRdfModelsPostgresBenchmark,
  type RdfPgAccelerationProfile,
  type RdfQuery,
} from '../../../src/storage/rdf';
import { rdfTermValueHead } from '../../../src/storage/rdf/RdfTermDictionary';

const { literal, namedNode, quad } = DataFactory;

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const CONTENT = 'http://rdfs.org/sioc/ns#content';
const PRIORITY = 'https://undefineds.co/ns#priority';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STATUS = 'https://undefineds.co/ns#status';
const THREAD = 'https://undefineds.co/ns#thread';

function stringList(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !(Symbol.iterator in value)) {
    return [];
  }
  return Array.from(value as Iterable<unknown>).filter((entry): entry is string => typeof entry === 'string');
}

describe('PostgresRdfEngine', () => {
  it('stores RDF facts asynchronously while preserving datatype and language terms', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const run = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl#run_1');

    try {
      await engine.open();
      await engine.replaceSource([
        quad(run, namedNode(CONTENT), literal('hello'), graph),
        quad(run, namedNode(PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
        quad(run, namedNode(LABEL), literal('Bonjour', 'fr'), graph),
      ], {
        source: graph.value,
        workspace: 'https://pod.example/alice/.data/task/secretary/',
        localPath: '.data/task/secretary/2026/05/18/runs.ttl',
        contentType: 'text/turtle',
        sourceVersion: 'v1',
      });

      const datatypeScan = await engine.scan({
        pattern: {
          graph,
          subject: run,
          predicate: namedNode(PRIORITY),
          object: { $datatype: namedNode(XSD_INTEGER) },
        },
      });
      expect(datatypeScan.quads).toHaveLength(1);
      expect(datatypeScan.metrics.queryPlan?.join('\n')).toContain('Rdf3xMembershipScan');
      expect(datatypeScan.metrics.queryPlan?.join('\n')).not.toContain('PostgresRdf3xScanFallback');
      expect(datatypeScan.quads[0].object.termType).toBe('Literal');
      expect(datatypeScan.quads[0].object.datatype.value).toBe(XSD_INTEGER);

      const languageScan = await engine.scan({
        pattern: {
          graph,
          subject: run,
          predicate: namedNode(LABEL),
          object: { $language: 'fr' },
        },
      });
      expect(languageScan.quads).toHaveLength(1);
      expect(languageScan.quads[0].object.termType).toBe('Literal');
      expect(languageScan.quads[0].object.language).toBe('fr');

      await engine.close();

      const reopened = new PostgresRdfEngine({
        driver: 'pglite',
        dataDir,
      });
      try {
        await reopened.open();
        await reopened.refreshDerivedIndexes();
        const persisted = await reopened.scan({
          pattern: {
            graph,
            predicate: namedNode(PRIORITY),
            object: literal('10', namedNode(XSD_INTEGER)),
          },
        });

        expect(persisted.quads).toHaveLength(1);
        expect(persisted.quads[0].subject.value).toBe(run.value);
        const storage = await reopened.storageStats();
        expect(storage.facts.quadCount).toBe(3);
        expect(storage.derivedIndexProfile).toBe('rdf3x');
        expect(storage.rdf3x).toMatchObject({
          syncedWithFacts: true,
          stats: {
            membershipCount: 3,
            uniqueTriples: 3,
            graphCount: 1,
          },
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('applies mixed deltas in one visible facts update', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-delta-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const content = namedNode(CONTENT);

    try {
      await engine.open();
      await engine.put(quad(message, content, literal('old'), graph));

      const result = await engine.applyDelta(
        [{ graph, subject: message, predicate: content, object: literal('old') }],
        [quad(message, content, literal('new'), graph)],
      );

      expect(result).toEqual({
        deletedRows: 1,
        insertedRows: 1,
      });
      expect((await engine.scan({ pattern: { graph, object: literal('old') } })).quads).toHaveLength(0);
      expect((await engine.scan({ pattern: { graph, object: literal('new') } })).quads).toHaveLength(1);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses PostgreSQL RDF-3X stats and BGP join without building a fallback cache', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf3x-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/thread-a/index.ttl#this');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message1, namedNode(PRIORITY), literal('5', namedNode(XSD_INTEGER)), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(STATUS), literal('closed'), graph),
        quad(message2, namedNode(PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      ], {
        source: graph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.data/chat/default/2026/05/18/messages.ttl',
        contentType: 'text/turtle',
        sourceVersion: 'v1',
      });

      const refresh = await engine.refreshDerivedIndexes();
      expect(refresh.rdf3x).toMatchObject({
        factsDataVersion: 1,
        syncedWithFacts: true,
        rebuild: {
          scannedQuads: 6,
          memberships: 6,
        },
      });
      expect(refresh.rdf3x?.plannerStats?.analyzedTables).toEqual(expect.arrayContaining([
        'rdf_terms',
        'rdf_quads',
        'rdf3x_stat_g',
      ]));
      expect(refresh.rdf3x?.plannerStats?.durationMs).toEqual(expect.any(Number));

      const scan = await engine.scan({
        pattern: {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          predicate: namedNode(STATUS),
          object: { $contains: 'open' },
        },
      });
      expect(scan.quads.map((entry) => entry.subject.value)).toEqual([message1.value]);
      expect(scan.metrics.queryPlan?.join('\n')).toContain('GraphPrefixMembershipFilter');
      expect(scan.metrics.queryPlan?.join('\n')).toContain('TextSearch(object$contains)');

      const join = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: thread,
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        select: ['message'],
      });
      expect(join.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(join.metrics.plan.some((entry) => entry.startsWith('PostgresRdf3xJoin('))).toBe(true);
      expect(join.metrics.plan).not.toContain('PostgresRdf3xFallback');

      const files = await readdir(dataDir);
      expect(files.some((entry) => entry.includes('rdf-cache.sqlite'))).toBe(false);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('caches PostgreSQL query results by facts data version and invalidates on writes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-'));
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const query = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      orderBy: [{ variable: 'message' }],
    };
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });

    try {
      await engine.open();
      await engine.put(quad(message1, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(first.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(first.metrics.plan).toContain('PostgresResultCacheStore');
      expect(first.metrics.plan).not.toContain('PostgresResultCacheHit');

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(second.metrics.plan).toContain('PostgresResultCacheHit');
      expect(second.metrics.plan.some((entry) => entry.startsWith('PostgresRdf3xJoin('))).toBe(true);

      const storage = await engine.storageStats();
      expect(storage.queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
      expect(storage.derivedBytes).toBeGreaterThanOrEqual(storage.queryResultCache?.totalBytes ?? 0);

      await engine.close();

      const reopened = new PostgresRdfEngine({
        driver: 'pglite',
        dataDir,
      });
      try {
        await reopened.open();
        const persisted = await reopened.query(query);
        expect(persisted.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
        expect(persisted.metrics.plan).toContain('PostgresResultCacheHit');

        await reopened.put(quad(message2, namedNode(STATUS), literal('open'), graph));
        const afterWrite = await reopened.query(query);
        expect(afterWrite.bindings.map((binding) => binding.message.value)).toEqual([message1.value, message2.value]);
        expect(afterWrite.metrics.plan).toContain('PostgresResultCacheMiss');
        expect(afterWrite.metrics.plan).not.toContain('PostgresResultCacheHit');
      } finally {
        await reopened.close();
      }
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('can disable PostgreSQL query result caching and fall back to the baseline query path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-disabled-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const query = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      const second = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan.join('\n')).not.toContain('PostgresResultCache');
      expect(second.metrics.plan.join('\n')).not.toContain('PostgresResultCache');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 0,
        scopeCount: 0,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('isolates PostgreSQL query result cache entries by query cache scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-scope-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const queryForScope = (scope: string): RdfQuery => ({
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: { scope },
    });

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const alice = await engine.query(queryForScope('principal:alice'));
      expect(alice.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(alice.metrics.plan).toContain('PostgresResultCacheStore');

      const bob = await engine.query(queryForScope('principal:bob'));
      expect(bob.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(bob.metrics.plan).toContain('PostgresResultCacheStore');
      expect(bob.metrics.plan).not.toContain('PostgresResultCacheHit');

      const aliceAgain = await engine.query(queryForScope('principal:alice'));
      expect(aliceAgain.metrics.plan).toContain('PostgresResultCacheHit');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 2,
        scopeCount: 2,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('can bypass PostgreSQL query result caching for a single query', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-bypass-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const query: RdfQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: { mode: 'bypass' },
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      const second = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan.join('\n')).not.toContain('PostgresResultCache');
      expect(second.metrics.plan.join('\n')).not.toContain('PostgresResultCache');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 0,
        scopeCount: 0,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('can refresh a PostgreSQL query result cache entry without changing its semantic key', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-refresh-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const baseQuery: RdfQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: { scope: 'principal:alice' },
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(baseQuery);
      expect(first.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(first.metrics.plan).toContain('PostgresResultCacheStore');

      const refreshed = await engine.query({
        ...baseQuery,
        cache: { ...baseQuery.cache, mode: 'refresh' },
      });
      expect(refreshed.metrics.plan).toContain('PostgresResultCacheRefresh');
      expect(refreshed.metrics.plan).toContain('PostgresResultCacheStore');
      expect(refreshed.metrics.plan).not.toContain('PostgresResultCacheHit');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });

      const afterRefresh = await engine.query(baseQuery);
      expect(afterRefresh.metrics.plan).toContain('PostgresResultCacheHit');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses the table-backed PostgreSQL result cache for the result-cache profile', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-result-cache-profile-'));
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const query: RdfQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
    };

    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      rdfAccelerationProfile: 'pg-result-cache',
    });

    try {
      await engine.open();
      expect((await engine.storageStats()).pgAcceleration).toMatchObject({
        profile: 'pg-result-cache',
        requested: true,
        available: true,
        enabled: true,
        provider: 'engine-sql',
        capabilities: ['cache.result'],
        capabilityProviders: {
          'cache.result': 'engine-sql',
        },
        requiredCapabilities: ['cache.result'],
        missingCapabilities: [],
        activeOperators: ['cache.result'],
      });

      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan).toContain('PostgresResultCacheStore');

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('PostgresResultCacheHit');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prunes PostgreSQL query result cache entries to the configured profile', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-prune-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxEntries: 1,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const openQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
    };
    const closedQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('closed'),
        },
      ],
      select: ['message'],
    };

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('closed'), graph),
      ]);

      const open = await engine.query(openQuery);
      expect(open.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(open.metrics.plan).toContain('PostgresResultCacheStore');

      const closed = await engine.query(closedQuery);
      expect(closed.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      expect(closed.metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to PostgreSQL facts for query shapes outside the RDF-3X fast path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-facts-query-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const message3 = namedNode(`${graph.value}#msg_3`);

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(CONTENT), literal('Hello managed agents'), graph),
        quad(message2, namedNode(CONTENT), literal('Draft note'), graph),
      ]);

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(CONTENT),
            object: { variable: 'content' },
          },
        ],
        filters: [
          {
            variable: 'content',
            operator: '$regex',
            value: 'managed\\s+agents',
            flags: 'i',
          },
        ],
        select: ['message'],
      });

      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(result.metrics.plan).toContain('PostgresFactsQuery');
      expect(result.metrics.plan).toContain('PostgresFactsFilter(?content$regex)');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
      const files = await readdir(dataDir);
      expect(files.some((entry) => entry.includes('rdf-cache.sqlite'))).toBe(false);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps same-pattern repeated variables on the PostgreSQL RDF-3X path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-repeat-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/test/repeated.ttl');
    const same = namedNode('https://example.com/same');
    const other = namedNode('https://example.com/other');

    try {
      await engine.open();
      await engine.put([
        quad(same, namedNode(THREAD), same, graph),
        quad(same, namedNode(THREAD), other, graph),
      ]);

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'node' },
            predicate: namedNode(THREAD),
            object: { variable: 'node' },
          },
        ],
        select: ['node'],
      });

      expect(result.bindings.map((binding) => binding.node.value)).toEqual([same.value]);
      expect(result.metrics.plan).toContain('Rdf3xPatternEquality(?node:subject=object)');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs grouped count HAVING/order/limit as PostgreSQL RDF-3X SQL', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-group-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread1 = namedNode('https://pod.example/alice/.data/chat/default/thread-1/index.ttl#this');
    const thread2 = namedNode('https://pod.example/alice/.data/chat/default/thread-2/index.ttl#this');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const message3 = namedNode(`${graph.value}#msg_3`);

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(THREAD), thread1, graph),
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(THREAD), thread1, graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
        quad(message3, namedNode(THREAD), thread2, graph),
        quad(message3, namedNode(STATUS), literal('open'), graph),
      ]);

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        having: [
          {
            variable: 'messageCount',
            operator: '$lt',
            value: 2,
          },
        ],
        orderBy: [
          {
            variable: 'messageCount',
            direction: 'desc',
          },
        ],
        limit: 1,
      });

      expect(result.bindings.map((binding) => ({
        thread: binding.thread.value,
        messageCount: binding.messageCount.value,
      }))).toEqual([
        {
          thread: thread2.value,
          messageCount: '1',
        },
      ]);
      expect(result.metrics.plan).toContain('PostgresRdf3xGroupCount');
      expect(result.metrics.plan).toContain('PostgresRdf3xAggregateHaving(?messageCount$lt)');
      expect(result.metrics.plan).toContain('PostgresRdf3xAggregateOrder(desc:messageCount)');
      expect(result.metrics.plan).toContain('PostgresRdf3xAggregateLimit');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs non-grouped numeric aggregates as PostgreSQL RDF-3X SQL', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-numeric-aggregate-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    const run1 = namedNode(`${graph.value}#run_1`);
    const run2 = namedNode(`${graph.value}#run_2`);
    const run3 = namedNode(`${graph.value}#run_3`);

    try {
      await engine.open();
      await engine.put([
        quad(run1, namedNode(STATUS), literal('queued'), graph),
        quad(run1, namedNode(PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
        quad(run2, namedNode(STATUS), literal('queued'), graph),
        quad(run2, namedNode(PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
        quad(run3, namedNode(STATUS), literal('running'), graph),
        quad(run3, namedNode(PRIORITY), literal('8', namedNode(XSD_INTEGER)), graph),
      ]);

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'run' },
            predicate: namedNode(STATUS),
            object: literal('queued'),
          },
          {
            graph,
            subject: { variable: 'run' },
            predicate: namedNode(PRIORITY),
            object: { variable: 'priority' },
          },
        ],
        filters: [
          {
            variable: 'priority',
            operator: '$termType',
            value: 'numeric',
          },
        ],
        aggregates: [
          {
            type: 'sum',
            as: 'priorityTotal',
            variable: 'priority',
          },
          {
            type: 'avg',
            as: 'priorityAvg',
            variable: 'priority',
          },
          {
            type: 'max',
            as: 'priorityMax',
            variable: 'priority',
          },
        ],
        select: ['priorityTotal', 'priorityAvg', 'priorityMax'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].priorityTotal.value).toBe('12');
      expect(result.bindings[0].priorityAvg.value).toBe('6');
      expect(result.bindings[0].priorityMax.value).toBe('10');
      expect(result.bindings[0].priorityTotal.datatype.value).toBe(XSD_DECIMAL);
      expect(result.metrics.plan).toContain('PostgresRdf3xJoinAggregate');
      expect(result.metrics.plan).toContain('Aggregate(sum(?priority),avg(?priority),max(?priority))');
      expect(result.metrics.plan).not.toContain('PostgresFactsQuery');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps derived RDF-3X stats asynchronous while facts stay immediately queryable', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-async-boundary-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const run1 = namedNode(`${graph.value}#run_1`);
    const run2 = namedNode(`${graph.value}#run_2`);

    try {
      await engine.open();
      await engine.put(quad(run1, namedNode(STATUS), literal('open'), graph));
      const firstRefresh = await engine.refreshDerivedIndexes();
      expect(firstRefresh.rdf3x).toMatchObject({
        factsDataVersion: 1,
        syncedWithFacts: true,
      });
      expect(firstRefresh.rdf3x?.plannerStats?.analyzedTables).toEqual(expect.arrayContaining([
        'rdf_terms',
        'rdf_quads',
        'rdf3x_stat_g',
      ]));
      expect(firstRefresh.rdf3x?.plannerStats?.durationMs).toEqual(expect.any(Number));
      const secondRefresh = await engine.refreshDerivedIndexes();
      expect(secondRefresh.rdf3x).toMatchObject({
        refreshed: false,
        previousFactsDataVersion: 1,
        factsDataVersion: 1,
        syncedWithFacts: true,
      });
      expect(secondRefresh.rdf3x?.plannerStats?.analyzedTables).toEqual(expect.arrayContaining([
        'rdf_terms',
        'rdf_quads',
        'rdf3x_stat_g',
      ]));
      expect(secondRefresh.rdf3x?.plannerStats?.durationMs).toEqual(expect.any(Number));
      expect(secondRefresh.rdf3x?.rebuild).toBeUndefined();

      await engine.put(quad(run2, namedNode(STATUS), literal('closed'), graph));
      const query = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'run' },
            predicate: namedNode(STATUS),
            object: { variable: 'status' },
          },
        ],
        orderBy: [{ variable: 'run' }],
      });

      expect(query.bindings.map((binding) => binding.run.value)).toEqual([run1.value, run2.value]);
      expect(query.metrics.plan).not.toContain('PostgresRdf3xFallback');
      const storage = await engine.storageStats();
      expect(storage.facts.quadCount).toBe(2);
      expect(storage.rdf3x).toMatchObject({
        syncedWithFacts: false,
        stats: expect.objectContaining({
          factsDataVersion: 1,
        }),
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('restores PostgreSQL string integer aliases for PG SQL group joins', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-pg-strings-'));
    const pool = new StringIntegerPgPool(dataDir);
    const engine = new PostgresRdfEngine({
      driver: 'pg',
      pool,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/thread-1/index.ttl#this');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
      ]);

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].thread.value).toBe(thread.value);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.metrics.plan).toContain('PostgresRdf3xGroupCount');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('enables PostgreSQL SQL hot operators in the standalone engine', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-hot-operators-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      rdfAccelerationProfile: 'pg-hot-operators',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      expect((await engine.storageStats()).pgAcceleration).toMatchObject({
        profile: 'pg-hot-operators',
        requested: true,
        available: true,
        enabled: true,
        provider: 'engine-sql',
        capabilities: expect.arrayContaining([
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
          'join.required_bgp',
          'join.values',
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ]),
        capabilityProviders: {
          'aggregate.count': 'engine-sql',
          'aggregate.numeric': 'engine-sql',
          'cache.result': 'engine-sql',
          'join.required_bgp': 'engine-sql',
          'join.values': 'engine-sql',
          'scan.exact_graph': 'engine-sql',
          'scan.graph_prefix': 'engine-sql',
          'scan.term_in': 'engine-sql',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
          'join.required_bgp',
          'join.values',
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
        ],
        missingCapabilities: [],
        activeOperators: [
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
          'join.required_bgp',
          'join.values',
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ],
      });
      const acceleration = (await engine.storageStats()).pgAcceleration;
      const activeOperators = stringList(acceleration?.activeOperators);
      const capabilities = stringList(acceleration?.capabilities);
      expect(activeOperators).not.toEqual(expect.arrayContaining([
        'join.required_bgp.order_page.native',
        'join.required_bgp.native',
        'join.required_bgp.limit.native',
        'index.xpod_rdf_perm',
      ]));
      expect(capabilities.filter((capability) => capability.includes('.native'))).toEqual([]);
      expect(capabilities.filter((capability) => capability.startsWith('index.xpod_rdf_perm'))).toEqual([]);

      await engine.put([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message1, namedNode(PRIORITY), literal('10', namedNode(XSD_DECIMAL)), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(PRIORITY), literal('20', namedNode(XSD_DECIMAL)), graph),
      ]);

      const scanResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        select: ['message'],
        cache: { mode: 'bypass' },
      });

      expect(scanResult.bindings.map((binding) => binding.message.value).sort()).toEqual([message1.value, message2.value]);
      expect(scanResult.metrics.plan).toContain('XpodRdfPgHotOperator(scan.exact_graph)');

      const valuesResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: { variable: 'status' },
          },
        ],
        values: [
          {
            variables: ['message'],
            rows: [
              { message: message2 },
            ],
          },
        ],
        select: ['message', 'status'],
        cache: { mode: 'bypass' },
      });

      expect(valuesResult.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      expect(valuesResult.bindings.map((binding) => binding.status.value)).toEqual(['open']);
      expect(valuesResult.metrics.plan).toContain('XpodRdfPgHotOperator(join.values)');
      expect(valuesResult.metrics.plan).toContain('Rdf3xJoinTupleValues(?message)');
      expect(valuesResult.metrics.plan).not.toContain('PostgresFactsValues');

      const aggregateResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(PRIORITY),
            object: { variable: 'priority' },
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
          {
            type: 'sum',
            as: 'priorityTotal',
            variable: 'priority',
          },
        ],
        cache: { mode: 'bypass' },
      });

      expect(aggregateResult.bindings).toHaveLength(1);
      expect(aggregateResult.bindings[0].messageCount.value).toBe('2');
      expect(aggregateResult.bindings[0].priorityTotal.value).toBe('30');
      expect(aggregateResult.metrics.plan).toContain('XpodRdfPgHotOperator(aggregate.count)');
      expect(aggregateResult.metrics.plan).toContain('XpodRdfPgHotOperator(aggregate.numeric)');
      expect(aggregateResult.metrics.plan).toContain('XpodRdfPgHotOperator(join.required_bgp)');
      expect(aggregateResult.metrics.plan).toContain('PostgresRdf3xGroupAggregate');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back the PostgreSQL custom-index profile when the native extension is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-fallback-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const query: RdfQuery = {
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: { mode: 'bypass' },
    };

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stats).toMatchObject({
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: false,
        provider: 'engine-sql',
        capabilities: expect.arrayContaining([
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
          'join.required_bgp',
          'join.values',
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ]),
        capabilityProviders: {
          'aggregate.count': 'engine-sql',
          'aggregate.numeric': 'engine-sql',
          'cache.result': 'engine-sql',
          'join.required_bgp': 'engine-sql',
          'join.values': 'engine-sql',
          'scan.exact_graph': 'engine-sql',
          'scan.graph_prefix': 'engine-sql',
          'scan.term_in': 'engine-sql',
        },
        missingCapabilities: ['index.xpod_rdf_perm'],
        fallbackReason: 'capability-missing',
      });
      expect(stringList(stats?.capabilities)).not.toContain('index.xpod_rdf_perm');
      expect(stats?.activeOperators ?? []).not.toEqual(expect.arrayContaining([
        'join.required_bgp.order_page.native',
        'join.required_bgp.native',
        'join.required_bgp.limit.native',
        'index.xpod_rdf_perm',
      ]));

      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      const result = await engine.query(query);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.plan).toContain('PostgresRdfAccelerationFallback(capability-missing)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('activates the wired native custom-index count operator', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-active-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const message3 = namedNode(`${graph.value}#msg_3`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stats).toMatchObject({
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        missingCapabilities: [],
        capabilityProviders: {
          'aggregate.bgp_count': 'extension',
          'aggregate.bgp_group_count': 'extension',
          'aggregate.bgp_numeric': 'extension',
          'aggregate.count': 'engine-sql',
          'aggregate.numeric': 'engine-sql',
          'cache.result': 'engine-sql',
          'index.xpod_rdf_perm': 'extension',
          'index.xpod_rdf_perm.count_any': 'extension',
          'index.xpod_rdf_perm.distinct_any': 'extension',
          'index.xpod_rdf_perm.scan_any': 'extension',
          'join.required_bgp': 'engine-sql',
          'join.values': 'engine-sql',
          'join.values.limit.native': 'extension',
          'join.values.native': 'extension',
          'scan.exact_graph': 'engine-sql',
          'scan.graph_prefix': 'engine-sql',
          'scan.term_in': 'engine-sql',
        },
      });
      expect(stringList(stats?.capabilities)).toEqual(expect.arrayContaining([
        'aggregate.bgp_count',
        'aggregate.bgp_group_count',
        'aggregate.bgp_numeric',
        'index.xpod_rdf_perm',
        'index.xpod_rdf_perm.count_any',
        'index.xpod_rdf_perm.distinct_any',
        'index.xpod_rdf_perm.scan_any',
        'join.required_bgp.native',
        'join.required_bgp.order_page.native',
        'join.values.limit.native',
        'join.values.native',
      ]));
      expect(stats?.activeOperators ?? []).toEqual([
        'aggregate.bgp_count',
        'aggregate.bgp_group_count',
        'aggregate.bgp_numeric',
        'aggregate.count',
        'aggregate.numeric',
        'cache.result',
        'index.xpod_rdf_perm.count_any',
        'index.xpod_rdf_perm.distinct_any',
        'index.xpod_rdf_perm.scan_any',
        'join.required_bgp',
        'join.required_bgp.native',
        'join.values',
        'join.values.limit.native',
        'join.values.native',
        'scan.exact_graph',
        'scan.graph_prefix',
        'scan.term_in',
      ]);
      expect(stats?.activeOperators ?? []).not.toEqual(expect.arrayContaining([
        'index.xpod_rdf_perm',
        'join.required_bgp.order_page.native',
      ]));
      expect(stats?.fallbackReason).toBeUndefined();
      expect(pool.customIndexStatements).toHaveLength(6);
      expect(pool.customIndexStatements.join('\n')).toContain('rdf_quads_spog_perm');
      expect(pool.customIndexStatements.join('\n')).toContain('rdf_quads_opsg_perm');
      expect(stats?.customIndexes).toHaveLength(6);
      expect(stats?.customIndexes?.[0]).toMatchObject({
        name: 'rdf_quads_spog_perm',
        permutation: 'SPO',
        columns: ['subject_id', 'predicate_id', 'object_id', 'graph_id'],
        stats: {
          layout: 'compressed-posting-v1',
          compressed: true,
          globalSorted: true,
        },
      });

      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message1, namedNode(THREAD), namedNode(`${graph.value}#thread_a`), graph),
        quad(message1, namedNode(PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(THREAD), namedNode(`${graph.value}#thread_a`), graph),
        quad(message2, namedNode(PRIORITY), literal('4', namedNode(XSD_INTEGER)), graph),
        quad(message3, namedNode(STATUS), literal('closed'), graph),
        quad(message3, namedNode(THREAD), namedNode(`${graph.value}#thread_b`), graph),
        quad(message3, namedNode(PRIORITY), literal('2', namedNode(XSD_INTEGER)), graph),
      ]);
      const scanResult = await engine.scan({
        pattern: {
          graph,
          predicate: namedNode(STATUS),
          object: { $in: [literal('open'), literal('closed')] },
        },
      });

      expect(scanResult.quads.map((entry) => entry.subject.value).sort()).toEqual([
        message1.value,
        message2.value,
        message3.value,
      ]);
      expect(scanResult.metrics.queryPlan).toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.scan_any)');
      expect(scanResult.metrics.queryPlan).toContain('PostgresRdfNativeCustomIndexScanAny(POS)');
      expect(scanResult.metrics.queryPlan).not.toContain('Rdf3xPermutationScan(POS)');
      expect(pool.nativeScanAnyCalls).toHaveLength(1);
      const scanAnyParams = pool.nativeScanAnyCalls[0].params;
      expect(scanAnyParams).toHaveLength(8);
      expect(scanAnyParams[0]).toBe('rdf_quads_posg_perm');
      expect(scanAnyParams[1]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(scanAnyParams[2]).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
      expect(scanAnyParams[3]).toBeNull();
      expect(scanAnyParams[4]).toBeNull();

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        select: ['messageCount'],
        cache: { mode: 'bypass' },
      });

      expect(result.count).toBe(2);
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.metrics.plan).toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.count_any)');
      expect(result.metrics.plan).toContain('PostgresRdfNativeCustomIndexCountAny(POS)');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xJoinCount');
      expect(pool.nativeCountAnyCalls).toHaveLength(2);
      const countAnyParams = pool.nativeCountAnyCalls[1].params;
      expect(countAnyParams).toHaveLength(10);
      expect(countAnyParams[0]).toBe('rdf_quads');
      expect(countAnyParams[1]).toBe('rdf_quads_posg_perm');
      expect(countAnyParams[2]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(countAnyParams[3]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(countAnyParams[4]).toBeNull();
      expect(countAnyParams[5]).toBeNull();
      expect(countAnyParams[6]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(countAnyParams[7]).toBeNull();
      expect(countAnyParams[8]).toEqual(countAnyParams[2]);
      expect(countAnyParams[9]).toEqual(countAnyParams[3]);

      const distinctResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: { $in: [literal('open'), literal('closed')] },
          },
        ],
        select: ['message'],
        distinct: true,
        limit: 2,
        offset: 1,
        cache: { mode: 'bypass' },
      });

      expect(distinctResult.bindings.map((binding) => binding.message.value)).toEqual([
        message2.value,
        message3.value,
      ]);
      expect(distinctResult.metrics.plan).toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.distinct_any)');
      expect(distinctResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexDistinctAny(POS,?message)');
      expect(distinctResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexDistinctLimit');
      expect(distinctResult.metrics.plan).not.toContain('PostgresRdf3xJoin(subject:?message');
      expect(pool.nativeDistinctAnyCalls).toHaveLength(1);
      const distinctAnyParams = pool.nativeDistinctAnyCalls[0].params;
      expect(distinctAnyParams).toHaveLength(13);
      expect(distinctAnyParams[0]).toBe('rdf_quads');
      expect(distinctAnyParams[1]).toBe('rdf_quads_posg_perm');
      expect(distinctAnyParams[2]).toBe(2);
      expect(distinctAnyParams[3]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(distinctAnyParams[4]).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
      expect(distinctAnyParams[5]).toBeNull();
      expect(distinctAnyParams[6]).toBeNull();
      expect(distinctAnyParams[7]).toEqual(expect.arrayContaining([expect.any(Number)]));
      expect(distinctAnyParams[8]).toBeNull();
      expect(distinctAnyParams[9]).toEqual(distinctAnyParams[3]);
      expect(distinctAnyParams[10]).toEqual(distinctAnyParams[4]);
      expect(distinctAnyParams[11]).toBe(2);
      expect(distinctAnyParams[12]).toBe(1);

      const joinResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        select: ['message', 'thread'],
        limit: 1,
        cache: { mode: 'bypass' },
      });

      expect(joinResult.bindings).toHaveLength(1);
      expect(joinResult.bindings[0].message.value).toBe(message1.value);
      expect(joinResult.bindings[0].thread.value).toBe(`${graph.value}#thread_a`);
      expect(joinResult.metrics.plan).toContain('XpodRdfExtensionOperator(join.required_bgp.native)');
      expect(joinResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexBgpJoin(2)');
      expect(joinResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexBgpLimit');
      expect(pool.nativeBgpJoinCalls).toHaveLength(1);
      const bgpParams = pool.nativeBgpJoinCalls[0].params;
      expect(bgpParams[0]).toBe('rdf_quads');
      expect(bgpParams.slice(1, 3)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^rdf_quads_.*_perm$/),
      ]));
      expect(bgpParams[3]).toHaveLength(8);
      expect(bgpParams[4]).toHaveLength(8);
      expect(bgpParams[5]).toEqual([1, 2]);
      expect(bgpParams[6]).toBe(1);
      expect(bgpParams[7]).toBeNull();

      const bgpCountResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
          {
            type: 'count',
            as: 'threadCount',
            variable: 'thread',
            distinct: true,
          },
        ],
        select: ['messageCount', 'threadCount'],
        cache: { mode: 'bypass' },
      });

      expect(bgpCountResult.count).toBe(2);
      expect(bgpCountResult.bindings).toHaveLength(1);
      expect(bgpCountResult.bindings[0].messageCount.value).toBe('2');
      expect(bgpCountResult.bindings[0].threadCount.value).toBe('1');
      expect(bgpCountResult.metrics.plan).toContain('XpodRdfExtensionOperator(aggregate.bgp_count)');
      expect(bgpCountResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexBgpCount(2)');
      expect(bgpCountResult.metrics.plan).not.toContain('PostgresRdf3xJoinCount');
      expect(pool.nativeBgpCountCalls).toHaveLength(1);
      const bgpCountParams = pool.nativeBgpCountCalls[0].params;
      expect(bgpCountParams[0]).toBe('rdf_quads');
      expect(bgpCountParams.slice(1, 3)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^rdf_quads_.*_perm$/),
      ]));
      expect(bgpCountParams[3]).toHaveLength(8);
      expect(bgpCountParams[4]).toHaveLength(8);
      expect(bgpCountParams[5]).toEqual([]);
      expect(bgpCountParams[6]).toEqual([]);
      expect(bgpCountParams[7]).toEqual([1, 2]);
      expect(bgpCountParams[8]).toEqual([0, 1]);

      const valuesJoinResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: { variable: 'status' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        values: [
          {
            variables: ['message'],
            rows: [
              { message: message2 },
              { message: message3 },
            ],
          },
        ],
        select: ['message', 'status', 'thread'],
        limit: 1,
        cache: { mode: 'bypass' },
      });

      expect(valuesJoinResult.bindings).toHaveLength(1);
      expect(valuesJoinResult.bindings[0].message.value).toBe(message2.value);
      expect(valuesJoinResult.bindings[0].status.value).toBe('open');
      expect(valuesJoinResult.bindings[0].thread.value).toBe(`${graph.value}#thread_a`);
      expect(valuesJoinResult.metrics.plan).toContain('XpodRdfExtensionOperator(join.values.limit.native)');
      expect(valuesJoinResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexValuesJoin(2)');
      expect(valuesJoinResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexValuesJoinLimit');
      expect(pool.nativeValuesJoinCalls).toHaveLength(1);
      const valuesJoinParams = pool.nativeValuesJoinCalls[0].params;
      expect(valuesJoinParams[0]).toBe('rdf_quads');
      expect(valuesJoinParams.slice(1, 3)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^rdf_quads_.*_perm$/),
      ]));
      expect(valuesJoinParams[3]).toHaveLength(8);
      expect(valuesJoinParams[4]).toHaveLength(8);
      expect(valuesJoinParams[5]).toEqual([1, 2, 3]);
      expect(valuesJoinParams[6]).toEqual([1]);
      expect(valuesJoinParams[7]).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
      expect(valuesJoinParams[8]).toBe(1);
      expect(valuesJoinParams[9]).toBeNull();

      const groupCountResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: { variable: 'status' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
          {
            type: 'count',
            as: 'statusCount',
            variable: 'status',
            distinct: true,
          },
        ],
        having: [
          {
            variable: 'messageCount',
            operator: '$gte',
            value: 1,
          },
        ],
        orderBy: [
          {
            variable: 'messageCount',
            direction: 'desc',
          },
        ],
        limit: 1,
        cache: { mode: 'bypass' },
      });

      expect(groupCountResult.bindings).toHaveLength(1);
      expect(groupCountResult.bindings[0].thread.value).toBe(`${graph.value}#thread_a`);
      expect(groupCountResult.bindings[0].messageCount.value).toBe('2');
      expect(groupCountResult.bindings[0].statusCount.value).toBe('1');
      expect(groupCountResult.metrics.plan).toContain('XpodRdfExtensionOperator(aggregate.bgp_group_count)');
      expect(groupCountResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexBgpGroupCount(2)');
      expect(groupCountResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateHaving(?messageCount$gte)');
      expect(groupCountResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateOrder(desc:messageCount)');
      expect(groupCountResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateLimit');
      expect(pool.nativeBgpGroupCountCalls).toHaveLength(1);
      const groupCountParams = pool.nativeBgpGroupCountCalls[0].params;
      expect(groupCountParams[0]).toBe('rdf_quads');
      expect(groupCountParams.slice(1, 3)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^rdf_quads_.*_perm$/),
      ]));
      expect(groupCountParams[3]).toHaveLength(8);
      expect(groupCountParams[4]).toHaveLength(8);
      expect(groupCountParams[5]).toEqual([]);
      expect(groupCountParams[6]).toEqual([]);
      expect(groupCountParams[7]).toEqual([3]);
      expect(groupCountParams[8]).toEqual([1, 2]);
      expect(groupCountParams[9]).toEqual([0, 1]);

      const numericAggregateResult = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(PRIORITY),
            object: { variable: 'score' },
          },
        ],
        filters: [
          {
            variable: 'score',
            operator: '$termType',
            value: 'numeric',
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
          {
            type: 'sum',
            as: 'scoreTotal',
            variable: 'score',
          },
          {
            type: 'avg',
            as: 'scoreAvg',
            variable: 'score',
          },
          {
            type: 'max',
            as: 'scoreMax',
            variable: 'score',
          },
        ],
        having: [
          {
            variable: 'scoreTotal',
            operator: '$gt',
            value: 5,
          },
        ],
        orderBy: [
          {
            variable: 'scoreTotal',
            direction: 'desc',
          },
        ],
        limit: 1,
        cache: { mode: 'bypass' },
      });

      expect(numericAggregateResult.bindings).toHaveLength(1);
      expect(numericAggregateResult.bindings[0].thread.value).toBe(`${graph.value}#thread_a`);
      expect(numericAggregateResult.bindings[0].messageCount.value).toBe('2');
      expect(numericAggregateResult.bindings[0].scoreTotal.value).toBe('14');
      expect(numericAggregateResult.bindings[0].scoreAvg.value).toBe('7');
      expect(numericAggregateResult.bindings[0].scoreMax.value).toBe('10');
      expect(numericAggregateResult.bindings[0].scoreTotal.datatype.value).toBe(XSD_DECIMAL);
      expect(numericAggregateResult.metrics.plan).toContain('XpodRdfExtensionOperator(aggregate.bgp_numeric)');
      expect(numericAggregateResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexBgpNumericAggregate(2)');
      expect(numericAggregateResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateHaving(?scoreTotal$gt)');
      expect(numericAggregateResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateOrder(desc:scoreTotal)');
      expect(numericAggregateResult.metrics.plan).toContain('PostgresRdfNativeCustomIndexAggregateLimit');
      expect(numericAggregateResult.metrics.plan.join('\n')).not.toContain('SELECT source.');
      expect(pool.nativeBgpNumericAggregateCalls).toHaveLength(1);
      const numericAggregateParams = pool.nativeBgpNumericAggregateCalls[0].params;
      expect(numericAggregateParams[0]).toBe('rdf_quads');
      expect(numericAggregateParams.slice(1, 3)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^rdf_quads_.*_perm$/),
      ]));
      expect(numericAggregateParams[3]).toHaveLength(8);
      expect(numericAggregateParams[4]).toHaveLength(8);
      expect(numericAggregateParams[5]).toEqual([]);
      expect(numericAggregateParams[6]).toEqual([]);
      expect(numericAggregateParams[7]).toEqual([2]);
      expect(numericAggregateParams[8]).toBe(3);
      expect(numericAggregateParams[9]).toBe(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('pushes bounded graph-prefix joins into native custom-index values', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-graph-prefix-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const prefix = 'https://pod.example/alice/.data/chat/default/2026/05/';
    const graph1 = namedNode(`${prefix}18/messages.ttl`);
    const graph2 = namedNode(`${prefix}19/messages.ttl`);
    const outsideGraph = namedNode('https://pod.example/alice/.data/chat/other/2026/05/19/messages.ttl');
    const message1 = namedNode(`${graph1.value}#msg_1`);
    const message2 = namedNode(`${graph2.value}#msg_2`);
    const message3 = namedNode(`${graph2.value}#msg_3`);
    const outsideMessage = namedNode(`${outsideGraph.value}#msg_outside`);
    const thread1 = namedNode(`${graph1.value}#thread_a`);
    const thread2 = namedNode(`${graph2.value}#thread_b`);

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph1),
        quad(message1, namedNode(THREAD), thread1, graph1),
        quad(message2, namedNode(STATUS), literal('open'), graph2),
        quad(message2, namedNode(THREAD), thread2, graph2),
        quad(message3, namedNode(STATUS), literal('closed'), graph2),
        quad(message3, namedNode(THREAD), thread2, graph2),
      ]);

      const scan = await engine.scan({
        pattern: {
          graph: { $startsWith: prefix },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      });
      expect(scan.quads.map((entry) => entry.subject.value).sort()).toEqual([
        message1.value,
        message2.value,
      ]);
      expect(scan.metrics.queryPlan).toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.scan_any)');
      expect(scan.metrics.queryPlan?.join('\n')).toContain('GraphPrefixMembershipFilter');
      expect(pool.nativeScanAnyCalls).toHaveLength(1);

      await engine.put([
        quad(outsideMessage, namedNode(STATUS), literal('open'), outsideGraph),
        quad(outsideMessage, namedNode(THREAD), namedNode(`${outsideGraph.value}#thread_outside`), outsideGraph),
      ]);

      const join = await engine.query({
        patterns: [
          {
            graph: { $startsWith: prefix },
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
          {
            graph: { $startsWith: prefix },
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        select: ['message', 'thread'],
        cache: { mode: 'bypass' },
      });
      expect(join.bindings.map((binding) => binding.message.value).sort()).toEqual([
        message1.value,
        message2.value,
      ]);
      expect(join.bindings.map((binding) => binding.thread.value).sort()).toEqual([
        thread1.value,
        thread2.value,
      ]);
      expect(join.metrics.plan).toContain('XpodRdfExtensionOperator(join.values.native)');
      expect(join.metrics.plan).toContain('PostgresRdfNativeCustomIndexValuesJoin(2)');
      expect(join.metrics.plan).toContain('PostgresRdfNativeGraphPrefixValues(2x2)');
      expect(join.metrics.plan).not.toContain('PostgresRdf3xJoin');
      expect(pool.nativeValuesJoinCalls).toHaveLength(1);
      const valuesJoinParams = pool.nativeValuesJoinCalls[0].params;
      expect(valuesJoinParams[6]).toHaveLength(2);
      expect(valuesJoinParams[7]).toHaveLength(8);

      const count = await engine.query({
        patterns: [
          {
            graph: { $startsWith: prefix },
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
          {
            graph: { $startsWith: prefix },
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        select: ['messageCount'],
        cache: { mode: 'bypass' },
      });
      expect(count.count).toBe(2);
      expect(count.bindings[0].messageCount.value).toBe('2');
      expect(count.metrics.plan).toContain('XpodRdfExtensionOperator(aggregate.bgp_count)');
      expect(count.metrics.plan).toContain('XpodRdfExtensionOperator(join.values.native)');
      expect(count.metrics.plan).toContain('PostgresRdfNativeGraphPrefixValues(2x2)');
      expect(pool.nativeBgpCountCalls).toHaveLength(1);
      const bgpCountParams = pool.nativeBgpCountCalls[0].params;
      expect(bgpCountParams[5]).toHaveLength(2);
      expect(bgpCountParams[6]).toHaveLength(8);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to RDF-3X join count when the native BGP count operator is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-bgp-count-fallback-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'aggregate.bgp_count'));
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stringList(stats?.capabilities)).not.toContain('aggregate.bgp_count');
      expect(stats?.activeOperators ?? []).not.toContain('aggregate.bgp_count');

      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message1, namedNode(THREAD), namedNode(`${graph.value}#thread_a`), graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(THREAD), namedNode(`${graph.value}#thread_a`), graph),
      ]);
      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
        ],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        select: ['messageCount'],
        cache: { mode: 'bypass' },
      });

      expect(result.count).toBe(2);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.metrics.plan).toContain('PostgresRdf3xJoinCount');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionOperator(aggregate.bgp_count)');
      expect(pool.nativeBgpCountCalls).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to RDF-3X group count when the native BGP group-count operator is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-bgp-group-count-fallback-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'aggregate.bgp_group_count'));
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const thread = namedNode(`${graph.value}#thread_a`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stringList(stats?.capabilities)).not.toContain('aggregate.bgp_group_count');
      expect(stats?.activeOperators ?? []).not.toContain('aggregate.bgp_group_count');

      await engine.put([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
      ]);
      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: { variable: 'status' },
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        cache: { mode: 'bypass' },
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.metrics.plan).toContain('PostgresRdf3xGroupCount');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionOperator(aggregate.bgp_group_count)');
      expect(pool.nativeBgpGroupCountCalls).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to RDF-3X numeric aggregate when the native BGP numeric operator is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-bgp-numeric-fallback-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'aggregate.bgp_numeric'));
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const thread = namedNode(`${graph.value}#thread_a`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stringList(stats?.capabilities)).not.toContain('aggregate.bgp_numeric');
      expect(stats?.activeOperators ?? []).not.toContain('aggregate.bgp_numeric');

      await engine.put([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(PRIORITY), literal('10', namedNode(XSD_INTEGER)), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(PRIORITY), literal('4', namedNode(XSD_INTEGER)), graph),
      ]);
      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(THREAD),
            object: { variable: 'thread' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(PRIORITY),
            object: { variable: 'score' },
          },
        ],
        filters: [
          {
            variable: 'score',
            operator: '$termType',
            value: 'numeric',
          },
        ],
        groupBy: ['thread'],
        aggregates: [
          {
            type: 'sum',
            as: 'scoreTotal',
            variable: 'score',
          },
        ],
        cache: { mode: 'bypass' },
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].scoreTotal.value).toBe('14');
      expect(result.metrics.plan).toContain('PostgresRdf3xGroupAggregate');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionOperator(aggregate.bgp_numeric)');
      expect(pool.nativeBgpNumericAggregateCalls).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to RDF-3X count when the native count_any operator is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-count-fallback-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'index.xpod_rdf_perm.count_any'));
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stringList(stats?.capabilities)).not.toContain('index.xpod_rdf_perm.count_any');
      expect(stats?.activeOperators ?? []).not.toContain('index.xpod_rdf_perm.count_any');

      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
      ]);
      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        aggregates: [
          {
            type: 'count',
            as: 'messageCount',
            variable: 'message',
          },
        ],
        select: ['messageCount'],
        cache: { mode: 'bypass' },
      });

      expect(result.count).toBe(2);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.metrics.plan).toContain('PostgresRdf3xJoinCount');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.count_any)');
      expect(pool.nativeCountAnyCalls).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to RDF-3X distinct when the native distinct_any operator is absent', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-distinct-fallback-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES.filter((capability) => capability !== 'index.xpod_rdf_perm.distinct_any'));
    const engine = new PostgresRdfEngine({
      pool,
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

    try {
      await engine.open();
      const stats = (await engine.storageStats()).pgAcceleration;
      expect(stringList(stats?.capabilities)).not.toContain('index.xpod_rdf_perm.distinct_any');
      expect(stats?.activeOperators ?? []).not.toContain('index.xpod_rdf_perm.distinct_any');

      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
      ]);
      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        select: ['message'],
        distinct: true,
        cache: { mode: 'bypass' },
      });

      expect(result.bindings.map((binding) => binding.message.value).sort()).toEqual([
        message1.value,
        message2.value,
      ]);
      expect(result.metrics.plan).toContain('PostgresRdf3xJoinDistinct(?message)');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionOperator(index.xpod_rdf_perm.distinct_any)');
      expect(pool.nativeDistinctAnyCalls).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs shared models benchmark cases on the PostgreSQL RDF engine without result-cache masking', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-models-benchmark-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });

    try {
      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
      }));

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 1,
      });

      expect(report.engine).toBe('postgres-rdf');
      expect(report.warmupIterations).toBe(1);
      expect(report.planMatched).toBe(true);
      expect(report.failedPlanCases).toEqual([]);
      expect(report.storage.derivedIndexProfile).toBe('rdf3x');
      expect(report.storage.rdf3x?.syncedWithFacts).toBe(true);
      expect(report.storage.pgAcceleration).toMatchObject({
        profile: 'baseline',
        enabled: false,
      });
      expect(report.queryCases.flatMap((testCase) => testCase.physicalPlan).join('\n')).not.toContain('PostgresResultCache');
      expect(report.cases.every((testCase) => testCase.durationsMs.length === 1)).toBe(true);
      expect(report.queryCases.every((testCase) => testCase.durationsMs.length === 1)).toBe(true);

      const numericAggregate = report.queryCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
      expect(numericAggregate).toBeDefined();
      expect(numericAggregate?.planMatched).toBe(true);
      expect(numericAggregate?.returnedRows).toBeGreaterThan(0);
      expect(numericAggregate?.physicalPlan).toContain('PostgresRdf3xGroupAggregate');
      expect(numericAggregate?.physicalPlan).not.toContain('PostgresFactsQuery');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('wires cloud RDF storage to PostgreSQL hot operators in the open-source config', async () => {
    const cloudConfig = JSON.parse(await readFile(path.join(process.cwd(), 'config/cloud.json'), 'utf8'));
    const engine = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:SolidRdfEngine');

    expect(engine).toMatchObject({
      '@type': 'PostgresRdfEngine',
      options_driver: 'pg',
      options_connectionString: {
        '@id': 'urn:solid-server:default:variable:sparqlEndpoint',
        '@type': 'Variable',
      },
      options_rdfAccelerationProfile: 'pg-hot-operators',
      options_autoOpen: true,
    });

    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-cloud-open-source-'));
    const cloudProfile = engine.options_rdfAccelerationProfile as RdfPgAccelerationProfile;
    const openSourceCloudEngine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      rdfAccelerationProfile: cloudProfile,
    });

    try {
      await openSourceCloudEngine.open();
      const stats = (await openSourceCloudEngine.storageStats()).pgAcceleration;
      expect(stats).toMatchObject({
        profile: 'pg-hot-operators',
        requested: true,
        available: true,
        enabled: true,
        provider: 'engine-sql',
        missingCapabilities: [],
      });
      expect(stats?.capabilityProviders).toMatchObject({
        'cache.result': 'engine-sql',
        'scan.exact_graph': 'engine-sql',
        'scan.graph_prefix': 'engine-sql',
        'scan.term_in': 'engine-sql',
        'join.required_bgp': 'engine-sql',
        'join.values': 'engine-sql',
        'aggregate.count': 'engine-sql',
        'aggregate.numeric': 'engine-sql',
      });
      expect(stats?.activeOperators ?? []).not.toEqual(expect.arrayContaining([
        'join.required_bgp.order_page.native',
        'join.required_bgp.native',
        'join.required_bgp.limit.native',
        'index.xpod_rdf_perm',
      ]));
      const capabilities = stringList(stats?.capabilities);
      expect(capabilities.filter((capability) => capability.includes('.native'))).toEqual([]);
      expect(capabilities.filter((capability) => capability.startsWith('index.xpod_rdf_perm'))).toEqual([]);
      expect(stats?.fallbackReason).toBeUndefined();
    } finally {
      await openSourceCloudEngine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

class XpodRdfExtensionPgPool {
  private readonly db: PGlite;
  public readonly customIndexStatements: string[] = [];
  public readonly nativeCountAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeScanAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeDistinctAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpJoinCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpCountCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeValuesJoinCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpGroupCountCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpNumericAggregateCalls: Array<{ sql: string; params: unknown[] }> = [];

  public constructor(
    dataDir: string,
    private readonly capabilities: string[] = XPOD_RDF_EXTENSION_CAPABILITIES,
  ) {
    this.db = new PGlite(dataDir);
  }

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const intercepted = xpodRdfExtensionProbeRows(sql, params, this.capabilities, this.nativeCountAnyCalls);
    if (intercepted) {
      return { rows: intercepted };
    }
    if (sql.includes('USING xpod_rdf_perm')) {
      this.customIndexStatements.push(sql);
      return { rows: [] };
    }
    if (sql.includes('xpod_rdf.perm_index_distinct_any(')) {
      this.nativeDistinctAnyCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionDistinctAnyRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_join(')) {
      this.nativeBgpJoinCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpJoinRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.values_join(')) {
      this.nativeValuesJoinCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionValuesJoinRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_group_count(')) {
      this.nativeBgpGroupCountCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpGroupCountRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_numeric_aggregate(')) {
      this.nativeBgpNumericAggregateCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpNumericAggregateRows(this.db, sql, params) };
    }
    if (sql.includes('xpod_rdf.bgp_count(')) {
      this.nativeBgpCountCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpCountRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.perm_index_scan_any(')) {
      this.nativeScanAnyCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionScanAnyRows(this.db, params) };
    }
    await this.db.waitReady;
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows as Array<Record<string, unknown>>,
    };
  }

  public async connect(): Promise<XpodRdfExtensionPgClient> {
    await this.db.waitReady;
    return new XpodRdfExtensionPgClient(
      this.db,
      this.customIndexStatements,
      this.nativeCountAnyCalls,
      this.nativeScanAnyCalls,
      this.nativeDistinctAnyCalls,
      this.nativeBgpJoinCalls,
      this.nativeBgpCountCalls,
      this.nativeValuesJoinCalls,
      this.nativeBgpGroupCountCalls,
      this.nativeBgpNumericAggregateCalls,
      this.capabilities,
    );
  }

  public async end(): Promise<void> {
    await this.db.close();
  }
}

class XpodRdfExtensionPgClient {
  public constructor(
    private readonly db: PGlite,
    private readonly customIndexStatements: string[],
    private readonly nativeCountAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeScanAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeDistinctAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpJoinCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpCountCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeValuesJoinCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpGroupCountCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpNumericAggregateCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly capabilities: string[],
  ) {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const intercepted = xpodRdfExtensionProbeRows(sql, params, this.capabilities, this.nativeCountAnyCalls);
    if (intercepted) {
      return { rows: intercepted };
    }
    if (sql.includes('USING xpod_rdf_perm')) {
      this.customIndexStatements.push(sql);
      return { rows: [] };
    }
    if (sql.includes('xpod_rdf.perm_index_distinct_any(')) {
      this.nativeDistinctAnyCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionDistinctAnyRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_join(')) {
      this.nativeBgpJoinCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpJoinRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.values_join(')) {
      this.nativeValuesJoinCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionValuesJoinRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_group_count(')) {
      this.nativeBgpGroupCountCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpGroupCountRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.bgp_numeric_aggregate(')) {
      this.nativeBgpNumericAggregateCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpNumericAggregateRows(this.db, sql, params) };
    }
    if (sql.includes('xpod_rdf.bgp_count(')) {
      this.nativeBgpCountCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpCountRows(this.db, params) };
    }
    if (sql.includes('xpod_rdf.perm_index_scan_any(')) {
      this.nativeScanAnyCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionScanAnyRows(this.db, params) };
    }
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows as Array<Record<string, unknown>>,
    };
  }

  public release(): void {}
}

const XPOD_RDF_EXTENSION_CAPABILITIES = [
  'scan.exact_graph',
  'scan.graph_prefix',
  'scan.term_in',
  'join.required_bgp',
  'join.required_bgp.native',
  'join.required_bgp.order_page.native',
  'join.values.native',
  'join.values.limit.native',
  'join.values',
  'aggregate.bgp_count',
  'aggregate.bgp_group_count',
  'aggregate.bgp_numeric',
  'aggregate.count',
  'aggregate.numeric',
  'cache.result',
  'index.xpod_rdf_perm',
  'index.xpod_rdf_perm.count_any',
  'index.xpod_rdf_perm.distinct_any',
  'index.xpod_rdf_perm.scan_any',
];

function xpodRdfExtensionProbeRows(
  sql: string,
  params: unknown[],
  capabilities: string[],
  nativeCountAnyCalls: Array<{ sql: string; params: unknown[] }>,
): Array<Record<string, unknown>> | null {
  if (sql.includes("to_regprocedure('xpod_rdf.version()')")) {
    return [{
      extension_version: '0.1.0',
      has_version: true,
      has_capabilities: true,
    }];
  }
  if (sql.trim() === 'SELECT xpod_rdf.version() AS version') {
    return [{ version: '0.1.0-native' }];
  }
  if (sql.trim() === 'SELECT xpod_rdf.capabilities() AS capabilities') {
    return [{
      capabilities: capabilities.join(','),
    }];
  }
  if (sql.includes('xpod_rdf.perm_index_count_any(')) {
    nativeCountAnyCalls.push({ sql, params });
    return [{ count: 2 }];
  }
  if (sql.trim() === 'SELECT xpod_rdf.perm_index_stats($1::regclass) AS stats') {
    return [{
      stats: JSON.stringify({
        layout: 'compressed-posting-v1',
        compressed: true,
        globalSorted: true,
      }),
    }];
  }
  return null;
}

async function xpodRdfExtensionScanAnyRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const indexName = String(params[0] ?? '');
  const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexName] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
  const prefixFilters = params.slice(1, 5).map((value) => (
    Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : null
  ));
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads');
  return (result.rows as Array<Record<string, unknown>>)
    .filter((row) => columns.every((column, index) => {
      const filter = prefixFilters[index];
      return !filter || filter.includes(Number(row[column]));
    }))
    .sort((left, right) => {
      for (const column of columns) {
        const delta = Number(left[column]) - Number(right[column]);
        if (delta !== 0) return delta;
      }
      return 0;
    });
}

async function xpodRdfExtensionDistinctAnyRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const indexName = String(params[1] ?? '');
  const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexName] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
  const projectColumn = XPOD_RDF_EXTENSION_PROJECT_COLUMNS[Number(params[2])] ?? 'subject_id';
  const prefixFilters = params.slice(3, 7).map((value) => (
    Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : null
  ));
  const fullFilters = params.slice(7, 11).map((value) => (
    Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : null
  ));
  const limit = typeof params[11] === 'number' ? Math.max(0, params[11]) : undefined;
  const offset = typeof params[12] === 'number' ? Math.max(0, params[12]) : 0;
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads');
  const counts = new Map<number, number>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const prefixMatched = columns.every((column, index) => {
      const filter = prefixFilters[index];
      return !filter || filter.includes(Number(row[column]));
    });
    const fullMatched = XPOD_RDF_EXTENSION_FULL_FILTER_COLUMNS.every((column, index) => {
      const filter = fullFilters[index];
      return !filter || filter.includes(Number(row[column]));
    });
    if (!prefixMatched || !fullMatched) {
      continue;
    }
    const value = Number(row[projectColumn]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .slice(offset, limit === undefined ? undefined : offset + limit)
    .map(([value, rowCount]) => ({
      v0: value,
      value,
      row_count: rowCount,
    }));
  return rows;
}

async function xpodRdfExtensionBgpJoinRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const constantsIndex = params.findIndex((value, index) => (
    index > 0
      && Array.isArray(value)
      && value.length > 0
      && value.length % 4 === 0
      && value.every((entry) => entry === null || typeof entry === 'number')
  ));
  if (constantsIndex < 0) {
    return [];
  }
  const indexNames = params.slice(1, constantsIndex).map((value) => String(value));
  const constants = params[constantsIndex] as Array<number | null>;
  const variableSlots = params[constantsIndex + 1] as number[];
  const outputSlots = params[constantsIndex + 2] as number[];
  const limit = typeof params[constantsIndex + 3] === 'number' ? Math.max(0, params[constantsIndex + 3] as number) : undefined;
  const offset = typeof params[constantsIndex + 4] === 'number' ? Math.max(0, params[constantsIndex + 4] as number) : 0;
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const output: Array<Record<string, unknown>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      const row: Record<string, unknown> = {};
      outputSlots.forEach((slot, index) => {
        row[`v${index}`] = bindings.get(slot);
      });
      output.push(row);
      return;
    }

    const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexNames[patternIndex]] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
    for (const quadRow of quads) {
      const nextBindings = new Map(bindings);
      let matched = true;
      for (const [keyIndex, column] of columns.entries()) {
        const flatIndex = (patternIndex * 4) + keyIndex;
        const value = Number(quadRow[column]);
        const constant = constants[flatIndex];
        if (constant !== null && constant !== value) {
          matched = false;
          break;
        }
        const slot = variableSlots[flatIndex] ?? 0;
        if (slot > 0) {
          const existing = nextBindings.get(slot);
          if (existing !== undefined && existing !== value) {
            matched = false;
            break;
          }
          nextBindings.set(slot, value);
        }
      }
      if (matched) {
        visit(patternIndex + 1, nextBindings);
      }
    }
  };

  visit(0, new Map());
  return output.slice(offset, limit === undefined ? undefined : offset + limit);
}

async function xpodRdfExtensionValuesJoinRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const constantsIndex = params.findIndex((value, index) => (
    index > 0
      && Array.isArray(value)
      && value.length > 0
      && value.length % 4 === 0
      && value.every((entry) => entry === null || typeof entry === 'number')
  ));
  if (constantsIndex < 0) {
    return [];
  }
  const indexNames = params.slice(1, constantsIndex).map((value) => String(value));
  const constants = params[constantsIndex] as Array<number | null>;
  const variableSlots = params[constantsIndex + 1] as number[];
  const outputSlots = params[constantsIndex + 2] as number[];
  const valueSlots = params[constantsIndex + 3] as number[];
  const valueRows = params[constantsIndex + 4] as number[];
  const limit = typeof params[constantsIndex + 5] === 'number' ? Math.max(0, params[constantsIndex + 5] as number) : undefined;
  const offset = typeof params[constantsIndex + 6] === 'number' ? Math.max(0, params[constantsIndex + 6] as number) : 0;
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const bindingsList: Array<Map<number, number>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      bindingsList.push(bindings);
      return;
    }

    const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexNames[patternIndex]] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
    for (const quadRow of quads) {
      const nextBindings = new Map(bindings);
      let matched = true;
      for (const [keyIndex, column] of columns.entries()) {
        const flatIndex = (patternIndex * 4) + keyIndex;
        const value = Number(quadRow[column]);
        const constant = constants[flatIndex];
        if (constant !== null && constant !== value) {
          matched = false;
          break;
        }
        const slot = variableSlots[flatIndex] ?? 0;
        if (slot > 0) {
          const existing = nextBindings.get(slot);
          if (existing !== undefined && existing !== value) {
            matched = false;
            break;
          }
          nextBindings.set(slot, value);
        }
      }
      if (matched) {
        visit(patternIndex + 1, nextBindings);
      }
    }
  };

  visit(0, new Map());
  return applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows)
    .slice(offset, limit === undefined ? undefined : offset + limit)
    .map((bindings) => Object.fromEntries(outputSlots.map((slot, index) => [`v${index}`, bindings.get(slot)])));
}

async function xpodRdfExtensionBgpCountRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const constantsIndex = params.findIndex((value, index) => (
    index > 0
      && Array.isArray(value)
      && value.length > 0
      && value.length % 4 === 0
      && value.every((entry) => entry === null || typeof entry === 'number')
  ));
  if (constantsIndex < 0) {
    return [];
  }
  const indexNames = params.slice(1, constantsIndex).map((value) => String(value));
  const constants = params[constantsIndex] as Array<number | null>;
  const variableSlots = params[constantsIndex + 1] as number[];
  const valueSlots = params[constantsIndex + 2] as number[];
  const valueRows = params[constantsIndex + 3] as number[];
  const aggregateSlots = params[constantsIndex + 4] as number[];
  const aggregateDistinct = params[constantsIndex + 5] as number[];
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const bindingsList: Array<Map<number, number>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      bindingsList.push(bindings);
      return;
    }

    const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexNames[patternIndex]] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
    for (const quadRow of quads) {
      const nextBindings = new Map(bindings);
      let matched = true;
      for (const [keyIndex, column] of columns.entries()) {
        const flatIndex = (patternIndex * 4) + keyIndex;
        const value = Number(quadRow[column]);
        const constant = constants[flatIndex];
        if (constant !== null && constant !== value) {
          matched = false;
          break;
        }
        const slot = variableSlots[flatIndex] ?? 0;
        if (slot > 0) {
          const existing = nextBindings.get(slot);
          if (existing !== undefined && existing !== value) {
            matched = false;
            break;
          }
          nextBindings.set(slot, value);
        }
      }
      if (matched) {
        visit(patternIndex + 1, nextBindings);
      }
    }
  };

  visit(0, new Map());
  const constrainedBindings = applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows);
  const row: Record<string, unknown> = {};
  aggregateSlots.forEach((slot, index) => {
    const distinct = aggregateDistinct[index] !== 0;
    if (distinct) {
      const values = new Set<number>();
      for (const bindings of constrainedBindings) {
        const value = bindings.get(slot);
        if (value !== undefined) {
          values.add(value);
        }
      }
      row[`a${index}`] = values.size;
      return;
    }
    if (slot < 0) {
      row[`a${index}`] = constrainedBindings.length;
      return;
    }
    row[`a${index}`] = constrainedBindings.filter((bindings) => bindings.has(slot)).length;
  });
  return [row];
}

async function xpodRdfExtensionBgpGroupCountRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const constantsIndex = params.findIndex((value, index) => (
    index > 0
      && Array.isArray(value)
      && value.length > 0
      && value.length % 4 === 0
      && value.every((entry) => entry === null || typeof entry === 'number')
  ));
  if (constantsIndex < 0) {
    return [];
  }
  const indexNames = params.slice(1, constantsIndex).map((value) => String(value));
  const constants = params[constantsIndex] as Array<number | null>;
  const variableSlots = params[constantsIndex + 1] as number[];
  const valueSlots = params[constantsIndex + 2] as number[];
  const valueRows = params[constantsIndex + 3] as number[];
  const groupSlots = params[constantsIndex + 4] as number[];
  const aggregateSlots = params[constantsIndex + 5] as number[];
  const aggregateDistinct = params[constantsIndex + 6] as number[];
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const bindingsList: Array<Map<number, number>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      bindingsList.push(bindings);
      return;
    }

    const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexNames[patternIndex]] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
    for (const quadRow of quads) {
      const nextBindings = new Map(bindings);
      let matched = true;
      for (const [keyIndex, column] of columns.entries()) {
        const flatIndex = (patternIndex * 4) + keyIndex;
        const value = Number(quadRow[column]);
        const constant = constants[flatIndex];
        if (constant !== null && constant !== value) {
          matched = false;
          break;
        }
        const slot = variableSlots[flatIndex] ?? 0;
        if (slot > 0) {
          const existing = nextBindings.get(slot);
          if (existing !== undefined && existing !== value) {
            matched = false;
            break;
          }
          nextBindings.set(slot, value);
        }
      }
      if (matched) {
        visit(patternIndex + 1, nextBindings);
      }
    }
  };

  visit(0, new Map());
  const constrainedBindings = applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows);
  const groups = new Map<string, Array<Map<number, number>>>();
  for (const bindings of constrainedBindings) {
    const key = groupSlots.map((slot) => bindings.get(slot) ?? -1).join(':');
    groups.set(key, [...(groups.get(key) ?? []), bindings]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, groupBindings]) => {
      const first = groupBindings[0] ?? new Map<number, number>();
      const row: Record<string, unknown> = {};
      groupSlots.forEach((slot, index) => {
        row[`v${index}`] = first.get(slot);
      });
      aggregateSlots.forEach((slot, index) => {
        const distinct = aggregateDistinct[index] !== 0;
        if (distinct) {
          const values = new Set<number>();
          for (const bindings of groupBindings) {
            const value = bindings.get(slot);
            if (value !== undefined) {
              values.add(value);
            }
          }
          row[`a${index}`] = values.size;
          return;
        }
        if (slot < 0) {
          row[`a${index}`] = groupBindings.length;
          return;
        }
        row[`a${index}`] = groupBindings.filter((bindings) => bindings.has(slot)).length;
      });
      return row;
    });
}

async function xpodRdfExtensionBgpNumericAggregateRows(db: PGlite, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const constantsIndex = params.findIndex((value, index) => (
    index > 0
      && Array.isArray(value)
      && value.length > 0
      && value.length % 4 === 0
      && value.every((entry) => entry === null || typeof entry === 'number')
  ));
  if (constantsIndex < 0) {
    return [];
  }
  const indexNames = params.slice(1, constantsIndex).map((value) => String(value));
  const constants = params[constantsIndex] as Array<number | null>;
  const variableSlots = params[constantsIndex + 1] as number[];
  const valueSlots = params[constantsIndex + 2] as number[];
  const valueRows = params[constantsIndex + 3] as number[];
  const groupSlots = params[constantsIndex + 4] as number[];
  const numericSlot = Number(params[constantsIndex + 5]);
  const numericDistinct = Number(params[constantsIndex + 6] ?? 0) !== 0;
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const bindingsList: Array<Map<number, number>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      bindingsList.push(bindings);
      return;
    }

    const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexNames[patternIndex]] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
    for (const quadRow of quads) {
      const nextBindings = new Map(bindings);
      let matched = true;
      for (const [keyIndex, column] of columns.entries()) {
        const flatIndex = (patternIndex * 4) + keyIndex;
        const value = Number(quadRow[column]);
        const constant = constants[flatIndex];
        if (constant !== null && constant !== value) {
          matched = false;
          break;
        }
        const slot = variableSlots[flatIndex] ?? 0;
        if (slot > 0) {
          const existing = nextBindings.get(slot);
          if (existing !== undefined && existing !== value) {
            matched = false;
            break;
          }
          nextBindings.set(slot, value);
        }
      }
      if (matched) {
        visit(patternIndex + 1, nextBindings);
      }
    }
  };

  visit(0, new Map());
  const termResult = await db.query('SELECT id, numeric_value FROM rdf_terms WHERE numeric_value IS NOT NULL');
  const numericValues = new Map<number, number>();
  for (const row of termResult.rows as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    const value = Number(row.numeric_value);
    if (Number.isFinite(id) && Number.isFinite(value)) {
      numericValues.set(id, value);
    }
  }

  const aggregateAliases = [...sql.matchAll(/native_numeric\.(value_count|value_sum|value_min|value_max|value_avg) AS (a\d+)/g)]
    .map((match) => ({ column: match[1], alias: match[2] }));
  const constrainedBindings = applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows)
    .filter((bindings) => numericValues.has(bindings.get(numericSlot) ?? -1));
  const groups = new Map<string, Array<Map<number, number>>>();
  for (const bindings of constrainedBindings) {
    const key = groupSlots.length === 0
      ? '__all__'
      : groupSlots.map((slot) => bindings.get(slot) ?? -1).join(':');
    groups.set(key, [...(groups.get(key) ?? []), bindings]);
  }
  if (groups.size === 0 && groupSlots.length === 0) {
    groups.set('__all__', []);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, groupBindings]) => {
      const first = groupBindings[0] ?? new Map<number, number>();
      const values = groupBindings
        .map((bindings) => numericValues.get(bindings.get(numericSlot) ?? -1))
        .filter((value): value is number => value !== undefined);
      const aggregateValues = numericDistinct ? [...new Set(values)] : values;
      const sum = aggregateValues.reduce((total, value) => total + value, 0);
      const summary: Record<string, number | null> = {
        value_count: aggregateValues.length,
        value_sum: sum,
        value_min: aggregateValues.length > 0 ? Math.min(...aggregateValues) : null,
        value_max: aggregateValues.length > 0 ? Math.max(...aggregateValues) : null,
        value_avg: aggregateValues.length > 0 ? sum / aggregateValues.length : null,
      };
      const row: Record<string, unknown> = {
        value_count: summary.value_count,
      };
      groupSlots.forEach((slot, index) => {
        row[`v${index}`] = first.get(slot);
      });
      aggregateAliases.forEach(({ column, alias }) => {
        row[alias] = summary[column];
      });
      return row;
    });
}

function applyXpodRdfExtensionValues(
  bindingsList: Array<Map<number, number>>,
  valueSlots: number[],
  valueRows: number[],
): Array<Map<number, number>> {
  if (valueSlots.length === 0) {
    return bindingsList;
  }
  const output: Array<Map<number, number>> = [];
  for (let index = 0; index < valueRows.length; index += valueSlots.length) {
    const tuple = valueRows.slice(index, index + valueSlots.length);
    for (const bindings of bindingsList) {
      let matched = true;
      for (const [slotIndex, slot] of valueSlots.entries()) {
        const value = bindings.get(slot);
        if (value !== tuple[slotIndex]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        output.push(bindings);
      }
    }
  }
  return output;
}

const XPOD_RDF_EXTENSION_INDEX_COLUMNS: Record<string, string[]> = {
  rdf_quads_spog_perm: ['subject_id', 'predicate_id', 'object_id', 'graph_id'],
  rdf_quads_sopg_perm: ['subject_id', 'object_id', 'predicate_id', 'graph_id'],
  rdf_quads_psog_perm: ['predicate_id', 'subject_id', 'object_id', 'graph_id'],
  rdf_quads_posg_perm: ['predicate_id', 'object_id', 'subject_id', 'graph_id'],
  rdf_quads_ospg_perm: ['object_id', 'subject_id', 'predicate_id', 'graph_id'],
  rdf_quads_opsg_perm: ['object_id', 'predicate_id', 'subject_id', 'graph_id'],
};

const XPOD_RDF_EXTENSION_FULL_FILTER_COLUMNS = ['graph_id', 'subject_id', 'predicate_id', 'object_id'];

const XPOD_RDF_EXTENSION_PROJECT_COLUMNS: Record<number, string> = {
  1: 'graph_id',
  2: 'subject_id',
  3: 'predicate_id',
  4: 'object_id',
};

class StringIntegerPgPool {
  private readonly db: PGlite;

  public constructor(dataDir: string) {
    this.db = new PGlite(dataDir);
  }

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    await this.db.waitReady;
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows.map(stringIntegerRow),
    };
  }

  public async connect(): Promise<StringIntegerPgClient> {
    await this.db.waitReady;
    return new StringIntegerPgClient(this.db);
  }

  public async end(): Promise<void> {
    await this.db.close();
  }
}

class StringIntegerPgClient {
  public constructor(private readonly db: PGlite) {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows.map(stringIntegerRow),
    };
  }

  public release(): void {}
}

function stringIntegerRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    isPgIntegerResultKey(key) && typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : value,
  ]));
}

function isPgIntegerResultKey(key: string): boolean {
  return key === 'id'
    || key.endsWith('_id')
    || key === 'count'
    || key === 'term_count'
    || key === 'quad_count'
    || key === 'source_count'
    || key === 'graph_count'
    || /^(?:v|a)\d+$/.test(key);
}
