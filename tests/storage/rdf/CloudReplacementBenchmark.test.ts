import { describe, expect, expectTypeOf, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import {
  buildCloudReplacementTopology,
  CLOUD_REPLACEMENT_GROUP_WEIGHTS,
  CLOUD_REPLACEMENT_THRESHOLDS,
  calculateCloudReplacementThroughput,
  calculateCloudReplacementThroughputRatio,
  calculateCloudReplacementWeightedP95Ratio,
  canonicalCloudReplacementDigests,
  canonicalCloudReplacementRow,
  canonicalCloudReplacementTerm,
  classifyCloudReplacementBenchmarkError,
  cloudReplacementWorkloads,
  compareCloudReplacementCase,
  createCloudReplacementSampleIdentitySource,
  decideCloudReplacement,
  measureCloudReplacementCase,
  measureCloudReplacementConcurrency,
  renderCloudReplacementJson,
  renderCloudReplacementMarkdown,
  sanitizeCloudReplacementEnvironment,
  type CloudReplacementBinding,
  type CloudReplacementCacheMode,
  type CloudReplacementConcurrency,
  type CloudReplacementCorrectness,
  type CloudReplacementErrorCategory,
  type CloudReplacementErrorEvidence,
  type CloudReplacementErrorStage,
  type CloudReplacementDecisionInput,
  type CloudReplacementEngineAdapter,
  type CloudReplacementEngineId,
  type CloudReplacementExecution,
  type CloudReplacementLatency,
  type CloudReplacementPgDiagnostics,
  type CloudReplacementRecommendation,
  type CloudReplacementReport,
  type CloudReplacementSampleIdentitySource,
  type CloudReplacementWorkload,
  type CloudReplacementWorkloadGroup,
} from '../../../src/storage/rdf/cloud-replacement-benchmark';
import { applyRdfAccessScope, rdfAccessGraphAllowed } from '../../../src/storage/rdf/RdfAccessScope';
import { RdfQuadIndex } from '../../../src/storage/rdf/RdfQuadIndex';
import { RdfSparqlAdapter } from '../../../src/storage/rdf/RdfSparqlAdapter';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import {
  buildRdfModelsBenchmarkSeed,
  buildRdfModelsSyntheticMessageBatch,
} from '../../../src/storage/rdf/models-benchmark';

const ALICE_POD = 'https://pod.example/alice/';
const ALICE_CHAT_PREFIX = 'https://pod.example/alice/.data/chat/';
const ALICE_CHAT_INDEX = `${ALICE_CHAT_PREFIX}default/index.ttl`;
const DAY_ONE = `${ALICE_CHAT_PREFIX}default/2026/05/01/messages.ttl`;
const DENIED_DAY = `${ALICE_CHAT_PREFIX}default/2026/05/05/messages.ttl`;

const QUERY_PREFIXES = [
  'PREFIX sioc: <http://rdfs.org/sioc/ns#>',
  'PREFIX dct: <http://purl.org/dc/terms/>',
  'PREFIX udfs: <https://undefineds.co/ns#>',
  'PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>',
  'PREFIX ai: <https://vocab.xpod.dev/ai#>',
].join('\n');

const SHARED_QUERY_BODIES = {
  'point-lookup': 'SELECT ?content WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> sioc:content ?content } }',
  'subject-star': 'SELECT ?p ?o WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> ?p ?o } }',
  'latest-message': 'SELECT ?message ?created WHERE { GRAPH ?g { ?message sioc:has_member <https://pod.example/alice/.data/chat/default/index.ttl#thread_1>; dct:created ?created } } ORDER BY DESC(?created) LIMIT 1',
  'keyset-page': 'SELECT ?message ?rank WHERE { GRAPH ?g { ?message udfs:rank ?rank . FILTER(?rank > 100) } } ORDER BY ?rank LIMIT 50',
  'exact-graph': 'SELECT ?message WHERE { GRAPH <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl> { ?message a meeting:Message } }',
  'selective-po': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97; udfs:status "indexed" } }',
  'two-hop-chain': 'SELECT ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'four-hop-chain': 'SELECT ?message ?owner WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } }',
  'eight-hop-chain': 'SELECT ?message ?category WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } GRAPH ?g5 { ?owner udfs:provider ?provider } GRAPH ?g6 { ?provider ai:hasModel ?model } GRAPH ?g7 { ?model udfs:capability ?capability } GRAPH ?g8 { ?capability udfs:category ?category } }',
  'message-star': 'SELECT ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'message-snowflake': 'SELECT ?message ?threadCreated ?score WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread; udfs:score ?score } GRAPH ?g2 { ?thread dct:created ?threadCreated; udfs:workspace ?workspace } }',
  'bounded-many-to-many': 'SELECT ?left ?right WHERE { GRAPH ?g1 { ?left sioc:has_member ?thread; udfs:rank ?leftRank } GRAPH ?g2 { ?right sioc:has_member ?thread; udfs:rank ?rightRank } FILTER(?leftRank < 20 && ?rightRank < 20 && ?left != ?right) }',
  'low-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 0) } }',
  'medium-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 50) } }',
  'high-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97 } }',
  'count-distinct-threads': 'SELECT (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } }',
  'ordered-top-k': 'SELECT ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
  'optional-content': 'SELECT ?message ?content WHERE { GRAPH ?g { ?message a meeting:Message . OPTIONAL { ?message sioc:content ?content } } }',
  'union-status-score': 'SELECT DISTINCT ?message WHERE { { GRAPH ?g { ?message udfs:status "indexed" } } UNION { GRAPH ?g { ?message udfs:score 100 } } }',
  'top-thread-aggregate': 'SELECT ?thread (COUNT(?message) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?thread ORDER BY DESC(?count) ?thread LIMIT 20',
} as const;

const SHORT_IDS = [
  'point-lookup',
  'subject-star',
  'latest-message',
  'keyset-page',
  'exact-graph',
  'selective-po',
] as const;

const LARGE_IDS = [
  'two-hop-chain',
  'four-hop-chain',
  'eight-hop-chain',
  'message-star',
  'message-snowflake',
  'bounded-many-to-many',
  'low-selectivity-filter',
  'medium-selectivity-filter',
  'high-selectivity-filter',
  'count-distinct-threads',
  'ordered-top-k',
  'optional-content',
  'union-status-score',
  'top-thread-aggregate',
] as const;

const AUTHORIZATION_IDS = [
  'authorization-inherited-prefix',
  'authorization-explicit-allow',
  'authorization-explicit-deny',
  'authorization-scoped-broad-join',
] as const;

const AUTHORIZATION_QUERY_BODIES = {
  'authorization-inherited-prefix': 'SELECT ?g ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'authorization-explicit-allow': 'SELECT ?g1 ?g2 ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'authorization-explicit-deny': 'SELECT ?g (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?g ORDER BY ?g',
  'authorization-scoped-broad-join': 'SELECT ?g ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
} as const;

const AUTHORIZATION_GRAPH_VARIABLES = {
  'authorization-inherited-prefix': [ 'g' ],
  'authorization-explicit-allow': [ 'g1', 'g2' ],
  'authorization-explicit-deny': [ 'g' ],
  'authorization-scoped-broad-join': [ 'g' ],
} as const;

const ROW_EXPECTATIONS = {
  'point-lookup': { expectedRows: 1, minRows: undefined },
  'subject-star': { expectedRows: 9, minRows: undefined },
  'latest-message': { expectedRows: 1, minRows: undefined },
  'keyset-page': { expectedRows: 50, minRows: undefined },
  'exact-graph': { expectedRows: undefined, minRows: 1 },
  'selective-po': { expectedRows: undefined, minRows: 1 },
  'two-hop-chain': { expectedRows: undefined, minRows: 1 },
  'four-hop-chain': { expectedRows: undefined, minRows: 1 },
  'eight-hop-chain': { expectedRows: undefined, minRows: 1 },
  'message-star': { expectedRows: undefined, minRows: 1 },
  'message-snowflake': { expectedRows: undefined, minRows: 1 },
  'bounded-many-to-many': { expectedRows: undefined, minRows: 1 },
  'low-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'medium-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'high-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'count-distinct-threads': { expectedRows: 1, minRows: undefined },
  'ordered-top-k': { expectedRows: 100, minRows: undefined },
  'optional-content': { expectedRows: undefined, minRows: 1 },
  'union-status-score': { expectedRows: undefined, minRows: 1 },
  'top-thread-aggregate': { expectedRows: undefined, minRows: 1 },
  'authorization-inherited-prefix': { expectedRows: undefined, minRows: 1 },
  'authorization-explicit-allow': { expectedRows: undefined, minRows: 1 },
  'authorization-explicit-deny': { expectedRows: undefined, minRows: 1 },
  'authorization-scoped-broad-join': { expectedRows: 100, minRows: undefined },
} as const;

const pointCase: CloudReplacementWorkload = {
  id: 'point-lookup',
  group: 'short',
  purpose: 'test fixture',
  sparql: 'SELECT ?s WHERE { VALUES ?s { <urn:s:1> <urn:s:2> } }',
  sharedSurface: true,
  orderSensitive: false,
  concurrencyRepresentative: true,
  expectedRows: 2,
};

const authorizationCase: CloudReplacementWorkload = {
  ...pointCase,
  id: 'authorization-oracle',
  group: 'authorization',
  expectedRows: 1,
  concurrencyRepresentative: false,
  accessScope: {
    basePath: ALICE_CHAT_PREFIX,
    mode: 'read',
    deniedGraphUrls: [ DENIED_DAY ],
  },
  authorizationGraphVariables: [ 'g' ],
};

function fakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  rows: string[],
  options: {
    fallbackReason?: string;
    orderedDigest?: string;
    multisetDigest?: string;
    queryElapsedMs?: number | null;
    onExecute?: (sampleIdentity?: string) => void;
  } = {},
): CloudReplacementEngineAdapter<Id> {
  const digests = canonicalCloudReplacementDigests(rows);
  return {
    id,
    async execute(_workload, sampleIdentity) {
      options.onExecute?.(sampleIdentity);
      return {
        rows,
        orderedDigest: options.orderedDigest ?? digests.orderedDigest,
        multisetDigest: options.multisetDigest ?? digests.multisetDigest,
        fallbackReason: options.fallbackReason ?? null,
        physicalPlan: [ `${id}:fake` ],
        queryElapsedMs: options.queryElapsedMs ?? null,
      };
    },
  };
}

function timedFakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  order: string[],
  durationMs: number,
  clock: { value: number },
): CloudReplacementEngineAdapter<Id> {
  const base = fakeAdapter(id, [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);
  return {
    id,
    async execute(workload, sampleIdentity) {
      order.push(id);
      const result = await base.execute(workload, sampleIdentity);
      clock.value += durationMs;
      return { ...result, queryElapsedMs: durationMs };
    },
  };
}

function sequencedTimedFakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  durationsMs: number[],
  clock: { value: number },
  identities: Array<string | undefined> = [],
): CloudReplacementEngineAdapter<Id> {
  const base = fakeAdapter(id, [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);
  let sampleIndex = 0;
  return {
    id,
    async execute(workload, sampleIdentity) {
      identities.push(sampleIdentity);
      const result = await base.execute(workload, sampleIdentity);
      const queryElapsedMs = durationsMs[sampleIndex] ?? 0;
      clock.value += queryElapsedMs;
      sampleIndex += 1;
      return { ...result, queryElapsedMs };
    },
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cloudReplacementConnectionError(message = 'connect ECONNREFUSED 10.0.0.1:5432'): Error {
  return Object.assign(new Error(message), { code: 'ECONNREFUSED' });
}

describe('cloud replacement benchmark', () => {
  it('alternates engine order and reports cache-labelled latency percentiles', async () => {
    const order: string[] = [];
    const clock = { value: 0 };
    const result = await measureCloudReplacementCase(
      pointCase,
      timedFakeAdapter('rdf3x', order, 10, clock),
      timedFakeAdapter('qlever', order, 5, clock),
      {
        warmupIterations: 3,
        iterations: 4,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    );

    expect(order).toEqual([
      'rdf3x', 'qlever',
      'qlever', 'rdf3x',
      'rdf3x', 'qlever',
      'qlever', 'rdf3x',
      'rdf3x', 'qlever',
      'qlever', 'rdf3x',
      'rdf3x', 'qlever',
      'qlever', 'rdf3x',
    ]);
    expect(result.rdf3x).toEqual({
      cacheMode: 'production',
      coldMs: 10,
      samplesMs: [ 10, 10, 10, 10 ],
      p50Ms: 10,
      p95Ms: 10,
      p99Ms: 10,
    } satisfies CloudReplacementLatency);
    expect(result.qlever).toEqual({
      cacheMode: 'production',
      coldMs: 5,
      samplesMs: [ 5, 5, 5, 5 ],
      p50Ms: 5,
      p95Ms: 5,
      p99Ms: 5,
    } satisfies CloudReplacementLatency);
    expectTypeOf<CloudReplacementCacheMode>().toEqualTypeOf<'off' | 'production'>();
  });

  it('runs all concurrency workers against one shared deadline', async () => {
    const starts: number[] = [];
    const clock = { value: 0 };
    const base = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]);
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute(workload, sampleIdentity) {
        starts.push(clock.value);
        clock.value += 10;
        return base.execute(workload, sampleIdentity);
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 8,
      durationMs: 100,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => clock.value,
    });

    expect(starts).toEqual(Array.from({ length: 16 }, (_value, index) => index * 10));
    expect(result).toEqual({
      cacheMode: 'production',
      concurrency: 8,
      durationMs: 100,
      elapsedMs: 160,
      completed: 16,
      errors: 0,
      infrastructureErrors: 0,
      infrastructureFailure: false,
      errorEvidence: {
        counts: {
          timeout: 0,
          connection: 0,
          cancelled: 0,
          engine: 0,
          correctness: 0,
          unknown: 0,
        },
        samples: [],
      },
      throughputPerSecond: 100,
    } satisfies CloudReplacementConcurrency);
  });

  it('classifies cloud replacement benchmark errors with stable categories and stages', () => {
    const connection = Object.assign(new Error('connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    });
    const sqlConnection = Object.assign(new Error('pool ended'), { code: '08006' });
    const timeout = new DOMException('statement timeout', 'TimeoutError');
    const statementTimeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const cancelled = new DOMException('manual abort', 'AbortError');
    const engine = new Error('adapter blew up');
    const correctness = { category: 'correctness', stage: 'materialize', message: 'digest mismatch' };

    expect(classifyCloudReplacementBenchmarkError(connection)).toMatchObject({
      category: 'connection',
      stage: 'acquire',
      code: 'ECONNRESET',
    });
    expect(classifyCloudReplacementBenchmarkError(sqlConnection)).toMatchObject({
      category: 'connection',
      stage: 'acquire',
      code: '08006',
    });
    expect(classifyCloudReplacementBenchmarkError(timeout)).toMatchObject({
      category: 'timeout',
      stage: 'query',
      name: 'TimeoutError',
    });
    expect(classifyCloudReplacementBenchmarkError(statementTimeout)).toMatchObject({
      category: 'timeout',
      stage: 'query',
      code: '57014',
    });
    expect(classifyCloudReplacementBenchmarkError(cancelled)).toMatchObject({
      category: 'cancelled',
      stage: 'cancel',
      name: 'AbortError',
    });
    expect(classifyCloudReplacementBenchmarkError(engine)).toMatchObject({
      category: 'engine',
      stage: 'query',
    });
    expect(classifyCloudReplacementBenchmarkError(correctness)).toMatchObject({
      category: 'correctness',
      stage: 'materialize',
      message: 'digest mismatch',
    });
    expect(classifyCloudReplacementBenchmarkError('plain failure')).toMatchObject({
      category: 'unknown',
      stage: 'query',
    });
    expectTypeOf<CloudReplacementErrorCategory>().toEqualTypeOf<
      'timeout' | 'connection' | 'cancelled' | 'engine' | 'correctness' | 'unknown'
    >();
    expectTypeOf<CloudReplacementErrorStage>().toEqualTypeOf<
      'acquire' | 'query' | 'materialize' | 'cancel' | 'cleanup'
    >();
  });

  it('prefers explicit legal stages and walks nested causes up to the connection root', () => {
    const root = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const wrapper = Object.assign(new Error('outer wrapper'), {
      stage: 'cleanup',
      cause: { cause: root },
    });

    expect(classifyCloudReplacementBenchmarkError(wrapper)).toMatchObject({
      category: 'connection',
      stage: 'cleanup',
      code: 'ECONNREFUSED',
    });
  });

  it('records bounded sanitized error evidence while preserving full category counts', async () => {
    const messages = [
      'variant one postgres://alice:secret@db.internal.example:5432/app password=hunter2 token=abc secret=def host=api.internal 192.168.1.50:5432',
      'variant two postgres://bob:secret@db2.internal.example:5432/app password=hidden token=ghi secret=jkl host=db2.internal 10.0.0.2:5432',
      'variant three https://user:pass@service.internal.example/path password=one token=two secret=three host=service.internal [2001:db8::1]:5432',
      'variant four postgres://carol:secret@db3.internal.example:5432/app password=more token=more secret=more host=db3.internal 172.16.0.3:5432',
      'variant one postgres://alice:secret@db.internal.example:5432/app password=hunter2 token=abc secret=def host=api.internal 192.168.1.50:5432',
    ];
    let attempts = 0;
    const seenAt = [
      new Date('2026-07-18T01:00:00.000Z'),
      new Date('2026-07-18T01:00:01.000Z'),
      new Date('2026-07-18T01:00:02.000Z'),
      new Date('2026-07-18T01:00:03.000Z'),
      new Date('2026-07-18T01:00:04.000Z'),
    ];
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        const message = messages[attempts] ?? messages[0];
        attempts += 1;
        throw Object.assign(new Error(`${message}\u0000${'x'.repeat(300)}`), {
          code: 'EPIPE',
        });
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 5,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => attempts,
      wallNow: () => seenAt[Math.max(attempts - 1, 0)] ?? seenAt[0]!,
      sleep: async () => {},
      maxConsecutiveConnectionErrors: 10,
    });

    expect(result.infrastructureErrors).toBe(5);
    expect(result.infrastructureFailure).toBe(false);
    expect(result.errors).toBe(0);
    expect(result.errorEvidence.counts.connection).toBe(5);
    expect(result.errorEvidence.samples).toHaveLength(3);
    expect(result.errorEvidence.samples[0]).toMatchObject({
      category: 'connection',
      stage: 'acquire',
      count: 2,
      firstSeenAt: '2026-07-18T01:00:00.000Z',
      lastSeenAt: '2026-07-18T01:00:04.000Z',
      workloadId: pointCase.id,
      engine: 'rdf3x',
      cacheMode: 'production',
      concurrency: 1,
    });
    for (const sample of result.errorEvidence.samples) {
      expect(sample.message.length).toBeLessThanOrEqual(240);
      expect(sample.message).not.toMatch(/alice|bob|carol|hunter2|secret|abc|ghi|jkl|db\d?\.internal|service\.internal|api\.internal|192\.168|10\.0|172\.16|2001:db8|password=|token=/iu);
    }
    expectTypeOf<CloudReplacementErrorEvidence>().toEqualTypeOf<{
      counts: Record<CloudReplacementErrorCategory, number>;
      samples: Array<{
        category: CloudReplacementErrorCategory;
        stage: CloudReplacementErrorStage;
        name: string;
        code: string | null;
        message: string;
        firstSeenAt: string;
        lastSeenAt: string;
        count: number;
        workloadId: string;
        engine: CloudReplacementEngineId;
        cacheMode: CloudReplacementCacheMode;
        concurrency: 1 | 8 | 32;
      }>;
    }>();
  });

  it('sanitizes raw endpoints and credential assignments in classified benchmark errors', () => {
    const classified = classifyCloudReplacementBenchmarkError(Object.assign(new Error(
      [
        'connect 192.168.10.20 and 192.168.10.21:5432',
        'ipv6 2001:db8:85a3::8a2e:370:7334 and [2001:db8::1]:5432',
        'password = hunter2 token: abc secret : def user=alice username: bob',
        'host = db.internal.example host: api.internal.example',
      ].join(' '),
    ), { code: 'ECONNRESET' }));

    expect(classified.category).toBe('connection');
    expect(classified.message).not.toMatch(
      /192\.168|2001:db8|hunter2|abc|def|alice|bob|db\.internal|api\.internal|password\s*[=:]|token\s*[=:]|secret\s*[=:]|user(?:name)?\s*[=:]|host\s*[=:]/iu,
    );
    expect(classified.message).toContain('[redacted-endpoint]');
    expect(classified.message).toContain('[redacted-credential]');
    expect(classified.message).toContain('[redacted-host]');
  });

  it('redacts DNS endpoint-looking hostnames while preserving diagnostic error codes', () => {
    for (const error of [
      Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432'), {
        code: 'ECONNREFUSED',
      }),
      Object.assign(new Error('getaddrinfo ENOTFOUND db.internal.example'), {
        code: 'ENOTFOUND',
      }),
    ]) {
      const classified = classifyCloudReplacementBenchmarkError(error);

      expect(classified.category).toBe('connection');
      expect(classified.stage).toBe('acquire');
      expect(classified.code).toBe((error as { code: string }).code);
      expect(classified.message).not.toMatch(/db\.internal\.example|5432/u);
      expect(classified.message).toContain('[redacted-endpoint]');
    }
  });

  it('keeps the measurement contracts exact and fixes adapter positions', () => {
    expectTypeOf<CloudReplacementLatency>().toEqualTypeOf<{
      cacheMode: CloudReplacementCacheMode;
      coldMs: number;
      samplesMs: number[];
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    }>();
    expectTypeOf<CloudReplacementConcurrency>().toEqualTypeOf<{
      cacheMode: CloudReplacementCacheMode;
      concurrency: 1 | 8 | 32;
      durationMs: number;
      elapsedMs: number;
      completed: number;
      errors: number;
      infrastructureErrors: number;
      infrastructureFailure: boolean;
      errorEvidence: CloudReplacementErrorEvidence;
      throughputPerSecond: number;
    }>();
    expectTypeOf<CloudReplacementPgDiagnostics>().toEqualTypeOf<{
      sharedBlocksRead: number | null;
      sharedBlocksHit: number | null;
      tempBytes: number | null;
      memoryPeakBytes: number | null;
      memoryLimitBytes: number | null;
      diagnosticsUnavailable: string[];
    }>();
    expectTypeOf<Parameters<typeof measureCloudReplacementCase>[1]>()
      .toEqualTypeOf<CloudReplacementEngineAdapter<'rdf3x'>>();
    expectTypeOf<Parameters<typeof measureCloudReplacementCase>[2]>()
      .toEqualTypeOf<CloudReplacementEngineAdapter<'qlever'>>();
    expectTypeOf<Parameters<typeof measureCloudReplacementCase>[3]['coldFirstEngine']>()
      .toEqualTypeOf<'rdf3x' | 'qlever'>();
    expectTypeOf<Parameters<typeof measureCloudReplacementCase>[3]['operationTimeoutMs']>()
      .toEqualTypeOf<number>();
    expectTypeOf<Parameters<typeof measureCloudReplacementConcurrency>[2]['concurrency']>()
      .toEqualTypeOf<1 | 8 | 32>();
    expectTypeOf<CloudReplacementSampleIdentitySource>().toEqualTypeOf<{
      next(engine: CloudReplacementEngineId): string;
    }>();
    expectTypeOf<Extract<
      Parameters<typeof measureCloudReplacementCase>[3],
      { cacheMode: 'off' }
    >['identitySource']>().toEqualTypeOf<CloudReplacementSampleIdentitySource>();
    expectTypeOf<Extract<
      Parameters<typeof measureCloudReplacementConcurrency>[2],
      { cacheMode: 'off' }
    >['identitySource']>().toEqualTypeOf<CloudReplacementSampleIdentitySource>();
    expectTypeOf<Parameters<CloudReplacementEngineAdapter['execute']>[2]>()
      .toEqualTypeOf<AbortSignal | undefined>();
  });

  it('creates namespaced monotonic sample identities and rejects unsafe namespaces', () => {
    const source = createCloudReplacementSampleIdentitySource('task4');

    expect(source.next('rdf3x')).toBe('# xpod-benchmark-sample:task4:rdf3x:0');
    expect(source.next('qlever')).toBe('# xpod-benchmark-sample:task4:qlever:1');
    for (const namespace of [ '', '\n', 'unsafe\rnamespace' ]) {
      expect(() => createCloudReplacementSampleIdentitySource(namespace)).toThrow(
        'Cloud replacement sample identity namespace must be non-empty and contain no newlines',
      );
    }
  });

  it('requires one caller-owned identity source for every cache-off measurement', async () => {
    const latencyOptions = {
      warmupIterations: 0,
      iterations: 0,
      cacheMode: 'off',
      coldFirstEngine: 'rdf3x',
      operationTimeoutMs: 1_000,
    } as Parameters<typeof measureCloudReplacementCase>[3];
    const concurrencyOptions = {
      concurrency: 1,
      durationMs: 0,
      cacheMode: 'off',
      operationTimeoutMs: 1_000,
      now: () => 0,
    } as Parameters<typeof measureCloudReplacementConcurrency>[2];

    await expect(measureCloudReplacementCase(
      pointCase,
      timedFakeAdapter('rdf3x', [], 1, { value: 0 }),
      timedFakeAdapter('qlever', [], 1, { value: 0 }),
      latencyOptions,
    )).rejects.toThrow('Cache-off cloud replacement measurements require identitySource');
    await expect(measureCloudReplacementConcurrency(
      pointCase,
      fakeAdapter('rdf3x', []),
      concurrencyOptions,
    )).rejects.toThrow('Cache-off cloud replacement measurements require identitySource');
  });

  it('starts cold with the caller-selected engine and keeps alternating across phases', async () => {
    const order: string[] = [];
    const clock = { value: 0 };

    await measureCloudReplacementCase(
      pointCase,
      timedFakeAdapter('rdf3x', order, 1, clock),
      timedFakeAdapter('qlever', order, 1, clock),
      {
        warmupIterations: 1,
        iterations: 1,
        cacheMode: 'production',
        coldFirstEngine: 'qlever',
        identitySource: {
          next() {
            throw new Error('production cache mode must not request an identity');
          },
        },
        operationTimeoutMs: 1_000,
      },
    );

    expect(order).toEqual([
      'qlever', 'rdf3x',
      'rdf3x', 'qlever',
      'qlever', 'rdf3x',
    ]);
  });

  it('waits for the first engine before starting the second in every round', async () => {
    const clock = { value: 0 };
    let inFlight = 0;
    const adapter = <Id extends CloudReplacementEngineId>(
      id: Id,
    ): CloudReplacementEngineAdapter<Id> => ({
      id,
      async execute() {
        expect(inFlight).toBe(0);
        inFlight += 1;
        await Promise.resolve();
        clock.value += 1;
        inFlight -= 1;
        const execution = await fakeAdapter(
          id,
          [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ],
          { queryElapsedMs: 1 },
        ).execute(pointCase);
        return execution;
      },
    });

    await measureCloudReplacementCase(pointCase, adapter('rdf3x'), adapter('qlever'), {
      warmupIterations: 2,
      iterations: 2,
      cacheMode: 'production',
      coldFirstEngine: 'rdf3x',
      operationTimeoutMs: 1_000,
    });

    expect(inFlight).toBe(0);
  });

  it.each([
    [ 'empty', [], { p50Ms: 0, p95Ms: 0, p99Ms: 0 } ],
    [ 'one sample', [ 7 ], { p50Ms: 7, p95Ms: 7, p99Ms: 7 } ],
    [ 'even samples', [ 4, 1, 3, 2 ], { p50Ms: 2, p95Ms: 4, p99Ms: 4 } ],
    [ 'odd samples', [ 5, 1, 4, 2, 3 ], { p50Ms: 3, p95Ms: 5, p99Ms: 5 } ],
  ] as const)('uses nearest-rank percentiles for %s', async (_name, durations, expected) => {
    const clock = { value: 0 };
    const result = await measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 11, ...durations ], clock),
      sequencedTimedFakeAdapter('qlever', [ 13, ...durations ], clock),
      {
        warmupIterations: 0,
        iterations: durations.length,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    );

    expect(result.rdf3x.coldMs).toBe(11);
    expect(result.rdf3x.samplesMs).toEqual([ ...durations ]);
    expect(result.rdf3x).toMatchObject(expected);
    expect(result.qlever.coldMs).toBe(13);
    expect(result.qlever.samplesMs).toEqual([ ...durations ]);
    expect(result.qlever).toMatchObject(expected);
  });

  it('records a separate first-execution cold latency before warmup', async () => {
    const clock = { value: 0 };
    const result = await measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 101, 100, 200, 1, 2, 3 ], clock),
      sequencedTimedFakeAdapter('qlever', [ 301, 300, 400, 4, 5, 6 ], clock),
      {
        warmupIterations: 2,
        iterations: 3,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    );

    expect(result.rdf3x).toMatchObject({
      coldMs: 101,
      samplesMs: [ 1, 2, 3 ],
      p50Ms: 2,
      p95Ms: 3,
      p99Ms: 3,
    });
    expect(result.qlever).toMatchObject({
      coldMs: 301,
      samplesMs: [ 4, 5, 6 ],
      p50Ms: 5,
      p95Ms: 6,
      p99Ms: 6,
    });
  });

  it('uses adapter query time instead of adapter post-processing wall time', async () => {
    const clock = { value: 0 };
    const adapter = <Id extends CloudReplacementEngineId>(
      id: Id,
    ): CloudReplacementEngineAdapter<Id> => {
      const base = fakeAdapter(id, []);
      return {
        id,
        async execute(workload, sampleIdentity) {
          const execution = await base.execute(workload, sampleIdentity);
          clock.value += 1_000;
          return { ...execution, queryElapsedMs: 5 };
        },
      };
    };

    const result = await measureCloudReplacementCase(
      pointCase,
      adapter('rdf3x'),
      adapter('qlever'),
      {
        warmupIterations: 0,
        iterations: 2,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    );

    expect(result.rdf3x).toMatchObject({ coldMs: 5, samplesMs: [ 5, 5 ] });
    expect(result.qlever).toMatchObject({ coldMs: 5, samplesMs: [ 5, 5 ] });
    expect(clock.value).toBe(6_000);
  });

  it.each([ null, Number.NaN, Number.POSITIVE_INFINITY, -1 ])(
    'rejects invalid latency queryElapsedMs %s',
    async (queryElapsedMs) => {
      await expect(measureCloudReplacementCase(
        pointCase,
        fakeAdapter('rdf3x', [], { queryElapsedMs }),
        fakeAdapter('qlever', [], { queryElapsedMs: 1 }),
        {
          warmupIterations: 0,
          iterations: 0,
          cacheMode: 'production',
          coldFirstEngine: 'rdf3x',
          operationTimeoutMs: 1_000,
        },
      )).rejects.toThrow('Cloud replacement latency execution requires finite non-negative queryElapsedMs');
    },
  );

  it('validates queryElapsedMs on warmup executions as well as recorded samples', async () => {
    const clock = { value: 0 };
    await expect(measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 1, 1 ], clock),
      sequencedTimedFakeAdapter('qlever', [ 1, -1 ], clock),
      {
        warmupIterations: 1,
        iterations: 0,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    )).rejects.toThrow('Cloud replacement latency execution requires finite non-negative queryElapsedMs');
  });

  it.each([ Number.NaN, Number.POSITIVE_INFINITY, -1 ])(
    'rejects invalid iteration count %s',
    async (value) => {
      for (const field of [ 'warmupIterations', 'iterations' ] as const) {
        await expect(measureCloudReplacementCase(
          pointCase,
          timedFakeAdapter('rdf3x', [], 1, { value: 0 }),
          timedFakeAdapter('qlever', [], 1, { value: 0 }),
          {
            warmupIterations: field === 'warmupIterations' ? value : 0,
            iterations: field === 'iterations' ? value : 0,
            cacheMode: 'production',
            coldFirstEngine: 'rdf3x',
            operationTimeoutMs: 1_000,
          },
        )).rejects.toThrow(
          `Cloud replacement ${field} must be finite and non-negative`,
        );
      }
    },
  );

  it('floors finite fractional warmup and iteration counts', async () => {
    const order: string[] = [];
    const result = await measureCloudReplacementCase(
      pointCase,
      timedFakeAdapter('rdf3x', order, 1, { value: 0 }),
      timedFakeAdapter('qlever', order, 1, { value: 0 }),
      {
        warmupIterations: 1.9,
        iterations: 1.9,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 1_000,
      },
    );

    expect(order).toHaveLength(6);
    expect(result.rdf3x.samplesMs).toHaveLength(1);
    expect(result.qlever.samplesMs).toHaveLength(1);
  });

  it.each([ 0, -1, Number.NaN, Number.POSITIVE_INFINITY ])(
    'rejects invalid operation timeout %s',
    async (operationTimeoutMs) => {
      await expect(measureCloudReplacementCase(
        pointCase,
        timedFakeAdapter('rdf3x', [], 1, { value: 0 }),
        timedFakeAdapter('qlever', [], 1, { value: 0 }),
        {
          warmupIterations: 0,
          iterations: 0,
          cacheMode: 'production',
          coldFirstEngine: 'rdf3x',
          operationTimeoutMs,
        },
      )).rejects.toThrow('Cloud replacement operationTimeoutMs must be finite and positive');
      await expect(measureCloudReplacementConcurrency(
        pointCase,
        fakeAdapter('rdf3x', []),
        {
          concurrency: 1,
          durationMs: 0,
          cacheMode: 'production',
          operationTimeoutMs,
        },
      )).rejects.toThrow('Cloud replacement operationTimeoutMs must be finite and positive');
    },
  );

  it.each([ Number.NaN, Number.POSITIVE_INFINITY ])(
    'rejects invalid concurrency duration %s',
    async (durationMs) => {
      await expect(measureCloudReplacementConcurrency(
        pointCase,
        fakeAdapter('rdf3x', []),
        {
          concurrency: 1,
          durationMs,
          cacheMode: 'production',
          operationTimeoutMs: 1_000,
          now: () => Number.POSITIVE_INFINITY,
        },
      )).rejects.toThrow('Cloud replacement durationMs must be finite');
    },
  );

  it('aborts and rejects a timed-out latency execution', async () => {
    let capturedSignal: AbortSignal | undefined;
    const aborted = deferred();
    const rdf3x: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      execute(_workload, _sampleIdentity, signal) {
        capturedSignal = signal;
        signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        return new Promise<CloudReplacementExecution>((resolve) => {
          setTimeout(() => {
            void fakeAdapter('rdf3x', [], { queryElapsedMs: 1 }).execute(pointCase).then(resolve);
          }, 25);
        });
      },
    };

    await expect(measureCloudReplacementCase(
      pointCase,
      rdf3x,
      fakeAdapter('qlever', [], { queryElapsedMs: 1 }),
      {
        warmupIterations: 0,
        iterations: 0,
        cacheMode: 'production',
        coldFirstEngine: 'rdf3x',
        operationTimeoutMs: 5,
      },
    )).rejects.toThrow('Cloud replacement rdf3x operation timed out after 5ms');
    await aborted.promise;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('bounds a hanging concurrency operation and counts its timeout', async () => {
    const signals: AbortSignal[] = [];
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      execute(_workload, _sampleIdentity, signal) {
        if (signal) {
          signals.push(signal);
        }
        return new Promise<CloudReplacementExecution>((resolve) => {
          setTimeout(() => {
            void fakeAdapter('rdf3x', []).execute(pointCase).then(resolve);
          }, 25);
        });
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 1,
      cacheMode: 'production',
      operationTimeoutMs: 5,
    });

    expect(result.completed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.infrastructureErrors).toBe(0);
    expect(result.errorEvidence.counts.timeout).toBe(1);
    expect(result.errorEvidence.samples[0]).toMatchObject({
      category: 'timeout',
      stage: 'query',
      count: 1,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('isolates cache-off identities from production-cache measurements', async () => {
    const offIdentities: Array<string | undefined> = [];
    const productionIdentities: Array<string | undefined> = [];
    const offClock = { value: 0 };
    const productionClock = { value: 0 };
    const identitySource = createCloudReplacementSampleIdentitySource('latency');

    const off = await measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 1, 1, 1, 1 ], offClock, offIdentities),
      sequencedTimedFakeAdapter('qlever', [ 1, 1, 1, 1 ], offClock, offIdentities),
      {
        warmupIterations: 1,
        iterations: 2,
        cacheMode: 'off',
        coldFirstEngine: 'rdf3x',
        identitySource,
        operationTimeoutMs: 1_000,
      },
    );
    const production = await measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 1, 1, 1, 1 ], productionClock, productionIdentities),
      sequencedTimedFakeAdapter('qlever', [ 1, 1, 1, 1 ], productionClock, productionIdentities),
      {
        warmupIterations: 1,
        iterations: 2,
        cacheMode: 'production',
        coldFirstEngine: 'qlever',
        operationTimeoutMs: 1_000,
      },
    );

    expect(off.rdf3x.cacheMode).toBe('off');
    expect(off.qlever.cacheMode).toBe('off');
    expect(offIdentities).toHaveLength(8);
    expect(offIdentities.every((identity) =>
      /^# xpod-benchmark-sample:latency:(?:rdf3x|qlever):\d+$/u.test(identity ?? ''))).toBe(true);
    expect(new Set(offIdentities).size).toBe(offIdentities.length);
    expect(production.rdf3x.cacheMode).toBe('production');
    expect(production.qlever.cacheMode).toBe('production');
    expect(productionIdentities).toEqual(Array.from({ length: 8 }, () => undefined));
  });

  it('keeps cache-off identities unique across latency and all concurrency lanes', async () => {
    const identitySource = createCloudReplacementSampleIdentitySource('shared-run');
    const identities: Array<string | undefined> = [];
    let expectedIdentities = 4;
    const latencyClock = { value: 0 };
    await measureCloudReplacementCase(
      pointCase,
      sequencedTimedFakeAdapter('rdf3x', [ 1, 1 ], latencyClock, identities),
      sequencedTimedFakeAdapter('qlever', [ 1, 1 ], latencyClock, identities),
      {
        warmupIterations: 0,
        iterations: 1,
        cacheMode: 'off',
        coldFirstEngine: 'rdf3x',
        identitySource,
        operationTimeoutMs: 1_000,
      },
    );

    for (const concurrency of [ 1, 8, 32 ] as const) {
      const clock = { value: 0 };
      const adapter = fakeAdapter('rdf3x', [], {
        onExecute: (sampleIdentity) => {
          identities.push(sampleIdentity);
          clock.value += 10;
        },
      });
      const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
        concurrency,
        durationMs: 20,
        cacheMode: 'off',
        identitySource,
        operationTimeoutMs: 1_000,
        now: () => clock.value,
      });
      expectedIdentities += result.completed + result.errors;
    }

    expect(identities).toHaveLength(expectedIdentities);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.every((identity) =>
      /^# xpod-benchmark-sample:shared-run:(?:rdf3x|qlever):\d+$/u.test(identity ?? '')))
      .toBe(true);
  });

  it('propagates latency adapter exceptions unchanged', async () => {
    const failure = new Error('timed execution failed');
    let qleverExecutions = 0;
    const rdf3x: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      execute() {
        throw failure;
      },
    };
    const qlever = fakeAdapter('qlever', [ 's=NamedNode:urn:s:1' ], {
      onExecute: () => qleverExecutions += 1,
    });

    await expect(measureCloudReplacementCase(pointCase, rdf3x, qlever, {
      warmupIterations: 0,
      iterations: 1,
      cacheMode: 'off',
      coldFirstEngine: 'rdf3x',
      identitySource: createCloudReplacementSampleIdentitySource('exception'),
      operationTimeoutMs: 1_000,
    })).rejects.toBe(failure);
    expect(qleverExecutions).toBe(0);
  });

  it('rejects invalid latency adapter identities before either adapter executes', async () => {
    let executions = 0;
    const rdf3x = fakeAdapter('qlever', [], {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'rdf3x'>;
    const qlever = fakeAdapter('rdf3x', [], {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'qlever'>;

    await expect(measureCloudReplacementCase(pointCase, rdf3x, qlever, {
      warmupIterations: 1,
      iterations: 1,
      cacheMode: 'off',
      coldFirstEngine: 'rdf3x',
      identitySource: createCloudReplacementSampleIdentitySource('invalid-adapter'),
      operationTimeoutMs: 1_000,
    })).rejects.toThrow(
      'Cloud replacement adapter configuration error: expected rdf3x at rdf3x position, received qlever',
    );
    expect(executions).toBe(0);
  });

  it.each([ 1, 8, 32 ] as const)(
    'sustains concurrency %i until the common configured deadline',
    async (concurrency) => {
      const clock = { value: 0 };
      const base = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]);
      const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
        id: 'rdf3x',
        async execute(workload, sampleIdentity) {
          clock.value += 10;
          return base.execute(workload, sampleIdentity);
        },
      };

      const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
        concurrency,
        durationMs: 100,
        cacheMode: 'production',
        operationTimeoutMs: 1_000,
        now: () => clock.value,
      });

      expect(result).toMatchObject({
        cacheMode: 'production',
        concurrency,
        durationMs: 100,
        errors: 0,
        throughputPerSecond: 100,
      });
      expect(result.completed).toBeGreaterThan(0);
      expect(result.elapsedMs).toBe(result.completed * 10);
    },
  );

  it.each([ 8, 32 ] as const)(
    'starts all %i workers concurrently before the shared deadline',
    async (concurrency) => {
      const clock = { value: 0 };
      const allEntered = deferred();
      const release = deferred();
      let entered = 0;
      let inFlight = 0;
      let peakInFlight = 0;
      const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
        id: 'rdf3x',
        async execute() {
          entered += 1;
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          if (entered === concurrency) {
            allEntered.resolve();
          }
          await release.promise;
          inFlight -= 1;
          return fakeAdapter('rdf3x', []).execute(pointCase);
        },
      };

      const measurement = measureCloudReplacementConcurrency(pointCase, adapter, {
        concurrency,
        durationMs: 100,
        cacheMode: 'production',
        operationTimeoutMs: 1_000,
        now: () => clock.value,
      });
      await allEntered.promise;
      expect(peakInFlight).toBe(concurrency);
      clock.value = 100;
      release.resolve();

      const result = await measurement;
      expect(result).toMatchObject({
        concurrency,
        completed: concurrency,
        errors: 0,
        elapsedMs: 100,
        throughputPerSecond: concurrency * 10,
      });
    },
  );

  it('includes in-flight tail completion time in concurrency throughput', async () => {
    const clock = { value: 0 };
    const allEntered = deferred();
    const release = deferred();
    let entered = 0;
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        entered += 1;
        if (entered === 8) {
          allEntered.resolve();
        }
        await release.promise;
        return fakeAdapter('rdf3x', []).execute(pointCase);
      },
    };

    const measurement = measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 8,
      durationMs: 10,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => clock.value,
    });
    await allEntered.promise;
    clock.value = 100;
    release.resolve();

    const result = await measurement;
    expect(result).toMatchObject({
      completed: 8,
      errors: 0,
      elapsedMs: 100,
      throughputPerSecond: 80,
    });
  });

  it('counts concurrency errors and continues attempting work until the deadline', async () => {
    const clock = { value: 0 };
    let attempts = 0;
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        const attempt = attempts;
        attempts += 1;
        clock.value += 10;
        if (attempt % 2 === 1) {
          throw new Error(`failure ${attempt}`);
        }
        return fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]).execute(pointCase);
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 50,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => clock.value,
    });

    expect(attempts).toBe(5);
    expect(result).toMatchObject({ completed: 3, errors: 2, throughputPerSecond: 60 });
    expect(result.infrastructureErrors).toBe(0);
    expect(result.errorEvidence.counts.engine).toBe(2);
  });

  it('stops a single disconnected worker at the shared connection-error threshold', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        attempts += 1;
        throw cloudReplacementConnectionError();
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 100,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => attempts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      connectionBackoffMs: 100,
      maxConsecutiveConnectionErrors: 3,
    });

    expect(result).toMatchObject({
      completed: 0,
      errors: 0,
      infrastructureErrors: 3,
      infrastructureFailure: true,
    });
    expect(sleeps).toEqual([ 100, 100 ]);
    expect(attempts).toBe(3);
  });

  it('resets the shared connection-error streak after successful work', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const base = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]);
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute(workload, sampleIdentity) {
        attempts += 1;
        if (attempts === 1 || attempts === 3) {
          throw cloudReplacementConnectionError();
        }
        return base.execute(workload, sampleIdentity);
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 4,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => attempts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      connectionBackoffMs: 25,
      maxConsecutiveConnectionErrors: 2,
    });

    expect(result.completed).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.infrastructureErrors).toBe(2);
    expect(result.infrastructureFailure).toBe(false);
    expect(sleeps).toEqual([ 25, 25 ]);
  });

  it('does not back off or trip infrastructure failure for ordinary engine errors', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        attempts += 1;
        throw new Error(`engine failure ${attempts}`);
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 5,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => attempts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      connectionBackoffMs: 100,
      maxConsecutiveConnectionErrors: 3,
    });

    expect(attempts).toBe(5);
    expect(result.errors).toBe(5);
    expect(result.infrastructureErrors).toBe(0);
    expect(result.infrastructureFailure).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('shares the disconnected breaker across concurrent workers without flooding attempts', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const adapter: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      async execute() {
        attempts += 1;
        throw cloudReplacementConnectionError();
      },
    };

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 8,
      durationMs: 1_000,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => attempts,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      connectionBackoffMs: 100,
      maxConsecutiveConnectionErrors: 3,
    });

    expect(result.completed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.infrastructureFailure).toBe(true);
    expect(result.infrastructureErrors).toBeGreaterThanOrEqual(3);
    expect(result.infrastructureErrors).toBeLessThanOrEqual(10);
    expect(attempts).toBe(result.infrastructureErrors);
    expect(sleeps.length).toBeLessThanOrEqual(2);
  });

  it.each([
    [ 'negative backoff', { connectionBackoffMs: -1 }, 'connectionBackoffMs must be finite and non-negative' ],
    [ 'infinite backoff', { connectionBackoffMs: Number.POSITIVE_INFINITY }, 'connectionBackoffMs must be finite and non-negative' ],
    [ 'zero threshold', { maxConsecutiveConnectionErrors: 0 }, 'maxConsecutiveConnectionErrors must be a finite positive integer' ],
    [ 'fractional threshold', { maxConsecutiveConnectionErrors: 1.5 }, 'maxConsecutiveConnectionErrors must be a finite positive integer' ],
    [ 'infinite threshold', { maxConsecutiveConnectionErrors: Number.POSITIVE_INFINITY }, 'maxConsecutiveConnectionErrors must be a finite positive integer' ],
  ] as const)('rejects invalid connection breaker option: %s', async (_name, invalid, message) => {
    await expect(measureCloudReplacementConcurrency(pointCase, fakeAdapter('rdf3x', []), {
      concurrency: 1,
      durationMs: 1,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => 0,
      ...invalid,
    })).rejects.toThrow(message);
  });

  it('rejects invalid connection breaker sleep hooks before any benchmark path can skip them', async () => {
    const invalidSleep = 'invalid' as unknown as (ms: number) => Promise<void>;

    await expect(measureCloudReplacementConcurrency(pointCase, fakeAdapter('rdf3x', []), {
      concurrency: 1,
      durationMs: 0,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      sleep: invalidSleep,
    })).rejects.toThrow('Cloud replacement sleep must be a function');

    await expect(measureCloudReplacementConcurrency(pointCase, fakeAdapter('rdf3x', []), {
      concurrency: 1,
      durationMs: 1,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => 1,
      sleep: invalidSleep,
    })).rejects.toThrow('Cloud replacement sleep must be a function');
  });

  it.each([ 'unsupported', '' ])(
    'counts fallback execution %j as a concurrency error',
    async (fallbackReason) => {
      const clock = { value: 0 };
      const adapter = fakeAdapter('rdf3x', [], {
        fallbackReason,
        onExecute: () => clock.value += 10,
      });

      const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
        concurrency: 1,
        durationMs: 20,
        cacheMode: 'production',
        operationTimeoutMs: 1_000,
        now: () => clock.value,
      });

      expect(result).toMatchObject({ completed: 0, errors: 2, elapsedMs: 20 });
      expect(result.infrastructureErrors).toBe(0);
      expect(result.errorEvidence.counts.engine).toBe(2);
      expect(result.errorEvidence.samples[0]).toMatchObject({
        category: 'engine',
        stage: 'query',
        message: `fallback:${fallbackReason}`,
      });
    },
  );

  it('keeps empty concurrency results structurally complete', async () => {
    const result = await measureCloudReplacementConcurrency(pointCase, fakeAdapter('rdf3x', []), {
      concurrency: 1,
      durationMs: 0,
      cacheMode: 'production',
      operationTimeoutMs: 1_000,
      now: () => 0,
    });

    expect(result).toEqual({
      cacheMode: 'production',
      concurrency: 1,
      durationMs: 0,
      elapsedMs: 0,
      completed: 0,
      errors: 0,
      infrastructureErrors: 0,
      infrastructureFailure: false,
      errorEvidence: {
        counts: {
          timeout: 0,
          connection: 0,
          cancelled: 0,
          engine: 0,
          correctness: 0,
          unknown: 0,
        },
        samples: [],
      },
      throughputPerSecond: 0,
    });
  });

  it('uses globally unique cache-off identities across concurrency workers', async () => {
    const identities: Array<string | undefined> = [];
    const clock = { value: 0 };
    const base = fakeAdapter('qlever', [ 's=NamedNode:urn:s:1' ]);
    const adapter: CloudReplacementEngineAdapter<'qlever'> = {
      id: 'qlever',
      async execute(workload, sampleIdentity) {
        identities.push(sampleIdentity);
        clock.value += 10;
        return base.execute(workload, sampleIdentity);
      },
    };
    const identitySource = createCloudReplacementSampleIdentitySource('concurrency');

    const result = await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 8,
      durationMs: 100,
      cacheMode: 'off',
      identitySource,
      operationTimeoutMs: 1_000,
      now: () => clock.value,
    });

    expect(result.cacheMode).toBe('off');
    expect(identities).toHaveLength(result.completed + result.errors);
    expect(identities.every((identity) =>
      /^# xpod-benchmark-sample:concurrency:qlever:\d+$/u.test(identity ?? ''))).toBe(true);
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('passes no sample identity in production concurrency mode', async () => {
    const identities: Array<string | undefined> = [];
    const clock = { value: 0 };
    const adapter = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ], {
      onExecute: (sampleIdentity) => {
        identities.push(sampleIdentity);
        clock.value += 10;
      },
    });

    await measureCloudReplacementConcurrency(pointCase, adapter, {
      concurrency: 1,
      durationMs: 30,
      cacheMode: 'production',
      identitySource: {
        next() {
          throw new Error('production cache mode must not request an identity');
        },
      },
      operationTimeoutMs: 1_000,
      now: () => clock.value,
    });

    expect(identities).toEqual([ undefined, undefined, undefined ]);
  });

  it.each([ 0, -1 ])('returns zero without executing for non-positive duration %i', async (durationMs) => {
    let executions = 0;
    const result = await measureCloudReplacementConcurrency(
      pointCase,
      fakeAdapter('rdf3x', [], { onExecute: () => executions += 1 }),
      {
        concurrency: 32,
        durationMs,
        cacheMode: 'off',
        identitySource: createCloudReplacementSampleIdentitySource(`non-positive-${durationMs}`),
        operationTimeoutMs: 1_000,
        now: () => 0,
      },
    );

    expect(result).toEqual({
      cacheMode: 'off',
      concurrency: 32,
      durationMs,
      elapsedMs: 0,
      completed: 0,
      errors: 0,
      infrastructureErrors: 0,
      infrastructureFailure: false,
      errorEvidence: {
        counts: {
          timeout: 0,
          connection: 0,
          cancelled: 0,
          engine: 0,
          correctness: 0,
          unknown: 0,
        },
        samples: [],
      },
      throughputPerSecond: 0,
    });
    expect(executions).toBe(0);
  });

  it('declares replacement weights before performance results exist', () => {
    expect(CLOUD_REPLACEMENT_GROUP_WEIGHTS).toEqual({ short: 0.60, large: 0.30, authorization: 0.10 });
    expect(Object.isFrozen(CLOUD_REPLACEMENT_GROUP_WEIGHTS)).toBe(true);
  });

  it('keeps the workload type contracts fixed', () => {
    expectTypeOf<CloudReplacementEngineId>().toEqualTypeOf<'rdf3x' | 'qlever'>();
    expectTypeOf<CloudReplacementWorkloadGroup>()
      .toEqualTypeOf<'short' | 'large' | 'authorization'>();
    expectTypeOf<CloudReplacementWorkload['sharedSurface']>().toEqualTypeOf<true>();
    expectTypeOf<CloudReplacementWorkload['orderSensitive']>().toEqualTypeOf<boolean>();
    expectTypeOf<CloudReplacementWorkload['concurrencyRepresentative']>().toEqualTypeOf<boolean>();
    expectTypeOf<CloudReplacementWorkload['authorizationGraphVariables']>()
      .toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<CloudReplacementExecution['fallbackReason']>().toEqualTypeOf<string | null>();
    expectTypeOf<CloudReplacementExecution['queryElapsedMs']>().toEqualTypeOf<number | null>();
    expectTypeOf<CloudReplacementCorrectness['rdf3x']>().toEqualTypeOf<CloudReplacementExecution>();
    expectTypeOf<CloudReplacementBinding>()
      .toEqualTypeOf<Readonly<Record<string, Term | undefined>>>();
    expectTypeOf<CloudReplacementEngineAdapter<'rdf3x'>['id']>().toEqualTypeOf<'rdf3x'>();
  });

  it('normalizes binding order without hiding ordered-result differences', async () => {
    const left = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:2', 's=NamedNode:urn:s:1' ]);
    const right = fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);

    const comparison = await compareCloudReplacementCase(pointCase, left, right);

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(false);
    expect(comparison.correct).toBe(true);
    expect(comparison.failures).not.toContain('order-mismatch');
    expect(comparison.rdf3x.physicalPlan).toEqual([ 'rdf3x:fake' ]);
    expect(comparison.qlever.physicalPlan).toEqual([ 'qlever:fake' ]);
  });

  it('fails correctness when either adapter reports fallback', async () => {
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', [ 'o=Literal:ok' ]),
      fakeAdapter('qlever', [ 'o=Literal:ok' ], { fallbackReason: 'unsupported' }),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-fallback:unsupported');
  });

  it('fails correctness when an adapter reports an empty fallback reason', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rows),
      fakeAdapter('qlever', rows, { fallbackReason: '' }),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-fallback:');
  });

  it('recomputes digests when different rows forge the same declared digest', async () => {
    const rdf3xRows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const qleverRows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:3' ];
    const forged = canonicalCloudReplacementDigests(rdf3xRows);
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rdf3xRows),
      fakeAdapter('qlever', qleverRows, forged),
    );

    expect(comparison.sameMultiset).toBe(false);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-invalid-ordered-digest');
    expect(comparison.failures).toContain('qlever-invalid-multiset-digest');
    expect(comparison.failures).toContain('multiset-mismatch');
  });

  it('rejects forged different digests without inventing a row mismatch', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rows),
      fakeAdapter('qlever', rows, {
        orderedDigest: 'forged-ordered',
        multisetDigest: 'forged-multiset',
      }),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(true);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-invalid-ordered-digest');
    expect(comparison.failures).toContain('qlever-invalid-multiset-digest');
    expect(comparison.failures).not.toContain('multiset-mismatch');
  });

  it('reports exact expected-row failures for each engine', async () => {
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', [ 's=NamedNode:urn:s:1' ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toEqual([
      'rdf3x-expected-rows:expected=2:actual=1',
      'qlever-expected-rows:expected=2:actual=1',
    ]);
  });

  it('reports minimum-row failures per engine without hiding zero rows', async () => {
    const minimumCase: CloudReplacementWorkload = {
      ...pointCase,
      expectedRows: undefined,
      minRows: 2,
    };
    const comparison = await compareCloudReplacementCase(
      minimumCase,
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', []),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toEqual([
      'rdf3x-min-rows:min=2:actual=1',
      'qlever-min-rows:min=2:actual=0',
      'multiset-mismatch',
    ]);
    expect(comparison.qlever.rows).toEqual([]);
  });

  it('requires matching order only for order-sensitive workloads', async () => {
    const comparison = await compareCloudReplacementCase(
      { ...pointCase, orderSensitive: true },
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:2', 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(false);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('order-mismatch');
  });

  it('canonicalizes variable order and all RDF literal identity fields', () => {
    const plain = DataFactory.literal('plain');
    const integer = DataFactory.literal('1', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'));
    const decimal = DataFactory.literal('1', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal'));
    const english = DataFactory.literal('chat', 'en');
    const french = DataFactory.literal('chat', 'fr');
    const subject = DataFactory.namedNode('urn:s:1');

    expect(canonicalCloudReplacementTerm(plain)).toBe(JSON.stringify([
      'Literal',
      'plain',
      '',
      'http://www.w3.org/2001/XMLSchema#string',
    ]));
    expect(canonicalCloudReplacementTerm(english)).toBe(JSON.stringify([
      'Literal',
      'chat',
      'en',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
    ]));
    expect(canonicalCloudReplacementTerm(integer)).toBe(JSON.stringify([
      'Literal',
      '1',
      '',
      'http://www.w3.org/2001/XMLSchema#integer',
    ]));
    expect(canonicalCloudReplacementTerm(decimal)).toBe(JSON.stringify([
      'Literal',
      '1',
      '',
      'http://www.w3.org/2001/XMLSchema#decimal',
    ]));
    expect(canonicalCloudReplacementTerm(integer)).not.toBe(canonicalCloudReplacementTerm(decimal));
    expect(canonicalCloudReplacementTerm(english)).not.toBe(canonicalCloudReplacementTerm(french));
    expect(canonicalCloudReplacementRow({ value: integer, subject }))
      .toBe(canonicalCloudReplacementRow({ subject, value: integer }));
    expect(canonicalCloudReplacementRow({ value: integer })).not
      .toBe(canonicalCloudReplacementRow({ value: decimal }));
    expect(canonicalCloudReplacementRow({ value: english })).not
      .toBe(canonicalCloudReplacementRow({ value: french }));
  });

  it('canonicalizes missing and explicitly unbound variables identically', () => {
    const subject = DataFactory.namedNode('urn:s:1');

    expect(canonicalCloudReplacementRow({})).toBe(canonicalCloudReplacementRow({ missing: undefined }));
    expect(canonicalCloudReplacementRow({ subject })).toBe(canonicalCloudReplacementRow({
      missing: undefined,
      subject,
    }));
  });

  it('builds deterministic ordered and multiplicity-preserving multiset digests', () => {
    const first = canonicalCloudReplacementRow({ s: DataFactory.namedNode('urn:s:1') });
    const second = canonicalCloudReplacementRow({ s: DataFactory.namedNode('urn:s:2') });
    const original = canonicalCloudReplacementDigests([ first, second, first ]);
    const reordered = canonicalCloudReplacementDigests([ first, first, second ]);
    const deduplicated = canonicalCloudReplacementDigests([ first, second ]);

    expect(original.orderedDigest).not.toBe(reordered.orderedDigest);
    expect(original.multisetDigest).toBe(reordered.multisetDigest);
    expect(original.multisetDigest).not.toBe(deduplicated.multisetDigest);
    expect(original).toEqual(canonicalCloudReplacementDigests([ first, second, first ]));
  });

  it('executes both adapters and propagates authorization errors unchanged', async () => {
    const authorizationError = new Error('authorization denied');
    let qleverExecuted = false;
    const rdf3x: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      execute() {
        throw authorizationError;
      },
    };
    const qlever: CloudReplacementEngineAdapter<'qlever'> = {
      id: 'qlever',
      async execute() {
        qleverExecuted = true;
        return fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ])
          .execute(pointCase);
      },
    };

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toBe(authorizationError);
    expect(qleverExecuted).toBe(true);
  });

  it('rejects swapped adapter identities before either adapter executes', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    let executions = 0;
    const rdf3x = fakeAdapter('qlever', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'rdf3x'>;
    const qlever = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'qlever'>;

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toThrow(
      'Cloud replacement adapter configuration error: expected rdf3x at rdf3x position, received qlever',
    );
    expect(executions).toBe(0);
  });

  it('rejects duplicate adapter identities before either adapter executes', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    let executions = 0;
    const rdf3x = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    });
    const qlever = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'qlever'>;

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toThrow(
      'Cloud replacement adapter configuration error: expected qlever at qlever position, received rdf3x',
    );
    expect(executions).toBe(0);
  });

  it('fails authorization correctness when both adapters return the same denied graph', async () => {
    const deniedRow = canonicalCloudReplacementRow({
      g: DataFactory.namedNode(DENIED_DAY),
      message: DataFactory.namedNode(`${DENIED_DAY}#message`),
    });
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ deniedRow ]),
      fakeAdapter('qlever', [ deniedRow ]),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(true);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain(
      `rdf3x-authorization-row:0:denied-graph:g:${DENIED_DAY}`,
    );
    expect(comparison.failures).toContain(
      `qlever-authorization-row:0:denied-graph:g:${DENIED_DAY}`,
    );
  });

  it('fails authorization correctness when a required graph variable is missing', async () => {
    const missingGraphRow = canonicalCloudReplacementRow({
      message: DataFactory.namedNode(`${DAY_ONE}#message`),
    });
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ missingGraphRow ]),
      fakeAdapter('qlever', [ missingGraphRow ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('rdf3x-authorization-row:0:missing-graph-variable:g');
    expect(comparison.failures).toContain('qlever-authorization-row:0:missing-graph-variable:g');
  });

  it.each([
    [ 'malformed row', 'not-json', 'malformed' ],
    [
      'non-named graph',
      canonicalCloudReplacementRow({ g: DataFactory.literal(DAY_ONE) }),
      'non-named-graph-variable:g',
    ],
  ])('fails authorization correctness for a %s', async (_name, row, failure) => {
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain(`rdf3x-authorization-row:0:${failure}`);
    expect(comparison.failures).toContain(`qlever-authorization-row:0:${failure}`);
  });

  it('fails closed when an authorization workload omits its oracle configuration', async () => {
    const row = canonicalCloudReplacementRow({ g: DataFactory.namedNode(DAY_ONE) });
    const withoutScope: CloudReplacementWorkload = {
      ...authorizationCase,
      accessScope: undefined,
    };
    const withoutVariables: CloudReplacementWorkload = {
      ...authorizationCase,
      authorizationGraphVariables: undefined,
    };

    const missingScope = await compareCloudReplacementCase(
      withoutScope,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );
    const missingVariables = await compareCloudReplacementCase(
      withoutVariables,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );

    expect(missingScope.failures).toContain('authorization-missing-access-scope');
    expect(missingVariables.failures).toContain('authorization-missing-graph-variables');
    expect(missingScope.correct).toBe(false);
    expect(missingVariables.correct).toBe(false);
  });

  it('covers the exact shared workload matrix without QLever-only cases', () => {
    const cases = cloudReplacementWorkloads();
    expect(new Set(cases.map((testCase) => testCase.group)))
      .toEqual(new Set([ 'short', 'large', 'authorization' ]));
    expect(cases.filter((testCase) => testCase.group === 'short').map((testCase) => testCase.id))
      .toEqual(SHORT_IDS);
    expect(cases.filter((testCase) => testCase.group === 'large').map((testCase) => testCase.id))
      .toEqual(LARGE_IDS);
    expect(cases.filter((testCase) => testCase.group === 'authorization').map((testCase) => testCase.id))
      .toEqual(AUTHORIZATION_IDS);
    expect(cases).toHaveLength(24);
    expect(cases.every((testCase) => testCase.sharedSurface)).toBe(true);
    expect(cases.every((testCase) => testCase.purpose.length > 0)).toBe(true);
    expect(cases.every((testCase) => typeof testCase.orderSensitive === 'boolean')).toBe(true);
    expect(cases.every((testCase) =>
      (testCase.expectedRows === undefined) !== (testCase.minRows === undefined))).toBe(true);
    expect(cases.every((testCase) =>
      !/(?:ql:|contains-word|contains-entity|similar-entities|nearest-neighbor|geof:)/iu.test(testCase.sparql)))
      .toBe(true);
  });

  it('uses the exact standard-SPARQL query bodies and prefixes', () => {
    const casesById = new Map(cloudReplacementWorkloads().map((testCase) => [ testCase.id, testCase ]));
    for (const [ id, body ] of Object.entries(SHARED_QUERY_BODIES)) {
      expect(casesById.get(id)?.sparql).toBe(`${QUERY_PREFIXES}\n${body}`);
    }
    for (const [ authorizationId, body ] of Object.entries(AUTHORIZATION_QUERY_BODIES)) {
      expect(casesById.get(authorizationId)?.sparql).toBe(`${QUERY_PREFIXES}\n${body}`);
    }
  });

  it('compiles every workload on the embedded RDF3X adapter surface', () => {
    const adapter = new RdfSparqlAdapter();
    for (const testCase of cloudReplacementWorkloads()) {
      expect(() => adapter.compile(testCase.sparql, ALICE_CHAT_PREFIX), testCase.id).not.toThrow();
    }
  });

  it('marks only the fixed concurrency representatives', () => {
    expect(cloudReplacementWorkloads()
      .filter((testCase) => testCase.concurrencyRepresentative)
      .map((testCase) => testCase.id))
      .toEqual([
        'point-lookup',
        'latest-message',
        'four-hop-chain',
        'eight-hop-chain',
        'count-distinct-threads',
        'authorization-scoped-broad-join',
      ]);
  });

  it('sets ordering and exact row expectations explicitly for every case', () => {
    const cases = cloudReplacementWorkloads();
    expect(cases.filter((testCase) => testCase.orderSensitive).map((testCase) => testCase.id))
      .toEqual([
        'latest-message',
        'keyset-page',
        'ordered-top-k',
        'top-thread-aggregate',
        'authorization-explicit-deny',
        'authorization-scoped-broad-join',
      ]);
    expect(Object.fromEntries(cases.map((testCase) => [
      testCase.id,
      { expectedRows: testCase.expectedRows, minRows: testCase.minRows },
    ]))).toEqual(ROW_EXPECTATIONS);
  });

  it('uses the four exact authorization scopes', () => {
    const workloads = cloudReplacementWorkloads();
    const authorizationCases = workloads
      .filter((testCase) => testCase.group === 'authorization');
    expect(workloads.filter((testCase) => testCase.group !== 'authorization')
      .every((testCase) => testCase.authorizationGraphVariables === undefined)).toBe(true);
    expect(authorizationCases.map((testCase) => testCase.accessScope)).toEqual([
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        version: 'inherited-prefix',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        allowedGraphUrls: [
          'https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl',
          'https://pod.example/alice/.data/chat/default/index.ttl',
        ],
        version: 'explicit-allow',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        deniedGraphUrls: [ 'https://pod.example/alice/.data/chat/default/2026/05/05/messages.ttl' ],
        version: 'explicit-deny',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        deniedGraphPrefixes: [ 'https://pod.example/alice/.data/chat/default/2026/05/05/' ],
        version: 'scoped-broad-join',
      },
    ]);
    expect(Object.fromEntries(authorizationCases.map((testCase) => [
      testCase.id,
      testCase.authorizationGraphVariables,
    ]))).toEqual(AUTHORIZATION_GRAPH_VARIABLES);
  });

  it('allows both explicit two-hop graphs and denies the populated denied day', () => {
    const workloads = cloudReplacementWorkloads();
    const explicitAllow = workloads
      .find((testCase) => testCase.id === 'authorization-explicit-allow');
    expect(explicitAllow?.accessScope).toBeDefined();
    expect(rdfAccessGraphAllowed(DAY_ONE, explicitAllow!.accessScope!)).toBe(true);
    expect(rdfAccessGraphAllowed(ALICE_CHAT_INDEX, explicitAllow!.accessScope!)).toBe(true);
    expect(rdfAccessGraphAllowed(DENIED_DAY, explicitAllow!.accessScope!)).toBe(false);
    for (const id of [ 'authorization-explicit-deny', 'authorization-scoped-broad-join' ]) {
      const workload = workloads.find((testCase) => testCase.id === id);
      expect(workload?.accessScope).toBeDefined();
      expect(rdfAccessGraphAllowed(DENIED_DAY, workload!.accessScope!)).toBe(false);
    }
  });

  it('executes explicit allow and the top-thread aggregate on a real RDF seed', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    const engine = new SolidRdfEngine({ index });
    const threadOne = `${ALICE_CHAT_INDEX}#thread_1`;
    const threadTwo = `${ALICE_CHAT_INDEX}#thread_2`;
    const hasMember = DataFactory.namedNode('http://rdfs.org/sioc/ns#has_member');
    const dayOneGraph = DataFactory.namedNode(DAY_ONE);
    engine.put([
      ...buildCloudReplacementTopology(1),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_1`), hasMember,
        DataFactory.namedNode(threadOne), dayOneGraph),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_2`), hasMember,
        DataFactory.namedNode(threadOne), dayOneGraph),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_3`), hasMember,
        DataFactory.namedNode(threadTwo), dayOneGraph),
    ]);

    try {
      const adapter = new RdfSparqlAdapter();
      const workloads = cloudReplacementWorkloads();
      const explicitAllow = workloads.find((testCase) => testCase.id === 'authorization-explicit-allow');
      if (!explicitAllow?.accessScope) {
        throw new Error('authorization-explicit-allow must define an access scope');
      }
      const explicitResult = engine.query(applyRdfAccessScope(
        adapter.compile(explicitAllow.sparql, ALICE_CHAT_PREFIX).query,
        explicitAllow.accessScope,
      ));
      expect(explicitResult.bindings).toHaveLength(3);
      expect(explicitResult.bindings.every((binding) =>
        binding.g1.termType === 'NamedNode' && binding.g1.value === DAY_ONE &&
        binding.g2.termType === 'NamedNode' && binding.g2.value === ALICE_CHAT_INDEX)).toBe(true);

      const aggregate = workloads.find((testCase) => testCase.id === 'top-thread-aggregate');
      if (!aggregate) {
        throw new Error('top-thread-aggregate workload is required');
      }
      const aggregateResult = engine.query(adapter.compile(aggregate.sparql, ALICE_CHAT_PREFIX).query);
      expect(aggregateResult.bindings.map((binding) => ({
        thread: binding.thread.value,
        count: binding.count.value,
      }))).toEqual([
        { thread: threadOne, count: '2' },
        { thread: threadTwo, count: '1' },
      ]);
      expect(aggregate.minRows).toBe(1);
      expect(aggregateResult.bindings.length).toBeGreaterThanOrEqual(aggregate.minRows ?? 0);
    } finally {
      await engine.close();
    }
  });

  it('executes all 24 workloads against the planned 32-pod skew fixture', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    const engine = new SolidRdfEngine({ index });
    const batch = buildRdfModelsSyntheticMessageBatch({ start: 0, count: 1024, syntheticPodCount: 32 });
    const workloads = cloudReplacementWorkloads();
    expect(batch.some((quad) => quad.graph.value === DENIED_DAY)).toBe(true);
    for (const id of [ 'authorization-explicit-deny', 'authorization-scoped-broad-join' ]) {
      const workload = workloads.find((testCase) => testCase.id === id);
      expect(workload?.accessScope).toBeDefined();
      expect(rdfAccessGraphAllowed(DENIED_DAY, workload!.accessScope!)).toBe(false);
    }
    engine.put([
      ...buildRdfModelsBenchmarkSeed({ syntheticMessages: 0, syntheticPodCount: 32 }),
      ...batch,
      ...buildCloudReplacementTopology(32),
    ]);

    try {
      const adapter = new RdfSparqlAdapter();
      const authorizationGraphs: string[] = [];
      const deniedByScopeGraphs: string[] = [];
      const outcomes = workloads.map((testCase) => {
        const compiled = adapter.compile(testCase.sparql, ALICE_POD);
        const query = testCase.accessScope
          ? applyRdfAccessScope(compiled.query, testCase.accessScope)
          : compiled.query;
        const result = engine.query(query);
        const rowCount = result.bindings.length;
        const meetsRows = testCase.expectedRows === undefined
          ? rowCount >= (testCase.minRows ?? 0)
          : rowCount === testCase.expectedRows;
        let stableOrder = true;
        if (testCase.orderSensitive) {
          const repeated = engine.query(query);
          const serialize = (bindings: typeof result.bindings): string =>
            JSON.stringify(bindings.map((binding) => canonicalCloudReplacementRow(binding)));
          stableOrder = serialize(result.bindings) === serialize(repeated.bindings);
        }
        let authorizationSafe = true;
        if (testCase.group === 'authorization') {
          authorizationSafe = Boolean(
            testCase.accessScope && testCase.authorizationGraphVariables?.length,
          );
          for (const binding of result.bindings) {
            for (const variable of testCase.authorizationGraphVariables ?? []) {
              const graph = binding[variable];
              if (!graph || graph.termType !== 'NamedNode' ||
                !testCase.accessScope || !rdfAccessGraphAllowed(graph.value, testCase.accessScope)) {
                authorizationSafe = false;
              } else {
                authorizationGraphs.push(graph.value);
                if (!rdfAccessGraphAllowed(DENIED_DAY, testCase.accessScope)) {
                  deniedByScopeGraphs.push(graph.value);
                }
              }
            }
          }
        }
        return {
          id: testCase.id,
          rowCount,
          expectedRows: testCase.expectedRows,
          minRows: testCase.minRows,
          meetsRows,
          stableOrder,
          authorizationSafe,
        };
      });

      expect(outcomes).toHaveLength(24);
      expect(outcomes.filter((outcome) =>
        !outcome.meetsRows || !outcome.stableOrder || !outcome.authorizationSafe)).toEqual([]);
      expect(authorizationGraphs.length).toBeGreaterThan(0);
      expect(deniedByScopeGraphs).not.toContain(DENIED_DAY);
    } finally {
      await engine.close();
    }
  });

  it('builds one reusable relationship topology per synthetic pod', () => {
    const quads = buildCloudReplacementTopology(2);
    expect(quads).toHaveLength(140);
    expect(quads.filter((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_parent'))
      .toHaveLength(128);
    expect(quads.filter((quad) => quad.predicate.value === 'https://vocab.xpod.dev/ai#hasModel'))
      .toHaveLength(2);
    for (const predicate of [
      'https://undefineds.co/ns#workspace',
      'https://undefineds.co/ns#owner',
      'https://undefineds.co/ns#provider',
      'https://vocab.xpod.dev/ai#hasModel',
      'https://undefineds.co/ns#capability',
      'https://undefineds.co/ns#category',
    ]) {
      expect(quads.filter((quad) => quad.predicate.value === predicate)).toHaveLength(2);
    }
    expect(quads.some((quad) => quad.subject.value ===
      'https://pod.example/alice/.data/chat/default/index.ttl#thread_64')).toBe(true);
    expect(quads.some((quad) => quad.subject.value ===
      'https://pod.example/synthetic-1/.data/chat/default/index.ttl#thread_64')).toBe(true);
  });

  it('uses product provider identities and stores provider relations in the provider graph', () => {
    const provider = 'https://pod.example/alice/settings/providers/benchmark.ttl';
    const model = `${provider}#benchmark-model`;
    const capability = `${provider}#capability-agent`;
    const quads = buildCloudReplacementTopology(1);
    expect(quads.find((quad) => quad.predicate.value === 'https://vocab.xpod.dev/ai#hasModel'))
      .toMatchObject({
        subject: { value: provider },
        object: { value: model },
        graph: { value: provider },
      });
    expect(quads.find((quad) => quad.subject.value === model &&
      quad.predicate.value === 'https://undefineds.co/ns#capability'))
      .toMatchObject({ object: { value: capability }, graph: { value: provider } });
    expect(quads.find((quad) => quad.subject.value === capability &&
      quad.predicate.value === 'https://undefineds.co/ns#category'))
      .toMatchObject({ graph: { value: provider } });
    expect(quads.some((quad) => quad.predicate.value === 'https://undefineds.co/ns/ai#hasModel'))
      .toBe(false);
    expect(quads.some((quad) => [ quad.subject, quad.object, quad.graph ]
      .some((term) => term.value.includes('#this#model')))).toBe(false);
    expect(quads.find((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_parent'))
      .toMatchObject({ graph: { value: 'https://pod.example/alice/.data/chat/default/index.ttl' } });
  });

  it('floors pod counts and always builds at least one pod', () => {
    expect(buildCloudReplacementTopology(2.9)).toHaveLength(140);
    expect(buildCloudReplacementTopology(0)).toHaveLength(70);
    expect(buildCloudReplacementTopology(-2)).toHaveLength(70);
  });

  const passingDecisionInput: CloudReplacementDecisionInput = {
    correctnessPassed: true,
    criticalShortP95Ratios: [ 1.05, 1.10 ],
    weightedP95Ratio: 0.75,
    throughputRatio: 1.30,
    largeCaseSpeedups: [ 1.60, 2.10 ],
    errorRate: 0,
    memoryLimitRatio: 0.70,
    tempDiskLimitRatio: 0.10,
  };

  const minimalCloudReplacementReport = (): CloudReplacementReport => ({
    environment: {
      postgresVersion: '17.5',
      engineCommit: 'abc123',
    },
    targetFacts: 1,
    actualFacts: 1,
    correctnessFailures: [],
    cases: [],
    concurrency: [],
    indexBuildAndStorage: {
      rdf3x: { buildMs: 1, storageBytes: 1 },
      qlever: { buildMs: 1, storageBytes: 1 },
    },
    resourceDiagnostics: {
      rdf3x: {
        sharedBlocksRead: null,
        sharedBlocksHit: null,
        tempBytes: null,
        memoryPeakBytes: null,
        memoryLimitBytes: null,
        diagnosticsUnavailable: [],
      },
      qlever: {
        sharedBlocksRead: null,
        sharedBlocksHit: null,
        tempBytes: null,
        memoryPeakBytes: null,
        memoryLimitBytes: null,
        diagnosticsUnavailable: [],
      },
    },
    decision: decideCloudReplacement(passingDecisionInput),
  });

  it('freezes the predeclared Cloud replacement thresholds', () => {
    expect(CLOUD_REPLACEMENT_THRESHOLDS).toEqual({
      maxCriticalShortP95Ratio: 1.20,
      maxWeightedP95Ratio: 0.80,
      minThroughputRatio: 1.25,
      minLargeCaseSpeedup: 1.50,
      minLargeWinningCases: 2,
      maxMemoryLimitRatio: 0.85,
      maxTempDiskLimitRatio: 0.20,
      maxErrorRate: 0,
    });
    expect(Object.isFrozen(CLOUD_REPLACEMENT_THRESHOLDS)).toBe(true);
  });

  it('returns the three predeclared replacement outcomes in gate order', () => {
    expect(decideCloudReplacement(passingDecisionInput).recommendation).toBe('replace');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      criticalShortP95Ratios: [ 1.25 ],
    }).recommendation).toBe('selective-routing-candidate');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      correctnessPassed: false,
    }).recommendation).toBe('retain-rdf3x');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      errorRate: 0.01,
    }).recommendation).toBe('retain-rdf3x');
    expectTypeOf<CloudReplacementRecommendation>()
      .toEqualTypeOf<'replace' | 'retain-rdf3x' | 'selective-routing-candidate'>();
  });

  it('exposes every replacement gate and an isolated observed input', () => {
    const decision = decideCloudReplacement(passingDecisionInput);

    expect(decision.passed).toEqual({
      correctness: true,
      criticalShortP95: true,
      weightedP95: true,
      throughput: true,
      aggregatePerformance: true,
      largeCases: true,
      errorRate: true,
      memoryLimit: true,
      tempDiskLimit: true,
      resources: true,
      all: true,
    });
    expect(decision.observed).toEqual(passingDecisionInput);
    expect(decision.observed).not.toBe(passingDecisionInput);
    expect(decision.observed.criticalShortP95Ratios)
      .not.toBe(passingDecisionInput.criticalShortP95Ratios);
    expect(decision.observed.largeCaseSpeedups).not.toBe(passingDecisionInput.largeCaseSpeedups);
  });

  it('accepts either weighted p95 or throughput for the aggregate performance gate', () => {
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      throughputRatio: 1,
    }).recommendation).toBe('replace');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      weightedP95Ratio: 1,
    }).recommendation).toBe('replace');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      weightedP95Ratio: 1,
      throughputRatio: 1,
    }).recommendation).toBe('selective-routing-candidate');
  });

  it('fails closed when critical short evidence or resource diagnostics are unknown', () => {
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      criticalShortP95Ratios: [],
      largeCaseSpeedups: [],
    }).recommendation).toBe('retain-rdf3x');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      criticalShortP95Ratios: [],
    }).recommendation).toBe('selective-routing-candidate');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      memoryLimitRatio: null,
      tempDiskLimitRatio: null,
    }).recommendation).toBe('selective-routing-candidate');
    expect(decideCloudReplacement({
      ...passingDecisionInput,
      largeCaseSpeedups: [ 1.49, 1.50 ],
      memoryLimitRatio: null,
    }).recommendation).toBe('retain-rdf3x');
  });

  it.each([
    [ 'critical short NaN', { criticalShortP95Ratios: [ Number.NaN ] } ],
    [ 'critical short infinity', { criticalShortP95Ratios: [ Number.POSITIVE_INFINITY ] } ],
    [ 'weighted p95 negative', { weightedP95Ratio: -1 } ],
    [ 'throughput infinity', { throughputRatio: Number.POSITIVE_INFINITY } ],
    [ 'large speedup negative', { largeCaseSpeedups: [ -1 ] } ],
    [ 'memory NaN', { memoryLimitRatio: Number.NaN } ],
    [ 'temporary disk infinity', { tempDiskLimitRatio: Number.POSITIVE_INFINITY } ],
  ])('rejects invalid decision ratio: %s', (_name, invalid) => {
    expect(() => decideCloudReplacement({
      ...passingDecisionInput,
      ...invalid,
    })).toThrow('must be finite and non-negative');
  });

  it.each([ Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01 ])(
    'rejects error rate outside the finite [0, 1] interval: %s',
    (errorRate) => {
      expect(() => decideCloudReplacement({
        ...passingDecisionInput,
        errorRate,
      })).toThrow('Cloud replacement errorRate must be finite and between 0 and 1');
    },
  );

  it('weights p95 ratios equally within each predeclared workload group', () => {
    const weighted = calculateCloudReplacementWeightedP95Ratio([
      { group: 'short', rdf3xP95Ms: 10, qleverP95Ms: 5 },
      { group: 'short', rdf3xP95Ms: 10, qleverP95Ms: 10 },
      { group: 'large', rdf3xP95Ms: 20, qleverP95Ms: 10 },
      { group: 'authorization', rdf3xP95Ms: 4, qleverP95Ms: 2 },
    ]);

    expect(weighted).toBeCloseTo(0.65, 10);
  });

  it('rejects incomplete or invalid weighted p95 evidence', () => {
    expect(() => calculateCloudReplacementWeightedP95Ratio([
      { group: 'short', rdf3xP95Ms: 10, qleverP95Ms: 5 },
    ])).toThrow('requires at least one case for group large');
    expect(() => calculateCloudReplacementWeightedP95Ratio([
      { group: 'short', rdf3xP95Ms: 0, qleverP95Ms: 0 },
      { group: 'large', rdf3xP95Ms: 10, qleverP95Ms: 5 },
      { group: 'authorization', rdf3xP95Ms: 10, qleverP95Ms: 5 },
    ])).toThrow('rdf3xP95Ms denominator must be finite and positive');
    expect(() => calculateCloudReplacementWeightedP95Ratio([
      { group: 'short', rdf3xP95Ms: 10, qleverP95Ms: Number.NaN },
      { group: 'large', rdf3xP95Ms: 10, qleverP95Ms: 5 },
      { group: 'authorization', rdf3xP95Ms: 10, qleverP95Ms: 5 },
    ])).toThrow('qleverP95Ms must be finite and non-negative');
    expect(() => calculateCloudReplacementWeightedP95Ratio([
      { group: 'short', rdf3xP95Ms: Number.MIN_VALUE, qleverP95Ms: 1 },
      { group: 'large', rdf3xP95Ms: 10, qleverP95Ms: 5 },
      { group: 'authorization', rdf3xP95Ms: 10, qleverP95Ms: 5 },
    ])).toThrow('weighted p95 case ratio must be finite and non-negative');
  });

  it('computes throughput from total completed operations and total measured seconds', () => {
    const rdf3x = [
      { completed: 20, elapsedMs: 1_000 },
      { completed: 40, elapsedMs: 3_000 },
    ];
    const qlever = [
      { completed: 50, elapsedMs: 1_000 },
      { completed: 100, elapsedMs: 3_000 },
    ];

    expect(calculateCloudReplacementThroughput(rdf3x)).toBe(15);
    expect(calculateCloudReplacementThroughput(qlever)).toBe(37.5);
    expect(calculateCloudReplacementThroughputRatio(rdf3x, qlever)).toBe(2.5);
  });

  it('rejects invalid throughput measurements and a zero baseline', () => {
    expect(() => calculateCloudReplacementThroughput([]))
      .toThrow('requires at least one measurement');
    expect(() => calculateCloudReplacementThroughput([ { completed: 1, elapsedMs: 0 } ]))
      .toThrow('elapsedMs denominator must be finite and positive');
    expect(() => calculateCloudReplacementThroughput([
      { completed: Number.POSITIVE_INFINITY, elapsedMs: 1 },
    ])).toThrow('completed must be a finite non-negative integer');
    expect(() => calculateCloudReplacementThroughputRatio(
      [ { completed: 0, elapsedMs: 1_000 } ],
      [ { completed: 1, elapsedMs: 1_000 } ],
    )).toThrow('RDF3X throughput denominator must be finite and positive');
    expect(() => calculateCloudReplacementThroughput([
      { completed: Number.MAX_SAFE_INTEGER, elapsedMs: Number.MIN_VALUE },
    ])).toThrow('calculated throughput must be finite and non-negative');
    expect(() => calculateCloudReplacementThroughputRatio(
      [ { completed: 1, elapsedMs: 1e303 } ],
      [ { completed: 1, elapsedMs: 1e-297 } ],
    )).toThrow('throughput ratio must be finite and non-negative');
  });

  it('redacts connection URLs without exposing the raw database name', () => {
    const sanitized = sanitizeCloudReplacementEnvironment({
      connectionString:
        'postgres://user:secret@db.example/xpod%20benchmark_benchmark?sslmode=require#private',
      postgresVersion: '17.5',
      engineCommit: 'abc123',
    });

    expect(sanitized).toEqual({
      postgresVersion: '17.5',
      engineCommit: 'abc123',
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /secret|db\.example|user|sslmode|private|xpod benchmark_benchmark/u,
    );
    expect(Object.keys(sanitized).sort()).toEqual([ 'engineCommit', 'postgresVersion' ]);
    expect(() => sanitizeCloudReplacementEnvironment({
      connectionString: 'postgres://user:secret@db.example/',
      postgresVersion: '17.5',
      engineCommit: 'abc123',
    })).toThrow('Cloud replacement connection URL requires a database path');
  });

  it.each([
    'postgres://example.test/xpod',
    'postgres://example.test/a/b_benchmark',
    'postgres://example.test/a%2Fb_benchmark',
  ])('rejects non-dedicated benchmark database path %s', (connectionString) => {
    expect(() => sanitizeCloudReplacementEnvironment({
      connectionString,
      postgresVersion: '17.5',
      engineCommit: 'abc123',
    })).toThrow('requires a dedicated benchmark database ending in _benchmark');
  });

  it.each([
    'access_token',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'client_secret',
    'clientSecret',
    'api_key',
    'apiKey',
    'secret_key',
    'secretKey',
    'private_key',
    'privateKey',
  ])('rejects credential report key %s', (key) => {
    const report = {
      ...minimalCloudReplacementReport(),
      [key]: 'sensitive-value',
    } as unknown as CloudReplacementReport;

    expect(() => renderCloudReplacementJson(report))
      .toThrow('Cloud replacement report contains credential fields');
    expect(() => renderCloudReplacementMarkdown(report))
      .toThrow('Cloud replacement report contains credential fields');
  });

  it.each([
    'access_token=sensitive-value',
    'accessToken=sensitive-value',
    'refresh_token: sensitive-value',
    'refreshToken: sensitive-value',
    'client_secret=sensitive-value',
    'clientSecret=sensitive-value',
    'api_key=sensitive-value',
    'apiKey=sensitive-value',
    'secret_key=sensitive-value',
    'secretKey=sensitive-value',
    'private_key=sensitive-value',
    'privateKey=sensitive-value',
    'password=sensitive-value',
    'passwd=sensitive-value',
    'token=sensitive-value',
    'secret=sensitive-value',
    'credential=sensitive-value',
    'credentials=sensitive-value',
    'Authorization: Bearer header.payload.signature',
  ])('rejects credential-bearing report text %s', (credentialText) => {
    const report = {
      ...minimalCloudReplacementReport(),
      correctnessFailures: [ credentialText ],
    };

    expect(() => renderCloudReplacementJson(report))
      .toThrow('Cloud replacement report contains credential-bearing text');
    expect(() => renderCloudReplacementMarkdown(report))
      .toThrow('Cloud replacement report contains credential-bearing text');
  });

  it.each([
    'query=point-lookup',
    'hash=multiset-digest',
    'authorization: denied by scope',
    'cacheKey=point-lookup',
    'key=subject-order',
  ])('renders benign report text assignment %s', (benignText) => {
    const report = {
      ...minimalCloudReplacementReport(),
      correctnessFailures: [ benignText ],
    };

    expect(JSON.parse(renderCloudReplacementJson(report))).toMatchObject({
      correctnessFailures: [ benignText ],
    });
    expect(renderCloudReplacementMarkdown(report)).toContain(benignText);
  });

  it('escapes HTML and preserves an escaped pipe inside Markdown tables', () => {
    const html = '<img src=x onerror=alert(1)>';
    const report: CloudReplacementReport = {
      ...minimalCloudReplacementReport(),
      correctnessFailures: [ html, 'Tom & <Admin>' ],
      cases: [
        {
          id: String.raw`left\|right`,
          group: 'short',
          correctnessFailures: [ html ],
          rdf3x: { fallbackReason: null, coldMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
          qlever: { fallbackReason: null, coldMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
        },
      ],
    };

    const markdown = renderCloudReplacementMarkdown(report);

    expect(markdown).not.toContain('<img');
    expect(markdown).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markdown).toContain('Tom &amp; &lt;Admin&gt;');
    expect(markdown).toContain(String.raw`left\\\|right`);
    expect(markdown).not.toContain('&amp;lt;');
  });

  it('renders complete sanitized JSON and Markdown reports with one recommendation', () => {
    const report: CloudReplacementReport = {
      environment: sanitizeCloudReplacementEnvironment({
        connectionString: 'postgres://user:secret@db.example/xpod_benchmark?sslmode=require#private',
        postgresVersion: '17.5',
        engineCommit: 'abc123',
      }),
      targetFacts: 10_000_000,
      actualFacts: 10_000_128,
      correctnessFailures: [ 'large-mismatch' ],
      cases: [
        {
          id: 'point-lookup',
          group: 'short',
          correctnessFailures: [],
          rdf3x: {
            fallbackReason: null,
            coldMs: 12,
            p50Ms: 4,
            p95Ms: 8,
            p99Ms: 10,
          },
          qlever: {
            fallbackReason: null,
            coldMs: 9,
            p50Ms: 3,
            p95Ms: 6,
            p99Ms: 7,
          },
        },
      ],
      concurrency: [
        {
          caseId: 'point-lookup',
          engine: 'qlever',
          concurrency: 8,
          completed: 800,
          errors: 0,
          infrastructureErrors: 2,
          infrastructureFailure: false,
          errorEvidence: {
            counts: {
              timeout: 0,
              connection: 2,
              cancelled: 0,
              engine: 0,
              correctness: 0,
              unknown: 0,
            },
            samples: [
              {
                category: 'connection',
                stage: 'acquire',
                name: 'Error',
                code: 'ECONNRESET',
                message: 'connection reset [redacted-endpoint]',
                firstSeenAt: '2026-07-18T01:00:00.000Z',
                lastSeenAt: '2026-07-18T01:00:05.000Z',
                count: 2,
                workloadId: 'point-lookup',
                engine: 'qlever',
                cacheMode: 'off',
                concurrency: 8,
              },
            ],
          },
          elapsedMs: 10_000,
          throughputPerSecond: 80,
        },
      ],
      indexBuildAndStorage: {
        rdf3x: { buildMs: 12_000, storageBytes: 400_000_000 },
        qlever: { buildMs: 9_000, storageBytes: 350_000_000 },
      },
      resourceDiagnostics: {
        rdf3x: {
          sharedBlocksRead: 100,
          sharedBlocksHit: 10_000,
          tempBytes: 0,
          memoryPeakBytes: 400_000_000,
          memoryLimitBytes: 1_000_000_000,
          diagnosticsUnavailable: [],
        },
        qlever: {
          sharedBlocksRead: 80,
          sharedBlocksHit: 12_000,
          tempBytes: 10_000_000,
          memoryPeakBytes: 700_000_000,
          memoryLimitBytes: 1_000_000_000,
          diagnosticsUnavailable: [ 'cpu-time' ],
        },
      },
      decision: decideCloudReplacement(passingDecisionInput),
    };

    const json = renderCloudReplacementJson(report);
    const markdown = renderCloudReplacementMarkdown(report);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const countRecommendationKeys = (value: unknown): number => {
      if (Array.isArray(value)) {
        return value.reduce((count, entry) => count + countRecommendationKeys(entry), 0);
      }
      if (!value || typeof value !== 'object') {
        return 0;
      }
      return Object.entries(value).reduce((count, [ key, entry ]) =>
        count + (key === 'recommendation' ? 1 : 0) + countRecommendationKeys(entry), 0);
    };

    expect(parsed).toMatchObject({
      environment: { postgresVersion: '17.5', engineCommit: 'abc123' },
      targetFacts: 10_000_000,
      actualFacts: 10_000_128,
      correctnessFailures: [ 'large-mismatch' ],
      concurrency: [
        {
          infrastructureErrors: 2,
          infrastructureFailure: false,
          errorEvidence: {
            counts: { connection: 2 },
            samples: [
              {
                category: 'connection',
                stage: 'acquire',
                firstSeenAt: '2026-07-18T01:00:00.000Z',
                lastSeenAt: '2026-07-18T01:00:05.000Z',
                message: 'connection reset [redacted-endpoint]',
              },
            ],
          },
        },
      ],
      decision: {
        recommendation: 'replace',
        passed: { correctness: true, all: true },
      },
    });
    expect(parsed.environment).toEqual({ postgresVersion: '17.5', engineCommit: 'abc123' });
    expect(json).not.toContain('xpod_benchmark');
    expect(countRecommendationKeys(parsed)).toBe(1);
    expect(markdown.match(/recommendation/giu)).toHaveLength(1);
    for (const expected of [
      '17.5',
      'abc123',
      '10,000,000',
      '10,000,128',
      'large-mismatch',
      'point-lookup',
      'cold',
      'p50',
      'p95',
      'p99',
      '80',
      'infrastructureErrors',
      'connection reset [redacted-endpoint]',
      '2026-07-18T01:00:05.000Z',
      '12,000',
      '400,000,000',
      'sharedBlocksRead',
      'cpu-time',
      'criticalShortP95',
      'aggregatePerformance',
      'replace',
    ]) {
      expect(markdown).toContain(expected);
    }
    expect(`${json}\n${markdown}`).not.toMatch(
      /secret|db\.example|user|sslmode|private|connectionString/iu,
    );
  });

  it('rejects invalid concurrency evidence while rendering reports', () => {
    const report: CloudReplacementReport = {
      ...minimalCloudReplacementReport(),
      concurrency: [
        {
          caseId: 'point-lookup',
          engine: 'qlever',
          concurrency: 8,
          completed: 1,
          errors: 0,
          infrastructureErrors: 0,
          infrastructureFailure: false,
          errorEvidence: {
            counts: {
              timeout: 0,
              connection: 0,
              cancelled: 0,
              engine: 0,
              correctness: 0,
              unknown: 0,
            },
            samples: [
              {
                category: 'connection',
                stage: 'query',
                name: 'Error',
                code: null,
                message: 'bad timestamp',
                firstSeenAt: 'not-a-date',
                lastSeenAt: '2026-07-18T01:00:00.000Z',
                count: 1,
                workloadId: 'point-lookup',
                engine: 'qlever',
                cacheMode: 'off',
                concurrency: 8,
              },
            ],
          },
          elapsedMs: 1_000,
          throughputPerSecond: 1,
        },
      ],
    };

    expect(() => renderCloudReplacementJson(report))
      .toThrow('Cloud replacement concurrency[0].errorEvidence.samples[0].firstSeenAt must be an ISO timestamp');
    expect(() => renderCloudReplacementJson({
      ...report,
      concurrency: [
        {
          ...report.concurrency[0]!,
          infrastructureErrors: -1,
          errorEvidence: { counts: { bogus: 1 }, samples: [] } as unknown as CloudReplacementErrorEvidence,
        },
      ],
    })).toThrow('Cloud replacement report concurrency[0].infrastructureErrors must be finite and non-negative');
  });

  it('rejects raw connection fields and credential-bearing report strings', () => {
    const report = {
      environment: {
        database: 'xpod_benchmark',
        postgresVersion: '17.5',
        engineCommit: 'abc123',
        connectionString: 'postgres://user:secret@db.example/xpod_benchmark',
      },
      targetFacts: 1,
      actualFacts: 1,
      correctnessFailures: [],
      cases: [],
      concurrency: [],
      indexBuildAndStorage: {
        rdf3x: { buildMs: 1, storageBytes: 1 },
        qlever: { buildMs: 1, storageBytes: 1 },
      },
      resourceDiagnostics: {
        rdf3x: {
          sharedBlocksRead: null,
          sharedBlocksHit: null,
          tempBytes: null,
          memoryPeakBytes: null,
          memoryLimitBytes: null,
          diagnosticsUnavailable: [],
        },
        qlever: {
          sharedBlocksRead: null,
          sharedBlocksHit: null,
          tempBytes: null,
          memoryPeakBytes: null,
          memoryLimitBytes: null,
          diagnosticsUnavailable: [],
        },
      },
      decision: decideCloudReplacement(passingDecisionInput),
    } as unknown as CloudReplacementReport;

    expect(() => renderCloudReplacementJson(report))
      .toThrow('Cloud replacement report environment must contain only sanitized fields');
    expect(() => renderCloudReplacementMarkdown({
      ...report,
      environment: {
        postgresVersion: '17.5',
        engineCommit: 'postgres://user:secret@db.example/xpod_benchmark',
      },
    })).toThrow('Cloud replacement report contains credential-bearing text');
    expect(() => renderCloudReplacementJson({
      ...report,
      environment: {
        postgresVersion: '17.5',
        engineCommit: 'postgres://db.example/xpod_benchmark',
      },
    })).toThrow('Cloud replacement report contains credential-bearing text');
  });
});
