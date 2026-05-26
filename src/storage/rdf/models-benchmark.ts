import { createHash } from 'node:crypto';
import { DataFactory } from 'n3';
import { termToId } from 'n3';
import type { Quad } from '@rdfjs/types';
import type { QuintPattern, QueryOptions, QuintStore, StoreStats } from '../quint/types';
import { isTerm } from '../quint/types';
import type {
  RdfBindingRow,
  RdfIndexMetrics,
  RdfIndexStats,
  RdfLocalQuery,
  RdfLocalQueryMetrics,
  RdfShadowDiff,
} from './types';
import { canonicalQuadKey, diffQuads } from './RdfShadowComparator';
import type { SolidRdfEngine } from './SolidRdfEngine';

const { namedNode, literal } = DataFactory;

export type RdfBenchmarkScale = 'small' | 'medium' | 'large';

export const RDF_MODELS_SYNTHETIC_MESSAGE_QUADS = 4;

const RDF_MODELS_SCALE_TARGET_QUADS: Record<RdfBenchmarkScale, number> = {
  small: 48,
  medium: 10_000,
  large: 1_000_000,
};

const RDF_MODELS_SYNTHETIC_POD_COUNTS: Record<RdfBenchmarkScale, number> = {
  small: 1,
  medium: 1,
  large: 4,
};

export interface RdfModelBenchmarkCase {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: {
    pattern: QuintPattern;
    options?: QueryOptions;
  };
  expectedPlan: string[];
}

export interface RdfModelLocalQueryBenchmarkCase {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: RdfLocalQuery;
  expectedPlan: string[];
}

export interface RdfModelBenchmarkRunOptions {
  cases?: readonly RdfModelBenchmarkCase[];
  localQueryCases?: readonly RdfModelLocalQueryBenchmarkCase[];
  scale?: RdfBenchmarkScale;
  iterations?: number;
}

export interface RdfModelBenchmarkResult {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: {
    pattern: JsonPattern;
    options?: QueryOptions;
  };
  expectedPlan: string[];
  planMatched: boolean;
  missingPlan: string[];
  physicalPlan: string[];
  scannedRows: number;
  indexChoice: string;
  joinOrder: string[];
  fallbackReason: string | null;
  returnedRows: number;
  checksum: string;
  orderedChecksum: string;
  durationsMs: number[];
  p50DurationMs: number;
  p95DurationMs: number;
  metrics: RdfIndexMetrics;
  indexStats: RdfIndexStats;
}

export interface RdfModelLocalQueryBenchmarkResult {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: JsonPattern;
  expectedPlan: string[];
  planMatched: boolean;
  missingPlan: string[];
  physicalPlan: string[];
  scannedRows: number;
  indexChoices: string[];
  fallbackReason: string | null;
  returnedRows: number;
  checksum: string;
  orderedChecksum: string;
  durationsMs: number[];
  p50DurationMs: number;
  p95DurationMs: number;
  metrics: RdfLocalQueryMetrics;
  indexStats: RdfIndexStats;
}

export interface RdfModelBenchmarkReport {
  engine: 'solid-rdf';
  scale: RdfBenchmarkScale;
  iterations: number;
  generatedAt: string;
  planMatched: boolean;
  failedPlanCases: string[];
  cases: RdfModelBenchmarkResult[];
  localQueryCases: RdfModelLocalQueryBenchmarkResult[];
}

export interface RdfModelShadowBenchmarkRunOptions extends RdfModelBenchmarkRunOptions {}

export interface RdfModelShadowBenchmarkSide {
  returnedRows: number;
  checksum: string;
  orderedChecksum: string;
  durationsMs: number[];
  p50DurationMs: number;
  p95DurationMs: number;
  storeStats?: StoreStats;
}

export interface RdfModelShadowPerformanceComparison {
  p95DeltaMs: number;
  p95Ratio: number;
  matched: boolean;
}

