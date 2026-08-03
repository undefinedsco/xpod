import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import type { Literal, NamedNode, Term } from '@rdfjs/types';
import { PGlite } from '@electric-sql/pglite';
import {
  PostgresRdfEngine,
  buildRdfModelsBenchmarkSeed,
  defaultSyntheticMessagesForRdfModelsScale,
  rdfModelsBenchmarkCasesForProfile,
  rdfModelsQueryBenchmarkCasesForProfile,
  rdfModelsPostgresMaterializedQueryBenchmarkCaseNames,
  rdfModelsPostgresQueryBenchmarkCasesForProfile,
  rdfModelsSearchFusionQueryBenchmarkCaseNames,
  rdfModelsBenchmarkSyntheticPodCount,
  runRdfModelsPostgresBenchmark,
  seedRdfModelsSearchFusionIndexes,
  applyRdfAccessScope,
  type RdfPgAccelerationProfile,
  type RdfQuery,
  type RdfQueryResult,
  type RdfVectorIndexLike,
  type RdfVectorSearchOptions,
  type RdfVectorSearchResult,
} from '../../../src/storage/rdf';
import { rdfTermValueHead } from '../../../src/storage/rdf/RdfTermDictionary';

const { literal, namedNode, quad } = DataFactory;

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const CONTENT = 'http://rdfs.org/sioc/ns#content';
const CREATED = 'http://purl.org/dc/terms/created';

function expectLiteral(term: Term): Literal {
  if (term.termType !== 'Literal') {
    throw new Error(`Expected literal term, got ${term.termType}`);
  }
  return term;
}
const PRIORITY = 'https://undefineds.co/ns#priority';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const STATUS = 'https://undefineds.co/ns#status';
const THREAD = 'https://undefineds.co/ns#thread';
const ACP = 'http://www.w3.org/ns/solid/acp#';

function stringList(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !(Symbol.iterator in value)) {
    return [];
  }
  return Array.from(value as Iterable<unknown>).filter((entry): entry is string => typeof entry === 'string');
}

vi.setConfig({ testTimeout: 60_000 });

