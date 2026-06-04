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
  type RdfPgAccelerationStats,
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
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf3x-native-'));
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

  it('installs and uses the schema-local xpod_rdf cache ABI for the result-cache profile', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-sql-abi-cache-'));
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
        provider: 'sql-abi',
        capabilities: ['cache.result'],
        capabilityProviders: {
          'cache.result': 'sql-abi',
        },
        requiredCapabilities: ['cache.result'],
        missingCapabilities: [],
        activeOperators: ['cache.result'],
      });

      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan).toContain('XpodRdfExtensionResultCacheStore');
      expect(first.metrics.plan).toContain('PostgresResultCacheStore');
      expect(first.metrics.plan).toContain('XpodRdfExtensionUnsupported(scan.exact_graph)');

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('XpodRdfExtensionResultCacheProbe');
      expect(second.metrics.plan).toContain('PostgresResultCacheHit');
      expect(second.metrics.plan).not.toContain('XpodRdfExtensionUnsupported(scan.exact_graph)');
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

  it('falls back to PostgreSQL facts for query shapes outside the native fast path', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-facts-query-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);

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

  it('keeps same-pattern repeated variables on the native PostgreSQL path', async () => {
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

  it('runs grouped count HAVING/order/limit as native PostgreSQL RDF-3X SQL', async () => {
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

  it('runs non-grouped numeric aggregates as native PostgreSQL RDF-3X SQL', async () => {
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

  it('restores PostgreSQL string integer aliases for native group joins', async () => {
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

  it('enables PostgreSQL SQL hot operators without requiring a native extension', async () => {
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
        capabilities: [
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
          'join.required_bgp',
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ],
        capabilityProviders: {
          'aggregate.count': 'engine-sql',
          'aggregate.numeric': 'engine-sql',
          'cache.result': 'sql-abi',
          'join.required_bgp': 'engine-sql',
          'scan.exact_graph': 'engine-sql',
          'scan.graph_prefix': 'engine-sql',
          'scan.term_in': 'engine-sql',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
          'join.required_bgp',
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
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ],
      });

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
      expect(scanResult.metrics.plan).not.toContain('XpodRdfExtensionFallback(extension-missing)');
      expect(scanResult.metrics.plan).not.toContain('XpodRdfExtensionUnsupported(scan.exact_graph)');

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

  it('does not enable the custom-index profile without a native xpod_rdf extension', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-custom-index-missing-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      rdfAccelerationProfile: 'pg-custom-index',
    });

    try {
      await engine.open();
      expect((await engine.storageStats()).pgAcceleration).toMatchObject({
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: false,
        provider: 'engine-sql',
        capabilities: [
          'aggregate.count',
          'aggregate.numeric',
          'cache.result',
          'join.required_bgp',
          'scan.exact_graph',
          'scan.graph_prefix',
          'scan.term_in',
        ],
        missingCapabilities: ['index.xpod_rdf_perm'],
        fallbackReason: 'capability-missing',
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes simple pg-custom-index queries through the native extension scan ABI', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-scan-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      scanPgExtensionQuadIds(resolved: unknown): Promise<Array<{
        graph_id: number;
        subject_id: number;
        predicate_id: number;
        object_id: number;
      }>>;
      countPgExtensionQuads(resolved: unknown): Promise<number>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const status = namedNode(STATUS);
    const open = literal('open');
    let scanCalls = 0;

    try {
      await engine.open();
      await engine.put(quad(message, status, open, graph));
      const dictionary = internals.requireDictionary();
      const graphId = await dictionary.find(graph);
      const subjectId = await dictionary.find(message);
      const predicateId = await dictionary.find(status);
      const objectId = await dictionary.find(open);
      expect(graphId).toBeDefined();
      expect(subjectId).toBeDefined();
      expect(predicateId).toBeDefined();
      expect(objectId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'cache.result',
          'index.xpod_rdf_perm',
          'scan.exact_graph',
          'scan.term_in',
        ],
        capabilityProviders: {
          'cache.result': 'extension',
          'index.xpod_rdf_perm': 'extension',
          'scan.exact_graph': 'extension',
          'scan.term_in': 'extension',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.term_in',
          'cache.result',
          'index.xpod_rdf_perm',
        ],
        missingCapabilities: [],
        activeOperators: [
          'cache.result',
          'index.xpod_rdf_perm',
          'scan.exact_graph',
          'scan.term_in',
        ],
      };
      internals.scanPgExtensionQuadIds = async () => {
        scanCalls++;
        return [{
          graph_id: graphId as number,
          subject_id: subjectId as number,
          predicate_id: predicateId as number,
          object_id: objectId as number,
        }];
      };
      internals.countPgExtensionQuads = async () => 1;

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: status,
            object: open,
          },
        ],
        select: ['message'],
        cache: { mode: 'bypass' },
      });

      expect(scanCalls).toBe(1);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.indexChoices).toEqual(['xpod_rdf.scan_quads']);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(scan.exact_graph)');
      expect(result.metrics.plan).toContain('XpodRdfExtensionScan(scan_quads)');
      expect(result.metrics.plan).toContain('PostgresRdfExtensionSinglePattern(graph:NamedNode:https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl,subject:?message,predicate:NamedNode:https://undefineds.co/ns#status,object:Literal:open)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes exact pg-custom-index queries through direct native perm index scan when available', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-perm-scan-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      requireExecutor(): {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
      };
      scanPgExtensionQuadIds(resolved: unknown): Promise<Array<{
        graph_id: number;
        subject_id: number;
        predicate_id: number;
        object_id: number;
      }>>;
      countPgExtensionQuads(resolved: unknown): Promise<number>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const status = namedNode(STATUS);
    const open = literal('open');
    const observedSql: string[] = [];
    let observedParams: unknown[] | undefined;

    try {
      await engine.open();
      const originalExecutor = internals.requireExecutor();
      await engine.put(quad(message, status, open, graph));
      const dictionary = internals.requireDictionary();
      const graphId = await dictionary.find(graph);
      const subjectId = await dictionary.find(message);
      const predicateId = await dictionary.find(status);
      const objectId = await dictionary.find(open);
      expect(graphId).toBeDefined();
      expect(subjectId).toBeDefined();
      expect(predicateId).toBeDefined();
      expect(objectId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'scan.exact_graph',
          'scan.term_in',
        ],
        capabilityProviders: {
          'cache.result': 'extension',
          'index.xpod_rdf_perm': 'extension',
          'index.xpod_rdf_perm.scan': 'extension',
          'scan.exact_graph': 'extension',
          'scan.term_in': 'extension',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.term_in',
          'cache.result',
          'index.xpod_rdf_perm',
        ],
        missingCapabilities: [],
        activeOperators: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'scan.exact_graph',
          'scan.term_in',
        ],
      };
      internals.scanPgExtensionQuadIds = async () => {
        throw new Error('scan_quads should not be used when direct perm index scan is available');
      };
      internals.countPgExtensionQuads = async () => {
        throw new Error('count_quads should not be used when direct perm index scan is available');
      };
      internals.requireExecutor = () => ({
        query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
          if (sql.includes('xpod_rdf.perm_index_scan')) {
            observedSql.push(sql);
            observedParams = params;
            if (sql.includes('COUNT(*) AS count')) {
              return [{ count: 1 }] as T[];
            }
            return [{
              graph_id: graphId as number,
              subject_id: subjectId as number,
              predicate_id: predicateId as number,
              object_id: objectId as number,
            }] as T[];
          }
          return originalExecutor.query<T>(sql, params);
        },
      });

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: status,
            object: open,
          },
        ],
        select: ['message'],
        cache: { mode: 'bypass' },
      });

      expect(observedSql[0]).toContain("xpod_rdf.perm_index_scan('rdf_quads_posg_perm'::regclass");
      expect(observedSql[0]).toContain('JOIN rdf_quads q');
      expect(observedSql[0]).toContain('q.ctid = idx.heap_tid');
      expect(observedSql[0]).toContain('q.predicate_id = idx.key1');
      expect(observedSql[0]).toContain('q.object_id = idx.key2');
      expect(observedParams?.slice(0, 2)).toEqual([predicateId, objectId]);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.indexChoices).toEqual(['xpod_rdf.perm_index_scan(POS,prefix:2)']);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(index.xpod_rdf_perm.scan)');
      expect(result.metrics.plan).toContain('XpodRdfCustomIndexScan(perm_index_scan:POS,prefix:2)');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionScan(scan_quads)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes term-in pg-custom-index queries through direct native perm index array-prefix scan when available', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-perm-scan-any-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      requireExecutor(): {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
      };
      scanPgExtensionQuadIds(resolved: unknown): Promise<Array<{
        graph_id: number;
        subject_id: number;
        predicate_id: number;
        object_id: number;
      }>>;
      countPgExtensionQuads(resolved: unknown): Promise<number>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const otherMessage = namedNode(`${graph.value}#msg_2`);
    const status = namedNode(STATUS);
    const thread = namedNode(THREAD);
    const open = literal('open');
    const observedSql: string[] = [];
    let observedParams: unknown[] | undefined;

    try {
      await engine.open();
      const originalExecutor = internals.requireExecutor();
      await engine.put(quad(message, status, open, graph));
      await engine.put(quad(otherMessage, thread, open, graph));
      const dictionary = internals.requireDictionary();
      const graphId = await dictionary.find(graph);
      const subjectId = await dictionary.find(message);
      const predicateId = await dictionary.find(status);
      const alternatePredicateId = await dictionary.find(thread);
      const objectId = await dictionary.find(open);
      expect(graphId).toBeDefined();
      expect(subjectId).toBeDefined();
      expect(predicateId).toBeDefined();
      expect(alternatePredicateId).toBeDefined();
      expect(objectId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'index.xpod_rdf_perm.scan_any',
          'scan.exact_graph',
          'scan.term_in',
        ],
        capabilityProviders: {
          'cache.result': 'extension',
          'index.xpod_rdf_perm': 'extension',
          'index.xpod_rdf_perm.scan': 'extension',
          'index.xpod_rdf_perm.scan_any': 'extension',
          'scan.exact_graph': 'extension',
          'scan.term_in': 'extension',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.term_in',
          'cache.result',
          'index.xpod_rdf_perm',
        ],
        missingCapabilities: [],
        activeOperators: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'index.xpod_rdf_perm.scan_any',
          'scan.exact_graph',
          'scan.term_in',
        ],
      };
      internals.scanPgExtensionQuadIds = async () => {
        throw new Error('scan_quads should not be used when direct perm index scan_any is available');
      };
      internals.countPgExtensionQuads = async () => {
        throw new Error('count_quads should not be used when direct perm index scan_any is available');
      };
      internals.requireExecutor = () => ({
        query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
          if (sql.includes('xpod_rdf.perm_index_scan_any')) {
            observedSql.push(sql);
            observedParams = params;
            if (sql.includes('COUNT(*) AS count')) {
              return [{ count: 1 }] as T[];
            }
            return [{
              graph_id: graphId as number,
              subject_id: subjectId as number,
              predicate_id: predicateId as number,
              object_id: objectId as number,
            }] as T[];
          }
          return originalExecutor.query<T>(sql, params);
        },
      });

      const result = await engine.query({
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: { $in: [status, thread] },
            object: open,
          },
        ],
        select: ['message'],
        cache: { mode: 'bypass' },
      });

      expect(observedSql[0]).toContain("xpod_rdf.perm_index_scan_any('rdf_quads_posg_perm'::regclass");
      expect(observedSql[0]).toContain('q.predicate_id = idx.key1');
      expect(observedSql[0]).toContain('q.object_id = idx.key2');
      expect(observedSql[0]).toContain('q.predicate_id = ANY');
      expect(observedParams?.[0]).toEqual([predicateId, alternatePredicateId]);
      expect(observedParams?.[1]).toEqual([objectId]);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.indexChoices).toEqual(['xpod_rdf.perm_index_scan_any(POS,prefix:2)']);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(index.xpod_rdf_perm.scan_any)');
      expect(result.metrics.plan).toContain('XpodRdfCustomIndexScan(perm_index_scan_any:POS,prefix:2)');
      expect(result.metrics.plan).not.toContain('XpodRdfExtensionScan(scan_quads)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to native scan_quads for term-in pg-custom-index queries when scan_any is unavailable', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-perm-scan-any-missing-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      requireExecutor(): {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
      };
      scanPgExtensionQuadIds(resolved: unknown): Promise<Array<{
        graph_id: number;
        subject_id: number;
        predicate_id: number;
        object_id: number;
      }>>;
      countPgExtensionQuads(resolved: unknown): Promise<number>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const status = namedNode(STATUS);
    const thread = namedNode(THREAD);
    const open = literal('open');
    let scanCalls = 0;
    const observedSql: string[] = [];

    try {
      await engine.open();
      const originalExecutor = internals.requireExecutor();
      await engine.put(quad(message, status, open, graph));
      const dictionary = internals.requireDictionary();
      const graphId = await dictionary.find(graph);
      const subjectId = await dictionary.find(message);
      const predicateId = await dictionary.find(status);
      const objectId = await dictionary.find(open);
      expect(graphId).toBeDefined();
      expect(subjectId).toBeDefined();
      expect(predicateId).toBeDefined();
      expect(objectId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'scan.exact_graph',
          'scan.term_in',
        ],
        capabilityProviders: {
          'cache.result': 'extension',
          'index.xpod_rdf_perm': 'extension',
          'index.xpod_rdf_perm.scan': 'extension',
          'scan.exact_graph': 'extension',
          'scan.term_in': 'extension',
        },
        requiredCapabilities: [
          'scan.exact_graph',
          'scan.term_in',
          'cache.result',
          'index.xpod_rdf_perm',
        ],
        missingCapabilities: [],
        activeOperators: [
          'cache.result',
          'index.xpod_rdf_perm',
          'index.xpod_rdf_perm.scan',
          'scan.exact_graph',
          'scan.term_in',
        ],
      };
      internals.requireExecutor = () => ({
        query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
          observedSql.push(sql);
          if (sql.includes('xpod_rdf.perm_index_scan_any')) {
            throw new Error('perm_index_scan_any should not be called without its extension capability');
          }
          return originalExecutor.query<T>(sql, params);
        },
      });
      internals.scanPgExtensionQuadIds = async () => {
        scanCalls++;
        return [{
          graph_id: graphId as number,
          subject_id: subjectId as number,
          predicate_id: predicateId as number,
          object_id: objectId as number,
        }];
      };
      internals.countPgExtensionQuads = async () => 1;

      const result = await engine.query({
        patterns: [
          {
            subject: { variable: 'message' },
            predicate: { $in: [status, thread] },
            object: { variable: 'value' },
          },
        ],
        select: ['message', 'value'],
        cache: { mode: 'bypass' },
      });

      expect(scanCalls).toBe(1);
      expect(observedSql.join('\n')).not.toContain('xpod_rdf.perm_index_scan_any');
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.bindings.map((binding) => binding.value.value)).toEqual([open.value]);
      expect(result.metrics.indexChoices).toEqual(['xpod_rdf.scan_quads']);
      expect(result.metrics.plan).toContain('XpodRdfExtensionScan(scan_quads)');
      expect(result.metrics.plan).not.toContain('XpodRdfCustomIndexScan(perm_index_scan_any:');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes graph-prefix pg-custom-index queries through the native extension scan ABI', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-graph-prefix-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      pgExtensionQuadScanParams(resolved: unknown): unknown[];
      scanPgExtensionQuadIds(resolved: unknown): Promise<Array<{
        graph_id: number;
        subject_id: number;
        predicate_id: number;
        object_id: number;
      }>>;
      countPgExtensionQuads(resolved: unknown): Promise<number>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const status = namedNode(STATUS);
    const open = literal('open');
    const prefix = 'https://pod.example/alice/.data/chat/default/';
    const prefixHead = rdfTermValueHead(prefix);
    let observedParams: unknown[] | undefined;

    try {
      await engine.open();
      await engine.put(quad(message, status, open, graph));
      const dictionary = internals.requireDictionary();
      const graphId = await dictionary.find(graph);
      const subjectId = await dictionary.find(message);
      const predicateId = await dictionary.find(status);
      const objectId = await dictionary.find(open);
      expect(graphId).toBeDefined();
      expect(subjectId).toBeDefined();
      expect(predicateId).toBeDefined();
      expect(objectId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-custom-index',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'cache.result',
          'index.xpod_rdf_perm',
          'scan.graph_prefix',
          'scan.term_in',
        ],
        capabilityProviders: {
          'cache.result': 'extension',
          'index.xpod_rdf_perm': 'extension',
          'scan.graph_prefix': 'extension',
          'scan.term_in': 'extension',
        },
        requiredCapabilities: [
          'scan.graph_prefix',
          'scan.term_in',
          'cache.result',
          'index.xpod_rdf_perm',
        ],
        missingCapabilities: [],
        activeOperators: [
          'cache.result',
          'index.xpod_rdf_perm',
          'scan.graph_prefix',
          'scan.term_in',
        ],
      };
      internals.scanPgExtensionQuadIds = async (resolved) => {
        observedParams = internals.pgExtensionQuadScanParams(resolved);
        return [{
          graph_id: graphId as number,
          subject_id: subjectId as number,
          predicate_id: predicateId as number,
          object_id: objectId as number,
        }];
      };
      internals.countPgExtensionQuads = async () => 1;

      const result = await engine.query({
        patterns: [
          {
            graph: { $startsWith: prefix },
            subject: { variable: 'message' },
            predicate: status,
            object: { $in: [open] },
          },
        ],
        select: ['message'],
        cache: { mode: 'bypass' },
      });

      expect(observedParams?.slice(4, 8)).toEqual([
        prefixHead,
        `${prefixHead}\uffff`,
        prefix,
        `${prefix}\uffff`,
      ]);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.indexChoices).toEqual(['xpod_rdf.scan_quads']);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(scan.graph_prefix)');
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(scan.term_in)');
      expect(result.metrics.plan).toContain('XpodRdfExtensionScan(scan_quads)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes required BGP joins through the native extension plan ABI', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-join-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      queryPgExtensionJsonRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const message = namedNode(`${graph.value}#msg_1`);
    let extensionCalls = 0;
    let observedSql = '';

    try {
      await engine.open();
      await engine.put([
        quad(message, namedNode(THREAD), thread, graph),
        quad(message, namedNode(STATUS), literal('open'), graph),
      ]);
      const dictionary = internals.requireDictionary();
      const messageId = await dictionary.find(message);
      expect(messageId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-hot-operators',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'join.required_bgp',
        ],
        capabilityProviders: {
          'join.required_bgp': 'extension',
        },
        requiredCapabilities: [
          'join.required_bgp',
        ],
        missingCapabilities: [],
        activeOperators: [
          'join.required_bgp',
        ],
      };
      internals.queryPgExtensionJsonRows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
        extensionCalls++;
        observedSql = sql;
        return [{ v0: messageId }] as T[];
      };

      const result = await engine.query({
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
        cache: { mode: 'bypass' },
      });

      expect(extensionCalls).toBe(1);
      expect(observedSql).toContain('JOIN rdf_quads');
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.indexChoices[0]).toMatch(/^xpod_rdf\.execute_plan_json\(Rdf3xJoinBGP\(/u);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(join.required_bgp)');
      expect(result.metrics.plan).toContain('XpodRdfExtensionJoin(execute_plan_json)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('routes aggregate hot operators through the native extension plan ABI', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-extension-aggregate-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const internals = engine as unknown as {
      pgAcceleration: RdfPgAccelerationStats;
      requireDictionary(): {
        find(term: unknown): Promise<number | undefined>;
      };
      queryPgExtensionJsonRows<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
    };
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    let extensionCalls = 0;
    const observedSql: string[] = [];

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(PRIORITY), literal('10', namedNode(XSD_DECIMAL)), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(PRIORITY), literal('20', namedNode(XSD_DECIMAL)), graph),
      ]);
      const dictionary = internals.requireDictionary();
      const threadId = await dictionary.find(thread);
      expect(threadId).toBeDefined();

      internals.pgAcceleration = {
        profile: 'pg-hot-operators',
        requested: true,
        available: true,
        enabled: true,
        provider: 'extension',
        version: '0.1.0-native',
        capabilities: [
          'aggregate.count',
          'aggregate.numeric',
          'join.required_bgp',
        ],
        capabilityProviders: {
          'aggregate.count': 'extension',
          'aggregate.numeric': 'extension',
          'join.required_bgp': 'extension',
        },
        requiredCapabilities: [
          'aggregate.count',
          'aggregate.numeric',
          'join.required_bgp',
        ],
        missingCapabilities: [],
        activeOperators: [
          'aggregate.count',
          'aggregate.numeric',
          'join.required_bgp',
        ],
      };
      internals.queryPgExtensionJsonRows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
        extensionCalls++;
        observedSql.push(sql);
        if (/SELECT COUNT\(\*\) AS count/u.test(sql)) {
          return [{ count: 1 }] as T[];
        }
        return [{ v1: threadId, a0: 2, a1: 30 }] as T[];
      };

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

      expect(extensionCalls).toBe(2);
      expect(observedSql[0]).toContain('GROUP BY source.v1');
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].thread.value).toBe(thread.value);
      expect(result.bindings[0].messageCount.value).toBe('2');
      expect(result.bindings[0].priorityTotal.value).toBe('30');
      expect(result.metrics.indexChoices[0]).toMatch(/^xpod_rdf\.execute_plan_json\(Rdf3xJoinBGP\(/u);
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(aggregate.count)');
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(aggregate.numeric)');
      expect(result.metrics.plan).toContain('XpodRdfPgHotOperator(join.required_bgp)');
      expect(result.metrics.plan).toContain('XpodRdfExtensionAggregate(execute_plan_json)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('projects native custom-index storage stats when pg-custom-index is enabled', async () => {
    const engine = new PostgresRdfEngine({
      driver: 'pg',
      connectionString: 'postgres://unused',
      rdfAccelerationProfile: 'pg-custom-index',
    });
    const internals = engine as unknown as {
      executor: {
        query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
        exec(sql: string, params?: unknown[]): Promise<void>;
        transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
        close(): Promise<void>;
      };
      pgAcceleration: RdfPgAccelerationStats;
      pgAccelerationStats(): Promise<RdfPgAccelerationStats>;
    };

    internals.executor = {
      async query<T = Record<string, unknown>>(_sql: string, params?: unknown[]): Promise<T[]> {
        expect(params?.[0]).toEqual(expect.arrayContaining([
          'rdf_quads_spog_perm',
          'rdf_quads_opsg_perm',
        ]));
        return [
          {
            name: 'rdf_quads_spog_perm',
            bytes: '8192',
            pages: '1',
            stats_json: JSON.stringify({
              layout: 'compressed-posting-v1',
              compressed: true,
              schemaVersion: 2,
              hasMetapage: true,
              globalSorted: true,
              prefixStatsExact: true,
              nkeys: 4,
              tupleCount: 10,
              distinctPrefix1: 2,
              distinctPrefix2: 3,
              distinctPrefix3: 4,
              distinctPrefix4: 4,
              avgPostingsPerPrefix1: 5,
              avgPostingsPerPrefix2: 3.333333,
              avgPostingsPerPrefix3: 2.5,
              avgPostingsPerPrefix4: 2.5,
              pageTupleCount: 10,
              itemCount: 4,
              postingCount: 10,
              dataPages: 1,
              emptyPages: 0,
              sortedPages: 1,
              unsortedPages: 0,
              minTuplesPerPage: 10,
              maxTuplesPerPage: 10,
              avgTuplesPerPage: 10,
              avgPostingsPerItem: 2.5,
              itemBytes: 480,
              freeBytes: 7000,
              avgEntryBytes: 48,
            }),
            probe_json: JSON.stringify({
              probe: 'prefix-equality-v1',
              layout: 'compressed-posting-v1',
              nkeys: 4,
              prefixKeys: 1,
              globalSorted: true,
              pages: 3,
              firstDataBlock: 1,
              startBlock: 2,
              dataPages: 1,
              seekPagesExamined: 1,
              pagesVisited: 1,
              pagesSkipped: 1,
              pagesSkippedBeforeLower: 0,
              pagesSkippedPastUpper: 1,
              pagesSkippedByRange: 0,
              stoppedAtUpperBound: true,
              pageLocalSeeks: 1,
              itemsExamined: 1,
              itemsMatched: 1,
              postingsMatched: 5,
            }),
          },
        ] as T[];
      },
      async exec(): Promise<void> {},
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(this);
      },
      async close(): Promise<void> {},
    };
    internals.pgAcceleration = {
      profile: 'pg-custom-index',
      requested: true,
      available: true,
      enabled: true,
      provider: 'extension',
      version: '0.1.0-native',
      capabilities: [
        'aggregate.count',
        'aggregate.numeric',
        'cache.result',
        'index.xpod_rdf_perm',
        'join.required_bgp',
        'scan.exact_graph',
        'scan.graph_prefix',
        'scan.term_in',
      ],
      requiredCapabilities: [
        'scan.exact_graph',
        'scan.graph_prefix',
        'scan.term_in',
        'join.required_bgp',
        'aggregate.count',
        'aggregate.numeric',
        'cache.result',
        'index.xpod_rdf_perm',
      ],
      missingCapabilities: [],
      activeOperators: [
        'aggregate.count',
        'aggregate.numeric',
        'cache.result',
        'index.xpod_rdf_perm',
        'join.required_bgp',
        'scan.exact_graph',
        'scan.graph_prefix',
        'scan.term_in',
      ],
    };

    await expect(internals.pgAccelerationStats()).resolves.toMatchObject({
      profile: 'pg-custom-index',
      enabled: true,
      customIndexes: [
        {
          name: 'rdf_quads_spog_perm',
          permutation: 'SPO',
          accessMethod: 'xpod_rdf_perm',
          layout: 'compressed-posting-v1',
          compressed: true,
          bytes: 8192,
          pages: 1,
          schemaVersion: 2,
          hasMetapage: true,
          globalSorted: true,
          prefixStatsExact: true,
          nkeys: 4,
          tupleCount: 10,
          distinctPrefix1: 2,
          distinctPrefix2: 3,
          distinctPrefix3: 4,
          distinctPrefix4: 4,
          avgPostingsPerPrefix1: 5,
          avgPostingsPerPrefix2: 3.333333,
          avgPostingsPerPrefix3: 2.5,
          avgPostingsPerPrefix4: 2.5,
          pageTupleCount: 10,
          itemCount: 4,
          postingCount: 10,
          dataPages: 1,
          sortedPages: 1,
          avgTuplesPerPage: 10,
          avgPostingsPerItem: 2.5,
          itemBytes: 480,
          freeBytes: 7000,
          avgEntryBytes: 48,
          probe: {
            probe: 'prefix-equality-v1',
            layout: 'compressed-posting-v1',
            nkeys: 4,
            prefixKeys: 1,
            globalSorted: true,
            pages: 3,
            firstDataBlock: 1,
            startBlock: 2,
            dataPages: 1,
            seekPagesExamined: 1,
            pagesVisited: 1,
            pagesSkipped: 1,
            pagesSkippedBeforeLower: 0,
            pagesSkippedPastUpper: 1,
            pagesSkippedByRange: 0,
            stoppedAtUpperBound: true,
            pageLocalSeeks: 1,
            itemsExamined: 1,
            itemsMatched: 1,
            postingsMatched: 5,
          },
        },
      ],
    });
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

  it('wires cloud RDF storage to the PostgreSQL RDF engine', async () => {
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
  });
});

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