export interface RdfModelShadowSpaceComparison {
  databaseDeltaBytes: number;
  tableDeltaBytes: number;
  indexDeltaBytes: number;
  databaseRatio: number;
  tableRatio: number;
  indexRatio: number;
  matched: boolean;
  unavailableReason?: string;
}

export interface RdfModelShadowBenchmarkResult {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: {
    pattern: JsonPattern;
    options?: QueryOptions;
  };
  expectedPlan: string[];
  planMatched: boolean;
  missingPlan: string[];
  matched: boolean;
  orderedMatch: boolean;
  diff: RdfShadowDiff;
  compatibility: RdfModelShadowBenchmarkSide;
  solidRdf: RdfModelShadowBenchmarkSide & {
    physicalPlan: string[];
    scannedRows: number;
    indexChoice: string;
    joinOrder: string[];
    fallbackReason: string | null;
    metrics: RdfIndexMetrics;
    indexStats: RdfIndexStats;
  };
  performance: RdfModelShadowPerformanceComparison;
  space: RdfModelShadowSpaceComparison;
}

export interface RdfModelShadowBenchmarkReport {
  engine: 'shadow';
  compatibilityEngine: 'quint-store';
  candidateEngine: 'solid-rdf';
  scale: RdfBenchmarkScale;
  iterations: number;
  generatedAt: string;
  matched: boolean;
  orderedMatched: boolean;
  planMatched: boolean;
  spaceGateEnforced: boolean;
  performanceMatched: boolean;
  spaceMatched: boolean;
  failedPlanCases: string[];
  failedPerformanceCases: string[];
  failedSpaceCases: string[];
  cases: RdfModelShadowBenchmarkResult[];
}

type JsonPattern = Record<string, unknown>;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const DCT_MODIFIED = 'http://purl.org/dc/terms/modified';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const UDFS = 'https://undefineds.co/ns#';
const MEETING = 'http://www.w3.org/ns/pim/meeting#';
const SIOC = 'http://rdfs.org/sioc/ns#';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const PERFORMANCE_P95_MIN_ABSOLUTE_HEADROOM_MS = 25;
const PERFORMANCE_P95_MAX_RATIO = 8;