describe('PostgresRdfEngine', () => {
  it('keeps the product path on ordinary B-tree permutations without CRv2 configuration', async () => {
    const engineSource = await readFile(
      path.resolve(__dirname, '../../../src/storage/rdf/PostgresRdfEngine.ts'),
      'utf8',
    );

    for (const token of [
      'index.xpod_rdf_perm',
      'USING xpod_rdf_perm',
      'ensurePgCustomIndexes',
      'deferPgCustomIndexInitialization',
      "'pg-custom-index'",
      'perm_index_scan',
      'perm_index_count',
      'perm_index_distinct',
    ]) {
      expect(engineSource).not.toContain(token);
    }
    expect(engineSource).toContain('CREATE INDEX IF NOT EXISTS rdf_quads_spog ON rdf_quads');
  });
  it('covers shared models resource surfaces in the RDF benchmark definitions', () => {
    const scanCaseNames = new Set(rdfModelsBenchmarkCasesForProfile('default').map((testCase) => testCase.name));
    const queryCaseNames = new Set(rdfModelsQueryBenchmarkCasesForProfile('default').map((testCase) => testCase.name));

    for (const caseName of [
      'list chats',
      'list tasks',
      'list threads by chat',
      'threads by modeled chat relation',
      'list threads by task',
      'messages by modeled thread relation',
      'chat latest message pointer',
      'list messages by thread',
      'latest message',
      'latest run',
      'pending runs',
      'running runs',
      'runs by workspace',
      'runs by numeric priority',
      'run with steps',
      'task materialization due time',
      'cron tasks due time',
      'waiting input runs',
      'runs by lease owner',
      'search message literals',
      'load by exact id',
      'acl graph prefix scoped query',
      'load webid profile',
      'profile public read acl',
      'profile public read acr',
      'list issues',
      'pending approvals',
      'active autonomy grants',
      'list inbox notifications',
      'list providers',
      'models by provider',
      'credentials by provider',
      'list agents',
      'list contacts',
      'list favorites',
      'list sessions',
      'active sessions',
      'audit entries by actor',
      'list settings',
      'sensitive settings',
      'list ai configs',
      'active vector stores',
      'indexed files by status',
      'running agent statuses',
      'oauth credentials expiring',
      'reply messages',
      'routed messages by target agent',
    ]) {
      expect(scanCaseNames.has(caseName), `${caseName} should be in shared models scan benchmark cases`).toBe(true);
    }

    for (const caseName of [
      'latest message by thread query',
      'thread message keyset page query',
      'thread context window query',
      'modeled thread message page query',
      'chat latest message hydration query',
      'thread chat hydration query',
      'next queued run by workspace query',
      'run steps by run query',
      'task run execution detail query',
      'task materialization active due query',
      'scheduled task trigger query',
      'scheduled task trigger keyset continuation query',
      'leased running run query',
      'provider model credential join query',
      'provider model credential VALUES join query',
      'provider model credential ordered join query',
      'ai credential selection query',
      'provider model credential count query',
      'provider credential grouped count query',
      'provider credential single-pattern grouped count query',
      'provider credential fail count aggregate query',
      'oauth credential expiry query',
      'profile acl authorization join query',
      'profile acr authorization join query',
      'profile inbox activity join query',
      'approval grant action match query',
      'settings owner category query',
      'settings owner category keyset query',
      'favorite target chat join query',
      'contact entity profile join query',
      'active session thread hydration query',
      'message reply chain query',
      'routed message agent query',
      'audit approval policy trace query',
      'ai config embedding model query',
      'vector indexed file store query',
      'message count by thread with having',
      'queued run priority numeric aggregate',
      'message score by thread numeric aggregate',
      'message join count distinct',
    ]) {
      expect(queryCaseNames.has(caseName), `${caseName} should be in shared models query benchmark cases`).toBe(true);
    }

    expect(rdfModelsPostgresQueryBenchmarkCasesForProfile('fusion').map((testCase) => testCase.name)).toEqual(
      rdfModelsSearchFusionQueryBenchmarkCaseNames(),
    );
    expect(rdfModelsPostgresQueryBenchmarkCasesForProfile('all').map((testCase) => testCase.name)).toEqual(
      expect.arrayContaining(rdfModelsSearchFusionQueryBenchmarkCaseNames()),
    );
  });

  it('pushes slot term-key ranges into PostgreSQL RDF scans', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-slot-range-'));
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
      await engine.replaceSource([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('open'), graph),
        quad(message3, namedNode(STATUS), literal('open'), graph),
      ], {
        source: graph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.data/chat/default/2026/05/18/messages.ttl',
        contentType: 'text/turtle',
        sourceVersion: 'v1',
      });

      const dictionary = (engine as unknown as { requireDictionary(): { find(term: unknown): Promise<number | undefined> } }).requireDictionary();
      const message2Id = await dictionary.find(message2);
      expect(message2Id).toBeTypeOf('number');

      const result = await engine.scan({
        pattern: {
          graph,
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
        options: {
          slotTermRanges: [{
            slot: 'subject',
            lower: message2Id!,
            upper: message2Id! + 1,
            lowerInclusive: true,
            upperExclusive: true,
          }],
        },
      });

      expect(result.quads.map((entry) => entry.subject.value)).toEqual([message2.value]);
      expect(result.metrics.queryPlan?.join('\n')).toContain('TermKeyRange(subject)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

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
      expect(expectLiteral(datatypeScan.quads[0].object).datatype.value).toBe(XSD_INTEGER);

      const languageScan = await engine.scan({
        pattern: {
          graph,
          subject: run,
          predicate: namedNode(LABEL),
          object: { $language: 'fr' },
        },
      });
      expect(languageScan.quads).toHaveLength(1);
      expect(expectLiteral(languageScan.quads[0].object).language).toBe('fr');

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
  }, 30_000);

  it('reports cold-start lifecycle stats in storage stats', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-lifecycle-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      maintenanceIntervalMs: 0,
    });

    try {
      await engine.open();
      const storage = await engine.storageStats();

      expect(storage.lifecycle).toMatchObject({
        status: 'ready',
        driver: 'pglite',
        openCount: 1,
        coldStart: {
          maintenanceEnabled: false,
          ownsTextIndex: false,
          ownsVectorIndex: false,
        },
      });
      expect(storage.lifecycle?.lastOpenStartedAt).toEqual(expect.any(String));
      expect(storage.lifecycle?.lastReadyAt).toEqual(expect.any(String));
      expect(storage.lifecycle?.lastOpenDurationMs).toEqual(expect.any(Number));
      expect(storage.lifecycle?.lastOpenDurationMs).toBeGreaterThanOrEqual(0);
      expect(storage.lifecycle?.coldStart?.durationMs).toBe(storage.lifecycle?.lastOpenDurationMs);
      expect(storage.lifecycle?.coldStart?.phases.map((phase) => phase.name)).toEqual(expect.arrayContaining([
        'executor',
        'text-index',
        'vector-index',
        'term-dictionary',
        'schema',
        'acceleration-probe',
        'native-sparql-probe',
        'maintenance-scheduler',
      ]));
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports PostgreSQL facts histogram distributions for planner cost input', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-facts-histogram-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryExplainSlowMs: 0,
      queryExplainSlowQueryMaxEntries: 4,
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const messageType = namedNode('https://type/Message');
    const tag = namedNode('https://p/tag');
    const chatGraph = namedNode('https://g/chat');
    const taskGraph = namedNode('https://g/task');
    const message1 = namedNode('https://message/1');
    const message2 = namedNode('https://message/2');
    const task1 = namedNode('https://task/1');

    try {
      await engine.open();
      await engine.put([
        quad(message1, rdfType, messageType, chatGraph),
        quad(message2, rdfType, messageType, chatGraph),
        quad(message1, namedNode(STATUS), literal('open'), chatGraph),
        quad(message2, namedNode(STATUS), literal('open'), chatGraph),
        quad(message1, tag, literal('alpha', 'en'), chatGraph),
        quad(message1, tag, literal('beta', 'en'), chatGraph),
        quad(task1, namedNode(STATUS), literal('open'), taskGraph),
        quad(task1, namedNode(PRIORITY), literal('10', namedNode(XSD_INTEGER)), taskGraph),
      ]);

      const facts = (await engine.storageStats()).facts;

      expect(facts.literalDatatypeDistribution[0]).toMatchObject({
        datatype: XSD_STRING,
        termCount: 1,
        objectQuadCount: 3,
      });
      expect(facts.literalDatatypeDistribution).toEqual(expect.arrayContaining([
        expect.objectContaining({
          datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
          termCount: 2,
          objectQuadCount: 2,
        }),
        expect.objectContaining({
          datatype: XSD_INTEGER,
          termCount: 1,
          objectQuadCount: 1,
        }),
      ]));
      expect(facts.cardinalityDistributions.graphs[0]).toMatchObject({
        graph: {
          value: chatGraph.value,
          kind: 'iri',
        },
        quadCount: 6,
        distinctSubjects: 2,
        distinctPredicates: 3,
        distinctObjects: 4,
      });
      expect(facts.cardinalityDistributions.predicates[0]).toMatchObject({
        predicate: {
          value: STATUS,
          kind: 'iri',
        },
        quadCount: 3,
        graphCount: 2,
        distinctSubjects: 3,
        distinctObjects: 1,
      });
      expect(facts.cardinalityDistributions.predicateObjects[0]).toMatchObject({
        predicate: {
          value: STATUS,
        },
        object: {
          value: 'open',
          kind: 'literal',
          datatype: XSD_STRING,
        },
        quadCount: 3,
        graphCount: 2,
        distinctSubjects: 3,
      });
      expect(facts.cardinalityDistributions.subjectPredicates[0]).toMatchObject({
        subject: {
          value: message1.value,
        },
        predicate: {
          value: tag.value,
        },
        quadCount: 2,
        graphCount: 1,
        distinctObjects: 2,
      });

      const result = await engine.query({
        patterns: [
          {
            graph: chatGraph,
            subject: { variable: 'message' },
            predicate: namedNode(STATUS),
            object: literal('open'),
          },
        ],
        select: ['message'],
      });
      expect(result.bindings.map((binding) => binding.message.value).sort()).toEqual([
        message1.value,
        message2.value,
      ]);
      expect(result.metrics.explain?.planner).toMatchObject({
        reasons: expect.arrayContaining([
          'histogram-graph-cardinality-available',
          'histogram-predicate-cardinality-available',
          'histogram-predicate-object-cardinality-available',
          'runtime-scan-rows-reported',
        ]),
        estimateInputs: expect.arrayContaining([
          'facts.graphCardinality',
          'facts.predicateCardinality',
          'facts.predicateObjectCardinality',
          'query.metrics.scannedRows',
        ]),
        runtime: {
          scannedRows: 2,
          joinedRows: 2,
          returnedRows: 2,
          indexChoices: expect.arrayContaining([expect.any(String)]),
          planSize: expect.any(Number),
        },
        staleStats: {
          factsDataVersion: 1,
          rdf3xFactsDataVersion: 1,
          stale: false,
          lag: 0,
        },
        histogramHints: expect.arrayContaining([
          expect.objectContaining({
            kind: 'graph',
            patternIndex: 0,
            graph: expect.objectContaining({ value: chatGraph.value }),
            quadCount: 6,
          }),
          expect.objectContaining({
            kind: 'predicate',
            patternIndex: 0,
            predicate: expect.objectContaining({ value: STATUS }),
            quadCount: 3,
          }),
          expect.objectContaining({
            kind: 'predicate-object',
            patternIndex: 0,
            predicate: expect.objectContaining({ value: STATUS }),
            object: expect.objectContaining({ value: 'open', datatype: XSD_STRING }),
            quadCount: 3,
          }),
        ]),
      });

      const subjectPredicateResult = await engine.query({
        patterns: [
          {
            graph: chatGraph,
            subject: message1,
            predicate: tag,
            object: { variable: 'tag' },
          },
        ],
        select: ['tag'],
      });
      expect(subjectPredicateResult.bindings.map((binding) => binding.tag.value).sort()).toEqual([
        'alpha',
        'beta',
      ]);
      expect(subjectPredicateResult.metrics.explain?.planner).toMatchObject({
        reasons: expect.arrayContaining([
          'histogram-subject-predicate-cardinality-available',
        ]),
        estimateInputs: expect.arrayContaining([
          'facts.subjectPredicateCardinality',
        ]),
        histogramHints: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subject-predicate',
            patternIndex: 0,
            subject: expect.objectContaining({ value: message1.value }),
            predicate: expect.objectContaining({ value: tag.value }),
            quadCount: 2,
          }),
        ]),
      });

      const slowQueryStats = (await engine.storageStats()).slowQueries;
      expect(slowQueryStats?.entries[0]).toMatchObject({
        selectedPath: 'rdf3x',
        histogramHints: expect.arrayContaining([
          expect.objectContaining({
            kind: 'subject-predicate',
            patternIndex: 0,
            subject: expect.objectContaining({ value: message1.value }),
            predicate: expect.objectContaining({ value: tag.value }),
            quadCount: 2,
          }),
        ]),
      });
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

  it('rewrites safe named-node URI terms in Postgres without changing quad membership', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    await engine.open();
    await engine.replaceSource([
      quad(
        namedNode('https://pod.example/old/data.ttl#this'),
        namedNode('https://schema.org/name'),
        literal('Demo'),
        namedNode('https://pod.example/old/data.ttl'),
      ),
    ], {
      source: 'https://pod.example/old/data.ttl',
      workspace: 'https://pod.example/',
      localPath: 'old/data.ttl',
      contentType: 'text/turtle',
    });

    const result = await engine.rewriteTerms({
      oldPrefix: 'https://pod.example/old/',
      newPrefix: 'https://pod.example/new/',
      scope: 'safe_projection',
      mode: 'safe',
    });

    expect(result).toMatchObject({ matchedTerms: 2, rewrittenTerms: 2, remappedTerms: 0, affectedQuads: 1 });
    const oldScan = await engine.scan({ pattern: { graph: namedNode('https://pod.example/old/data.ttl') } });
    expect(oldScan.quads).toHaveLength(0);
    const newScan = await engine.scan({ pattern: { graph: namedNode('https://pod.example/new/data.ttl') } });
    expect(newScan.quads).toHaveLength(1);
    expect(newScan.quads[0].subject.value).toBe('https://pod.example/new/data.ttl#this');
    await engine.close();
  });

  it('keeps sibling Postgres RDF graph URIs outside exact rewrite boundaries', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-sibling-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const oldGraph = namedNode('https://pod.example/old/data.ttl');
    const newGraph = namedNode('https://pod.example/new/data.ttl');
    const siblingGraph = namedNode('https://pod.example/old/data.ttl.bak');
    const oldSubject = namedNode('https://pod.example/old/data.ttl#this');
    const siblingSubject = namedNode('https://pod.example/old/data.ttl.bak#this');
    const name = namedNode('https://schema.org/name');

    try {
      await engine.open();
      await engine.replaceSource([
        quad(oldSubject, name, literal('Moving'), oldGraph),
      ], {
        source: oldGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl',
        contentType: 'text/turtle',
      });
      await engine.replaceSource([
        quad(siblingSubject, name, literal('Sibling'), siblingGraph),
      ], {
        source: siblingGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl.bak',
        contentType: 'text/turtle',
      });

      const result = await engine.rewriteTerms({
        oldPrefix: oldGraph.value,
        newPrefix: newGraph.value,
        scope: 'safe_projection',
        mode: 'safe',
      });

      expect(result).toMatchObject({ matchedTerms: 2, rewrittenTerms: 2, remappedTerms: 0, affectedQuads: 1 });
      expect(result.skippedTerms).toEqual([]);

      const oldScan = await engine.scan({ pattern: { graph: oldGraph } });
      expect(oldScan.quads).toHaveLength(0);

      const newScan = await engine.scan({ pattern: { graph: newGraph } });
      expect(newScan.quads).toHaveLength(1);
      expect(newScan.quads[0].subject.value).toBe('https://pod.example/new/data.ttl#this');

      const siblingScan = await engine.scan({ pattern: { graph: siblingGraph } });
      expect(siblingScan.quads).toHaveLength(1);
      expect(siblingScan.quads[0].subject.value).toBe(siblingSubject.value);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('skips mixed Postgres RDF term rewrite usage in sibling graph exact boundary scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-sibling-mixed-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const oldGraph = namedNode('https://pod.example/old/data.ttl');
    const newGraph = namedNode('https://pod.example/new/data.ttl');
    const siblingGraph = namedNode('https://pod.example/old/data.ttl.bak');
    const sharedTerm = namedNode('https://pod.example/old/data.ttl#this');
    const siblingSubject = namedNode('https://pod.example/old/data.ttl.bak#this');
    const name = namedNode('https://schema.org/name');
    const about = namedNode('https://schema.org/about');

    try {
      await engine.open();
      await engine.replaceSource([
        quad(sharedTerm, name, literal('Moving'), oldGraph),
      ], {
        source: oldGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl',
        contentType: 'text/turtle',
      });
      await engine.replaceSource([
        quad(siblingSubject, about, sharedTerm, siblingGraph),
      ], {
        source: siblingGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl.bak',
        contentType: 'text/turtle',
      });

      const result = await engine.rewriteTerms({
        oldPrefix: oldGraph.value,
        newPrefix: newGraph.value,
        scope: 'safe_projection',
        mode: 'safe',
      });

      expect(result).toMatchObject({ matchedTerms: 2, rewrittenTerms: 1, remappedTerms: 0, affectedQuads: 1 });
      expect(result.skippedTerms).toEqual([
        expect.objectContaining({
          value: sharedTerm.value,
          reason: 'mixed_usage',
        }),
      ]);

      const oldScan = await engine.scan({ pattern: { graph: oldGraph } });
      expect(oldScan.quads).toHaveLength(0);

      const newScan = await engine.scan({ pattern: { graph: newGraph } });
      expect(newScan.quads).toHaveLength(1);
      expect(newScan.quads[0].subject.value).toBe(sharedTerm.value);

      const siblingScan = await engine.scan({ pattern: { graph: siblingGraph } });
      expect(siblingScan.quads).toHaveLength(1);
      expect(siblingScan.quads[0].subject.value).toBe(siblingSubject.value);
      expect(siblingScan.quads[0].object.value).toBe(sharedTerm.value);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('skips mixed Postgres RDF term rewrite usage outside the moved graph scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-mixed-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const movingGraph = namedNode('https://pod.example/old/data.ttl');
    const newGraph = namedNode('https://pod.example/new/data.ttl');
    const sharedTerm = namedNode('https://pod.example/old/data.ttl#this');
    const unrelatedGraph = namedNode('https://pod.example/notes/other.ttl');
    const unrelatedSubject = namedNode('https://pod.example/notes/other.ttl#note');
    const name = namedNode('https://schema.org/name');
    const about = namedNode('https://schema.org/about');

    try {
      await engine.open();
      await engine.replaceSource([
        quad(sharedTerm, name, literal('Demo'), movingGraph),
      ], {
        source: movingGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl',
        contentType: 'text/turtle',
      });
      await engine.replaceSource([
        quad(unrelatedSubject, about, sharedTerm, unrelatedGraph),
      ], {
        source: unrelatedGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'notes/other.ttl',
        contentType: 'text/turtle',
      });

      const result = await engine.rewriteTerms({
        oldPrefix: 'https://pod.example/old/',
        newPrefix: 'https://pod.example/new/',
        scope: 'safe_projection',
        mode: 'safe',
      });

      expect(result).toMatchObject({
        matchedTerms: 2,
        rewrittenTerms: 1,
        remappedTerms: 0,
        affectedQuads: 1,
      });
      expect(result.skippedTerms).toEqual([
        expect.objectContaining({
          value: sharedTerm.value,
          reason: expect.stringMatching(/^(mixed_usage|outside_scope)$/),
        }),
      ]);

      const oldGraphScan = await engine.scan({ pattern: { graph: movingGraph } });
      expect(oldGraphScan.quads).toHaveLength(0);

      const newGraphScan = await engine.scan({ pattern: { graph: newGraph } });
      expect(newGraphScan.quads).toHaveLength(1);
      expect(newGraphScan.quads[0].subject.value).toBe(sharedTerm.value);

      const unrelatedScan = await engine.scan({ pattern: { graph: unrelatedGraph } });
      expect(unrelatedScan.quads).toHaveLength(1);
      expect(unrelatedScan.quads[0].object.value).toBe(sharedTerm.value);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('moves Postgres RDF source metadata so deleting the new source removes moved quads', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-source-move-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const oldGraph = namedNode('https://pod.example/old/data.ttl');
    const newSource = 'https://pod.example/new/data.ttl';
    const subject = namedNode('https://pod.example/old/data.ttl#this');
    const name = namedNode('https://schema.org/name');

    try {
      await engine.open();
      await engine.replaceSource([
        quad(subject, name, literal('Demo'), oldGraph),
      ], {
        source: oldGraph.value,
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl',
        contentType: 'text/turtle',
      });

      await expect(engine.moveSource(oldGraph.value, {
        source: newSource,
        workspace: 'https://pod.example/',
        localPath: 'new/data.ttl',
        contentType: 'text/turtle',
        sourceVersion: 'moved-v1',
      })).resolves.toBeGreaterThanOrEqual(1);

      await expect(engine.deleteSource(oldGraph.value)).resolves.toBe(0);
      await expect(engine.deleteSource(newSource)).resolves.toBe(1);
      const remaining = await engine.scan({ pattern: { graph: oldGraph } });
      expect(remaining.quads).toHaveLength(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns zero result when Postgres RDF term rewrite new prefix is empty', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-rewrite-empty-new-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });

    try {
      await engine.open();
      await engine.replaceSource([
        quad(
          namedNode('https://pod.example/old/data.ttl#this'),
          namedNode('https://schema.org/name'),
          literal('Demo'),
          namedNode('https://pod.example/old/data.ttl'),
        ),
      ], {
        source: 'https://pod.example/old/data.ttl',
        workspace: 'https://pod.example/',
        localPath: 'old/data.ttl',
        contentType: 'text/turtle',
      });

      const result = await engine.rewriteTerms({
        oldPrefix: 'https://pod.example/old/',
        newPrefix: '',
        scope: 'safe_projection',
        mode: 'safe',
      });

      expect(result).toEqual({ matchedTerms: 0, rewrittenTerms: 0, remappedTerms: 0, skippedTerms: [], affectedQuads: 0 });
      const oldScan = await engine.scan({ pattern: { graph: namedNode('https://pod.example/old/data.ttl') } });
      expect(oldScan.quads).toHaveLength(1);
      expect(oldScan.quads[0].subject.value).toBe('https://pod.example/old/data.ttl#this');
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
      });
      expect(refresh.rdf3x?.plannerStats?.analyzedTables).toEqual(expect.arrayContaining([
        'rdf_terms',
        'rdf_quads',
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
      expect(join.metrics.explain?.planner).toMatchObject({
        selectedPath: 'rdf3x',
        reasons: expect.arrayContaining([
          'rdf3x-sql-path-selected',
          'join-order-by-pattern-cardinality',
        ]),
        estimateInputs: expect.arrayContaining([
          'facts.exactPatternCounts',
        ]),
        availableStats: expect.arrayContaining([
          'facts.cardinalityDistributions',
          'rdf3x.projectionStats',
        ]),
      });

      const files = await readdir(dataDir);
      expect(files.some((entry) => entry.includes('rdf-cache.sqlite'))).toBe(false);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('marks PostgreSQL RDF-3X subject-star joins for product detail queries', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-subject-star-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const thread = namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1');
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      await engine.put([
        quad(message, namedNode(THREAD), thread, graph),
        quad(message, namedNode(STATUS), literal('open'), graph),
        quad(message, namedNode(PRIORITY), literal('5', namedNode(XSD_INTEGER)), graph),
      ]);

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
            object: { variable: 'status' },
          },
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(PRIORITY),
            object: { variable: 'priority' },
          },
        ],
        select: ['message', 'status', 'priority'],
        cache: { mode: 'bypass' },
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.metrics.plan).toContain('PostgresRdf3xSubjectStarJoin(?message;patterns:3)');
      expect(result.metrics.plan.some((entry) => entry.startsWith('PostgresRdf3xJoin('))).toBe(true);
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
        hitCount: 1,
        missCount: 1,
        storeCount: 1,
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

  it('prunes PostgreSQL query result cache rows by exact access scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-scope-prune-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxBytes: 1024 * 1024,
      materializedResultCacheMaxBytes: 1024 * 1024,
      queryTemplateCacheMaxEntries: 8,
      derivedCacheScopeMaxBytes: 30_000,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const scopeFor = (principal: string, permissionVersion: string) => ({
      principal,
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read',
      authorizationModel: 'acr',
      permissionVersion,
      allowedGraphUrls: [graph.value],
    });
    const queryForScope = (
      scope: ReturnType<typeof scopeFor>,
      materialized?: string,
    ): RdfQuery => ({
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
          predicate: namedNode(CONTENT),
          object: { variable: 'content' },
        },
      ],
      select: ['message', 'content'],
      cache: {
        scope,
        ...(materialized ? { materialized } : {}),
      },
    });
    const aliceScope = scopeFor('https://id.example/alice/profile/card#me', 'acl-v1');
    const bobScope = scopeFor('https://id.example/bob/profile/card#me', 'acl-v2');

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      await engine.put(quad(message, namedNode(CONTENT), literal('x'.repeat(20_000)), graph));

      const alice = await engine.query(queryForScope(aliceScope));
      expect(alice.metrics.plan).toContain('PostgresResultCacheStore');

      const bob = await engine.query(queryForScope(bobScope));
      expect(bob.metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 2,
        scopeCount: 2,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const bobMaterialized = await engine.query(queryForScope(
        bobScope,
        'chat/default/open-messages-with-content',
      ));
      expect(bobMaterialized.metrics.plan).toContain('PostgresMaterializedResultStore');

      const storage = await engine.storageStats();
      expect(storage.derivedCache?.evictions.scopeBytes).toBeGreaterThan(0);
      expect(storage.queryResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
      expect(storage.materializedResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });

      const aliceAgain = await engine.query(queryForScope(aliceScope));
      expect(aliceAgain.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(aliceAgain.metrics.plan).toContain('PostgresResultCacheHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports PostgreSQL derived cache access-scope drill-down entries', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-cache-scope-stats-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxBytes: 1024 * 1024,
      materializedResultCacheMaxBytes: 1024 * 1024,
      derivedCacheScopeMaxBytes: 1024 * 1024,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const scopeFor = (principal: string, permissionVersion: string) => ({
      principal,
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read',
      authorizationModel: 'acr',
      permissionVersion,
      allowedGraphUrls: [graph.value],
    });
    const queryForScope = (
      scope: ReturnType<typeof scopeFor>,
      materialized?: string,
    ): RdfQuery => ({
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
          predicate: namedNode(CONTENT),
          object: { variable: 'content' },
        },
      ],
      select: ['message', 'content'],
      cache: {
        scope,
        ...(materialized ? { materialized } : {}),
      },
    });
    const aliceScope = scopeFor('https://id.example/alice/profile/card#me', 'acl-v1');
    const bobScope = scopeFor('https://id.example/bob/profile/card#me', 'acl-v2');

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      await engine.put(quad(message, namedNode(CONTENT), literal('scope drill-down payload'), graph));

      await engine.query(queryForScope(aliceScope));
      await engine.query(queryForScope(bobScope));
      await engine.query(queryForScope(bobScope, 'chat/default/open-messages-with-content'));

      const storage = await engine.storageStats();
      expect(storage.derivedCache?.scopeVersionCount).toBe(2);
      expect(storage.derivedCache?.scopeEntries).toHaveLength(2);

      const [largest, second] = storage.derivedCache?.scopeEntries ?? [];
      expect(largest).toMatchObject({
        principal: 'https://id.example/bob/profile/card#me',
        basePath: 'https://pod.example/alice/.data/',
        mode: 'read',
        authorizationModel: 'acr',
        permissionVersion: 'acl-v2',
        queryResultEntries: 1,
        materializedResultEntries: 1,
      });
      expect(largest.payloadBytes).toBeGreaterThan(largest.queryResultPayloadBytes);
      expect(largest.materializedResultPayloadBytes).toBeGreaterThan(0);
      expect(second).toMatchObject({
        principal: 'https://id.example/alice/profile/card#me',
        permissionVersion: 'acl-v1',
        queryResultEntries: 1,
        materializedResultEntries: 0,
      });
      expect(second.payloadBytes).toBe(second.queryResultPayloadBytes);

      const limitedStorage = await engine.storageStats({ cacheScope: { limit: 1 } });
      expect(limitedStorage.derivedCache?.scopeVersionCount).toBe(2);
      expect(limitedStorage.derivedCache?.scopeEntries).toHaveLength(1);

      const aliceStorage = await engine.storageStats({ cacheScope: { query: 'acl-v1' } });
      expect(aliceStorage.derivedCache?.scopeVersionCount).toBe(1);
      expect(aliceStorage.derivedCache?.scopeEntries).toHaveLength(1);
      expect(aliceStorage.derivedCache?.scopeEntries[0]).toMatchObject({
        principal: 'https://id.example/alice/profile/card#me',
        permissionVersion: 'acl-v1',
      });

      const emptyStorage = await engine.storageStats({ cacheScope: { query: 'charlie' } });
      expect(emptyStorage.derivedCache?.scopeVersionCount).toBe(0);
      expect(emptyStorage.derivedCache?.scopeEntries).toEqual([]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prunes PostgreSQL query result cache by payload bytes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-bytes-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxBytes: 1,
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
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(first.metrics.plan).toContain('PostgresResultCacheStore');
      expect(first.metrics.explain?.cache?.result).toMatchObject({
        status: 'miss',
        maxBytes: 1,
        stored: true,
      });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 0,
        payloadBytes: 0,
        maxPayloadBytes: 1,
      });

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(second.metrics.plan).not.toContain('PostgresResultCacheHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('isolates and invalidates PostgreSQL query result cache entries by structured access scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-cache-access-scope-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const accessScope = (permissionVersion: string, allowedGraphUrls = [graph.value, 'https://pod.example/alice/.data/profile/card']) => ({
      principal: 'https://id.example/alice/profile/card#me',
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read',
      authorizationModel: 'acr',
      permissionVersion,
      allowedGraphUrls,
    });
    const queryForScope = (scope: ReturnType<typeof accessScope>): RdfQuery => ({
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

      const v1 = await engine.query(queryForScope(accessScope('acl-v1')));
      expect(v1.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(v1.metrics.plan).toContain('PostgresResultCacheStore');
      expect(v1.metrics.explain).toMatchObject({
        engine: 'postgres-rdf',
        cache: {
          result: {
            status: 'miss',
            stored: true,
          },
          materialized: {
            status: 'not-applicable',
          },
          scope: {
            principal: 'https://id.example/alice/profile/card#me',
            basePath: 'https://pod.example/alice/.data/',
            mode: 'read',
            authorizationModel: 'acr',
            permissionVersion: 'acl-v1',
          },
        },
      });
      expect(v1.metrics.explain?.factsDataVersion).toBeGreaterThan(0);
      expect(v1.metrics.explain?.cache?.scope?.hash).toEqual(expect.any(String));
      expect(v1.metrics.explain?.cache?.scope?.shape).toEqual(expect.any(String));

      const v1SameScopeDifferentOrder = await engine.query(queryForScope(accessScope(
        'acl-v1',
        ['https://pod.example/alice/.data/profile/card', graph.value],
      )));
      expect(v1SameScopeDifferentOrder.metrics.plan).toContain('PostgresResultCacheHit');
      expect(v1SameScopeDifferentOrder.metrics.explain?.cache?.result).toMatchObject({
        status: 'hit',
      });

      const v2 = await engine.query(queryForScope(accessScope('acl-v2')));
      expect(v2.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(v2.metrics.plan).toContain('PostgresResultCacheStore');
      expect(v2.metrics.plan).not.toContain('PostgresResultCacheHit');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 2,
        scopeCount: 2,
      });

      const deleted = await engine.invalidateQueryResultCache(accessScope('acl-v1'));
      expect(deleted).toBe(1);

      const afterInvalidation = await engine.query(queryForScope(accessScope('acl-v1')));
      expect(afterInvalidation.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(afterInvalidation.metrics.plan).toContain('PostgresResultCacheStore');

      const v2StillCached = await engine.query(queryForScope(accessScope('acl-v2')));
      expect(v2StillCached.metrics.plan).toContain('PostgresResultCacheHit');
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

  it('uses PostgreSQL materialized result cache by facts version without populating the ordinary result cache', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-materialized-cache-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryExplainSlowMs: 0,
      queryExplainSlowQueryMaxEntries: 2,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
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
      orderBy: [{ variable: 'message' }],
      cache: {
        materialized: { key: 'chat/default/open-messages', version: 'v1' },
      },
    };

    try {
      await engine.open();
      await engine.put(quad(message1, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(first.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(first.metrics.plan).toContain('PostgresMaterializedResultStore');
      expect(first.metrics.plan.join('\n')).not.toContain('PostgresResultCacheStore');

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(second.metrics.plan).toContain('PostgresMaterializedResultHit');
      expect(second.metrics.plan.some((entry) => entry.startsWith('PostgresMaterializedResultTemplate('))).toBe(true);
      expect(second.metrics.plan.join('\n')).not.toContain('PostgresResultCacheHit');
      expect(second.metrics.explain).toMatchObject({
        engine: 'postgres-rdf',
        cache: {
          materialized: {
            status: 'hit',
          },
          result: {
            status: 'not-applicable',
          },
        },
      });
      const templateKey = second.metrics.explain?.cache?.template?.key;
      expect(templateKey).toEqual(expect.any(String));
      expect(second.metrics.explain?.planner).toMatchObject({
        selectedPath: 'materialized-result-cache',
        reasons: expect.arrayContaining([
          'materialized-result-cache-hit',
        ]),
        estimateInputs: expect.arrayContaining([
          'facts.dataVersion',
          'query.cache.scope',
        ]),
      });
      expect(second.metrics.explain?.cache?.materialized?.key).toEqual(expect.any(String));
      expect(second.metrics.explain?.cache?.materialized?.templateKey).toBe(templateKey);
      expect(second.metrics.explain?.cache?.materialized?.factsDataVersion).toBeGreaterThan(0);
      const executor = (engine as unknown as {
        requireExecutor(): { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
      }).requireExecutor();
      const materializedRows = await executor.query<{ template_key: string }>(`
        SELECT template_key
        FROM rdf_materialized_result_cache
      `);
      expect(materializedRows).toEqual([{ template_key: templateKey }]);
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
        hitCount: 1,
        missCount: 1,
        storeCount: 1,
      });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({
        entryCount: 0,
      });

      await engine.put(quad(message2, namedNode(STATUS), literal('open'), graph));
      const afterWrite = await engine.query(query);
      expect(afterWrite.bindings.map((binding) => binding.message.value)).toEqual([message1.value, message2.value]);
      expect(afterWrite.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(afterWrite.metrics.plan).toContain('PostgresMaterializedResultStore');
      expect(afterWrite.metrics.plan).not.toContain('PostgresMaterializedResultHit');
      const storage = await engine.storageStats();
      expect(storage.materializedResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
        hitCount: 1,
        missCount: 2,
        storeCount: 2,
      });
      expect(storage.slowQueries?.entries[0]).toMatchObject({
        templateKey: afterWrite.metrics.explain?.cache?.template?.key,
        selectedPath: 'rdf3x',
        cache: {
          resultStatus: 'not-applicable',
          materializedStatus: 'miss',
          result: {
            status: 'not-applicable',
          },
          materialized: {
            status: 'miss',
            key: afterWrite.metrics.explain?.cache?.materialized?.key,
            templateKey: afterWrite.metrics.explain?.cache?.template?.key,
            factsDataVersion: afterWrite.metrics.explain?.cache?.materialized?.factsDataVersion,
            stored: true,
          },
        },
      });
      const factsVersionEvictions = storage.derivedCache?.evictions.factsVersion;
      expect(storage.derivedCache).toMatchObject({
        evictionCount: expect.any(Number),
        evictions: {
          factsVersion: expect.any(Number),
        },
      });
      expect(factsVersionEvictions).toBeGreaterThan(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('builds n-column materialized views and joins active rows as query values', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-materialized-view-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryExplainSlowMs: 0,
      queryExplainSlowQueryMaxEntries: 2,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const thread = namedNode(`${graph.value}#thread_a`);
    const scope = { principal: 'https://pod.example/alice/profile/card#me', basePath: 'https://pod.example/alice/' };
    const viewKey = 'models/chat/default/open-message-thread-view';
    const viewQuery: RdfQuery = {
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
      orderBy: [{ variable: 'message' }],
      cache: { mode: 'bypass', scope },
    };

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message1, namedNode(THREAD), thread, graph),
        quad(message1, namedNode(CONTENT), literal('first open'), graph),
        quad(message2, namedNode(STATUS), literal('closed'), graph),
        quad(message2, namedNode(THREAD), thread, graph),
        quad(message2, namedNode(CONTENT), literal('second later open'), graph),
      ]);

      const firstBuild = await engine.materializeView({
        key: viewKey,
        version: 'v1',
        query: viewQuery,
        variables: ['message', 'thread'],
        scope,
      });
      expect(firstBuild).toMatchObject({
        key: viewKey,
        version: 'v1',
        rowCount: 1,
        variables: ['message', 'thread'],
        active: true,
      });

      const firstView = await engine.readMaterializedView({ key: viewKey, version: 'v1', scope });
      expect(firstView).toMatchObject({
        key: viewKey,
        version: 'v1',
        rowCount: 1,
        variables: ['message', 'thread'],
        active: true,
      });
      expect(firstView?.rows.map((row) => ({
        message: row.message.value,
        thread: row.thread.value,
      }))).toEqual([{ message: message1.value, thread: thread.value }]);
      await expect(engine.readMaterializedView({ key: viewKey, version: 'v1' })).resolves.toBeUndefined();

      const firstJoin = await engine.query({
        materializedViews: [
          { key: viewKey, version: 'v1', scope, variables: ['message'] },
        ],
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(CONTENT),
            object: { variable: 'content' },
          },
        ],
        select: ['message', 'content'],
        orderBy: [{ variable: 'message' }],
        cache: { mode: 'bypass' },
      });
      expect(firstJoin.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(firstJoin.bindings.map((binding) => binding.content.value)).toEqual(['first open']);
      expect(firstJoin.metrics.plan).toContain('Rdf3xJoinTupleValues(?message)');

      await engine.put(quad(message2, namedNode(STATUS), literal('open'), graph));
      const secondBuild = await engine.materializeView({
        key: viewKey,
        version: 'v1',
        query: viewQuery,
        variables: ['message', 'thread'],
        scope,
        activate: false,
      });
      expect(secondBuild.rowCount).toBe(2);
      expect(secondBuild.factsDataVersion).toBeGreaterThan(firstBuild.factsDataVersion);
      expect(secondBuild.active).toBe(false);

      const beforeCutover = await engine.query({
        materializedViews: [
          { key: viewKey, version: 'v1', scope, variables: ['message'] },
        ],
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(CONTENT),
            object: { variable: 'content' },
          },
        ],
        select: ['message', 'content'],
        orderBy: [{ variable: 'message' }],
        cache: { mode: 'bypass' },
      });
      expect(beforeCutover.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);

      await expect(engine.activateMaterializedView({
        key: viewKey,
        version: 'v1',
        scope,
        factsDataVersion: secondBuild.factsDataVersion,
      })).resolves.toMatchObject({
        key: viewKey,
        version: 'v1',
        factsDataVersion: secondBuild.factsDataVersion,
        previousFactsDataVersion: firstBuild.factsDataVersion,
        activated: true,
      });

      const secondJoin = await engine.query({
        materializedViews: [
          { key: viewKey, version: 'v1', scope, variables: ['message'] },
        ],
        patterns: [
          {
            graph,
            subject: { variable: 'message' },
            predicate: namedNode(CONTENT),
            object: { variable: 'content' },
          },
        ],
        select: ['message', 'content'],
        orderBy: [{ variable: 'message' }],
        cache: { mode: 'bypass' },
      });
      expect(secondJoin.bindings.map((binding) => binding.message.value)).toEqual([message1.value, message2.value]);
      expect(secondJoin.bindings.map((binding) => binding.content.value)).toEqual(['first open', 'second later open']);

      const executor = (engine as unknown as {
        requireExecutor(): { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
      }).requireExecutor();
      const activeRows = await executor.query<{ count: number | string }>(`
        SELECT COUNT(*) AS count
        FROM rdf_materialized_views
        WHERE view_key = $1
          AND view_version = $2
          AND active = TRUE
      `, [viewKey, 'v1']);
      expect(Number(activeRows[0]?.count ?? 0)).toBe(1);
      const activeCells = await executor.query<{ count: number | string }>(`
        SELECT COUNT(*) AS count
        FROM rdf_materialized_view_cells cell
        JOIN rdf_materialized_views view
          ON view.view_key = cell.view_key
         AND view.view_version = cell.view_version
         AND view.scope_hash = cell.scope_hash
         AND view.facts_data_version = cell.facts_data_version
        WHERE view.view_key = $1
          AND view.view_version = $2
          AND view.active = TRUE
      `, [viewKey, 'v1']);
      expect(Number(activeCells[0]?.count ?? 0)).toBe(4);

      await expect(engine.query({
        materializedViews: [{ key: viewKey, version: 'v1', scope: { principal: 'https://pod.example/bob/profile/card#me' } }],
        patterns: [],
        select: ['message'],
        cache: { mode: 'bypass' },
      })).rejects.toThrow(/materialized view is not active/);

      await expect(engine.deleteMaterializedView({ key: viewKey, version: 'v1', scope })).resolves.toBe(2);
      await expect(engine.readMaterializedView({ key: viewKey, version: 'v1', scope })).resolves.toBeUndefined();
      const remainingCells = await executor.query<{ count: number | string }>(`
        SELECT COUNT(*) AS count
        FROM rdf_materialized_view_cells
        WHERE view_key = $1
          AND view_version = $2
      `, [viewKey, 'v1']);
      expect(Number(remainingCells[0]?.count ?? 0)).toBe(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('explores schema and autocomplete candidates from RDF facts', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-schema-explorer-'));
    const engine = new PostgresRdfEngine({ driver: 'pglite', dataDir });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const otherGraph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const run = namedNode(`${otherGraph.value}#run_1`);
    const messageClass = namedNode('https://schema.example/Message');
    const runClass = namedNode('https://schema.example/Run');
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

    try {
      await engine.open();
      await engine.put([
        quad(message, rdfType, messageClass, graph),
        quad(message, namedNode(STATUS), literal('open'), graph),
        quad(message, namedNode(CONTENT), literal('schema explorer message'), graph),
        quad(run, rdfType, runClass, otherGraph),
        quad(run, namedNode(STATUS), literal('running'), otherGraph),
      ]);

      const all = await engine.exploreSchema({ limit: 10 });
      expect(all.graphs.map((entry) => entry.graph.value)).toEqual(expect.arrayContaining([graph.value, otherGraph.value]));
      expect(all.predicates.map((entry) => entry.predicate.value)).toEqual(expect.arrayContaining([
        rdfType.value,
        STATUS,
        CONTENT,
      ]));
      expect(all.classes.map((entry) => entry.object.value)).toEqual(expect.arrayContaining([
        messageClass.value,
        runClass.value,
      ]));
      expect(all.terms.map((entry) => entry.term.value)).toEqual(expect.arrayContaining([
        message.value,
        messageClass.value,
        STATUS,
      ]));

      const chatOnlyMessage = await engine.exploreSchema({
        query: 'message',
        graphPrefix: 'https://pod.example/alice/.data/chat/',
        limit: 10,
      });
      expect(chatOnlyMessage.graphs.map((entry) => entry.graph.value)).toEqual([graph.value]);
      expect(chatOnlyMessage.classes.map((entry) => entry.object.value)).toEqual([messageClass.value]);
      expect(chatOnlyMessage.terms.map((entry) => entry.term.value)).toEqual(expect.arrayContaining([
        message.value,
        messageClass.value,
      ]));
      expect(chatOnlyMessage.terms.map((entry) => entry.term.value)).not.toContain(run.value);

      const statusOnly = await engine.exploreSchema({ query: 'status', limit: 5 });
      expect(statusOnly.predicates.map((entry) => entry.predicate.value)).toEqual([STATUS]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('searches bounded RDF paths with predicate, direction, and graph-prefix limits', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-path-search-'));
    const engine = new PostgresRdfEngine({ driver: 'pglite', dataDir });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const otherGraph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    const a = namedNode(`${graph.value}#a`);
    const b = namedNode(`${graph.value}#b`);
    const c = namedNode(`${graph.value}#c`);
    const d = namedNode(`${graph.value}#d`);
    const outside = namedNode(`${otherGraph.value}#outside`);
    const replyTo = namedNode('http://rdfs.org/sioc/ns#has_reply');
    const mentions = namedNode('https://schema.org/mentions');

    try {
      await engine.open();
      await engine.put([
        quad(a, replyTo, b, graph),
        quad(b, replyTo, c, graph),
        quad(a, mentions, d, graph),
        quad(a, replyTo, outside, otherGraph),
      ]);

      const forward = await engine.searchPaths({
        start: a,
        target: c,
        predicates: [replyTo],
        graphPrefix: 'https://pod.example/alice/.data/chat/',
        maxDepth: 2,
        maxPaths: 5,
      });
      expect(forward).toMatchObject({
        truncated: false,
        maxDepth: 2,
      });
      expect(forward.paths.map((path) => path.nodes.map((node) => node.value))).toEqual([
        [a.value, b.value, c.value],
      ]);
      expect(forward.paths[0].edges.map((edge) => ({
        predicate: edge.predicate.value,
        direction: edge.direction,
      }))).toEqual([
        { predicate: replyTo.value, direction: 'out' },
        { predicate: replyTo.value, direction: 'out' },
      ]);

      const tooShallow = await engine.searchPaths({
        start: a,
        target: c,
        predicates: [replyTo],
        graphPrefix: 'https://pod.example/alice/.data/chat/',
        maxDepth: 1,
      });
      expect(tooShallow.paths).toEqual([]);

      const inverse = await engine.searchPaths({
        start: c,
        target: a,
        direction: 'in',
        predicates: [replyTo],
        graphPrefix: 'https://pod.example/alice/.data/chat/',
        maxDepth: 2,
      });
      expect(inverse.paths.map((path) => path.nodes.map((node) => node.value))).toEqual([
        [c.value, b.value, a.value],
      ]);
      expect(inverse.paths[0].edges.map((edge) => edge.direction)).toEqual(['in', 'in']);

      const oneHopAllPredicates = await engine.searchPaths({
        start: a,
        graphPrefix: 'https://pod.example/alice/.data/chat/',
        maxDepth: 1,
        maxPaths: 10,
      });
      expect(oneHopAllPredicates.paths.map((path) => path.nodes.map((node) => node.value))).toEqual([
        [a.value, b.value],
        [a.value, d.value],
      ]);
      expect(oneHopAllPredicates.paths.map((path) => path.edges[0].graph.value)).toEqual([graph.value, graph.value]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prunes PostgreSQL materialized result cache by payload bytes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-materialized-cache-bytes-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      materializedResultCacheMaxBytes: 1,
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
      cache: {
        materialized: 'chat/default/open-messages',
      },
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const first = await engine.query(query);
      expect(first.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(first.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(first.metrics.plan).toContain('PostgresMaterializedResultStore');
      expect(first.metrics.explain?.cache?.materialized).toMatchObject({
        status: 'miss',
        maxBytes: 1,
        stored: true,
      });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({
        entryCount: 0,
        payloadBytes: 0,
        maxPayloadBytes: 1,
      });
      const storage = await engine.storageStats();
      const payloadBytesEvictions = storage.derivedCache?.evictions.payloadBytes;
      expect(storage.derivedCache).toMatchObject({
        cachePressure: 0,
        evictions: {
          payloadBytes: expect.any(Number),
        },
      });
      expect(payloadBytesEvictions).toBeGreaterThan(0);

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(second.metrics.plan).not.toContain('PostgresMaterializedResultHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces a shared PostgreSQL derived cache byte budget', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-derived-cache-budget-'));
    const perCacheMaxBytes = 1024 * 1024;
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxBytes: perCacheMaxBytes,
      materializedResultCacheMaxBytes: perCacheMaxBytes,
      queryTemplateCacheMaxEntries: 8,
      derivedCacheMaxBytes: 1,
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
    };
    const materializedQuery: RdfQuery = {
      ...query,
      cache: {
        materialized: 'chat/default/open-messages',
      },
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const result = await engine.query(query);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.plan).toContain('PostgresResultCacheStore');

      const materialized = await engine.query(materializedQuery);
      expect(materialized.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(materialized.metrics.plan).toContain('PostgresMaterializedResultStore');

      const storage = await engine.storageStats();
      const totalBytesEvictions = storage.derivedCache?.evictions.totalBytes;
      const templateBytesEvictions = storage.derivedCache?.evictions.templateBytes;
      expect(storage.derivedCache).toMatchObject({
        cacheBytes: 0,
        maxCacheBytes: 1,
        cachePressure: 0,
        queryResultPayloadBytes: 0,
        materializedResultPayloadBytes: 0,
        queryTemplateBytes: 0,
        evictions: {
          totalBytes: expect.any(Number),
          templateBytes: expect.any(Number),
        },
      });
      expect(totalBytesEvictions).toBeGreaterThan(0);
      expect(templateBytesEvictions).toBeGreaterThan(0);
      expect(storage.queryResultCache).toMatchObject({
        entryCount: 0,
        maxPayloadBytes: perCacheMaxBytes,
      });
      expect(storage.materializedResultCache).toMatchObject({
        entryCount: 0,
        maxPayloadBytes: perCacheMaxBytes,
      });
      expect(storage.queryTemplateCache).toMatchObject({
        entryCount: 0,
      });

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(second.metrics.plan).not.toContain('PostgresResultCacheHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces a PostgreSQL derived cache byte budget per access scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-derived-cache-scope-budget-'));
    const perCacheMaxBytes = 1024 * 1024;
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheMaxBytes: perCacheMaxBytes,
      materializedResultCacheMaxBytes: perCacheMaxBytes,
      queryTemplateCacheMaxEntries: 8,
      derivedCacheScopeMaxBytes: 1,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const accessScope = {
      principal: 'https://pod.example/alice/profile/card#me',
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read',
      authorizationModel: 'acr',
      permissionVersion: 'acl-v1',
      allowedGraphUrls: [graph.value],
    };
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
      cache: {
        scope: accessScope,
      },
    };
    const materializedQuery: RdfQuery = {
      ...query,
      cache: {
        ...query.cache,
        materialized: 'chat/default/open-messages',
      },
    };

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const result = await engine.query(query);
      expect(result.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(result.metrics.plan).toContain('PostgresResultCacheStore');

      const materialized = await engine.query(materializedQuery);
      expect(materialized.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(materialized.metrics.plan).toContain('PostgresMaterializedResultStore');

      const storage = await engine.storageStats();
      const scopeBytesEvictions = storage.derivedCache?.evictions.scopeBytes;
      expect(storage.derivedCache).toMatchObject({
        maxCacheBytes: 0,
        maxScopeBytes: 1,
        scopeVersionCount: 0,
        largestScopeBytes: 0,
        largestScopePressure: 0,
        queryResultPayloadBytes: 0,
        materializedResultPayloadBytes: 0,
        evictions: {
          scopeBytes: expect.any(Number),
        },
      });
      expect(scopeBytesEvictions).toBeGreaterThan(0);
      expect(storage.derivedCache?.queryTemplateBytes).toBeGreaterThan(0);
      expect(storage.queryResultCache).toMatchObject({
        entryCount: 0,
        maxPayloadBytes: perCacheMaxBytes,
      });
      expect(storage.materializedResultCache).toMatchObject({
        entryCount: 0,
        maxPayloadBytes: perCacheMaxBytes,
      });
      expect(storage.queryTemplateCache).toMatchObject({
        entryCount: 1,
      });

      const second = await engine.query(query);
      expect(second.bindings.map((binding) => binding.message.value)).toEqual([message.value]);
      expect(second.metrics.plan).toContain('PostgresResultCacheMiss');
      expect(second.metrics.plan).not.toContain('PostgresResultCacheHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('isolates and invalidates PostgreSQL materialized result cache entries by structured access scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-materialized-cache-scope-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const accessScope = (principal: string) => ({
      principal,
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read',
      authorizationModel: 'acr',
      permissionVersion: 'acl-v1',
      allowedGraphUrls: [graph.value],
    });
    const queryForScope = (scope: ReturnType<typeof accessScope>): RdfQuery => ({
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: {
        scope,
        materialized: 'chat/default/open-messages',
      },
    });

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      const alice = await engine.query(queryForScope(accessScope('https://id.example/alice/profile/card#me')));
      expect(alice.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(alice.metrics.plan).toContain('PostgresMaterializedResultStore');

      const bob = await engine.query(queryForScope(accessScope('https://id.example/bob/profile/card#me')));
      expect(bob.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(bob.metrics.plan).toContain('PostgresMaterializedResultStore');
      expect(bob.metrics.plan).not.toContain('PostgresMaterializedResultHit');
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({
        entryCount: 2,
        scopeCount: 2,
      });

      const aliceAgain = await engine.query(queryForScope(accessScope('https://id.example/alice/profile/card#me')));
      expect(aliceAgain.metrics.plan).toContain('PostgresMaterializedResultHit');

      const deleted = await engine.invalidateQueryResultCache(accessScope('https://id.example/alice/profile/card#me'));
      expect(deleted).toBe(1);
      const aliceAfterInvalidation = await engine.query(queryForScope(accessScope('https://id.example/alice/profile/card#me')));
      expect(aliceAfterInvalidation.metrics.plan).toContain('PostgresMaterializedResultMiss');
      expect(aliceAfterInvalidation.metrics.plan).toContain('PostgresMaterializedResultStore');
      const bobStillCached = await engine.query(queryForScope(accessScope('https://id.example/bob/profile/card#me')));
      expect(bobStillCached.metrics.plan).toContain('PostgresMaterializedResultHit');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('invalidates PostgreSQL result caches by overlapping ACL or ACR access scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-access-cache-clear-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const otherGraph = namedNode('https://pod.example/bob/.data/chat/default/2026/05/18/messages.ttl');
    const otherMessage = namedNode(`${otherGraph.value}#msg_1`);
    const profileAclGraph = namedNode('https://pod.example/alice/profile/card.acl');
    const aclGraph = namedNode(`${graph.value}.acl`);
    const acrGraph = namedNode('https://pod.example/alice/.data/chat/default/.acr');
    const queryFor = (
      targetGraph: NamedNode,
      principal: string,
      basePath: string,
      materialized?: string,
    ): RdfQuery => ({
      patterns: [
        {
          graph: targetGraph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: {
        scope: {
          principal,
          basePath,
          mode: 'read',
          authorizationModel: 'acr',
          permissionVersion: 'acl-v1',
          allowedGraphUrls: [targetGraph.value],
        },
        ...(materialized ? { materialized } : {}),
      },
    });
    const resultQuery = queryFor(graph, 'https://id.example/alice/profile/card#me', 'https://pod.example/alice/');
    const materializedQuery = queryFor(
      graph,
      'https://id.example/alice/profile/card#me',
      'https://pod.example/alice/',
      'chat/default/open-messages',
    );
    const otherResultQuery = queryFor(otherGraph, 'https://id.example/bob/profile/card#me', 'https://pod.example/bob/');
    const otherMaterializedQuery = queryFor(
      otherGraph,
      'https://id.example/bob/profile/card#me',
      'https://pod.example/bob/',
      'chat/default/open-messages',
    );

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));
      await engine.put(quad(otherMessage, namedNode(STATUS), literal('open'), otherGraph));

      expect((await engine.query(resultQuery)).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(materializedQuery)).metrics.plan).toContain('PostgresMaterializedResultStore');
      expect((await engine.query(otherResultQuery)).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(otherMaterializedQuery)).metrics.plan).toContain('PostgresMaterializedResultStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 2 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 2 });

      await engine.replaceSource([
        quad(
          namedNode(`${profileAclGraph.value}#public`),
          namedNode('http://www.w3.org/ns/auth/acl#mode'),
          namedNode('http://www.w3.org/ns/auth/acl#Read'),
          profileAclGraph,
        ),
      ], {
        source: profileAclGraph.value,
        workspace: 'https://pod.example/alice/profile/',
        localPath: 'profile/card.acl',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v1',
      });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 2 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 2 });

      await engine.replaceSource([
        quad(
          namedNode(`${aclGraph.value}#public`),
          namedNode('http://www.w3.org/ns/auth/acl#mode'),
          namedNode('http://www.w3.org/ns/auth/acl#Read'),
          aclGraph,
        ),
      ], {
        source: aclGraph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/2026/05/18/',
        localPath: 'messages.ttl.acl',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v1',
      });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.query(otherResultQuery)).metrics.plan).toContain('PostgresResultCacheMiss');
      expect((await engine.query(otherMaterializedQuery)).metrics.plan).toContain('PostgresMaterializedResultMiss');

      expect((await engine.query(resultQuery)).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(materializedQuery)).metrics.plan).toContain('PostgresMaterializedResultStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 2 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 2 });

      await engine.put(quad(
        namedNode(`${acrGraph.value}#publicReadAccess`),
        namedNode('http://www.w3.org/ns/solid/acp#allow'),
        namedNode('http://www.w3.org/ns/solid/acp#Read'),
        acrGraph,
      ));
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.query(otherResultQuery)).metrics.plan).toContain('PostgresResultCacheMiss');
      expect((await engine.query(otherMaterializedQuery)).metrics.plan).toContain('PostgresMaterializedResultMiss');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses explicit ACL or ACR target triples to narrow access-cache invalidation', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-access-override-index-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const siblingGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const siblingMessage = namedNode(`${siblingGraph.value}#msg_1`);
    const acrGraph = namedNode('https://pod.example/alice/.data/chat/default/.acr');
    const accessControl = namedNode(`${acrGraph.value}#messageDayAccess`);
    const queryFor = (targetGraph: NamedNode, materialized?: string): RdfQuery => ({
      patterns: [
        {
          graph: targetGraph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: {
        scope: {
          principal: 'https://id.example/alice/profile/card#me',
          basePath: 'https://pod.example/alice/',
          mode: 'read',
          authorizationModel: 'acr',
          permissionVersion: 'acl-v1',
          allowedGraphUrls: [targetGraph.value],
        },
        ...(materialized ? { materialized } : {}),
      },
    });
    const targetResultQuery = queryFor(graph);
    const targetMaterializedQuery = queryFor(graph, 'chat/default/2026-05-18/open-messages');
    const siblingResultQuery = queryFor(siblingGraph);
    const siblingMaterializedQuery = queryFor(siblingGraph, 'chat/default/2026-05-19/open-messages');

    try {
      await engine.open();
      await engine.put([
        quad(message, namedNode(STATUS), literal('open'), graph),
        quad(siblingMessage, namedNode(STATUS), literal('open'), siblingGraph),
      ]);

      expect((await engine.query(targetResultQuery)).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(targetMaterializedQuery)).metrics.plan).toContain('PostgresMaterializedResultStore');
      expect((await engine.query(siblingResultQuery)).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(siblingMaterializedQuery)).metrics.plan).toContain('PostgresMaterializedResultStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 2 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 2 });

      await engine.replaceSource([
        quad(graph, namedNode(`${ACP}accessControl`), accessControl, acrGraph),
        quad(accessControl, namedNode(`${ACP}apply`), graph, acrGraph),
        quad(accessControl, namedNode(`${ACP}allow`), namedNode(`${ACP}Read`), acrGraph),
      ], {
        source: acrGraph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.acr',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v1',
      });

      expect((await engine.storageStats()).accessControlOverrides).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 1 });

      await engine.replaceSource([
        quad(siblingGraph, namedNode(`${ACP}accessControl`), accessControl, acrGraph),
        quad(accessControl, namedNode(`${ACP}apply`), siblingGraph, acrGraph),
        quad(accessControl, namedNode(`${ACP}allow`), namedNode(`${ACP}Read`), acrGraph),
      ], {
        source: acrGraph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.acr',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v2',
      });

      expect((await engine.storageStats()).accessControlOverrides).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 0 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 0 });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('narrows access-cache invalidation to known permission versions', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-access-version-index-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);
    const acrGraph = namedNode('https://pod.example/alice/.data/chat/default/.acr');
    const accessControl = namedNode(`${acrGraph.value}#messageDayAccess`);
    const queryFor = (permissionVersion: string, materialized?: string): RdfQuery => ({
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal('open'),
        },
      ],
      select: ['message'],
      cache: {
        scope: {
          principal: 'https://id.example/alice/profile/card#me',
          basePath: 'https://pod.example/alice/',
          mode: 'read',
          authorizationModel: 'acr',
          permissionVersion,
          allowedGraphUrls: [graph.value],
        },
        ...(materialized ? { materialized } : {}),
      },
    });

    try {
      await engine.open();
      await engine.put(quad(message, namedNode(STATUS), literal('open'), graph));

      expect((await engine.query(queryFor('acl-v1'))).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(queryFor('acl-v1', 'chat/default/acl-v1/open-messages'))).metrics.plan)
        .toContain('PostgresMaterializedResultStore');
      expect((await engine.query(queryFor('acl-v2'))).metrics.plan).toContain('PostgresResultCacheStore');
      expect((await engine.query(queryFor('acl-v2', 'chat/default/acl-v2/open-messages'))).metrics.plan)
        .toContain('PostgresMaterializedResultStore');
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 2 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 2 });

      await engine.replaceSource([
        quad(graph, namedNode(`${ACP}accessControl`), accessControl, acrGraph),
        quad(accessControl, namedNode(`${ACP}apply`), graph, acrGraph),
        quad(accessControl, namedNode(`${ACP}allow`), namedNode(`${ACP}Read`), acrGraph),
      ], {
        source: acrGraph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.acr',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v1',
      });

      expect((await engine.storageStats()).accessControlOverrides).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats({ cacheScope: { permissionVersion: 'acl-v2' } })).derivedCache)
        .toMatchObject({ scopeVersionCount: 1 });

      await engine.replaceSource([
        quad(graph, namedNode(`${ACP}accessControl`), accessControl, acrGraph),
        quad(accessControl, namedNode(`${ACP}apply`), graph, acrGraph),
        quad(accessControl, namedNode(`${ACP}allow`), namedNode(`${ACP}Read`), acrGraph),
      ], {
        source: acrGraph.value,
        workspace: 'https://pod.example/alice/.data/chat/default/',
        localPath: '.acr',
        contentType: 'text/turtle',
        sourceVersion: 'acl-v2',
      });

      expect((await engine.storageStats()).accessControlOverrides).toMatchObject({ entryCount: 1 });
      expect((await engine.storageStats()).queryResultCache).toMatchObject({ entryCount: 0 });
      expect((await engine.storageStats()).materializedResultCache).toMatchObject({ entryCount: 0 });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prunes PostgreSQL materialized result cache entries to the configured profile', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-materialized-cache-prune-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      materializedResultCacheMaxEntries: 1,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const queryForStatus = (status: string, materialized: string): RdfQuery => ({
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal(status),
        },
      ],
      select: ['message'],
      cache: { materialized },
    });

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('closed'), graph),
      ]);

      const open = await engine.query(queryForStatus('open', 'chat/default/open-messages'));
      expect(open.metrics.plan).toContain('PostgresMaterializedResultStore');
      const closed = await engine.query(queryForStatus('closed', 'chat/default/closed-messages'));
      expect(closed.metrics.plan).toContain('PostgresMaterializedResultStore');
      const storage = await engine.storageStats();
      expect(storage.materializedResultCache).toMatchObject({
        entryCount: 1,
        scopeCount: 1,
      });
      expect(storage.derivedCache).toMatchObject({
        evictions: {
          maxEntries: 1,
        },
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('records PostgreSQL query template cache hits without caching results', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-template-cache-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      queryTemplateCacheMaxEntries: 1,
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
      expect(open.metrics.plan.join('\n')).toContain('PostgresQueryTemplateCacheMiss');
      expect(open.metrics.plan.join('\n')).toContain('PostgresCompiledSqlTemplateMiss');
      expect(open.metrics.plan.join('\n')).not.toContain('PostgresResultCacheHit');

      const closed = await engine.query(closedQuery);
      expect(closed.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      expect(closed.metrics.plan.join('\n')).toContain('PostgresQueryTemplateCacheHit');
      expect(closed.metrics.plan.join('\n')).toContain('PostgresCompiledSqlTemplateHit');
      expect(closed.metrics.plan.join('\n')).not.toContain('PostgresResultCacheHit');
      expect(closed.metrics.explain).toMatchObject({
        engine: 'postgres-rdf',
        cache: {
          template: {
            status: 'hit',
            maxEntries: 1,
          },
          result: {
            status: 'disabled',
            maxEntries: expect.any(Number),
          },
        },
      });
      expect(closed.metrics.explain?.cache?.template?.key).toEqual(expect.any(String));

      const distinctClosed = await engine.query({
        ...closedQuery,
        distinct: true,
      });
      expect(distinctClosed.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      expect(distinctClosed.metrics.plan.join('\n')).toContain('PostgresQueryTemplateCacheMiss');
      expect(distinctClosed.metrics.plan.join('\n')).toContain('PostgresCompiledSqlTemplateMiss');
      expect((await engine.storageStats()).queryTemplateCache).toMatchObject({
        entryCount: 1,
        hitCount: 1,
        missCount: 2,
        evictionCount: 1,
        compiledSqlEntryCount: 1,
        compiledSqlHitCount: 1,
        compiledSqlMissCount: 2,
        compiledSqlEvictionCount: 1,
      });
      expect((await engine.storageStats()).derivedCache).toMatchObject({
        evictions: {
          templateMaxEntries: 1,
        },
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('expires PostgreSQL query template cache entries and reports memory size', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-query-template-cache-ttl-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      queryTemplateCacheMaxEntries: 4,
      queryTemplateCacheTtlMs: 60_000,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const message1 = namedNode(`${graph.value}#msg_1`);
    const message2 = namedNode(`${graph.value}#msg_2`);
    const queryForStatus = (status: string): RdfQuery => ({
      patterns: [
        {
          graph,
          subject: { variable: 'message' },
          predicate: namedNode(STATUS),
          object: literal(status),
        },
      ],
      select: ['message'],
    });

    try {
      await engine.open();
      await engine.put([
        quad(message1, namedNode(STATUS), literal('open'), graph),
        quad(message2, namedNode(STATUS), literal('closed'), graph),
      ]);

      const open = await engine.query(queryForStatus('open'));
      expect(open.bindings.map((binding) => binding.message.value)).toEqual([message1.value]);
      expect(open.metrics.plan.join('\n')).toContain('PostgresQueryTemplateCacheMiss');

      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
      let closed!: RdfQueryResult;
      try {
        closed = await engine.query(queryForStatus('closed'));
      } finally {
        dateNow.mockRestore();
      }
      expect(closed.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      expect(closed.metrics.plan.join('\n')).toContain('PostgresQueryTemplateCacheMiss');
      expect(closed.metrics.explain).toMatchObject({
        cache: {
          template: {
            status: 'miss',
            maxEntries: 4,
            ttlMs: 60_000,
          },
        },
      });

      const storage = await engine.storageStats();
      expect(storage.queryTemplateCache).toMatchObject({
        entryCount: 1,
        maxEntries: 4,
        ttlMs: 60_000,
        hitCount: 0,
        missCount: 2,
        evictionCount: 1,
      });
      expect(storage.derivedCache).toMatchObject({
        evictions: {
          templateTtl: 1,
        },
      });
      expect(storage.queryTemplateCache?.totalBytes).toBeGreaterThan(0);
      expect(storage.derivedBytes).toBeGreaterThanOrEqual(storage.queryTemplateCache?.totalBytes ?? 0);
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
      queryExplainSlowMs: 0,
      queryExplainSlowQueryMaxEntries: 1,
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
      expect(result.metrics.explain?.planner).toMatchObject({
        selectedPath: 'facts',
        reasons: expect.arrayContaining([
          'facts-fallback-selected',
          'regex-filter-requires-facts-fallback',
          'slow-query-detected',
          'slow-query-duration-threshold',
        ]),
        slowQuery: {
          thresholdMs: 0,
          scannedRows: 2,
          reasons: expect.arrayContaining(['duration-threshold']),
        },
      });

      const repeated = await engine.query({
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
            value: 'Draft',
            flags: 'i',
          },
        ],
        select: ['message'],
      });
      expect(repeated.bindings.map((binding) => binding.message.value)).toEqual([message2.value]);
      const slowQueryStats = (await engine.storageStats()).slowQueries;
      expect(slowQueryStats).toMatchObject({
        entryCount: 1,
        maxEntries: 1,
        entries: [
          {
            queryKey: repeated.metrics.explain?.cache?.result?.key,
            templateKey: repeated.metrics.explain?.cache?.template?.key,
            selectedPath: 'facts',
            reasons: expect.arrayContaining([
              'facts-fallback-selected',
              'regex-filter-requires-facts-fallback',
              'slow-query-detected',
            ]),
            runtime: {
              scannedRows: 2,
              returnedRows: 1,
            },
            slowQuery: {
              thresholdMs: 0,
              scannedRows: 2,
              reasons: expect.arrayContaining(['duration-threshold']),
            },
            derivedCache: {
              cacheBytes: expect.any(Number),
              maxCacheBytes: expect.any(Number),
              cachePressure: expect.any(Number),
              largestScopeBytes: expect.any(Number),
              largestScopePressure: expect.any(Number),
              evictionCount: 0,
              evictions: {
                factsVersion: 0,
                ttl: 0,
                maxEntries: 0,
                payloadBytes: 0,
                scopeBytes: 0,
                totalBytes: 0,
                templateTtl: 0,
                templateMaxEntries: 0,
                templateBytes: 0,
              },
            },
            cache: {
              templateStatus: 'hit',
              resultStatus: 'miss',
              materializedStatus: 'not-applicable',
              result: {
                status: 'miss',
                key: repeated.metrics.explain?.cache?.result?.key,
                factsDataVersion: repeated.metrics.explain?.cache?.result?.factsDataVersion,
                stored: true,
              },
              materialized: {
                status: 'not-applicable',
              },
              scopeHash: expect.any(String),
              scopeBasePath: null,
              scopePrincipal: null,
            },
            acceleration: {
              profile: 'baseline',
              requested: false,
              enabled: false,
            },
          },
        ],
      });
      expect(slowQueryStats?.entries[0].generatedAt).toEqual(expect.any(String));
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
      expect(expectLiteral(result.bindings[0].priorityTotal).datatype.value).toBe(XSD_DECIMAL);
      expect(result.metrics.plan).toContain('PostgresRdf3xJoinAggregate');
      expect(result.metrics.plan).toContain('Aggregate(sum(?priority),avg(?priority),max(?priority))');
      expect(result.metrics.plan).not.toContain('PostgresFactsQuery');
      expect(result.metrics.plan).not.toContain('PostgresRdf3xFallback');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

it('keeps PostgreSQL RDF planning statistics exact without an asynchronous projection refresh', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-shared-stats-'));
    const engine = new PostgresRdfEngine({ driver: 'pglite', dataDir });
    const graph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const source = {
      source: graph.value,
      workspace: 'alice',
      localPath: '/.data/task/secretary/2026/05/18/runs.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const run1 = namedNode(`${graph.value}#run_1`);
    const run2 = namedNode(`${graph.value}#run_2`);
    const run3 = namedNode(`${graph.value}#run_3`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(run1, namedNode(STATUS), literal('open'), graph),
        quad(run2, namedNode(STATUS), literal('closed'), graph),
      ], source);

      const beforeRefresh = await engine.storageStats();
      expect(beforeRefresh.rdf3x).toMatchObject({
        factsDataVersion: 1,
        rdf3xFactsDataVersion: 1,
        refreshLag: 0,
        syncedWithFacts: true,
        stats: expect.objectContaining({
          factsDataVersion: 1,
          membershipCount: 2,
          graphCount: 1,
        }),
      });

      const refresh = await engine.refreshDerivedIndexes();
      expect(refresh.rdf3x).toMatchObject({
        refreshed: false,
        previousFactsDataVersion: 1,
        factsDataVersion: 1,
        syncedWithFacts: true,
        sourceQueue: {
          pendingSources: 1,
          drainedSources: 1,
        },
      });
      expect(refresh.rdf3x?.rebuild).toBeUndefined();

      const delta = await engine.applyDelta(
        [{ graph, subject: run1 }],
        [quad(run3, namedNode(STATUS), literal('open'), graph)],
      );
      expect(delta).toEqual({ deletedRows: 1, insertedRows: 1 });
      const afterDelta = await engine.storageStats();
      expect(afterDelta.rdf3x).toMatchObject({
        factsDataVersion: 2,
        rdf3xFactsDataVersion: 2,
        refreshLag: 0,
        syncedWithFacts: true,
        stats: expect.objectContaining({
          factsDataVersion: 2,
          membershipCount: 2,
          graphCount: 1,
        }),
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('drains dirty source queue for replaced and deleted sources', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-source-queue-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const source = {
      source: graph.value,
      workspace: 'alice',
      localPath: '/.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(message, namedNode(STATUS), literal('open'), graph),
      ], source);

      const replaceRefresh = await engine.refreshDerivedIndexes();
      expect(replaceRefresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x).toMatchObject({
        syncedWithFacts: true,
        stats: expect.objectContaining({
          membershipCount: 1,
        }),
      });

      const deleted = await engine.deleteSource(source.source);
      expect(deleted).toBe(1);
      const deleteRefresh = await engine.refreshDerivedIndexes();
      expect(deleteRefresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x).toMatchObject({
        syncedWithFacts: true,
        stats: expect.objectContaining({
          membershipCount: 0,
        }),
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('can drain dirty source queue in bounded batches', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-source-batch-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graphs = [
      namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      namedNode('https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl'),
    ];
    const sources = graphs.map((graph, index) => ({
      source: graph.value,
      workspace: 'alice',
      localPath: `/.data/chat/default/2026/05/${18 + index}/messages.ttl`,
      contentType: 'text/turtle',
      sourceVersion: `v${index + 1}`,
    }));
    const messages = graphs.map((graph, index) => namedNode(`${graph.value}#msg_${index + 1}`));

    try {
      await engine.open();
      await engine.replaceSource([
        quad(messages[0], namedNode(STATUS), literal('open'), graphs[0]),
      ], sources[0]);
      await engine.replaceSource([
        quad(messages[1], namedNode(STATUS), literal('closed'), graphs[1]),
      ], sources[1]);
      expect((await engine.storageStats()).rdf3x?.pendingSources).toBe(2);

      const firstRefresh = await engine.refreshDerivedIndexes({ maxDirtySources: 1 });
      expect(firstRefresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 2,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x).toMatchObject({
        factsDataVersion: 2,
        rdf3xFactsDataVersion: 2,
        syncedWithFacts: true,
        pendingSources: 1,
      });

      const secondRefresh = await engine.refreshDerivedIndexes({ maxDirtySources: 1 });
      expect(secondRefresh.rdf3x).toMatchObject({
        refreshed: false,
        previousFactsDataVersion: 2,
        factsDataVersion: 2,
        syncedWithFacts: true,
      });
      expect(secondRefresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
      expect(secondRefresh.rdf3x?.rebuild).toBeUndefined();
      expect((await engine.storageStats()).rdf3x?.pendingSources).toBe(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('maintains dirty source queue through a leased maintenance cycle', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-maintenance-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      maintenanceLeaseOwner: 'test-worker-a',
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const source = {
      source: graph.value,
      workspace: 'alice',
      localPath: '/.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(message, namedNode(STATUS), literal('open'), graph),
      ], source);

      const maintained = await engine.maintainDerivedIndexes();
      expect(maintained).toMatchObject({
        attempted: true,
        claimed: true,
        refreshed: true,
        pendingSources: 1,
      });
      expect(maintained.refresh?.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });

      const idle = await engine.maintainDerivedIndexes();
      expect(idle).toEqual({
        attempted: false,
        claimed: false,
        refreshed: false,
        reason: 'idle',
        pendingSources: 0,
      });

      const executor = (engine as unknown as {
        requireExecutor(): { exec(sql: string, params?: unknown[]): Promise<void> };
      }).requireExecutor();
      await executor.exec(`
        INSERT INTO rdf_dirty_sources (
          source,
          workspace,
          local_path,
          content_type,
          source_version,
          operation
        )
        VALUES ($1, $2, $3, $4, $5, 'upsert')
      `, [
        source.source,
        source.workspace,
        source.localPath,
        source.contentType,
        'v2',
      ]);

      const drainedOnly = await engine.maintainDerivedIndexes();
      expect(drainedOnly).toMatchObject({
        attempted: true,
        claimed: true,
        refreshed: true,
        pendingSources: 1,
      });
      expect(drainedOnly.refresh?.rdf3x).toMatchObject({
        refreshed: false,
        previousFactsDataVersion: 1,
        factsDataVersion: 1,
        syncedWithFacts: true,
      });
      expect(drainedOnly.refresh?.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('applies source batch size during leased maintenance cycles', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-maintenance-batch-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      maintenanceLeaseOwner: 'test-worker-a',
      maintenanceSourceBatchSize: 1,
    });
    const graphs = [
      namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl'),
      namedNode('https://pod.example/alice/.data/task/secretary/2026/05/19/runs.ttl'),
    ];
    const sources = graphs.map((graph, index) => ({
      source: graph.value,
      workspace: 'alice',
      localPath: `/.data/task/secretary/2026/05/${18 + index}/runs.ttl`,
      contentType: 'text/turtle',
      sourceVersion: `v${index + 1}`,
    }));
    const runs = graphs.map((graph, index) => namedNode(`${graph.value}#run_${index + 1}`));

    try {
      await engine.open();
      await engine.replaceSource([
        quad(runs[0], namedNode(STATUS), literal('queued'), graphs[0]),
      ], sources[0]);
      await engine.replaceSource([
        quad(runs[1], namedNode(STATUS), literal('running'), graphs[1]),
      ], sources[1]);

      const firstCycle = await engine.maintainDerivedIndexes();
      expect(firstCycle).toMatchObject({
        attempted: true,
        claimed: true,
        refreshed: true,
        pendingSources: 2,
      });
      expect(firstCycle.refresh?.rdf3x?.sourceQueue).toEqual({
        pendingSources: 2,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x).toMatchObject({
        factsDataVersion: 2,
        rdf3xFactsDataVersion: 2,
        syncedWithFacts: true,
        pendingSources: 1,
      });

      const secondCycle = await engine.maintainDerivedIndexes();
      expect(secondCycle).toMatchObject({
        attempted: true,
        claimed: true,
        refreshed: true,
        pendingSources: 1,
      });
      expect(secondCycle.refresh?.rdf3x).toMatchObject({
        refreshed: false,
        previousFactsDataVersion: 2,
        factsDataVersion: 2,
        syncedWithFacts: true,
      });
      expect(secondCycle.refresh?.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });

      const idle = await engine.maintainDerivedIndexes();
      expect(idle).toEqual({
        attempted: false,
        claimed: false,
        refreshed: false,
        reason: 'idle',
        pendingSources: 0,
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not drain dirty source writes newer than the refresh cutoff', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-source-cutoff-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
    });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const lateGraph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl');
    const source = {
      source: graph.value,
      workspace: 'alice',
      localPath: '/.data/chat/default/2026/05/18/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const lateSource = {
      source: lateGraph.value,
      workspace: 'alice',
      localPath: '/.data/chat/default/2026/05/19/messages.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v2',
    };
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(message, namedNode(STATUS), literal('open'), graph),
      ], source);
      const executor = (engine as unknown as {
        requireExecutor(): { exec(sql: string, params?: unknown[]): Promise<void> };
      }).requireExecutor();
      await executor.exec(`
        INSERT INTO rdf_dirty_sources (
          source,
          workspace,
          local_path,
          content_type,
          source_version,
          operation,
          changed_at
        )
        VALUES ($1, $2, $3, $4, $5, 'upsert', $6::timestamptz)
      `, [
        lateSource.source,
        lateSource.workspace,
        lateSource.localPath,
        lateSource.contentType,
        lateSource.sourceVersion,
        '2999-01-01T00:00:00.000Z',
      ]);
      expect((await engine.storageStats()).rdf3x?.pendingSources).toBe(2);

      const refresh = await engine.refreshDerivedIndexes();
      expect(refresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x?.pendingSources).toBe(1);

      await executor.exec(`
        UPDATE rdf_dirty_sources
        SET changed_at = $2::timestamptz
        WHERE source = $1
      `, [lateSource.source, '2000-01-01T00:00:00.000Z']);

      const drainLateSource = await engine.refreshDerivedIndexes();
      expect(drainLateSource.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
      });
      expect((await engine.storageStats()).rdf3x?.pendingSources).toBe(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('skips maintenance when another worker owns the lease', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-maintenance-lease-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      maintenanceLeaseOwner: 'test-worker-a',
    });
    const graph = namedNode('https://pod.example/alice/.data/task/secretary/2026/05/18/runs.ttl');
    const source = {
      source: graph.value,
      workspace: 'alice',
      localPath: '/.data/task/secretary/2026/05/18/runs.ttl',
      contentType: 'text/turtle',
      sourceVersion: 'v1',
    };
    const run = namedNode(`${graph.value}#run_1`);

    try {
      await engine.open();
      await engine.replaceSource([
        quad(run, namedNode(STATUS), literal('queued'), graph),
      ], source);
      const executor = (engine as unknown as {
        requireExecutor(): { exec(sql: string, params?: unknown[]): Promise<void> };
      }).requireExecutor();
      await executor.exec(`
        INSERT INTO rdf_maintenance_leases (
          name,
          owner,
          claimed_at_ms,
          heartbeat_at_ms,
          expires_at_ms
        )
        VALUES ('rdf-derived-indexes', 'test-worker-b', 0, 0, 9999999999999)
      `);

      const busy = await engine.maintainDerivedIndexes();
      expect(busy).toEqual({
        attempted: true,
        claimed: false,
        refreshed: false,
        reason: 'lease_busy',
        pendingSources: 1,
      });

      const manualRefresh = await engine.refreshDerivedIndexes();
      expect(manualRefresh.rdf3x?.sourceQueue).toEqual({
        pendingSources: 1,
        drainedSources: 1,
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

  it('retries transient PostgreSQL deadlocks during writes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-deadlock-retry-'));
    const pool = new InstrumentedPgPool(dataDir);
    const engine = new PostgresRdfEngine({
      driver: 'pg',
      pool,
    });
    const graph = namedNode('https://pod.example/alice/.data/deadlock/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      pool.failNextQuadInsertWithDeadlock();

      await engine.put(quad(message, namedNode(CONTENT), literal('retry me'), graph));

      const scan = await engine.scan({
        pattern: {
          graph,
          subject: message,
          predicate: namedNode(CONTENT),
          object: literal('retry me'),
        },
      });
      expect(scan.quads).toHaveLength(1);
      expect(pool.deadlockFailuresInjected).toBe(1);
      expect(pool.transactionBeginsAfterReset).toBe(2);
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
      expect(aggregateResult.metrics.plan).toContain('PostgresFactsQuery');
      expect(aggregateResult.metrics.plan.some((entry) => entry.startsWith('PostgresNumericAggregateFactsCutover('))).toBe(true);
      expect(aggregateResult.metrics.explain?.planner).toMatchObject({
        selectedPath: 'facts',
        reasons: expect.arrayContaining([
          'numeric-aggregate-cost-cutover',
        ]),
      });
      expect(aggregateResult.metrics.plan).not.toContain('PostgresRdf3xGroupAggregate');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });






  it('uses temporary staging tables for large RDF term and quad bulk inserts', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-bulk-stage-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    const engine = new PostgresRdfEngine({ pool });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const messageCount = 2601;
    const quads = Array.from({ length: messageCount }, (_, index) => {
      const message = namedNode(`${graph.value}#msg_${index}`);
      return [
        quad(message, namedNode(STATUS), literal(index % 2 === 0 ? 'open' : 'closed'), graph),
        quad(message, namedNode(PRIORITY), literal(String(index), namedNode(XSD_INTEGER)), graph),
      ];
    }).flat();
    quads.push(quads[0]);

    try {
      await engine.open();
      pool.executedSql.length = 0;

      await engine.put(quads);

      const createTermStageStatements = pool.executedSql.filter((sql) => sql.includes('CREATE TEMP TABLE rdf_terms_bulk_stage_'));
      const termStageInsertStatements = pool.executedSql.filter((sql) => sql.includes('INSERT INTO rdf_terms_bulk_stage_'));
      const finalTermInsertStatements = pool.executedSql.filter((sql) => (
        sql.includes('INSERT INTO rdf_terms (') && sql.includes('FROM rdf_terms_bulk_stage_')
      ));
      const dropTermStageStatements = pool.executedSql.filter((sql) => sql.includes('DROP TABLE IF EXISTS rdf_terms_bulk_stage_'));
      const createQuadStageStatements = pool.executedSql.filter((sql) => sql.includes('CREATE TEMP TABLE rdf_quads_bulk_stage_'));
      const quadStageInsertStatements = pool.executedSql.filter((sql) => sql.includes('INSERT INTO rdf_quads_bulk_stage_'));
      const finalQuadInsertStatements = pool.executedSql.filter((sql) => (
        sql.includes('INSERT INTO rdf_quads (') && sql.includes('FROM rdf_quads_bulk_stage_')
      ));
      const dropQuadStageStatements = pool.executedSql.filter((sql) => sql.includes('DROP TABLE IF EXISTS rdf_quads_bulk_stage_'));
      expect(createTermStageStatements).toHaveLength(1);
      expect(termStageInsertStatements.length).toBeGreaterThanOrEqual(1);
      expect(finalTermInsertStatements).toHaveLength(1);
      expect(finalTermInsertStatements[0]).toContain('SELECT DISTINCT');
      expect(dropTermStageStatements).toHaveLength(1);
      expect(createQuadStageStatements).toHaveLength(1);
      expect(quadStageInsertStatements.length).toBeGreaterThanOrEqual(1);
      expect(finalQuadInsertStatements).toHaveLength(1);
      expect(finalQuadInsertStatements[0]).toContain('SELECT DISTINCT');
      expect(dropQuadStageStatements).toHaveLength(1);

      const stats = await engine.storageStats();
      expect(stats.facts.quadCount).toBe(messageCount * 2);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('uses COPY stream capability for large RDF term and quad staging inserts', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-bulk-copy-'));
    const pool = new XpodRdfExtensionPgPool(dataDir, XPOD_RDF_EXTENSION_CAPABILITIES, true);
    const engine = new PostgresRdfEngine({ pool });
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const messageCount = 2601;
    const quads = Array.from({ length: messageCount }, (_, index) => {
      const message = namedNode(`${graph.value}#msg_${index}`);
      return [
        quad(message, namedNode(STATUS), literal(index % 2 === 0 ? 'open' : 'closed'), graph),
        quad(message, namedNode(PRIORITY), literal(String(index), namedNode(XSD_INTEGER)), graph),
      ];
    }).flat();
    quads.push(quads[0]);

    try {
      await engine.open();
      pool.executedSql.length = 0;
      pool.copyFromRowsStatements.length = 0;

      await engine.put(quads);

      const copiedTables = pool.copyFromRowsStatements.map((entry) => entry.table);
      expect(copiedTables.some((table) => table.startsWith('rdf_terms_bulk_stage_'))).toBe(true);
      expect(copiedTables.some((table) => table.startsWith('rdf_quads_bulk_stage_'))).toBe(true);
      expect(pool.copyFromRowsStatements.reduce((total, entry) => total + entry.rowCount, 0)).toBeGreaterThan(messageCount * 2);
      expect(pool.executedSql.filter((sql) => sql.includes('INSERT INTO rdf_terms_bulk_stage_'))).toHaveLength(0);
      expect(pool.executedSql.filter((sql) => sql.includes('INSERT INTO rdf_quads_bulk_stage_'))).toHaveLength(0);

      const stats = await engine.storageStats();
      expect(stats.facts.quadCount).toBe(messageCount * 2);
      expect(stats.bulkLoad?.copyFromRows).toMatchObject({
        attempts: 2,
        succeeded: 2,
        fallbacks: 0,
      });
      expect(stats.bulkLoad?.copyFromRows.rows).toBeGreaterThan(messageCount * 2);
      expect(stats.bulkLoad?.copyFromRows.tables).toEqual([
        expect.objectContaining({
          kind: 'rdf_quads_bulk_stage',
          statements: 1,
          rows: messageCount * 2,
        }),
        expect.objectContaining({
          kind: 'rdf_terms_bulk_stage',
          statements: 1,
        }),
      ]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });


  it('does not run RDF term schema DDL inside write transactions', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-no-tx-ddl-'));
    const pool = new InstrumentedPgPool(dataDir);
    const engine = new PostgresRdfEngine({
      driver: 'pg',
      pool,
    });
    const graph = namedNode('https://pod.example/alice/.data/no-ddl/messages.ttl');
    const message = namedNode(`${graph.value}#msg_1`);

    try {
      await engine.open();
      pool.resetInstrumentation();

      await engine.put(quad(message, namedNode(CONTENT), literal('no ddl'), graph));

      expect(pool.transactionQueriesAfterReset.some((sql) => /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b/i.test(sql))).toBe(false);
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
        concurrency: 2,
      });
      const firstQueryCase = report.coldStartBenchmark?.firstQueryAfterRefresh?.queryCase;
      const firstQueryReturnedRows = report.coldStartBenchmark?.firstQueryAfterRefresh?.returnedRows;
      const warmQueryCase = report.coldStartBenchmark?.warmSteadyState?.queryCase;
      const warmReturnedRows = report.coldStartBenchmark?.warmSteadyState?.returnedRows;

      expect(report.engine).toBe('postgres-rdf');
      expect(report.warmupIterations).toBe(1);
      expect(report.concurrency).toBe(2);
      expect(report.refresh?.rdf3x?.syncedWithFacts).toBe(true);
      expect(report.refresh?.rdf3x?.plannerStats?.analyzedTables).toEqual(expect.arrayContaining([
        'rdf_terms',
        'rdf_quads',
      ]));
      expect(report.refreshBenchmark).toMatchObject({
        durationMs: expect.any(Number),
        refreshed: false,
        previousFactsDataVersion: 1,
        factsDataVersion: 1,
        syncedWithFacts: true,
        plannerStatsDurationMs: expect.any(Number),
        analyzedTables: expect.arrayContaining([
          'rdf_terms',
          'rdf_quads',
        ]),
        sourceQueue: {
          pendingSources: 0,
          drainedSources: 0,
        },
      });
      expect(report.coldStartBenchmark).toMatchObject({
        startup: {
          status: 'ready',
          driver: 'pglite',
          openCount: 1,
          durationMs: expect.any(Number),
          phases: expect.arrayContaining([
            expect.objectContaining({ name: 'executor', durationMs: expect.any(Number) }),
            expect.objectContaining({ name: 'schema', durationMs: expect.any(Number) }),
            expect.objectContaining({ name: 'maintenance-scheduler', durationMs: expect.any(Number) }),
          ]),
        },
        firstQueryAfterRefresh: {
          queryCase: expect.any(String),
          durationMs: expect.any(Number),
          planMatched: true,
          missingPlan: [],
          cacheMode: 'bypass',
          returnedRows: expect.any(Number),
        },
        warmSteadyState: {
          queryCase: expect.any(String),
          iterations: 1,
          warmupIterations: 1,
          durationsMs: [expect.any(Number)],
          p50DurationMs: expect.any(Number),
          p95DurationMs: expect.any(Number),
          planMatched: true,
          returnedRows: expect.any(Number),
        },
      });
      expect(warmQueryCase).toBe(firstQueryCase);
      expect(firstQueryReturnedRows).toBeGreaterThan(0);
      expect(warmReturnedRows).toBe(firstQueryReturnedRows);
      expect(report.planMatched).toBe(true);
      expect(report.failedPlanCases).toEqual([]);
      expect(report.concurrencyGate).toMatchObject({
        enabled: true,
        concurrency: 2,
        matched: true,
        failedCases: [],
      });
      expect(report.concurrencyGate.cases.map((testCase) => testCase.name)).toEqual([
        'modeled thread message page query',
        'scheduled task trigger keyset continuation query',
        'settings owner category keyset query',
        'provider model credential ordered join query',
      ]);
      expect(report.concurrencyGate.cases.every((testCase) => testCase.planMatched)).toBe(true);
      expect(report.concurrencyGate.cases.every((testCase) => testCase.returnedRows.every((rows) => rows === testCase.expectedReturnedRows))).toBe(true);
      expect(report.concurrencyGate.cases.every((testCase) => testCase.checksums.every((value) => value === testCase.expectedChecksum))).toBe(true);
      expect(report.concurrencyGate.cases.every((testCase) => testCase.orderedChecksums.every((value) => value === testCase.expectedOrderedChecksum))).toBe(true);
      expect(report.servingRegressionGate).toMatchObject({
        enabled: true,
        matched: true,
        failedCases: [],
      });
      expect(report.servingRegressionGate.thresholds).toBeUndefined();
      expect(report.servingRegressionGate.cases.map((testCase) => testCase.name)).toEqual(
        report.queryCases.map((testCase) => testCase.name),
      );
      expect(report.servingRegressionGate.cases.every((testCase) => testCase.planMatched)).toBe(true);
      expect(report.servingRegressionGate.cases.every((testCase) => testCase.matched)).toBe(true);
      expect(report.servingRegressionGate.cases.every((testCase) => testCase.failedReasons.length === 0)).toBe(true);
      expect(report.servingRegressionGate.cases.every((testCase) => testCase.p95DurationMs >= 0)).toBe(true);
      expect(report.servingRegressionGate.cases.every((testCase) => testCase.scannedRows >= 0)).toBe(true);
      const smallQueryCaseCount = rdfModelsPostgresQueryBenchmarkCasesForProfile('default')
        .filter((testCase) => testCase.minScale === 'small')
        .length;
      expect(report.queryCases).toHaveLength(smallQueryCaseCount);
      expect(report.storage.derivedIndexProfile).toBe('rdf3x');
      expect(report.storage.rdf3x?.syncedWithFacts).toBe(true);
      expect(report.storage.pgAcceleration).toMatchObject({
        profile: 'baseline',
        enabled: false,
      });
      expect(report.queryCases.flatMap((testCase) => testCase.physicalPlan).join('\n')).not.toContain('PostgresResultCache');
      expect(report.cases.every((testCase) => testCase.durationsMs.length === 1)).toBe(true);
      expect(report.queryCases.every((testCase) => testCase.durationsMs.length === 1)).toBe(true);

      for (const caseName of [
        'threads by modeled chat relation',
        'messages by modeled thread relation',
        'chat latest message pointer',
        'cron tasks due time',
        'waiting input runs',
        'runs by lease owner',
        'list providers',
        'models by provider',
        'credentials by provider',
        'list agents',
        'list contacts',
        'list favorites',
        'list sessions',
        'active sessions',
        'list settings',
        'sensitive settings',
        'list ai configs',
        'active vector stores',
        'indexed files by status',
        'running agent statuses',
        'oauth credentials expiring',
        'reply messages',
        'routed messages by target agent',
      ]) {
        const result = report.cases.find((testCase) => testCase.name === caseName);
        expect(result, `${caseName} should execute in the PostgreSQL models scan benchmark`).toBeDefined();
        expect(result?.planMatched).toBe(true);
        expect(result?.returnedRows).toBeGreaterThan(0);
      }

      const materializedCaseNames = rdfModelsPostgresMaterializedQueryBenchmarkCaseNames();
      const materializedCases = report.queryCases.filter((testCase) => materializedCaseNames.includes(testCase.name));
      expect(materializedCases.map((testCase) => testCase.name)).toEqual(materializedCaseNames);
      expect(materializedCases.every((testCase) => testCase.planMatched)).toBe(true);
      expect(materializedCases.every((testCase) => testCase.physicalPlan.includes('PostgresMaterializedResultHit'))).toBe(true);
      expect(materializedCases.every((testCase) => testCase.physicalPlan.some((entry) => entry.startsWith('PostgresQueryTemplateCacheHit')))).toBe(true);
      expect(report.storage.materializedResultCache?.entryCount).toBeGreaterThanOrEqual(materializedCaseNames.length);
      expect(report.storage.queryResultCache?.entryCount).toBe(0);
      expect(report.storage.queryTemplateCache?.hitCount).toBeGreaterThan(0);

      for (const caseName of [
        'modeled thread message page query',
        'chat latest message hydration query',
        'thread chat hydration query',
        'task run execution detail query',
        'scheduled task trigger query',
        'scheduled task trigger keyset continuation query',
        'leased running run query',
        'provider model credential join query',
        'provider model credential VALUES join query',
        'provider model credential ordered join query',
        'ai credential selection query',
        'provider model credential count query',
        'provider credential grouped count query',
        'provider credential single-pattern grouped count query',
        'oauth credential expiry query',
        'settings owner category query',
        'settings owner category keyset query',
        'favorite target chat join query',
        'contact entity profile join query',
        'active session thread hydration query',
        'message reply chain query',
        'routed message agent query',
        'ai config embedding model query',
        'vector indexed file store query',
        'queued run priority numeric aggregate',
      ]) {
        const result = report.queryCases.find((testCase) => testCase.name === caseName);
        expect(result, `${caseName} should be covered by the PostgreSQL models benchmark`).toBeDefined();
        expect(result?.planMatched).toBe(true);
        expect(result?.returnedRows).toBeGreaterThan(0);
        expect(result?.physicalPlan.some((entry) => entry.startsWith('PostgresRdf3x'))).toBe(true);
        expect(result?.physicalPlan).not.toContain('PostgresFactsQuery');
      }

      const providerNumericAggregate = report.queryCases.find((testCase) => testCase.name === 'provider credential fail count aggregate query');
      expect(providerNumericAggregate).toBeDefined();
      expect(providerNumericAggregate?.planMatched).toBe(true);
      expect(providerNumericAggregate?.returnedRows).toBeGreaterThan(0);
      expect(providerNumericAggregate?.physicalPlan).toContain('PostgresFactsQuery');
      expect(providerNumericAggregate?.physicalPlan.some((entry) => entry.startsWith('PostgresNumericAggregateFactsCutover('))).toBe(true);
      expect(providerNumericAggregate?.physicalPlan).not.toContain('PostgresRdf3xGroupAggregate');

      const numericAggregate = report.queryCases.find((testCase) => testCase.name === 'message score by thread numeric aggregate');
      expect(numericAggregate).toBeDefined();
      expect(numericAggregate?.planMatched).toBe(true);
      expect(numericAggregate?.returnedRows).toBeGreaterThan(0);
      expect(numericAggregate?.physicalPlan).toContain('PostgresRdf3xGroupAggregate');
      expect(numericAggregate?.physicalPlan).toContain('GraphPrefixMembershipFilter');
      expect(numericAggregate?.physicalPlan).not.toContain('PostgresFactsQuery');
      expect(numericAggregate?.physicalPlan.some((entry) => entry.startsWith('PostgresNumericAggregateFactsCutover('))).toBe(false);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports post-write incremental refresh cost for dirty source calibration', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-refresh-mutation-benchmark-'));
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
        cases: [],
        queryCases: [],
        refreshMutationSources: 3,
        refreshMutationQuadsPerSource: 4,
      });
      const postWriteFactsDataVersion = report.postWriteRefreshBenchmark?.factsDataVersion;
      const postWriteFactsDataVersionBeforeRefresh = report.postWriteRefreshBenchmark?.factsDataVersionBeforeRefresh;

      expect(report.refreshBenchmark).toMatchObject({
        refreshed: false,
        sourceQueue: {
          pendingSources: 0,
          drainedSources: 0,
        },
      });
      expect(report.postWriteRefreshBenchmark).toMatchObject({
        mutationSources: 3,
        mutationQuadsPerSource: 4,
        mutationQuads: 12,
        pendingSourcesBeforeRefresh: 3,
        durationMs: expect.any(Number),
        refreshed: false,
        syncedWithFacts: true,
        factsDataVersionBeforeRefresh: expect.any(Number),
        matched: true,
        failedReasons: [],
        sourceQueue: {
          pendingSources: 3,
          drainedSources: 3,
        },
      });
      expect(postWriteFactsDataVersion).toBe(postWriteFactsDataVersionBeforeRefresh);
      expect(report.storage.rdf3x).toMatchObject({
        pendingSources: 0,
        refreshLag: 0,
        syncedWithFacts: true,
      });
      expect(report.cases).toEqual([]);
      expect(report.queryCases).toEqual([]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails the serving regression gate when explicit scanned-row thresholds are exceeded', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-serving-threshold-benchmark-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
    });
    const queryCase = rdfModelsPostgresQueryBenchmarkCasesForProfile('default')
      .find((testCase) => testCase.name === 'modeled thread message page query');

    try {
      expect(queryCase).toBeDefined();
      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
      }));

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 1,
        warmupIterations: 0,
        concurrency: 1,
        cases: [],
        queryCases: [queryCase!],
        servingRegressionThresholds: {
          maxScannedRows: 0,
        },
      });

      expect(report.planMatched).toBe(false);
      expect(report.failedPlanCases).toEqual(['serving-regression:modeled thread message page query']);
      expect(report.servingRegressionGate).toMatchObject({
        enabled: true,
        matched: false,
        thresholds: {
          maxScannedRows: 0,
        },
        failedCases: ['modeled thread message page query'],
      });
      expect(report.servingRegressionGate.cases[0]).toMatchObject({
        name: 'modeled thread message page query',
        matched: false,
        failedReasons: ['scanned-rows-threshold'],
      });
      expect(report.servingRegressionGate.cases[0].scannedRows).toBeGreaterThan(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });


  it('builds strict P3 release evidence from an all-profile PostgreSQL benchmark run', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-all-p3-gate-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });

    try {
      const broadSourceCount = 64;
      const servingCase = rdfModelsPostgresQueryBenchmarkCasesForProfile('default')
        .find((testCase) => testCase.name === 'modeled thread message page query');
      const broadCase = rdfModelsPostgresQueryBenchmarkCasesForProfile('fusion')
        .find((testCase) => testCase.name === 'broad agent context text vector fusion query');
      expect(servingCase).toBeDefined();
      expect(broadCase).toBeDefined();

      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: broadSourceCount + 3,
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
        caseProfile: 'all',
        searchFusionBroadSourceCount: broadSourceCount,
      }));
      await seedRdfModelsSearchFusionIndexes(engine, { broadSourceCount });

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 3,
        warmupIterations: 1,
        caseProfile: 'all',
        servingRegressionThresholds: {
          maxScannedRows: 10_000,
          maxP95DurationMs: 10_000,
        },
        fusionBenchmarkThresholds: {
          maxScannedRows: 10_000,
          maxP95DurationMs: 10_000,
        },
        queryCases: [servingCase!, broadCase!],
        fusionBenchmarkBaselines: {
          'broad agent context text vector fusion query': {
            label: 'strict-p3-test-baseline',
            scannedRows: 1,
            p95DurationMs: 1,
            maxScannedRows: 10_000,
            maxP95DurationMs: 10_000,
          },
        },
      });

      expect(report.servingRegressionGate).toMatchObject({
        enabled: true,
        thresholds: {
          maxScannedRows: 10_000,
          maxP95DurationMs: 10_000,
        },
        matched: true,
        failedCases: [],
      });
      expect(report.servingRegressionGate.cases.map((testCase) => testCase.name)).toEqual([servingCase!.name]);
      expect(report.fusionBenchmarkGate).toMatchObject({
        enabled: true,
        matched: true,
        failedCases: [],
      });
      expect(report.fusionBenchmarkGate.cases.map((testCase) => testCase.name)).toEqual([broadCase!.name]);
      expect(report.fusionBenchmarkGate.cases[0]).toMatchObject({
        matched: true,
        batchedBroadCandidateJoin: true,
        baselineComparison: {
          label: 'strict-p3-test-baseline',
          matched: true,
          scannedRowsBaseline: 1,
          p95DurationMsBaseline: 1,
          maxScannedRows: 10_000,
          maxP95DurationMs: 10_000,
        },
      });
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('batches bound-source RDF fact joins for broad PostgreSQL fusion candidates', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-batch-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });

    try {
      const broadSourceCount = 64;
      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: broadSourceCount + 3,
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
        caseProfile: 'fusion',
        searchFusionBroadSourceCount: broadSourceCount,
      }));
      await seedRdfModelsSearchFusionIndexes(engine, { broadSourceCount });

      const broadCase = rdfModelsPostgresQueryBenchmarkCasesForProfile('fusion')
        .find((testCase) => testCase.name === 'broad agent context text vector fusion query');
      expect(broadCase).toBeDefined();

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 1,
        warmupIterations: 0,
        caseProfile: 'fusion',
        queryCases: [broadCase!],
      });

      const broadFusion = report.queryCases[0];
      const membershipScans = broadFusion.physicalPlan
        .filter((entry) => entry === 'Rdf3xMembershipScan').length;

      const broadFusionGate = report.fusionBenchmarkGate.cases[0];

      expect(broadFusion.returnedRows).toBe(10);
      expect(broadFusion.physicalPlan.some((entry) => entry.startsWith('PostgresFactsBatchScan('))).toBe(true);
      expect(membershipScans).toBeLessThanOrEqual(6);
      expect(broadFusionGate.batchedBroadCandidateJoin).toBe(true);
      expect(broadFusionGate.failedReasons).not.toContain('missing-batched-broad-candidate-join');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs text/vector fusion benchmark cases on PostgreSQL facts with configured search indexes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-benchmark-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });

    try {
      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
        caseProfile: 'fusion',
      }));
      await seedRdfModelsSearchFusionIndexes(engine);

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 1,
        warmupIterations: 0,
        caseProfile: 'fusion',
        fusionBenchmarkBaselines: {
          'broad agent context text vector fusion query': {
            label: 'p0-p1-p2-physical-source-baseline',
            scannedRows: 10_000,
            p95DurationMs: 10_000,
          },
        },
      });

      expect(report.planMatched).toBe(true);
      expect(report.failedPlanCases).toEqual([]);
      expect(report.cases).toHaveLength(0);
      expect(report.queryCases.map((testCase) => testCase.name)).toEqual(rdfModelsSearchFusionQueryBenchmarkCaseNames());
      expect(report.queryCases.map((testCase) => testCase.name)).toContain('broad agent context text vector fusion query');
      expect(report.fusionBenchmarkGate).toMatchObject({
        enabled: true,
        caseProfile: 'fusion',
        matched: true,
        failedCases: [],
      });
      expect(report.fusionBenchmarkGate.cases.map((testCase) => testCase.name)).toEqual(report.queryCases.map((testCase) => testCase.name));

      const fusion = report.queryCases[0];
      const fusionGate = report.fusionBenchmarkGate.cases[0];
      expect(fusion.returnedRows).toBe(2);
      expect(fusion.indexChoices).toEqual(expect.arrayContaining(['text-chunk', 'vector-chunk']));
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('TextSearch('))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('TextMatchSource('))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('VectorSearch('))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('VectorMatchSource('))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => /^SourceEstimate\(TextMatchSource#0 rows:\d+ cost:\d+ selectivity:/.test(entry))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => /^SourceEstimate\(VectorMatchSource#0 rows:\d+ cost:\d+ selectivity:/.test(entry))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => /^SourceEstimate\(RdfBgpSource#0 rows:\d+ cost:\d+ selectivity:/.test(entry))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('PostgresFactsScan('))).toBe(true);
      expect(fusion.physicalPlan.some((entry) => entry.startsWith('PostgresFactsBind(?fusionScore:='))).toBe(true);
      expect(fusion.physicalPlan).toContain('FusionRankInputs(text:?textScore,vector:?vectorScore,output:?fusionScore)');
      expect(fusion.physicalPlan).toContain('FusionRankWeights(text:0.55,vector:0.45,output:?fusionScore)');
      expect(fusion.physicalPlan).toContain('FusionRankTieBreaker(asc:?message)');
      expect(fusion.physicalPlan).toContain('FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)');
      expect(fusion.physicalPlan).toContain('PostgresFactsSort(desc:fusionScore,asc:message)');
      expect(fusion.physicalPlan.join('\n')).not.toContain('PostgresResultCache');
      expect(fusionGate).toMatchObject({
        matched: true,
        planMatched: true,
        failedReasons: [],
        hardFiltersBeforeRank: true,
        rankInputs: true,
        rankWeights: true,
        rankTieBreaker: true,
        resultCacheBypassed: true,
        returnedRows: 2,
      });
      expect(fusionGate.candidateSources).toEqual(expect.arrayContaining([
        'TextMatchSource',
        'VectorMatchSource',
        'RdfBgpSource',
        'PathScopeSource',
        'AclScopeSource',
      ]));
      expect(fusionGate.sourceEstimateCount).toBeGreaterThanOrEqual(5);
      expect(fusionGate.sourceChoiceCount).toBeGreaterThanOrEqual(3);
      expect(fusionGate.scannedRows).toBe(fusion.scannedRows);
      expect(fusionGate.p95DurationMs).toBe(fusion.p95DurationMs);
      const broadFusion = report.queryCases.find((testCase) => testCase.name === 'broad agent context text vector fusion query');
      const broadFusionGate = report.fusionBenchmarkGate.cases.find((testCase) => testCase.name === 'broad agent context text vector fusion query');
      expect(broadFusion?.returnedRows).toBe(10);
      expect(broadFusion?.physicalPlan).toContain('FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)');
      expect(broadFusion?.physicalPlan).toContain('PostgresFactsLimit');
      expect(broadFusionGate).toMatchObject({
        matched: true,
        planMatched: true,
        returnedRows: 10,
        hardFiltersBeforeRank: true,
        resultCacheBypassed: true,
        baselineComparison: {
          label: 'p0-p1-p2-physical-source-baseline',
          matched: true,
          scannedRowsBaseline: 10_000,
          p95DurationMsBaseline: 10_000,
        },
      });
      expect(broadFusionGate?.baselineComparison?.scannedRowsRatio).toBeLessThanOrEqual(1);
      expect(broadFusionGate?.baselineComparison?.p95DurationMsRatio).toBeLessThanOrEqual(1);
      expect(broadFusionGate?.candidateSources).toEqual(expect.arrayContaining([
        'TextMatchSource',
        'VectorMatchSource',
        'RdfBgpSource',
        'PathScopeSource',
        'AclScopeSource',
      ]));
      expect(broadFusionGate?.sourceChoiceCount).toBeGreaterThanOrEqual(3);
      expect(broadFusionGate?.scannedRows).toBeGreaterThanOrEqual(10);
      const performanceTotalBytes = report.performanceCosts.storageOverhead.totalBytes;
      const storageTotalBytes = report.storage.totalBytes;
      const performanceIndexBuildDurationMs = report.performanceCosts.indexBuild?.durationMs;
      const refreshBenchmarkDurationMs = report.refreshBenchmark?.durationMs;
      expect(report.performanceCosts).toMatchObject({
        storageOverhead: {
          factsBytes: expect.any(Number),
          derivedBytes: expect.any(Number),
          totalBytes: expect.any(Number),
          derivedToFactsRatio: expect.any(Number),
          totalToFactsRatio: expect.any(Number),
        },
        indexBuild: {
          durationMs: expect.any(Number),
          refreshed: false,
        },
      });
      expect(performanceTotalBytes).toBe(storageTotalBytes);
      expect(performanceIndexBuildDurationMs).toBe(refreshBenchmarkDurationMs);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails the fusion benchmark gate when explicit scanned-row thresholds are exceeded', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-threshold-benchmark-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });

    try {
      await engine.open();
      await engine.put(buildRdfModelsBenchmarkSeed({
        syntheticMessages: defaultSyntheticMessagesForRdfModelsScale('small'),
        syntheticPodCount: rdfModelsBenchmarkSyntheticPodCount('small'),
        caseProfile: 'fusion',
      }));
      await seedRdfModelsSearchFusionIndexes(engine);

      const report = await runRdfModelsPostgresBenchmark(engine, {
        scale: 'small',
        iterations: 1,
        warmupIterations: 0,
        caseProfile: 'fusion',
        fusionBenchmarkThresholds: {
          maxScannedRows: 0,
        },
      });

      expect(report.planMatched).toBe(false);
      expect(report.failedPlanCases).toEqual(expect.arrayContaining([
        'fusion:agent context text vector fusion query',
        'fusion:broad agent context text vector fusion query',
      ]));
      expect(report.fusionBenchmarkGate).toMatchObject({
        enabled: true,
        caseProfile: 'fusion',
        matched: false,
        thresholds: {
          maxScannedRows: 0,
        },
        failedCases: expect.arrayContaining([
          'agent context text vector fusion query',
          'broad agent context text vector fusion query',
        ]),
      });
      expect(report.fusionBenchmarkGate.cases[0]).toMatchObject({
        name: 'agent context text vector fusion query',
        matched: false,
        failedReasons: ['scanned-rows-threshold'],
      });
      expect(report.fusionBenchmarkGate.cases[0].scannedRows).toBeGreaterThan(0);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects PostgreSQL text/vector fusion queries before cache lookup when search indexes are not configured', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-missing-index-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: true,
    });

    try {
      await engine.open();
      const [fusion] = rdfModelsPostgresQueryBenchmarkCasesForProfile('fusion');
      await expect(engine.query(fusion.query)).rejects.toThrow('RdfQuery textSearch requires a configured RdfTextIndex');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes text-search entity constraints into PostgreSQL text index joins', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-entity-query-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const task = namedNode('https://pod.example/alice/.data/tasks/default.ttl#task_1');
    const matchingSource = namedNode('https://pod.example/alice/projects/demo/matching.md');
    const wrongEntitySource = namedNode('https://pod.example/alice/projects/demo/wrong-entity.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(matchingSource, rdfType, docType, matchingSource),
        quad(wrongEntitySource, rdfType, docType, wrongEntitySource),
      ]);
      await engine.indexTextSource({
        source: matchingSource.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'matching.md',
        contentType: 'text/markdown',
      }, '', [{
        chunkKey: 'matching-task',
        ordinal: 0,
        level: 1,
        heading: 'Matching',
        path: ['Matching'],
        content: 'Managed runtime handoff mentions the task.',
        startOffset: 0,
        endOffset: 43,
        entities: [{ entity: task.value, predicate: 'https://schema.org/about' }],
      }]);
      await engine.indexTextSource({
        source: wrongEntitySource.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'wrong-entity.md',
        contentType: 'text/markdown',
      }, '', [{
        chunkKey: 'wrong-task',
        ordinal: 0,
        level: 1,
        heading: 'Wrong',
        path: ['Wrong'],
        content: 'Managed runtime handoff mentions another task.',
        startOffset: 0,
        endOffset: 46,
        entities: [{ entity: 'https://pod.example/alice/.data/tasks/default.ttl#task_2' }],
      }]);

      const result = await engine.query({
        textSearch: [{
          query: 'managed runtime',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          entities: [task.value],
          source: 'source',
          content: 'snippet',
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'snippet'],
      });

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([matchingSource.value]);
      expect(result.metrics.plan).toContain('TextSearch("managed runtime"@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet entities:1)');
      expect(result.metrics.indexChoices).toContain('text-chunk');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('binds PostgreSQL text-search source and retrieval-point provenance for Agent context projection', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-context-provenance-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const task = namedNode('https://pod.example/alice/.data/tasks/default.ttl#task_1');
    const source = namedNode('https://pod.example/alice/projects/demo/context.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(source, rdfType, docType, source),
      ]);
      await engine.indexTextSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'context.md',
        contentType: 'text/markdown',
        sourceKey: 'source-node:context',
      }, '', [{
        chunkKey: 'context-task',
        ordinal: 0,
        level: 1,
        heading: 'Context',
        path: ['Context'],
        content: 'Managed runtime handoff mentions the task.',
        startOffset: 0,
        endOffset: 43,
        retrievalKind: 'file-chunk',
        entities: [{
          entity: task.value,
          predicate: 'https://schema.org/about',
          value: 'Managed runtime handoff mentions the task.',
          policyRole: 'searchableText',
          occurrences: 1,
        }],
      }]);

      const result = await engine.query({
        textSearch: [{
          query: 'managed runtime',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
          sourceKey: 'sourceKey',
          retrievalPoint: 'retrievalPointKey',
          retrievalKind: 'retrievalKind',
          entityProvenance: 'entityProvenance',
          scoreComponents: 'scoreComponents',
        } as any],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'snippet', 'sourceKey', 'retrievalPointKey', 'retrievalKind', 'entityProvenance', 'scoreComponents'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].sourceKey.value).toBe('source-node:context');
      expect(result.bindings[0].retrievalPointKey.value).toBe('context-task');
      expect(result.bindings[0].retrievalKind.value).toBe('file-chunk');
      expect(JSON.parse(result.bindings[0].scoreComponents.value)).toMatchObject({
        sourceType: 'text',
        algorithm: 'occurrence-heading-boost',
        normalizedQuery: 'managed runtime',
        occurrenceScore: 1,
      });
      expect(JSON.parse(result.bindings[0].entityProvenance.value)).toEqual([{
        entity: task.value,
        predicate: 'https://schema.org/about',
        value: 'Managed runtime handoff mentions the task.',
        policyRole: 'searchableText',
        occurrences: 1,
      }]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('filters PostgreSQL text-search candidates by local path subtree scope', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-local-path-prefix-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docsSource = namedNode('https://pod.example/alice/projects/demo/docs/runbook.md');
    const archiveSource = namedNode('https://pod.example/alice/projects/demo/archive/runbook.md');
    const docType = namedNode('https://schema.org/DigitalDocument');

    try {
      await engine.open();
      await engine.put([
        quad(docsSource, rdfType, docType, docsSource),
        quad(archiveSource, rdfType, docType, archiveSource),
      ]);
      await engine.indexTextSource({
        source: docsSource.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'docs/runbook.md',
        contentType: 'text/markdown',
      }, '# Docs\n\nManaged runtime subtree marker.\n');
      await engine.indexTextSource({
        source: archiveSource.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'archive/runbook.md',
        contentType: 'text/markdown',
      }, '# Archive\n\nManaged runtime subtree marker.\n');

      const result = await engine.query({
        textSearch: [{
          query: 'managed runtime subtree',
          scope: {
            workspace: 'https://pod.example/alice/projects/demo/',
            localPathPrefix: 'docs/',
          },
          source: 'source',
          localPath: 'localPath',
          content: 'snippet',
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'localPath', 'snippet'],
      });

      expect(result.bindings.map((binding) => binding.localPath.value)).toEqual(['docs/runbook.md']);
      expect(result.metrics.plan).toContain('PathScopeSource(workspace:https://pod.example/alice/projects/demo/,local-path-prefix:docs/)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports PostgreSQL textSearch source-local top-K pushdown in the physical plan', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-topk-plan-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const first = namedNode('https://pod.example/alice/projects/demo/a.md');
    const second = namedNode('https://pod.example/alice/projects/demo/b.md');

    try {
      await engine.open();
      await engine.put([
        quad(first, rdfType, docType, first),
        quad(second, rdfType, docType, second),
      ]);
      await engine.indexTextSource({
        source: first.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'a.md',
        contentType: 'text/markdown',
      }, '# A\n\nManaged runtime.\n');
      await engine.indexTextSource({
        source: second.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'b.md',
        contentType: 'text/markdown',
      }, '# B\n\nManaged runtime managed runtime.\n');

      const result = await engine.query(applyRdfAccessScope({
        textSearch: [{
          query: 'managed runtime',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
          orderBy: [{ field: 'source', direction: 'desc' }],
          limit: 1,
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'snippet'],
      }, {
        basePath: 'https://pod.example/alice/projects/demo/',
        mode: 'read',
        principal: 'https://id.example/alice/profile/card#me',
        allowedGraphUrls: [second.value],
        deniedGraphPrefixes: ['https://pod.example/alice/projects/private/'],
        version: 'acl-v1',
      }));

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([second.value]);
      expect(result.metrics.plan).toContain('TextSearch("managed runtime"@workspace:https://pod.example/alice/projects/demo/ source:?source,content:?snippet limit:1 order:source:desc)');
      expect(result.metrics.plan).toContain('PathScopeSource(workspace:https://pod.example/alice/projects/demo/,prefix:https://pod.example/alice/projects/demo/)');
      expect(result.metrics.plan).toContain('AclScopeSource(base-path:https://pod.example/alice/projects/demo/ allowed:1 denied-prefix:1)');
      expect(result.metrics.plan).toContain('TopKPushdown(TextSearch limit:1 order:source:desc)');
      expect(result.metrics.plan).toContain('NoTsFullMaterialize(TextSearch)');
      const textPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('TextSearch('));
      const rdfPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('PostgresFactsScan('));
      expect(textPlan).toBeGreaterThanOrEqual(0);
      expect(rdfPlan).toBeGreaterThanOrEqual(0);
      expect(textPlan).toBeLessThan(rdfPlan);
      const firstChoice = result.metrics.plan.find((entry) => entry.startsWith('PostgresPlannerSourceChoice(')) ?? '';
      expect(firstChoice).toMatch(/cpu:\d+/);
      expect(firstChoice).toMatch(/io:\d+/);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('pushes a conservative candidate budget into fused text/vector search when final query is top-k ranked', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-budget-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const first = namedNode('https://pod.example/alice/projects/demo/fusion-a.md');
    const second = namedNode('https://pod.example/alice/projects/demo/fusion-b.md');

    try {
      await engine.open();
      await engine.put([
        quad(first, rdfType, docType, first),
        quad(second, rdfType, docType, second),
      ]);
      await engine.indexTextSource({
        source: first.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'fusion-a.md',
        contentType: 'text/markdown',
      }, '# A\n\nManaged runtime candidate.\n');
      await engine.indexTextSource({
        source: second.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'fusion-b.md',
        contentType: 'text/markdown',
      }, '# B\n\nManaged runtime candidate candidate.\n');
      await engine.indexVectorSource({
        source: first.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'fusion-a.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'first',
        ordinal: 0,
        level: 1,
        content: 'Managed runtime candidate.',
        startOffset: 0,
        endOffset: 26,
        embedding: [1, 0],
        model: 'test-embed',
      }]);
      await engine.indexVectorSource({
        source: second.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'fusion-b.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'second',
        ordinal: 0,
        level: 1,
        content: 'Managed runtime candidate candidate.',
        startOffset: 0,
        endOffset: 36,
        embedding: [0.9, 0.1],
        model: 'test-embed',
      }]);

      const result = await engine.query({
        textSearch: [{
          query: 'managed runtime candidate',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          score: 'textScore',
        }],
        vectorSearch: [{
          embedding: [1, 0],
          vectorModel: 'test-embed',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          score: 'vectorScore',
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        binds: [{
          variable: 'fusionScore',
          expression: {
            type: 'add',
            expressions: [
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'textScore' } },
                  { type: 'term', term: literal('0.55', namedNode(XSD_DECIMAL)) },
                ],
              },
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'vectorScore' } },
                  { type: 'term', term: literal('0.45', namedNode(XSD_DECIMAL)) },
                ],
              },
            ],
          },
        }],
        select: ['source', 'fusionScore'],
        orderBy: [{ variable: 'fusionScore', direction: 'desc' }],
        limit: 1,
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.metrics.plan).toContain('CandidateBudget(TextSearch limit:256 from-query-limit:1)');
      expect(result.metrics.plan).toContain('CandidateBudget(VectorSearch limit:256 from-query-limit:1)');
      expect(result.metrics.plan).toContain('TopKPushdown(TextSearch limit:256)');
      expect(result.metrics.plan).toContain('TopKPushdown(VectorSearch limit:256)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exposes native pgvector evidence in PostgreSQL fusion plans', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-native-vector-plan-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      vectorIndex: new NativeVectorEvidenceIndex(),
    });

    try {
      await engine.open();
      const result = await engine.query({
        patterns: [],
        vectorSearch: [{
          embedding: [1, 0],
          scope: { workspace: 'https://pod.example/alice/' },
          source: 'source',
          content: 'content',
          score: 'vectorScore',
        }],
        select: ['source', 'content', 'vectorScore'],
      });

      expect(result.bindings).toHaveLength(1);
      expect(result.metrics.plan).toContain('PostgresNativeVector(VectorSearch pgvector)');
      expect(result.metrics.plan).toContain('PostgresNativeVectorHnsw(VectorSearch)');
      expect(result.metrics.plan).toContain('PostgresNativeVectorRank(pgvector)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('filters unauthorized PostgreSQL candidates before final fusion ranking', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-fusion-acl-rank-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
      vectorIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const publicSource = namedNode('https://pod.example/alice/.data/public/fusion.md');
    const privateSource = namedNode('https://pod.example/alice/.data/private/fusion.md');

    try {
      await engine.open();
      await engine.put([
        quad(publicSource, rdfType, docType, publicSource),
        quad(privateSource, rdfType, docType, privateSource),
      ]);
      await engine.indexTextSource({
        source: publicSource.value,
        workspace: 'https://pod.example/alice/',
        localPath: '.data/public/fusion.md',
        contentType: 'text/markdown',
      }, '# Public\n\nManaged runtime approvals.\n');
      await engine.indexTextSource({
        source: privateSource.value,
        workspace: 'https://pod.example/alice/',
        localPath: '.data/private/fusion.md',
        contentType: 'text/markdown',
      }, '# Private managed runtime\n\nManaged runtime managed runtime managed runtime approvals.\n');
      await engine.indexVectorSource({
        source: publicSource.value,
        workspace: 'https://pod.example/alice/',
        localPath: '.data/public/fusion.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'public',
        ordinal: 0,
        level: 1,
        content: 'Managed runtime approvals.',
        startOffset: 0,
        endOffset: 26,
        embedding: [0.1, 1],
        model: 'test-embed',
      }]);
      await engine.indexVectorSource({
        source: privateSource.value,
        workspace: 'https://pod.example/alice/',
        localPath: '.data/private/fusion.md',
        contentType: 'text/markdown',
      }, [{
        chunkKey: 'private',
        ordinal: 0,
        level: 1,
        content: 'Managed runtime approvals with private high score.',
        startOffset: 0,
        endOffset: 49,
        embedding: [1, 0],
        model: 'test-embed',
      }]);

      const result = await engine.query(applyRdfAccessScope({
        textSearch: [{
          query: 'managed runtime',
          scope: { workspace: 'https://pod.example/alice/' },
          source: 'source',
          content: 'textSnippet',
          score: 'textScore',
        }],
        vectorSearch: [{
          embedding: [1, 0],
          vectorModel: 'test-embed',
          scope: { workspace: 'https://pod.example/alice/' },
          source: 'source',
          content: 'vectorSnippet',
          score: 'vectorScore',
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        binds: [{
          variable: 'fusionScore',
          expression: {
            type: 'add',
            expressions: [
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'textScore' } },
                  { type: 'term', term: literal('0.55', namedNode(XSD_DECIMAL)) },
                ],
              },
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'vectorScore' } },
                  { type: 'term', term: literal('0.45', namedNode(XSD_DECIMAL)) },
                ],
              },
            ],
          },
        }],
        select: ['source', 'fusionScore'],
        orderBy: [
          { variable: 'fusionScore', direction: 'desc' },
          { variable: 'source' },
        ],
        limit: 1,
      }, {
        basePath: 'https://pod.example/alice/.data/',
        mode: 'read',
        principal: 'https://id.example/alice/profile/card#me',
        allowedGraphUrls: [publicSource.value],
        deniedGraphPrefixes: ['https://pod.example/alice/.data/private/'],
        version: 'acl-v1',
      }));

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([publicSource.value]);
      expect(result.metrics.plan).toContain('FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)');
      expect(result.metrics.plan).toContain('AclScopeSource(base-path:https://pod.example/alice/.data/ allowed:1 denied-prefix:1)');
      expect(result.metrics.plan.join('\n')).not.toContain('PostgresResultCache');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('orders selective PostgreSQL text search before broad RDF scans by estimate', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-estimate-order-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const selected = namedNode('https://pod.example/alice/projects/demo/selected.md');

    try {
      await engine.open();
      const docs = Array.from({ length: 40 }, (_value, index) => (
        index === 0
          ? selected
          : namedNode(`https://pod.example/alice/projects/demo/doc-${index}.md`)
      ));
      await engine.put(docs.map((source) => quad(source, rdfType, docType, source)));
      await engine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nRare planner marker.\n');

      const result = await engine.query({
        textSearch: [{
          query: 'rare planner marker',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'snippet'],
      });

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([selected.value]);
      const textPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('TextSearch('));
      const rdfPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('PostgresFactsScan('));
      expect(textPlan).toBeGreaterThanOrEqual(0);
      expect(rdfPlan).toBeGreaterThanOrEqual(0);
      expect(textPlan).toBeLessThan(rdfPlan);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('orders selective PostgreSQL text search before broad VALUES sources by estimate', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-values-estimate-order-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const selected = namedNode('https://pod.example/alice/projects/demo/selected-values.md');

    try {
      await engine.open();
      const docs = Array.from({ length: 50 }, (_value, index) => (
        index === 0
          ? selected
          : namedNode(`https://pod.example/alice/projects/demo/values-doc-${index}.md`)
      ));
      await engine.indexTextSource({
        source: selected.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'selected-values.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nRare planner values marker.\n');

      const result = await engine.query({
        patterns: [],
        values: [{
          variables: ['source'],
          rows: docs.map((source) => ({ source })),
        }],
        textSearch: [{
          query: 'rare planner values marker',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
        }],
        select: ['source', 'snippet'],
      });

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([selected.value]);
      const textPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('TextSearch('));
      const valuesPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('PostgresFactsValues('));
      expect(textPlan).toBeGreaterThanOrEqual(0);
      expect(valuesPlan).toBeGreaterThanOrEqual(0);
      expect(textPlan).toBeLessThan(valuesPlan);
      const firstChoice = result.metrics.plan.find((entry) => entry.startsWith('PostgresPlannerSourceChoice(')) ?? '';
      expect(firstChoice).toContain('selected:TextMatchSource#0');
      expect(firstChoice).toContain('ValuesSource#0');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('prefers connected PostgreSQL text sources over disconnected RDF sources after bindings', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-adaptive-fusion-order-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const selectedPredicate = namedNode('https://schema.org/identifier');
    const selected = namedNode('https://pod.example/alice/projects/demo/selected.md');

    try {
      await engine.open();
      const docs = Array.from({ length: 40 }, (_value, index) => (
        index === 0
          ? selected
          : namedNode(`https://pod.example/alice/projects/demo/broad-${index}.md`)
      ));
      await engine.put([
        ...docs.map((source) => quad(source, rdfType, docType, source)),
        quad(selected, selectedPredicate, literal('selected'), selected),
      ]);
      for (const source of docs) {
        await engine.indexTextSource({
          source: source.value,
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: source.value.slice(source.value.lastIndexOf('/') + 1),
          contentType: 'text/markdown',
        }, '# Note\n\nManaged runtime adaptive planner marker.\n');
      }

      const result = await engine.query({
        patterns: [
          {
            graph: { variable: 'source' },
            subject: { variable: 'source' },
            predicate: selectedPredicate,
            object: literal('selected'),
          },
          {
            graph: { variable: 'other' },
            subject: { variable: 'other' },
            predicate: rdfType,
            object: docType,
          },
        ],
        textSearch: [{
          query: 'managed runtime adaptive planner marker',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
        }],
        select: ['source', 'snippet'],
        distinct: true,
      });

      expect(result.bindings.map((binding) => binding.source.value)).toEqual([selected.value]);
      const firstRdfPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('PostgresFactsScan('));
      const textPlan = result.metrics.plan.findIndex((entry) => entry.startsWith('TextSearch('));
      const secondRdfPlan = result.metrics.plan.findIndex((entry, index) => (
        index > firstRdfPlan && entry.startsWith('PostgresFactsScan(')
      ));
      expect(firstRdfPlan).toBeGreaterThanOrEqual(0);
      expect(textPlan).toBeGreaterThan(firstRdfPlan);
      expect(secondRdfPlan).toBeGreaterThan(textPlan);
      expect(result.metrics.scannedRows).toBeLessThan(docs.length + docs.length);
      const sourceChoiceMarkers = result.metrics.plan.filter((entry) => entry.startsWith('PostgresPlannerSourceChoice('));
      expect(sourceChoiceMarkers.some((entry) => (
        entry.includes('selected:RdfBgpSource#0')
          && entry.includes('TextMatchSource#0[priority:1,connected:true')
      ))).toBe(true);
      expect(sourceChoiceMarkers.some((entry) => (
        entry.includes('selected:TextMatchSource#0')
          && entry.includes('RdfBgpSource#1[priority:1,connected:false')
          && entry.includes('input:1')
          && entry.includes('output:40')
          && entry.includes('cost:40')
      ))).toBe(true);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses PostgreSQL variable distinct estimates to price future joined source fanout', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-join-distinct-planner-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const selectedPredicate = namedNode('https://schema.org/selectedForDistinctPlanner');
    const primaryPredicate = namedNode('https://schema.org/primaryFacet');
    const secondaryPredicate = namedNode('https://schema.org/secondaryFacet');
    const anchorPredicate = namedNode('https://schema.org/anchorFacet');
    const anchorObject = namedNode('https://pod.example/alice/planner/anchor');

    try {
      await engine.open();
      const selectedSource = namedNode('https://pod.example/alice/planner/selected.md');
      const selectedSubject = namedNode(`${selectedSource.value}#selected`);
      const primaryObjects = Array.from({ length: 40 }, (_value, index) => (
        namedNode(`https://pod.example/alice/planner/primary-${index}`)
      ));
      const secondaryObjects = Array.from({ length: 40 }, (_value, index) => (
        namedNode(`https://pod.example/alice/planner/secondary-${index}`)
      ));
      const primaryFacts = primaryObjects.map((object) => quad(selectedSubject, primaryPredicate, object, selectedSource));
      const secondaryFacts = secondaryObjects.map((object) => quad(selectedSubject, secondaryPredicate, object, selectedSource));
      const anchoredPrimaryFacts = primaryObjects.slice(0, 4).flatMap((subject) => (
        Array.from({ length: 8 }, (_value, index) => (
          quad(subject, anchorPredicate, namedNode(`${anchorObject.value}/primary-${index}`), selectedSource)
        ))
      ));
      const anchoredSecondaryFacts = secondaryObjects.flatMap((subject) => (
        Array.from({ length: 8 }, (_value, index) => (
          quad(subject, anchorPredicate, namedNode(`${anchorObject.value}/secondary-${index}`), selectedSource)
        ))
      ));
      await engine.put([
        quad(selectedSubject, selectedPredicate, literal('yes'), selectedSource),
        ...primaryFacts,
        ...secondaryFacts,
        ...anchoredPrimaryFacts,
        ...anchoredSecondaryFacts,
      ]);
      await engine.indexTextSource({
        source: selectedSource.value,
        workspace: 'https://pod.example/alice/planner/',
        localPath: 'selected.md',
        contentType: 'text/markdown',
      }, '# Selected\n\nDistinct join distribution marker.\n');

      const result = await engine.query({
        textSearch: [{
          query: 'distinct join distribution marker',
          scope: { workspace: 'https://pod.example/alice/planner/' },
          source: 'source',
          content: 'snippet',
        }],
        patterns: [
          {
            graph: { variable: 'source' },
            subject: { variable: 'item' },
            predicate: selectedPredicate,
            object: literal('yes'),
          },
          {
            graph: { variable: 'source' },
            subject: { variable: 'item' },
            predicate: secondaryPredicate,
            object: { variable: 'broadFacet' },
          },
          {
            graph: { variable: 'source' },
            subject: { variable: 'item' },
            predicate: primaryPredicate,
            object: { variable: 'facet' },
          },
          {
            graph: { variable: 'source' },
            subject: { variable: 'facet' },
            predicate: anchorPredicate,
            object: { variable: 'anchor' },
          },
        ],
        select: ['item'],
        distinct: true,
      });

      expect(result.bindings.map((binding) => binding.item.value)).toEqual([selectedSubject.value]);
      const scanPlans = result.metrics.plan.filter((entry) => entry.startsWith('PostgresFactsScan('));
      expect(scanPlans[0]).toContain(`predicate:${selectedPredicate.value}`);
      expect(scanPlans[1]).toContain(`predicate:${primaryPredicate.value}`);
      expect(scanPlans[2]).toContain(`predicate:${anchorPredicate.value}`);
      expect(scanPlans[3]).toContain(`predicate:${secondaryPredicate.value}`);
      const sourceChoiceMarkers = result.metrics.plan.filter((entry) => entry.startsWith('PostgresPlannerSourceChoice('));
      expect(sourceChoiceMarkers.some((entry) => (
        entry.includes('selected:RdfBgpSource#2')
          && entry.includes('RdfBgpSource#3')
          && entry.includes('dist:facet=40')
      ))).toBe(true);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses multi-step PostgreSQL planner cost to avoid cheap disconnected prefixes', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-multistep-planner-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const otherPredicate = namedNode('https://schema.org/category');

    try {
      await engine.open();
      const docs = Array.from({ length: 30 }, (_value, index) => (
        namedNode(`https://pod.example/alice/projects/demo/doc-${index}.md`)
      ));
      const others = Array.from({ length: 20 }, (_value, index) => (
        namedNode(`https://pod.example/alice/projects/demo/other-${index}`)
      ));
      await engine.put([
        ...docs.map((source) => quad(source, rdfType, docType, source)),
        ...others.map((source) => quad(source, otherPredicate, literal('other'), source)),
      ]);
      for (const source of docs) {
        await engine.indexTextSource({
          source: source.value,
          workspace: 'https://pod.example/alice/projects/demo/',
          localPath: source.value.slice(source.value.lastIndexOf('/') + 1),
          contentType: 'text/markdown',
        }, '# Note\n\nPlanner cascade marker.\n');
      }

      const result = await engine.query({
        patterns: [
          {
            graph: { variable: 'otherGraph' },
            subject: { variable: 'other' },
            predicate: otherPredicate,
            object: literal('other'),
          },
          {
            graph: { variable: 'source' },
            subject: { variable: 'source' },
            predicate: rdfType,
            object: docType,
          },
        ],
        textSearch: [{
          query: 'planner cascade marker',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
        }],
        select: ['source'],
        distinct: true,
      });

      expect(result.bindings.map((binding) => binding.source.value)).toHaveLength(docs.length);
      const scanPlans = result.metrics.plan.filter((entry) => entry.startsWith('PostgresFactsScan('));
      expect(scanPlans[0]).toContain(`predicate:${rdfType.value}`);
      expect(scanPlans[1]).toContain(`predicate:${otherPredicate.value}`);
      const firstChoice = result.metrics.plan.find((entry) => entry.startsWith('PostgresPlannerSourceChoice(')) ?? '';
      expect(firstChoice).toContain('selected:RdfBgpSource#1');
      expect(firstChoice).toContain('future:');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('bounds PostgreSQL planner multi-step lookahead for many required sources', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-bounded-planner-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const graph = namedNode('https://pod.example/alice/projects/demo/bounded.ttl');
    const subject = namedNode(`${graph.value}#item`);
    const predicates = Array.from({ length: 8 }, (_value, index) => (
      namedNode(`https://schema.org/boundedPredicate${index}`)
    ));

    try {
      await engine.open();
      await engine.put(predicates.map((predicate, index) => (
        quad(subject, predicate, literal(`value-${index}`), graph)
      )));
      await engine.indexTextSource({
        source: subject.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'bounded.ttl',
        contentType: 'text/turtle',
      }, '# Bounded planner marker\n');

      const result = await engine.query({
        textSearch: [{
          query: 'bounded planner marker',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'item',
          content: 'snippet',
        }],
        patterns: predicates.map((predicate, index) => ({
          graph,
          subject: { variable: 'item' },
          predicate,
          object: literal(`value-${index}`),
        })),
        select: ['item', 'snippet'],
      });

      expect(result.bindings.map((binding) => binding.item.value)).toEqual([subject.value]);
      const firstChoice = result.metrics.plan.find((entry) => entry.startsWith('PostgresPlannerSourceChoice(')) ?? '';
      expect(firstChoice).toContain('lookahead:bounded');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reports PostgreSQL textSearch per-source cap pushdown in the physical plan', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-text-per-source-plan-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      queryResultCacheEnabled: false,
      textIndex: { path: ':memory:' },
    });
    const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    const docType = namedNode('https://schema.org/DigitalDocument');
    const source = namedNode('https://pod.example/alice/projects/demo/capped.md');

    try {
      await engine.open();
      await engine.put([
        quad(source, rdfType, docType, source),
      ]);
      await engine.indexTextSource({
        source: source.value,
        workspace: 'https://pod.example/alice/projects/demo/',
        localPath: 'capped.md',
        contentType: 'text/markdown',
      }, '# A\n\nManaged runtime.\n\n# B\n\nManaged runtime again.\n');

      const result = await engine.query(applyRdfAccessScope({
        textSearch: [{
          query: 'managed runtime',
          scope: { workspace: 'https://pod.example/alice/projects/demo/' },
          source: 'source',
          content: 'snippet',
          perSourceLimit: 1,
        }],
        patterns: [{
          graph: { variable: 'source' },
          subject: { variable: 'source' },
          predicate: rdfType,
          object: docType,
        }],
        select: ['source', 'snippet'],
      }, {
        basePath: 'https://pod.example/alice/projects/demo/',
        mode: 'read',
        principal: 'https://id.example/alice/profile/card#me',
        allowedGraphUrls: [source.value],
        version: 'acl-v1',
      }));

      expect(result.metrics.plan).toContain('PerSourceCap(TextSearch per-source:1)');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('owns PostgreSQL text and vector indexes configured through engine options', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-owned-index-engine-'));
    const textIndexDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-owned-text-'));
    const vectorIndexDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-rdf-owned-vector-'));
    const engine = new PostgresRdfEngine({
      driver: 'pglite',
      dataDir,
      textIndex: {
        driver: 'pglite',
        dataDir: textIndexDir,
      },
      vectorIndex: {
        driver: 'pglite',
        dataDir: vectorIndexDir,
        defaultMetric: 'cosine',
      },
    });

    try {
      await engine.open();
      await engine.indexTextSource({
        source: 'https://pod.example/alice/docs/owned-text.md',
        workspace: 'https://pod.example/alice/docs/',
        localPath: 'owned-text.md',
        contentType: 'text/markdown',
      }, '# Owned Search\n\nalpha beta runtime');
      await engine.indexVectorSource({
        source: 'https://pod.example/alice/docs/owned-vector.md',
        workspace: 'https://pod.example/alice/docs/',
        localPath: 'owned-vector.md',
        contentType: 'text/markdown',
      }, [
        {
          chunkKey: 'owned-vector-0',
          ordinal: 0,
          level: 1,
          heading: 'Owned Vector',
          path: ['Owned Vector'],
          content: 'alpha vector runtime',
          startOffset: 0,
          endOffset: 20,
          embedding: [1, 0],
          model: 'test-embed',
        },
      ]);

      const textResults = await engine.searchText({
        query: 'alpha',
        workspace: 'https://pod.example/alice/docs/',
      });
      expect(textResults).toEqual([
        expect.objectContaining({
          source: 'https://pod.example/alice/docs/owned-text.md',
          chunkKey: expect.any(String),
        }),
      ]);

      const vectorResults = await engine.searchVector({
        embedding: [1, 0],
        workspace: 'https://pod.example/alice/docs/',
        limit: 1,
      });
      expect(vectorResults).toEqual([
        expect.objectContaining({
          source: 'https://pod.example/alice/docs/owned-vector.md',
          chunkKey: 'owned-vector-0',
          score: 1,
        }),
      ]);
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(textIndexDir, { recursive: true, force: true });
      await rm(vectorIndexDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('wires cloud RDF storage to PostgreSQL hot operators in the open-source config', async () => {
    const cloudConfig = JSON.parse(await readFile(path.join(process.cwd(), 'config/cloud.json'), 'utf8'));
    const engine = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:SolidRdfEngine');
    const textIndex = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:PostgresRdfTextIndex');
    const vectorIndex = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:PostgresRdfVectorIndex');
    const legacyVectorStore = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:VectorStore');
    const legacyVectorHandler = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:VectorHttpHandler');
    const mixAccessor = cloudConfig['@graph'].find((entry: Record<string, unknown>) => entry['@id'] === 'urn:undefineds:xpod:MixDataAccessor');

    expect(engine).toMatchObject({
      '@type': 'PostgresRdfEngine',
      options_driver: 'pg',
      options_connectionString: {
        '@id': 'urn:solid-server:default:variable:sparqlEndpoint',
        '@type': 'Variable',
      },
      options_textIndex: {
        '@id': 'urn:undefineds:xpod:PostgresRdfTextIndex',
      },
      options_vectorIndex: {
        '@id': 'urn:undefineds:xpod:PostgresRdfVectorIndex',
      },
      options_rdfAccelerationProfile: 'pg-hot-operators',
      options_nativeSparqlEnabled: true,
      options_nativeSparqlRequired: false,
      options_autoOpen: true,
    });
    expect(textIndex).toMatchObject({
      '@type': 'PostgresRdfTextIndex',
      options_driver: 'pg',
      options_connectionString: {
        '@id': 'urn:solid-server:default:variable:sparqlEndpoint',
        '@type': 'Variable',
      },
    });
    expect(vectorIndex).toMatchObject({
      '@type': 'PostgresRdfVectorIndex',
      options_driver: 'pg',
      options_backend: 'component',
      options_connectionString: {
        '@id': 'urn:solid-server:default:variable:sparqlEndpoint',
        '@type': 'Variable',
      },
      options_defaultMetric: 'cosine',
    });
    expect(legacyVectorStore).toBeUndefined();
    expect(legacyVectorHandler).toBeUndefined();
    expect(mixAccessor).toMatchObject({
      '@type': 'MixDataAccessor',
      textSearchIndexingEnabled: true,
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

  it('exposes native SPARQL as an opt-in PostgreSQL extension call', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-native-sparql-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    const disabled = new PostgresRdfEngine({ pool });
    expect(disabled.sparqlQuery).toBeUndefined();

    const engine = new PostgresRdfEngine({
      pool,
      nativeSparqlEnabled: true,
    });

    try {
      await engine.open();
      const result = await engine.sparqlQuery?.('ASK { ?s ?p ?o }', {
        basePath: 'https://pod.example/alice/',
        operation: 'queryBoolean',
        timeoutMs: 2500,
        acceptMediaType: 'application/sparql-results+json',
        loadDocument: {
          sourceUri: 'https://pod.example/alice/input.nt',
          body: '<urn:s> <urn:p> <urn:o> .',
          mediaType: 'application/n-triples',
        },
        accessScope: {
          basePath: 'https://pod.example/alice/',
          mode: 'read',
          principal: 'https://id.example/alice#me',
        },
      });

      expect(result).toMatchObject({
        status: 'ok',
        mediaType: 'application/sparql-results+json',
        body: '{"head":{},"boolean":true}',
      });
      expect(pool.nativeSparqlCalls).toHaveLength(1);
      expect(pool.executedSql.some((sql) => sql.includes('xpod_rdf.native_sparql_capabilities()'))).toBe(true);
      expect(pool.nativeSparqlCalls[0].sql).toContain('xpod_rdf.native_sparql_query($1, $2::jsonb)');
      expect(pool.nativeSparqlCalls[0].params[0]).toBe('ASK { ?s ?p ?o }');
      expect(JSON.parse(pool.nativeSparqlCalls[0].params[1] as string)).toMatchObject({
        operation: 'execute',
        acceptMediaType: 'application/sparql-results+json',
        graphPrefix: 'https://pod.example/alice/',
        principal: 'https://id.example/alice#me',
        accessMode: 'read',
        accessScopeResolved: true,
        authorizationModel: 'mixed',
        timeoutMs: 2500,
        loadDocumentSourceUri: 'https://pod.example/alice/input.nt',
        loadDocumentBody: '<urn:s> <urn:p> <urn:o> .',
        loadDocumentMediaType: 'application/n-triples',
      });
      expect(JSON.parse(pool.nativeSparqlCalls[0].params[1] as string)).not.toHaveProperty('sourceUriPrefix');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails opening native SPARQL when the PostgreSQL runtime is not linked', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-native-sparql-unlinked-'));
    const pool = new XpodRdfExtensionPgPool(
      dataDir,
      XPOD_RDF_EXTENSION_CAPABILITIES,
      false,
      { mode: 'postgres-extension', nativeRuntime: 'stub' },
    );
    const engine = new PostgresRdfEngine({ pool, nativeSparqlEnabled: true });

    try {
      await expect(engine.open()).rejects.toThrow('requires native SPARQL ABI version 1');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps RDF3X available when optional native SPARQL is not linked', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-native-sparql-optional-'));
    const pool = new XpodRdfExtensionPgPool(
      dataDir,
      XPOD_RDF_EXTENSION_CAPABILITIES,
      false,
      { mode: 'postgres-extension', nativeRuntime: 'stub' },
    );
    const engine = new PostgresRdfEngine({
      pool,
      nativeSparqlEnabled: true,
      nativeSparqlRequired: false,
    });

    try {
      await expect(engine.open()).resolves.toBeUndefined();
      expect(engine.sparqlQuery).toBeUndefined();
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not hide native SPARQL probe failures behind the optional RDF3X fallback', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-native-sparql-probe-failure-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    pool.nativeSparqlCapabilitiesError = new Error('connection lost');
    const engine = new PostgresRdfEngine({
      pool,
      nativeSparqlEnabled: true,
      nativeSparqlRequired: false,
    });

    try {
      await expect(engine.open()).rejects.toThrow('connection lost');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('classifies PostgreSQL native SPARQL call failures as server execution errors', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'xpod-postgres-native-sparql-error-'));
    const pool = new XpodRdfExtensionPgPool(dataDir);
    const engine = new PostgresRdfEngine({ pool, nativeSparqlEnabled: true });

    try {
      await engine.open();
      pool.nativeSparqlError = new Error('connection lost');
      await expect(engine.sparqlQuery?.('ASK { ?s ?p ?o }', {
        basePath: 'https://pod.example/alice/',
      })).rejects.toThrow('Native SPARQL engine failed: connection lost');
    } finally {
      await engine.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

class XpodRdfExtensionPgPool {
  private readonly db: PGlite;
  public readonly executedSql: string[] = [];
  public readonly copyFromRowsStatements: Array<{ sql: string; table: string; rowCount: number }> = [];
  public readonly customIndexStatements: string[] = [];
  public readonly nativeCountAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeScanAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeDistinctAnyCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpJoinCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpOrderPageCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpCountCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeValuesJoinCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpGroupCountCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeBgpNumericAggregateCalls: Array<{ sql: string; params: unknown[] }> = [];
  public readonly nativeSparqlCalls: Array<{ sql: string; params: unknown[] }> = [];
  public nativeSparqlError?: Error;
  public nativeSparqlCapabilitiesError?: Error;

  public constructor(
    dataDir: string,
    private readonly capabilities: string[] = XPOD_RDF_EXTENSION_CAPABILITIES,
    private readonly copyFromRows = false,
    private readonly nativeVersion: Record<string, unknown> = {
      mode: 'postgres-extension',
      nativeRuntime: 'linked',
    },
  ) {
    this.db = new PGlite(dataDir);
  }

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.executedSql.push(sql);
    if (sql.includes('xpod_rdf.native_sparql_capabilities()')) {
      if (this.nativeSparqlCapabilitiesError) {
        throw this.nativeSparqlCapabilitiesError;
      }
      return {
        rows: [{
          capabilities: {
            abiVersion: 1,
            ready: this.nativeVersion.nativeRuntime === 'linked',
          },
        }],
      };
    }
    if (sql.includes('xpod_rdf.native_sparql_query(')) {
      if (this.nativeSparqlError) {
        throw this.nativeSparqlError;
      }
      this.nativeSparqlCalls.push({ sql, params });
      return {
        rows: [
          {
            result: {
              status: 'ok',
              mediaType: 'application/sparql-results+json',
              body: '{"head":{},"boolean":true}',
              profile: {},
              error: '',
            },
          },
        ],
      };
    }
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
      return { rows: await xpodRdfExtensionBgpJoinRows(this.db, sql, params) };
    }
    if (sql.includes('xpod_rdf.bgp_order_page(')) {
      this.nativeBgpOrderPageCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpOrderPageRows(this.db, params) };
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
      return { rows: await xpodRdfExtensionScanAnyRows(this.db, sql, params) };
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
      this.executedSql,
      this.customIndexStatements,
      this.nativeCountAnyCalls,
      this.nativeScanAnyCalls,
      this.nativeDistinctAnyCalls,
      this.nativeBgpJoinCalls,
      this.nativeBgpOrderPageCalls,
      this.nativeBgpCountCalls,
      this.nativeValuesJoinCalls,
      this.nativeBgpGroupCountCalls,
      this.nativeBgpNumericAggregateCalls,
      this.capabilities,
      this.copyFromRows,
      this.copyFromRowsStatements,
    );
  }

  public async end(): Promise<void> {
    await this.db.close();
  }
}

class XpodRdfExtensionPgClient {
  public constructor(
    private readonly db: PGlite,
    private readonly executedSql: string[],
    private readonly customIndexStatements: string[],
    private readonly nativeCountAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeScanAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeDistinctAnyCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpJoinCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpOrderPageCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpCountCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeValuesJoinCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpGroupCountCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly nativeBgpNumericAggregateCalls: Array<{ sql: string; params: unknown[] }>,
    private readonly capabilities: string[],
    copyFromRows: boolean,
    private readonly copyFromRowsStatements: Array<{ sql: string; table: string; rowCount: number }>,
  ) {
    if (copyFromRows) {
      this.connection = new XpodRdfCopyConnection(this.db, this.copyFromRowsStatements);
    }
  }

  public readonly connection?: XpodRdfCopyConnection;

  public async query(sql: any, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    if (sql && typeof sql === 'object' && typeof sql.submit === 'function') {
      if (!this.connection) {
        throw new Error('COPY query received by a fake client without COPY support');
      }
      const submitError = sql.submit(this.connection);
      if (submitError) {
        sql.handleError(submitError);
        return { rows: [] };
      }
      sql.handleCopyInResponse(this.connection);
      await this.connection.flushCopy();
      sql.handleCommandComplete?.({}, this.connection);
      sql.handleReadyForQuery(this.connection);
      return { rows: [] };
    }

    this.executedSql.push(sql);
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
      return { rows: await xpodRdfExtensionBgpJoinRows(this.db, sql, params) };
    }
    if (sql.includes('xpod_rdf.bgp_order_page(')) {
      this.nativeBgpOrderPageCalls.push({ sql, params });
      return { rows: await xpodRdfExtensionBgpOrderPageRows(this.db, params) };
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
      return { rows: await xpodRdfExtensionScanAnyRows(this.db, sql, params) };
    }
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows as Array<Record<string, unknown>>,
    };
  }

  public release(): void {}
}

class XpodRdfCopyConnection {
  private sql = '';
  private chunks: Buffer[] = [];

  public constructor(
    private readonly db: PGlite,
    private readonly copyFromRowsStatements: Array<{ sql: string; table: string; rowCount: number }>,
  ) {}

  public query(sql: string): void {
    this.sql = sql;
    this.chunks = [];
  }

  public sendCopyFromChunk(chunk: Buffer): void {
    this.chunks.push(Buffer.from(chunk));
  }

  public endCopyFrom(): void {
  }

  public sendCopyFail(message: string): void {
    throw new Error(message);
  }

  public async flushCopy(): Promise<void> {
    const parsed = parseCopyFromSql(this.sql);
    const rows = parseCopyCsvRows(Buffer.concat(this.chunks).toString('utf8'));
    this.copyFromRowsStatements.push({
      sql: this.sql,
      table: parsed.table,
      rowCount: rows.length,
    });

    for (const chunk of chunkArray(rows, 500)) {
      if (chunk.length === 0) {
        continue;
      }
      const params: unknown[] = [];
      const rowSql = chunk.map((row) => {
        const start = params.length;
        const placeholders = parsed.columns.map((_, columnIndex) => `$${start + columnIndex + 1}`);
        params.push(...row);
        return `(${placeholders.join(', ')})`;
      });
      await this.db.query(
        `INSERT INTO ${testPgIdentifier(parsed.table)} (${parsed.columns.map(testPgIdentifier).join(', ')}) VALUES ${rowSql.join(', ')}`,
        params,
      );
    }
  }
}

function parseCopyFromSql(sql: string): { table: string; columns: string[] } {
  const match = sql.match(/^COPY\s+"([^"]+)"\s+\(([^)]+)\)\s+FROM STDIN/i);
  if (!match) {
    throw new Error(`Unexpected COPY statement: ${sql}`);
  }
  return {
    table: match[1].replaceAll('""', '"'),
    columns: match[2].split(',').map((column) => column.trim().replace(/^"|"$/g, '').replaceAll('""', '"')),
  };
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseCopyCsvRows(input: string): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  let row: Array<string | null> = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let fieldStarted = false;

  const pushField = (): void => {
    row.push(!quoted && field === '\\N' ? null : field);
    field = '';
    quoted = false;
    inQuotes = false;
    fieldStarted = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (char === ',') {
      pushField();
      continue;
    }
    if (char === '\n') {
      pushRow();
      continue;
    }
    if (char === '\r') {
      continue;
    }
    field += char;
    fieldStarted = true;
  }
  if (fieldStarted || field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

function testPgIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const XPOD_RDF_EXTENSION_CAPABILITIES = [
  'scan.exact_graph',
  'scan.graph_prefix',
  'scan.term_in',
  'join.required_bgp',
  'join.required_bgp.native',
  'join.required_bgp.order_page.native',
  'join.required_bgp.order_page.topn.native',
  'join.subject_star',
  'join.values.native',
  'join.values.limit.native',
  'join.slot_filter.native',
  'join.values',
  'aggregate.bgp_count',
  'aggregate.bgp_group_count',
  'aggregate.bgp_numeric',
  'aggregate.subject_star_count',
  'aggregate.count',
  'aggregate.numeric',
  'cache.result',
  'index.xpod_rdf_perm',
  'index.xpod_rdf_perm.count_any',
  'index.xpod_rdf_perm.distinct_any',
  'index.xpod_rdf_perm.scan_any',
  'index.xpod_rdf_perm.scan_any.limit',
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

async function xpodRdfExtensionScanAnyRows(db: PGlite, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  await db.waitReady;
  const indexName = String(params[0] ?? '');
  const columns = XPOD_RDF_EXTENSION_INDEX_COLUMNS[indexName] ?? XPOD_RDF_EXTENSION_INDEX_COLUMNS.rdf_quads_spog_perm;
  const prefixFilters = params.slice(1, 5).map((value) => (
    Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : null
  ));
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads');
  const rows = (result.rows as Array<Record<string, unknown>>)
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
  const limit = sqlPlaceholderNumber(sql, params, 'LIMIT');
  const offset = sqlPlaceholderNumber(sql, params, 'OFFSET') ?? 0;
  return rows.slice(offset, limit === undefined ? undefined : offset + limit);
}

function sqlPlaceholderNumber(sql: string, params: unknown[], keyword: 'LIMIT' | 'OFFSET'): number | undefined {
  const match = new RegExp(`${keyword}\\s+\\$(\\d+)`, 'i').exec(sql);
  if (!match) return undefined;
  const value = params[Number(match[1]) - 1];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
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

async function xpodRdfExtensionBgpJoinRows(db: PGlite, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
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
  const hasSlotFilters = Array.isArray(params[constantsIndex + 3]);
  const filterSlots = hasSlotFilters ? params[constantsIndex + 3] as number[] : [];
  const filterOffsets = hasSlotFilters ? params[constantsIndex + 4] as number[] : [];
  const filterValues = hasSlotFilters ? params[constantsIndex + 5] as number[] : [];
  const limitIndex = constantsIndex + (hasSlotFilters ? 6 : 3);
  const offsetIndex = limitIndex + 1;
  const limit = typeof params[limitIndex] === 'number' ? Math.max(0, params[limitIndex] as number) : undefined;
  const offset = typeof params[offsetIndex] === 'number' ? Math.max(0, params[offsetIndex] as number) : 0;
  const result = await db.query('SELECT graph_id, subject_id, predicate_id, object_id FROM rdf_quads ORDER BY graph_id, subject_id, predicate_id, object_id');
  const quads = result.rows as Array<Record<string, unknown>>;
  const output: Array<Record<string, unknown>> = [];

  const visit = (patternIndex: number, bindings: Map<number, number>): void => {
    if (patternIndex >= indexNames.length) {
      if (!xpodRdfExtensionSlotFiltersMatch(bindings, filterSlots, filterOffsets, filterValues)) {
        return;
      }
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
  const nativeRows = output.slice(offset, limit === undefined ? undefined : offset + limit);
  return xpodRdfExtensionApplyOuterOrderPage(db, sql, params, nativeRows);
}

async function xpodRdfExtensionBgpOrderPageRows(db: PGlite, params: unknown[]): Promise<Array<Record<string, unknown>>> {
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
  const outputSlots = params[constantsIndex + 2] as number[];
  const orderSlots = params[constantsIndex + 3] as number[];
  const orderDesc = params[constantsIndex + 4] as boolean[];
  const limit = typeof params[constantsIndex + 5] === 'number' ? Math.max(0, params[constantsIndex + 5] as number) : undefined;
  const offset = typeof params[constantsIndex + 6] === 'number' ? Math.max(0, params[constantsIndex + 6] as number) : 0;
  const joinRows = await xpodRdfExtensionBgpJoinRows(
    db,
    'SELECT * FROM xpod_rdf.bgp_join(',
    [
      params[0],
      ...params.slice(1, constantsIndex),
      params[constantsIndex],
      params[constantsIndex + 1],
      outputSlots,
      null,
      null,
    ],
  );
  const terms = await db.query('SELECT id, value FROM rdf_terms');
  const valueById = new Map((terms.rows as Array<Record<string, unknown>>).map((term) => [
    Number(term.id),
    String(term.value ?? ''),
  ]));
  const orderColumns = orderSlots.map((slot) => outputSlots.indexOf(slot));
  if (orderColumns.some((index) => index < 0)) {
    return [];
  }
  const ordered = [...joinRows].sort((left, right) => {
    for (const [index, outputIndex] of orderColumns.entries()) {
      const leftValue = valueById.get(Number(left[`v${outputIndex}`])) ?? '';
      const rightValue = valueById.get(Number(right[`v${outputIndex}`])) ?? '';
      const comparison = leftValue.localeCompare(rightValue);
      if (comparison !== 0) {
        return orderDesc[index] ? -comparison : comparison;
      }
    }
    return 0;
  });
  return ordered.slice(offset, limit === undefined ? undefined : offset + limit);
}

async function xpodRdfExtensionApplyOuterOrderPage(
  db: PGlite,
  sql: string,
  params: unknown[],
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (!sql.includes('PostgresRdfNativeCustomIndexBgpOrderPage') && !sql.includes('ORDER BY join_order_t')) {
    return rows;
  }
  const orderColumns = [...sql.matchAll(/JOIN rdf_terms join_order_t(\d+) ON join_order_t\1\.id = ordered\.v(\d+)/g)]
    .map((match) => ({
      aliasIndex: Number(match[1]),
      valueColumn: `v${Number(match[2])}`,
    }))
    .sort((left, right) => left.aliasIndex - right.aliasIndex);
  if (orderColumns.length === 0) {
    return rows;
  }
  const orderSql = /ORDER BY\s+([\s\S]*?)(?:\s+LIMIT|\s+OFFSET|$)/i.exec(sql)?.[1] ?? '';
  const directions = orderColumns.map((column) => (
    new RegExp(`join_order_t${column.aliasIndex}\\.value\\s+DESC`, 'i').test(orderSql) ? 'desc' : 'asc'
  ));
  const terms = await db.query('SELECT id, value FROM rdf_terms');
  const valueById = new Map((terms.rows as Array<Record<string, unknown>>).map((term) => [
    Number(term.id),
    String(term.value ?? ''),
  ]));
  const ordered = [...rows].sort((left, right) => {
    for (const [index, column] of orderColumns.entries()) {
      const leftValue = valueById.get(Number(left[column.valueColumn])) ?? '';
      const rightValue = valueById.get(Number(right[column.valueColumn])) ?? '';
      const comparison = leftValue.localeCompare(rightValue);
      if (comparison !== 0) {
        return directions[index] === 'desc' ? -comparison : comparison;
      }
    }
    return 0;
  });
  const outerLimit = sqlPlaceholderNumber(sql, params, 'LIMIT');
  const outerOffset = sqlPlaceholderNumber(sql, params, 'OFFSET') ?? 0;
  return ordered.slice(outerOffset, outerLimit === undefined ? undefined : outerOffset + outerLimit);
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
  const hasSlotFilters = Array.isArray(params[constantsIndex + 5]);
  const filterSlots = hasSlotFilters ? params[constantsIndex + 5] as number[] : [];
  const filterOffsets = hasSlotFilters ? params[constantsIndex + 6] as number[] : [];
  const filterValues = hasSlotFilters ? params[constantsIndex + 7] as number[] : [];
  const limitIndex = constantsIndex + (hasSlotFilters ? 8 : 5);
  const offsetIndex = limitIndex + 1;
  const limit = typeof params[limitIndex] === 'number' ? Math.max(0, params[limitIndex] as number) : undefined;
  const offset = typeof params[offsetIndex] === 'number' ? Math.max(0, params[offsetIndex] as number) : 0;
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
  return applyXpodRdfExtensionSlotFilters(
    applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows),
    filterSlots,
    filterOffsets,
    filterValues,
  )
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
  const hasSlotFilters = params.length > constantsIndex + 6;
  const filterSlots = hasSlotFilters ? params[constantsIndex + 4] as number[] : [];
  const filterOffsets = hasSlotFilters ? params[constantsIndex + 5] as number[] : [];
  const filterValues = hasSlotFilters ? params[constantsIndex + 6] as number[] : [];
  const aggregateSlotsIndex = constantsIndex + (hasSlotFilters ? 7 : 4);
  const aggregateSlots = params[aggregateSlotsIndex] as number[];
  const aggregateDistinct = params[aggregateSlotsIndex + 1] as number[];
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
  const constrainedBindings = applyXpodRdfExtensionSlotFilters(
    applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows),
    filterSlots,
    filterOffsets,
    filterValues,
  );
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
  const hasSlotFilters = params.length > constantsIndex + 7;
  const filterSlots = hasSlotFilters ? params[constantsIndex + 4] as number[] : [];
  const filterOffsets = hasSlotFilters ? params[constantsIndex + 5] as number[] : [];
  const filterValues = hasSlotFilters ? params[constantsIndex + 6] as number[] : [];
  const groupSlotsIndex = constantsIndex + (hasSlotFilters ? 7 : 4);
  const groupSlots = params[groupSlotsIndex] as number[];
  const aggregateSlots = params[groupSlotsIndex + 1] as number[];
  const aggregateDistinct = params[groupSlotsIndex + 2] as number[];
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
  const constrainedBindings = applyXpodRdfExtensionSlotFilters(
    applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows),
    filterSlots,
    filterOffsets,
    filterValues,
  );
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
  const hasSlotFilters = params.length > constantsIndex + 7;
  const filterSlots = hasSlotFilters ? params[constantsIndex + 4] as number[] : [];
  const filterOffsets = hasSlotFilters ? params[constantsIndex + 5] as number[] : [];
  const filterValues = hasSlotFilters ? params[constantsIndex + 6] as number[] : [];
  const groupSlotsIndex = constantsIndex + (hasSlotFilters ? 7 : 4);
  const groupSlots = params[groupSlotsIndex] as number[];
  const numericSlot = Number(params[groupSlotsIndex + 1]);
  const numericDistinct = Number(params[groupSlotsIndex + 2] ?? 0) !== 0;
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
  const constrainedBindings = applyXpodRdfExtensionSlotFilters(
    applyXpodRdfExtensionValues(bindingsList, valueSlots, valueRows),
    filterSlots,
    filterOffsets,
    filterValues,
  )
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

function applyXpodRdfExtensionSlotFilters(
  bindingsList: Array<Map<number, number>>,
  filterSlots: number[],
  filterOffsets: number[],
  filterValues: number[],
): Array<Map<number, number>> {
  if (filterSlots.length === 0) {
    return bindingsList;
  }
  return bindingsList.filter((bindings) => xpodRdfExtensionSlotFiltersMatch(bindings, filterSlots, filterOffsets, filterValues));
}

function xpodRdfExtensionSlotFiltersMatch(
  bindings: Map<number, number>,
  filterSlots: number[],
  filterOffsets: number[],
  filterValues: number[],
): boolean {
  for (const [index, slot] of filterSlots.entries()) {
    const value = bindings.get(slot);
    if (value === undefined) {
      return false;
    }
    const start = filterOffsets[index] ?? 0;
    const end = filterOffsets[index + 1] ?? start;
    if (!filterValues.slice(start, end).includes(value)) {
      return false;
    }
  }
  return true;
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

class NativeVectorEvidenceIndex implements RdfVectorIndexLike {
  public open(): void {}
  public close(): void {}
  public clear(): void {}
  public indexVector(): void {}
  public deleteSource(): number {
    return 0;
  }
  public search(_options: RdfVectorSearchOptions): RdfVectorSearchResult[] {
    return [{
      source: 'https://pod.example/alice/docs/native-vector.md',
      workspace: 'https://pod.example/alice/',
      localPath: 'docs/native-vector.md',
      contentType: 'text/markdown',
      sourceKey: 'source-node:native-vector',
      chunkKey: 'native-vector-0',
      retrievalPointKey: 'native-vector-0',
      ordinal: 0,
      level: 1,
      content: 'native vector content',
      path: [],
      startOffset: 0,
      endOffset: 21,
      embedding: [1, 0],
      scoreComponents: {
        sourceType: 'vector',
        backend: 'pg-vector',
        metric: 'cosine',
        dimensions: 2,
        score: 1,
        distance: 0,
        dotProduct: 1,
        queryMagnitude: 1,
        candidateMagnitude: 1,
      },
      score: 1,
      distance: 0,
    }];
  }
  public summaryLifecycle(): [] {
    return [];
  }
  public estimateSearchCardinality(): { rows: number; source: 'pg-vector-score'; indexChoice: string } {
    return { rows: 1, source: 'pg-vector-score', indexChoice: 'pg-vector-score' };
  }
  public stats(): { sourceCount: number; chunkCount: number; componentCount: number; databaseBytes: number; modelDistribution: [] } {
    return { sourceCount: 1, chunkCount: 1, componentCount: 0, databaseBytes: 0, modelDistribution: [] };
  }
  public modelDistribution(): [] {
    return [];
  }
}

class StringIntegerPgPool {
  private readonly db: PGlite;

  public constructor(dataDir: string) {
    this.db = new PGlite(dataDir);
  }

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    await this.db.waitReady;
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows.map((row) => stringIntegerRow(row as Record<string, unknown>)),
    };
  }

  public async connect(): Promise<StringIntegerPgClientLike> {
    await this.db.waitReady;
    return new StringIntegerPgClient(this.db);
  }

  public async end(): Promise<void> {
    await this.db.close();
  }
}

interface StringIntegerPgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

class StringIntegerPgClient {
  public constructor(private readonly db: PGlite) {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows.map((row) => stringIntegerRow(row as Record<string, unknown>)),
    };
  }

  public release(): void {}
}

class InstrumentedPgPool extends StringIntegerPgPool {
  private shouldFailNextQuadInsert = false;
  public deadlockFailuresInjected = 0;
  public transactionBeginsAfterReset = 0;
  public transactionQueriesAfterReset: string[] = [];

  public failNextQuadInsertWithDeadlock(): void {
    this.shouldFailNextQuadInsert = true;
  }

  public resetInstrumentation(): void {
    this.deadlockFailuresInjected = 0;
    this.transactionBeginsAfterReset = 0;
    this.transactionQueriesAfterReset = [];
  }

  public override async connect(): Promise<InstrumentedPgClient> {
    const client = await super.connect();
    return new InstrumentedPgClient(client, this);
  }

  public consumeQuadInsertDeadlock(): boolean {
    if (!this.shouldFailNextQuadInsert) {
      return false;
    }
    this.shouldFailNextQuadInsert = false;
    this.deadlockFailuresInjected += 1;
    return true;
  }
}

class InstrumentedPgClient {
  private inTransaction = false;

  public constructor(
    private readonly delegate: StringIntegerPgClientLike,
    private readonly pool: InstrumentedPgPool,
  ) {}

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const normalized = sql.trim();
    if (/^BEGIN\b/i.test(normalized)) {
      this.inTransaction = true;
      this.pool.transactionBeginsAfterReset += 1;
    } else if (/^(?:COMMIT|ROLLBACK)\b/i.test(normalized)) {
      this.inTransaction = false;
    } else if (this.inTransaction) {
      this.pool.transactionQueriesAfterReset.push(normalized);
    }

    if (/INSERT\s+INTO\s+rdf_quads\b/i.test(normalized) && this.pool.consumeQuadInsertDeadlock()) {
      const error = new Error('deadlock detected') as Error & { code: string };
      error.code = '40P01';
      throw error;
    }

    return this.delegate.query(sql, params);
  }

  public release(): void {
    this.delegate.release();
  }
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