export const rdfModelsBenchmarkCases: readonly RdfModelBenchmarkCase[] = [
  {
    name: 'list chats',
    resource: 'chat',
    purpose: 'surface list with graph-scope and type filter',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${MEETING}LongChat`),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list tasks',
    resource: 'task',
    purpose: 'task surface list with status/type filtering',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${UDFS}Task`),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list threads by chat',
    resource: 'thread',
    purpose: 'relation lookup under a chat index graph',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${SIOC}Thread`),
        graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list threads by task',
    resource: 'thread',
    purpose: 'relation lookup under a task index graph',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${SIOC}Thread`),
        graph: namedNode('https://pod.example/alice/.data/task/default/index.ttl'),
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list messages by thread',
    resource: 'message',
    purpose: 'date-bucketed message lookup through thread inverse membership',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(SIOC_HAS_MEMBER),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'limit'],
  },
  {
    name: 'latest message',
    resource: 'message',
    purpose: 'ORDER BY + LIMIT over message date bucket',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(DCT_CREATED),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
      },
      options: { order: ['object'], reverse: true, limit: 1 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'order', 'limit'],
  },
  {
    name: 'latest run',
    resource: 'run',
    purpose: 'ORDER BY + LIMIT over date-bucketed run documents',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(DCT_CREATED),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
      },
      options: { order: ['object'], reverse: true, limit: 1 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'order', 'limit'],
  },
  {
    name: 'pending runs',
    resource: 'run',
    purpose: 'status filter for scheduler and state center',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}status`),
        object: literal('queued'),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'running runs',
    resource: 'run',
    purpose: 'status filter for active runtime execution',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}status`),
        object: literal('running'),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'runs by workspace',
    resource: 'run',
    purpose: 'workspace relation filter for runtime placement and steering',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}workspace`),
        object: namedNode('file://macbook.local/Users/alice/project/'),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'runs by numeric priority',
    resource: 'run',
    purpose: 'typed numeric literal range filter for scheduler priority queues',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}priority`),
        object: { $gt: literal('9', namedNode('http://www.w3.org/2001/XMLSchema#integer')) },
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-range-filter', 'limit'],
  },
  {
    name: 'run with steps',
    resource: 'runStep',
    purpose: 'one-to-many run-step relation lookup',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}run`),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
      },
      options: { order: ['subject'], limit: 200 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'limit'],
  },
  {
    name: 'task materialization due time',
    resource: 'schedule',
    purpose: 'schedule due-time candidate lookup',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}nextRunAt`),
        object: { $lte: literal('2026-05-18T01:30:00.000Z') },
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['object'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-range-filter', 'order', 'limit'],
  },
  {
    name: 'search message literals',
    resource: 'message',
    purpose: 'literal/text index candidate that reconnects to RDF subjects',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(SIOC_CONTENT),
        object: { $contains: 'searchable' },
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['text-index', 'rdf-subject-join'],
  },
  {
    name: 'load by exact id',
    resource: 'any',
    purpose: 'base-relative id expands to exact subject IRI',
    minScale: 'small',
    query: {
      pattern: {
        subject: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
      },
    },
    expectedPlan: ['SPOG'],
  },
  {
    name: 'acl graph prefix scoped query',
    resource: 'any',
    purpose: 'scope filter must avoid unbounded full-pod scans',
    minScale: 'medium',
    query: {
      pattern: {
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
        predicate: namedNode(DCT_MODIFIED),
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'limit'],
  },
  {
    name: 'list providers',
    resource: 'aiProvider',
    purpose: 'AI provider settings list and provider/model relation baseline',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${UDFS}Provider`),
        graph: { $startsWith: 'https://pod.example/alice/settings/providers/' },
      },
    },
    expectedPlan: ['graph-scope', 'type-filter'],
  },
  {
    name: 'models by provider',
    resource: 'aiModel',
    purpose: 'AI model lookup by provider relation',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}isProvidedBy`),
        object: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      },
    },
    expectedPlan: ['POSG'],
  },
  {
    name: 'credentials by provider',
    resource: 'credential',
    purpose: 'credential lookup by provider relation',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}provider`),
        object: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
      },
    },
    expectedPlan: ['POSG'],
  },
  {
    name: 'list agents',
    resource: 'agent',
    purpose: 'agent identity list under the shared models agent resource base',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(FOAF_AGENT),
        graph: { $startsWith: 'https://pod.example/alice/.data/agents/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list contacts',
    resource: 'contact',
    purpose: 'contact index list under the shared models contact resource base',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(VCARD_INDIVIDUAL),
        graph: { $startsWith: 'https://pod.example/alice/.data/contacts/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list favorites',
    resource: 'favorite',
    purpose: 'favorite list over date-bucketed favorite documents',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(SCHEMA_CREATIVE_WORK),
        graph: { $startsWith: 'https://pod.example/alice/.data/favorites/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
];

export const rdfModelsLocalQueryBenchmarkCases: readonly RdfModelLocalQueryBenchmarkCase[] = [
  {
    name: 'latest message by thread local query',
    resource: 'message',
    purpose: 'date-bucketed message timeline keeps ORDER BY/LIMIT inside SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'next queued run by workspace local query',
    resource: 'run',
    purpose: 'run state center scheduler query keeps status/workspace/date joins in SQL before LIMIT',
    minScale: 'small',
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('queued'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode('file://macbook.local/Users/alice/project/'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
      ],
      select: ['run', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'asc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'run steps by run local query',
    resource: 'runStep',
    purpose: 'one-to-many run-step lookup keeps type and run relation in SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
          subject: { variable: 'step' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}RunStep`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
          subject: { variable: 'step' },
          predicate: namedNode(`${UDFS}run`),
          object: namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_1'),
        },
      ],
      select: ['step'],
      orderBy: [
        {
          variable: 'step',
          direction: 'asc',
        },
      ],
      limit: 50,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'task materialization active due local query',
    resource: 'schedule',
    purpose: 'task scheduler materialization keeps active status and due-time filter in SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'schedule' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Schedule`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'schedule' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('active'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'schedule' },
          predicate: namedNode(`${UDFS}nextRunAt`),
          object: { variable: 'nextRunAt' },
        },
      ],
      filters: [
        {
          variable: 'nextRunAt',
          operator: '$lte',
          value: literal('2026-05-18T01:30:00.000Z'),
        },
      ],
      select: ['schedule', 'nextRunAt'],
      orderBy: [
        {
          variable: 'nextRunAt',
          direction: 'asc',
        },
      ],
      limit: 100,
    },
    expectedPlan: ['join-index', 'range-filter-pushdown', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'message count by thread with having',
    resource: 'message',
    purpose: 'grouped message count uses SQL GROUP BY/HAVING before pagination',
    minScale: 'small',
    query: {
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
      ],
      groupBy: ['thread'],
      aggregate: {
        type: 'count',
        as: 'count',
        variable: 'message',
      },
      having: [
        {
          variable: 'count',
          operator: '$gt',
          value: literal('2', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
      select: ['thread', 'count'],
      orderBy: [
        {
          variable: 'count',
          direction: 'desc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['group-count-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'message join count distinct',
    resource: 'message',
    purpose: 'message/thread BGP aggregate count stays inside SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
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
    },
    expectedPlan: ['join-count-index'],
  },
];

export function rdfModelsBenchmarkCaseNames(): string[] {
  return rdfModelsBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsLocalQueryBenchmarkCaseNames(): string[] {
  return rdfModelsLocalQueryBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsBenchmarkScaleTargetQuads(scale: RdfBenchmarkScale): number {
  return RDF_MODELS_SCALE_TARGET_QUADS[scale];
}

export function rdfModelsBenchmarkSyntheticPodCount(scale: RdfBenchmarkScale): number {
  return RDF_MODELS_SYNTHETIC_POD_COUNTS[scale];
}

export function estimateRdfModelsSyntheticQuadCount(syntheticMessages: number): number {
  return Math.max(0, Math.floor(syntheticMessages)) * RDF_MODELS_SYNTHETIC_MESSAGE_QUADS;
}

export function defaultSyntheticMessagesForRdfModelsScale(scale: RdfBenchmarkScale): number {
  if (scale === 'small') {
    return 12;
  }
  return Math.ceil(rdfModelsBenchmarkScaleTargetQuads(scale) / RDF_MODELS_SYNTHETIC_MESSAGE_QUADS);
}

export function rdfModelsBenchmarkScaleSatisfied(scale: RdfBenchmarkScale, seedQuadCount: number): boolean {
  return seedQuadCount >= rdfModelsBenchmarkScaleTargetQuads(scale);
}

export function runRdfModelsBenchmark(
  engine: SolidRdfEngine,
  options: RdfModelBenchmarkRunOptions = {},
): RdfModelBenchmarkReport {
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const cases = (options.cases ?? rdfModelsBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const localQueryCases = (options.localQueryCases ?? rdfModelsLocalQueryBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const results = cases.map((testCase) => runBenchmarkCase(engine, testCase, iterations));
  const localQueryResults = localQueryCases.map((testCase) => runLocalQueryBenchmarkCase(engine, testCase, iterations));
  const failedPlanCases = [
    ...results.filter((result) => !result.planMatched).map((result) => result.name),
    ...localQueryResults.filter((result) => !result.planMatched).map((result) => result.name),
  ];

  return {
    engine: 'solid-rdf',
    scale,
    iterations,
    generatedAt: new Date().toISOString(),
    planMatched: failedPlanCases.length === 0,
    failedPlanCases,
    cases: results,
    localQueryCases: localQueryResults,
  };
}

export async function runRdfModelsShadowBenchmark(
  engine: SolidRdfEngine,
  compatibilityStore: QuintStore,
  options: RdfModelShadowBenchmarkRunOptions = {},
): Promise<RdfModelShadowBenchmarkReport> {
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const cases = (options.cases ?? rdfModelsBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const results = [];
  const compatibilityStats = await compatibilityStore.stats();

  for (const testCase of cases) {
    results.push(await runShadowBenchmarkCase(engine, compatibilityStore, testCase, iterations, compatibilityStats));
  }
  const spaceGateEnforced = scaleRank(scale) >= scaleRank('medium');
  const failedPerformanceCases = results.filter((result) => !result.performance.matched).map((result) => result.name);
  const failedSpaceCases = spaceGateEnforced
    ? results.filter((result) => !result.space.matched).map((result) => result.name)
    : [];

  return {
    engine: 'shadow',
    compatibilityEngine: 'quint-store',
    candidateEngine: 'solid-rdf',
    scale,
    iterations,
    generatedAt: new Date().toISOString(),
    matched: results.every((result) => result.matched),
    orderedMatched: results.every((result) => result.orderedMatch),
    planMatched: results.every((result) => result.planMatched),
    spaceGateEnforced,
    performanceMatched: failedPerformanceCases.length === 0,
    spaceMatched: failedSpaceCases.length === 0,
    failedPlanCases: results.filter((result) => !result.planMatched).map((result) => result.name),
    failedPerformanceCases,
    failedSpaceCases,
    cases: results,
  };
}

function runBenchmarkCase(
  engine: SolidRdfEngine,
  testCase: RdfModelBenchmarkCase,
  iterations: number,
): RdfModelBenchmarkResult {
  const durationsMs: number[] = [];
  let metrics: RdfIndexMetrics | undefined;
  let keys: string[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    const result = engine.scan(testCase.query);
    durationsMs.push(Math.max(0, Date.now() - start));
    metrics = result.metrics;
    keys = result.quads.map(canonicalQuadKey);
  }

  const finalMetrics = metrics ?? {
    engine: 'solid-rdf',
    indexChoice: 'not-run',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  };
  const missingPlan = missingExpectedPlan(testCase, finalMetrics);
  const execution = benchmarkExecution(finalMetrics);

  return {
    name: testCase.name,
    resource: testCase.resource,
    purpose: testCase.purpose,
    minScale: testCase.minScale,
    query: {
      pattern: serializePattern(testCase.query.pattern),
      ...(testCase.query.options ? { options: testCase.query.options } : {}),
    },
    expectedPlan: [...testCase.expectedPlan],
    planMatched: missingPlan.length === 0,
    missingPlan,
    ...execution,
    returnedRows: keys.length,
    checksum: checksum(keys, false),
    orderedChecksum: checksum(keys, true),
    durationsMs,
    p50DurationMs: percentile(durationsMs, 0.5),
    p95DurationMs: percentile(durationsMs, 0.95),
    metrics: finalMetrics,
    indexStats: engine.index.stats(),
  };
}

function runLocalQueryBenchmarkCase(
  engine: SolidRdfEngine,
  testCase: RdfModelLocalQueryBenchmarkCase,
  iterations: number,
): RdfModelLocalQueryBenchmarkResult {
  const durationsMs: number[] = [];
  let metrics: RdfLocalQueryMetrics | undefined;
  let keys: string[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    const result = engine.query(testCase.query);
    durationsMs.push(Math.max(0, Date.now() - start));
    metrics = result.metrics;
    keys = result.bindings.map(bindingKey);
  }

  const finalMetrics = metrics ?? {
    engine: 'solid-rdf',
    plan: [],
    scannedRows: 0,
    joinedRows: 0,
    returnedRows: 0,
    durationMs: 0,
    indexChoices: [],
    filtersApplied: 0,
    filtersPushedDown: 0,
  };
  const missingPlan = missingExpectedLocalQueryPlan(testCase, finalMetrics);

  return {
    name: testCase.name,
    resource: testCase.resource,
    purpose: testCase.purpose,
    minScale: testCase.minScale,
    query: serializeLocalQuery(testCase.query),
    expectedPlan: [...testCase.expectedPlan],
    planMatched: missingPlan.length === 0,
    missingPlan,
    physicalPlan: finalMetrics.plan,
    scannedRows: finalMetrics.scannedRows,
    indexChoices: [...finalMetrics.indexChoices],
    fallbackReason: null,
    returnedRows: keys.length,
    checksum: checksum(keys, false),
    orderedChecksum: checksum(keys, true),
    durationsMs,
    p50DurationMs: percentile(durationsMs, 0.5),
    p95DurationMs: percentile(durationsMs, 0.95),
    metrics: finalMetrics,
    indexStats: engine.index.stats(),
  };
}

async function runShadowBenchmarkCase(
  engine: SolidRdfEngine,
  compatibilityStore: QuintStore,
  testCase: RdfModelBenchmarkCase,
  iterations: number,
  compatibilityStats: StoreStats,
): Promise<RdfModelShadowBenchmarkResult> {
  const compatibilityDurationsMs: number[] = [];
  const solidRdfDurationsMs: number[] = [];
  let compatibilityQuads: Quad[] = [];
  let solidRdfQuads: Quad[] = [];
  let metrics: RdfIndexMetrics | undefined;

  for (let i = 0; i < iterations; i += 1) {
    let start = Date.now();
    compatibilityQuads = await compatibilityStore.get(testCase.query.pattern, testCase.query.options);
    compatibilityDurationsMs.push(Math.max(0, Date.now() - start));

    start = Date.now();
    const solidRdfResult = engine.scan(testCase.query);
    solidRdfDurationsMs.push(Math.max(0, Date.now() - start));
    solidRdfQuads = solidRdfResult.quads;
    metrics = solidRdfResult.metrics;
  }

  const compatibilityKeys = compatibilityQuads.map(canonicalQuadKey);
  const solidRdfKeys = solidRdfQuads.map(canonicalQuadKey);
  const diff = diffQuads(solidRdfQuads, compatibilityQuads);
  const orderedMatch = isSemanticallyOrdered(testCase.query.options)
    ? solidRdfKeys.join('\n') === compatibilityKeys.join('\n')
    : true;
  const finalMetrics = metrics ?? {
    engine: 'solid-rdf',
    indexChoice: 'not-run',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  };
  const missingPlan = missingExpectedPlan(testCase, finalMetrics);
  const execution = benchmarkExecution(finalMetrics);
  const compatibilitySide = {
    ...benchmarkSide(compatibilityKeys, compatibilityDurationsMs),
    storeStats: compatibilityStats,
  };
  const solidRdfSide = {
    ...benchmarkSide(solidRdfKeys, solidRdfDurationsMs),
    ...execution,
    metrics: finalMetrics,
    indexStats: engine.index.stats(),
  };

  return {
    name: testCase.name,
    resource: testCase.resource,
    purpose: testCase.purpose,
    minScale: testCase.minScale,
    query: {
      pattern: serializePattern(testCase.query.pattern),
      ...(testCase.query.options ? { options: testCase.query.options } : {}),
    },
    expectedPlan: [...testCase.expectedPlan],
    planMatched: missingPlan.length === 0,
    missingPlan,
    matched: diff.missingFromPrimary.length === 0 && diff.extraInPrimary.length === 0,
    orderedMatch,
    diff,
    compatibility: compatibilitySide,
    solidRdf: solidRdfSide,
    performance: comparePerformance(compatibilitySide, solidRdfSide),
    space: compareSpace(compatibilityStats, solidRdfSide.indexStats),
  };
}

function benchmarkExecution(metrics: RdfIndexMetrics): {
  physicalPlan: string[];
  scannedRows: number;
  indexChoice: string;
  joinOrder: string[];
  fallbackReason: string | null;
} {
  return {
    physicalPlan: metrics.queryPlan ?? [],
    scannedRows: metrics.matchedRows,
    indexChoice: metrics.indexChoice,
    joinOrder: [metrics.indexChoice],
    fallbackReason: null,
  };
}

function isSemanticallyOrdered(options?: QueryOptions): boolean {
  return Boolean(options?.order && options.order.length > 0);
}

function benchmarkSide(keys: string[], durationsMs: number[]): RdfModelShadowBenchmarkSide {
  return {
    returnedRows: keys.length,
    checksum: checksum(keys, false),
    orderedChecksum: checksum(keys, true),
    durationsMs,
    p50DurationMs: percentile(durationsMs, 0.5),
    p95DurationMs: percentile(durationsMs, 0.95),
  };
}

function comparePerformance(
  compatibility: RdfModelShadowBenchmarkSide,
  solidRdf: RdfModelShadowBenchmarkSide,
): RdfModelShadowPerformanceComparison {
  const p95DeltaMs = solidRdf.p95DurationMs - compatibility.p95DurationMs;
  const p95Ratio = solidRdf.p95DurationMs / Math.max(1, compatibility.p95DurationMs);
  return {
    p95DeltaMs,
    p95Ratio,
    matched: p95DeltaMs <= PERFORMANCE_P95_MIN_ABSOLUTE_HEADROOM_MS
      || p95Ratio <= PERFORMANCE_P95_MAX_RATIO,
  };
}

function compareSpace(
  compatibility: StoreStats,
  solidRdf: RdfIndexStats,
): RdfModelShadowSpaceComparison {
  if (
    compatibility.databaseBytes === undefined
    || compatibility.tableBytes === undefined
    || compatibility.indexBytes === undefined
  ) {
    return {
      databaseDeltaBytes: 0,
      tableDeltaBytes: 0,
      indexDeltaBytes: 0,
      databaseRatio: 0,
      tableRatio: 0,
      indexRatio: 0,
      matched: false,
      unavailableReason: 'compatibility store did not report database/table/index bytes',
    };
  }

  const databaseDeltaBytes = solidRdf.databaseBytes - compatibility.databaseBytes;
  const tableDeltaBytes = solidRdf.tableBytes - compatibility.tableBytes;
  const indexDeltaBytes = solidRdf.indexBytes - compatibility.indexBytes;

  return {
    databaseDeltaBytes,
    tableDeltaBytes,
    indexDeltaBytes,
    databaseRatio: ratio(solidRdf.databaseBytes, compatibility.databaseBytes),
    tableRatio: ratio(solidRdf.tableBytes, compatibility.tableBytes),
    indexRatio: ratio(solidRdf.indexBytes, compatibility.indexBytes),
    matched: databaseDeltaBytes <= 0 && tableDeltaBytes <= 0 && indexDeltaBytes <= 0,
  };
}

function ratio(candidate: number, baseline: number): number {
  if (baseline <= 0) {
    return candidate <= 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return candidate / baseline;
}

function missingExpectedPlan(testCase: RdfModelBenchmarkCase, metrics: RdfIndexMetrics): string[] {
  return testCase.expectedPlan.filter((label) => !matchesExpectedPlanLabel(label, testCase, metrics));
}

function matchesExpectedPlanLabel(label: string, testCase: RdfModelBenchmarkCase, metrics: RdfIndexMetrics): boolean {
  const pattern = testCase.query.pattern;
  const planText = (metrics.queryPlan ?? []).join('\n');
  switch (label) {
    case 'graph-scope':
      return Boolean(pattern.graph) && metrics.indexChoice.includes('G');
    case 'type-filter':
      return isTerm(pattern.predicate as any)
        && termToId(pattern.predicate as any) === RDF_TYPE
        && Boolean(pattern.object)
        && metrics.indexChoice !== 'full-scan';
    case 'predicate-filter':
      return Boolean(pattern.predicate) && metrics.indexChoice.includes('P');
    case 'predicate-object-filter':
      return Boolean(pattern.predicate) && Boolean(pattern.object) && metrics.indexChoice.includes('P');
    case 'predicate-object-range-filter':
      return Boolean(pattern.predicate)
        && (planText.includes('_range') || planText.includes('LexicalRange(') || planText.includes('NumericRange('));
    case 'limit':
      return testCase.query.options?.limit !== undefined && planText.includes('LIMIT');
    case 'order':
      return Boolean(testCase.query.options?.order?.length) && planText.includes('ORDER BY');
    case 'text-index':
      return planText.includes('TextSearch(');
    case 'rdf-subject-join':
      return planText.includes('TextSearch(')
        && metrics.indexChoice !== 'full-scan'
        && metrics.matchedRows >= metrics.returnedRows;
    case 'SPOG':
    case 'POSG':
    case 'GSPO':
    case 'GPOS':
    case 'OSPG':
      return metrics.indexChoice === label;
    default:
      return false;
  }
}

function missingExpectedLocalQueryPlan(
  testCase: RdfModelLocalQueryBenchmarkCase,
  metrics: RdfLocalQueryMetrics,
): string[] {
  return testCase.expectedPlan.filter((label) => !matchesExpectedLocalQueryPlanLabel(label, metrics));
}

function matchesExpectedLocalQueryPlanLabel(label: string, metrics: RdfLocalQueryMetrics): boolean {
  const planText = metrics.plan.join('\n');
  switch (label) {
    case 'group-count-index':
      return planText.includes('Aggregate(group-count-index)');
    case 'having-pushdown':
      return planText.includes('IndexGroupCountHaving(')
        && !planText.includes('\nHaving(');
    case 'order':
      return planText.includes('IndexGroupCountOrder(') && !planText.includes('\nSort');
    case 'limit':
      return planText.includes('IndexGroupCountLimit') && !planText.includes('\nLimit');
    case 'join-index':
      return planText.includes('IndexJoin(')
        && !planText.includes('\nIndexScan(');
    case 'join-order-pushdown':
      return planText.includes('IndexJoinOrder(')
        && !planText.includes('\nSort');
    case 'join-limit-pushdown':
      return planText.includes('IndexJoinLimit')
        && !planText.includes('\nLimit');
    case 'range-filter-pushdown':
      return metrics.filtersPushedDown > 0
        && planText.includes('LexicalRange(');
    case 'join-count-index':
      return planText.includes('Aggregate(join-count-distinct-index)')
        && planText.includes('IndexJoinCount(')
        && !planText.includes('\nIndexScan(');
    default:
      return false;
  }
}

function bindingKey(binding: RdfBindingRow): string {
  return Object.keys(binding)
    .sort()
    .map((key) => `${key}=${termToId(binding[key] as any)}`)
    .join('\u001f');
}

function checksum(keys: string[], ordered: boolean): string {
  const normalized = ordered ? keys : [...keys].sort();
  return createHash('sha256')
    .update(normalized.join('\n'))
    .digest('hex');
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index];
}

function scaleRank(scale: RdfBenchmarkScale): number {
  switch (scale) {
    case 'small':
      return 1;
    case 'medium':
      return 2;
    case 'large':
      return 3;
    default: {
      const exhaustive: never = scale;
      return exhaustive;
    }
  }
}

function serializePattern(pattern: QuintPattern): JsonPattern {
  return Object.fromEntries(
    Object.entries(pattern).map(([key, value]) => [key, serializePatternValue(value)]),
  );
}

function serializeLocalQuery(query: RdfLocalQuery): JsonPattern {
  return serializePatternValue(query) as JsonPattern;
}

function serializePatternValue(value: unknown): unknown {
  if (!value) {
    return value;
  }
  if (isTerm(value as any)) {
    return termToId(value as any);
  }
  if (Array.isArray(value)) {
    return value.map(serializePatternValue);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, serializePatternValue(nested)]),
    );
  }
  return value;
}
