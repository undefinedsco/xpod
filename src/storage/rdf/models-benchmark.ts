import { createHash } from 'node:crypto';
import { DataFactory } from 'n3';
import { termToId } from 'n3';
import type { Quad, Term } from '@rdfjs/types';
import type { QuintPattern, QueryOptions, QuintStore, StoreStats } from '../quint/types';
import { isTerm } from '../quint/types';
import type {
  Rdf3xJoinMetrics,
  Rdf3xIndexMetrics,
  Rdf3xIndexStats,
  Rdf3xObjectOperatorPattern,
  Rdf3xObjectRangePattern,
  Rdf3xObjectTextSearchPattern,
  Rdf3xPermutationName,
  Rdf3xTermInPattern,
  Rdf3xTermNotInPattern,
  Rdf3xTriplePattern,
  RdfBindingRow,
  RdfEngineStorageStats,
  RdfIndexMetrics,
  RdfIndexStats,
  RdfQuery,
  RdfQueryMetrics,
  RdfQuadJoinCountOptions,
  RdfQuadJoinGroupAggregateHaving,
  RdfQuadJoinGroupAggregateOptions,
  RdfQuadJoinOptions,
  RdfQuadJoinPattern,
  RdfQueryAggregate,
  RdfQueryFilter,
  RdfQueryPattern,
  RdfQueryPatternKey,
  RdfShadowDiff,
} from './types';
import { canonicalQuadKey, diffQuads } from './RdfShadowComparator';
import type { SolidRdfEngine } from './SolidRdfEngine';
import { isRdfNumericDatatype, rdfNumericValue } from './RdfTermSemantics';

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

export interface RdfModelQueryBenchmarkCase {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  minReturnedRows?: number;
  query: RdfQuery;
  expectedPlan: string[];
}

export interface RdfModelBenchmarkRunOptions {
  cases?: readonly RdfModelBenchmarkCase[];
  queryCases?: readonly RdfModelQueryBenchmarkCase[];
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

export interface RdfModelQueryBenchmarkResult {
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
  metrics: RdfQueryMetrics;
  indexStats: RdfIndexStats;
}

export interface RdfModelBenchmarkReport {
  engine: 'solid-rdf';
  scale: RdfBenchmarkScale;
  iterations: number;
  generatedAt: string;
  planMatched: boolean;
  failedPlanCases: string[];
  storage: RdfEngineStorageStats;
  cases: RdfModelBenchmarkResult[];
  queryCases: RdfModelQueryBenchmarkResult[];
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

export interface RdfModelRdf3xShadowBenchmarkResult {
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
  supported: boolean;
  unsupportedReason?: string;
  matched: boolean;
  orderedMatch: boolean;
  diff: RdfShadowDiff;
  solidRdf: RdfModelShadowBenchmarkSide & {
    physicalPlan: string[];
    scannedRows: number;
    indexChoice: string;
    joinOrder: string[];
    fallbackReason: string | null;
    metrics: RdfIndexMetrics;
    indexStats: RdfIndexStats;
  };
  rdf3x?: RdfModelShadowBenchmarkSide & {
    physicalPlan: string[];
    scannedRows: number;
    indexChoice: string;
    joinOrder: string[];
    fallbackReason: string | null;
    metrics: Rdf3xIndexMetrics;
    indexStats: Rdf3xIndexStats;
  };
}

export interface RdfModelRdf3xShadowJoinBenchmarkResult {
  name: string;
  resource: string;
  purpose: string;
  minScale: RdfBenchmarkScale;
  query: JsonPattern;
  expectedPlan: string[];
  planMatched: boolean;
  missingPlan: string[];
  supported: boolean;
  unsupportedReason?: string;
  matched: boolean;
  orderedMatch: boolean;
  diff: RdfShadowDiff;
  solidRdf: RdfModelShadowBenchmarkSide & {
    physicalPlan: string[];
    scannedRows: number;
    indexChoice: string;
    joinOrder: string[];
    fallbackReason: string | null;
    metrics: RdfIndexMetrics;
    indexStats: RdfIndexStats;
  };
  rdf3x?: RdfModelShadowBenchmarkSide & {
    physicalPlan: string[];
    scannedRows: number;
    indexChoice: string;
    joinOrder: string[];
    fallbackReason: string | null;
    metrics: Rdf3xJoinMetrics;
    indexStats: Rdf3xIndexStats;
  };
}

export interface RdfModelRdf3xShadowBenchmarkReport {
  engine: 'rdf3x-shadow';
  primaryEngine: 'solid-rdf';
  candidateEngine: 'solid-rdf3x';
  scale: RdfBenchmarkScale;
  iterations: number;
  generatedAt: string;
  matched: boolean;
  orderedMatched: boolean;
  planMatched: boolean;
  skippedCases: string[];
  skippedJoinCases: string[];
  failedCases: string[];
  failedJoinCases: string[];
  failedPlanCases: string[];
  rebuild: {
    scannedQuads: number;
    uniqueTriples: number;
    memberships: number;
    projectionRows: number;
    durationMs: number;
  };
  storage: RdfEngineStorageStats;
  cases: RdfModelRdf3xShadowBenchmarkResult[];
  joinCases: RdfModelRdf3xShadowJoinBenchmarkResult[];
}

type Rdf3xJoinBenchmarkShape =
  | {
      kind: 'join';
      patterns: RdfQuadJoinPattern[];
      options?: RdfQuadJoinOptions;
    }
  | {
      kind: 'join-count' | 'join-aggregate';
      patterns: RdfQuadJoinPattern[];
      options: RdfQuadJoinCountOptions;
    }
  | {
      kind: 'group-count' | 'group-aggregate';
      patterns: RdfQuadJoinPattern[];
      options: RdfQuadJoinGroupAggregateOptions;
    };

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

export const rdfModelsQueryBenchmarkCases: readonly RdfModelQueryBenchmarkCase[] = [
  {
    name: 'latest message by thread query',
    resource: 'message',
    purpose: 'date-bucketed message timeline keeps ORDER BY/LIMIT inside SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
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
    name: 'next queued run by workspace query',
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
    name: 'run steps by run query',
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
    name: 'task materialization active due query',
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
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
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
    name: 'message score by thread numeric aggregate',
    resource: 'message',
    purpose: 'grouped numeric message score aggregate stays inside SQL/RDF-3X GROUP BY',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}score`),
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
          as: 'count',
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
      ],
      having: [
        {
          variable: 'scoreTotal',
          operator: '$gt',
          value: literal('4', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
      select: ['thread', 'count', 'scoreTotal', 'scoreAvg'],
      orderBy: [
        {
          variable: 'scoreTotal',
          direction: 'desc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['group-aggregate-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'message join count distinct',
    resource: 'message',
    purpose: 'message/thread BGP aggregate count stays inside SQL self-join',
    minScale: 'small',
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
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

export function rdfModelsQueryBenchmarkCaseNames(): string[] {
  return rdfModelsQueryBenchmarkCases.map((testCase) => testCase.name);
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
  const queryCases = (options.queryCases ?? rdfModelsQueryBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const results = cases.map((testCase) => runBenchmarkCase(engine, testCase, iterations));
  const queryResults = queryCases.map((testCase) => runQueryBenchmarkCase(engine, testCase, iterations));
  const failedPlanCases = [
    ...results.filter((result) => !result.planMatched).map((result) => result.name),
    ...queryResults.filter((result) => !result.planMatched).map((result) => result.name),
  ];

  return {
    engine: 'solid-rdf',
    scale,
    iterations,
    generatedAt: new Date().toISOString(),
    planMatched: failedPlanCases.length === 0,
    failedPlanCases,
    storage: engine.storageStats(),
    cases: results,
    queryCases: queryResults,
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

export function runRdfModelsRdf3xShadowBenchmark(
  engine: SolidRdfEngine,
  options: RdfModelBenchmarkRunOptions = {},
): RdfModelRdf3xShadowBenchmarkReport {
  if (!engine.rdf3xIndex) {
    throw new Error('runRdfModelsRdf3xShadowBenchmark requires SolidRdfEngine.rdf3xIndex');
  }
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const cases = (options.cases ?? rdfModelsBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const queryCases = (options.queryCases ?? rdfModelsQueryBenchmarkCases)
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const rebuild = engine.rdf3xIndex.rebuildFromCurrentQuads();
  const results = cases.map((testCase) => runRdf3xShadowBenchmarkCase(engine, testCase, iterations));
  const joinResults = queryCases.map((testCase) => runRdf3xShadowJoinBenchmarkCase(engine, testCase, iterations));
  const supportedResults = results.filter((result) => result.supported);
  const supportedJoinResults = joinResults.filter((result) => result.supported);
  const failedPlanCases = [
    ...supportedResults.filter((result) => !result.planMatched).map((result) => result.name),
    ...supportedJoinResults.filter((result) => !result.planMatched).map((result) => result.name),
  ];

  return {
    engine: 'rdf3x-shadow',
    primaryEngine: 'solid-rdf',
    candidateEngine: 'solid-rdf3x',
    scale,
    iterations,
    generatedAt: new Date().toISOString(),
    matched: supportedResults.every((result) => result.matched)
      && supportedJoinResults.every((result) => result.matched),
    orderedMatched: supportedResults.every((result) => result.orderedMatch)
      && supportedJoinResults.every((result) => result.orderedMatch),
    planMatched: failedPlanCases.length === 0,
    skippedCases: results.filter((result) => !result.supported).map((result) => result.name),
    skippedJoinCases: joinResults.filter((result) => !result.supported).map((result) => result.name),
    failedCases: supportedResults.filter((result) => !result.matched || !result.orderedMatch).map((result) => result.name),
    failedJoinCases: supportedJoinResults
      .filter((result) => !result.matched || !result.orderedMatch)
      .map((result) => result.name),
    failedPlanCases,
    rebuild,
    storage: engine.storageStats(),
    cases: results,
    joinCases: joinResults,
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

function runQueryBenchmarkCase(
  engine: SolidRdfEngine,
  testCase: RdfModelQueryBenchmarkCase,
  iterations: number,
): RdfModelQueryBenchmarkResult {
  const durationsMs: number[] = [];
  let metrics: RdfQueryMetrics | undefined;
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
  const missingPlan = missingExpectedQueryPlan(testCase, finalMetrics, keys.length);

  return {
    name: testCase.name,
    resource: testCase.resource,
    purpose: testCase.purpose,
    minScale: testCase.minScale,
    query: serializeQueryPlan(testCase.query),
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

function runRdf3xShadowBenchmarkCase(
  engine: SolidRdfEngine,
  testCase: RdfModelBenchmarkCase,
  iterations: number,
): RdfModelRdf3xShadowBenchmarkResult {
  const baseResult = baseRdf3xShadowBenchmarkResult(testCase);
  const unsupportedReason = unsupportedRdf3xPatternReason(testCase.query.pattern);
  if (unsupportedReason) {
    return {
      ...baseResult,
      supported: false,
      unsupportedReason,
      planMatched: false,
      missingPlan: [unsupportedReason],
      matched: false,
      orderedMatch: false,
      diff: {
        missingFromPrimary: [],
        extraInPrimary: [],
      },
      solidRdf: emptySolidRdfBenchmarkSide(engine),
    };
  }

  const solidRdfDurationsMs: number[] = [];
  const rdf3xDurationsMs: number[] = [];
  let solidRdfQuads: Quad[] = [];
  let rdf3xQuads: Quad[] = [];
  let solidRdfMetrics: RdfIndexMetrics | undefined;
  let rdf3xMetrics: Rdf3xIndexMetrics | undefined;

  for (let i = 0; i < iterations; i += 1) {
    let start = Date.now();
    const solidRdfResult = engine.scan(testCase.query);
    solidRdfDurationsMs.push(Math.max(0, Date.now() - start));
    solidRdfQuads = solidRdfResult.quads;
    solidRdfMetrics = solidRdfResult.metrics;

    start = Date.now();
    const rdf3xResult = engine.rdf3xIndex!.scan(rdf3xPatternFor(testCase.query.pattern), testCase.query.options);
    rdf3xDurationsMs.push(Math.max(0, Date.now() - start));
    rdf3xQuads = rdf3xResult.quads;
    rdf3xMetrics = rdf3xResult.metrics;
  }

  const solidRdfKeys = solidRdfQuads.map(canonicalQuadKey);
  const rdf3xKeys = rdf3xQuads.map(canonicalQuadKey);
  const diff = diffQuads(solidRdfQuads, rdf3xQuads);
  const orderedMatch = isSemanticallyOrdered(testCase.query.options)
    ? rdf3xKeys.join('\n') === solidRdfKeys.join('\n')
    : true;
  const finalSolidRdfMetrics = solidRdfMetrics ?? {
    engine: 'solid-rdf',
    indexChoice: 'not-run',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  };
  const finalRdf3xMetrics = rdf3xMetrics ?? {
    engine: 'solid-rdf3x',
    indexChoice: 'none',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  } satisfies Rdf3xIndexMetrics;
  const missingPlan = missingExpectedRdf3xPlan(testCase, finalRdf3xMetrics);
  const planMatched = missingPlan.length === 0;

  return {
    ...baseResult,
    supported: true,
    planMatched,
    missingPlan,
    matched: planMatched && diff.missingFromPrimary.length === 0 && diff.extraInPrimary.length === 0,
    orderedMatch,
    diff,
    solidRdf: {
      ...benchmarkSide(solidRdfKeys, solidRdfDurationsMs),
      ...benchmarkExecution(finalSolidRdfMetrics),
      metrics: finalSolidRdfMetrics,
      indexStats: engine.index.stats(),
    },
    rdf3x: {
      ...benchmarkSide(rdf3xKeys, rdf3xDurationsMs),
      ...rdf3xBenchmarkExecution(finalRdf3xMetrics),
      metrics: finalRdf3xMetrics,
      indexStats: engine.rdf3xIndex!.stats(),
    },
  };
}

function runRdf3xShadowJoinBenchmarkCase(
  engine: SolidRdfEngine,
  testCase: RdfModelQueryBenchmarkCase,
  iterations: number,
): RdfModelRdf3xShadowJoinBenchmarkResult {
  const unsupportedReason = unsupportedRdf3xJoinQueryReason(testCase.query);
  if (unsupportedReason) {
    return {
      ...baseRdf3xShadowJoinBenchmarkResult(testCase),
      supported: false,
      unsupportedReason,
      planMatched: false,
      missingPlan: [unsupportedReason],
      matched: false,
      orderedMatch: false,
      diff: {
        missingFromPrimary: [],
        extraInPrimary: [],
      },
      solidRdf: emptySolidRdfBenchmarkSide(engine),
    };
  }

  const joinShape = rdf3xJoinShapeFor(testCase.query);
  const solidRdfDurationsMs: number[] = [];
  const rdf3xDurationsMs: number[] = [];
  let solidRdfBindings: RdfBindingRow[] = [];
  let rdf3xBindings: RdfBindingRow[] = [];
  let solidRdfMetrics: RdfIndexMetrics | undefined;
  let rdf3xMetrics: Rdf3xJoinMetrics | undefined;

  for (let i = 0; i < iterations; i += 1) {
    let start = Date.now();
    const solidRdfResult = runSolidRdfJoinShape(engine, joinShape);
    solidRdfDurationsMs.push(Math.max(0, Date.now() - start));
    solidRdfBindings = solidRdfResult.bindings;
    solidRdfMetrics = solidRdfResult.metrics;

    start = Date.now();
    const rdf3xResult = runRdf3xJoinShape(engine, joinShape);
    rdf3xDurationsMs.push(Math.max(0, Date.now() - start));
    rdf3xBindings = rdf3xResult.bindings;
    rdf3xMetrics = rdf3xResult.metrics;
  }

  const solidRdfKeys = solidRdfBindings.map(bindingKey);
  const rdf3xKeys = rdf3xBindings.map(bindingKey);
  const diff = diffBindingKeys(solidRdfKeys, rdf3xKeys);
  const orderedMatch = isSemanticallyOrderedRdf3xJoinShape(joinShape)
    ? rdf3xKeys.join('\n') === solidRdfKeys.join('\n')
    : true;
  const finalSolidRdfMetrics = solidRdfMetrics ?? {
    engine: 'solid-rdf',
    indexChoice: 'not-run',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  };
  const finalRdf3xMetrics = rdf3xMetrics ?? {
    engine: 'solid-rdf3x',
    indexChoice: 'none',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  } satisfies Rdf3xJoinMetrics;
  const missingPlan = [
    ...missingExpectedRdf3xJoinPlan(testCase, finalRdf3xMetrics, rdf3xKeys.length),
    ...unresolvedPlanFailures(finalSolidRdfMetrics.queryPlan ?? []).map((label) => `solid-rdf:${label}`),
  ];
  const planMatched = missingPlan.length === 0;

  return {
    ...baseRdf3xShadowJoinBenchmarkResult(testCase),
    supported: true,
    planMatched,
    missingPlan,
    matched: planMatched
      && diff.missingFromPrimary.length === 0
      && diff.extraInPrimary.length === 0,
    orderedMatch,
    diff,
    solidRdf: {
      ...benchmarkSide(solidRdfKeys, solidRdfDurationsMs),
      ...benchmarkExecution(finalSolidRdfMetrics),
      metrics: finalSolidRdfMetrics,
      indexStats: engine.index.stats(),
    },
    rdf3x: {
      ...benchmarkSide(rdf3xKeys, rdf3xDurationsMs),
      ...rdf3xJoinBenchmarkExecution(finalRdf3xMetrics),
      metrics: finalRdf3xMetrics,
      indexStats: engine.rdf3xIndex!.stats(),
    },
  };
}

function runSolidRdfJoinShape(
  engine: SolidRdfEngine,
  shape: Rdf3xJoinBenchmarkShape,
): { bindings: RdfBindingRow[]; metrics: RdfIndexMetrics } {
  switch (shape.kind) {
    case 'join':
      return engine.index.joinPatterns(shape.patterns, shape.options);
    case 'join-count':
      return engine.index.countJoinPatterns(shape.patterns, shape.options);
    case 'join-aggregate':
      return engine.index.aggregateJoinPatterns(shape.patterns, shape.options);
    case 'group-count':
      return engine.index.groupCountJoinPatterns(shape.patterns, shape.options);
    case 'group-aggregate':
      return engine.index.groupAggregateJoinPatterns(shape.patterns, shape.options);
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unsupported RDF-3X benchmark shape: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function runRdf3xJoinShape(
  engine: SolidRdfEngine,
  shape: Rdf3xJoinBenchmarkShape,
): { bindings: RdfBindingRow[]; metrics: Rdf3xJoinMetrics } {
  switch (shape.kind) {
    case 'join':
      return engine.rdf3xIndex!.joinPatterns(shape.patterns, shape.options);
    case 'join-count':
      return engine.rdf3xIndex!.countJoinPatterns(shape.patterns, shape.options);
    case 'join-aggregate':
      return engine.rdf3xIndex!.aggregateJoinPatterns(shape.patterns, shape.options);
    case 'group-count':
      return engine.rdf3xIndex!.groupCountJoinPatterns(shape.patterns, shape.options);
    case 'group-aggregate':
      return engine.rdf3xIndex!.groupAggregateJoinPatterns(shape.patterns, shape.options);
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unsupported RDF-3X benchmark shape: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function baseRdf3xShadowBenchmarkResult(testCase: RdfModelBenchmarkCase): Pick<
  RdfModelRdf3xShadowBenchmarkResult,
  'name' | 'resource' | 'purpose' | 'minScale' | 'query' | 'expectedPlan'
> {
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
  };
}

function emptySolidRdfBenchmarkSide(engine: SolidRdfEngine): RdfModelRdf3xShadowBenchmarkResult['solidRdf'] {
  const metrics: RdfIndexMetrics = {
    engine: 'solid-rdf',
    indexChoice: 'not-run',
    matchedRows: 0,
    returnedRows: 0,
    durationMs: 0,
  };
  return {
    ...benchmarkSide([], []),
    ...benchmarkExecution(metrics),
    metrics,
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

function rdf3xBenchmarkExecution(metrics: Rdf3xIndexMetrics): {
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

function rdf3xJoinBenchmarkExecution(metrics: Rdf3xJoinMetrics): {
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

function baseRdf3xShadowJoinBenchmarkResult(testCase: RdfModelQueryBenchmarkCase): Pick<
  RdfModelRdf3xShadowJoinBenchmarkResult,
  'name' | 'resource' | 'purpose' | 'minScale' | 'query' | 'expectedPlan'
> {
  return {
    name: testCase.name,
    resource: testCase.resource,
    purpose: testCase.purpose,
    minScale: testCase.minScale,
    query: serializeQueryPlan(testCase.query),
    expectedPlan: [...testCase.expectedPlan],
  };
}

function unsupportedRdf3xJoinQueryReason(query: RdfQuery): string | undefined {
  if (query.patterns.length === 0) {
    return 'RDF-3X join shadow requires at least one required BGP pattern';
  }
  if (query.values?.length) {
    return 'RDF-3X join shadow does not support VALUES yet';
  }
  if (query.textSearch?.length || query.vectorSearch?.length) {
    return 'RDF-3X join shadow does not support search sources yet';
  }
  if (query.unions?.length || query.minus?.length || query.exists?.length || query.optional?.length) {
    return 'RDF-3X join shadow only supports required BGP queries';
  }
  if (query.binds?.length) {
    return 'RDF-3X join shadow does not support BIND yet';
  }

  const aggregates = queryAggregates(query);
  const visibleVariables = new Set(query.patterns.flatMap((pattern) => variablesInLocalPattern(pattern)));
  const compiled = rdf3xJoinPatternsFor(query, aggregates);
  if (compiled.unsupportedReason) {
    return compiled.unsupportedReason;
  }
  if ((query.filters?.length ?? 0) > 0 && compiled.pushedFilterIndexes.size < (query.filters?.length ?? 0)) {
    return 'RDF-3X join shadow only supports filters that can be fully pushed into RDF-3X patterns';
  }

  if (aggregates.length > 0) {
    const aggregateReason = unsupportedRdf3xAggregateReason(query, aggregates, visibleVariables);
    if (aggregateReason) {
      return aggregateReason;
    }
  }
  if (aggregates.length === 0 && (query.groupBy?.length ?? 0) > 0) {
    return 'RDF-3X join shadow does not support GROUP BY without aggregates';
  }
  if (aggregates.length === 0 && (query.having?.length ?? 0) > 0) {
    return 'RDF-3X join shadow does not support HAVING without aggregates';
  }
  return undefined;
}

function rdf3xJoinShapeFor(query: RdfQuery): Rdf3xJoinBenchmarkShape {
  const aggregates = queryAggregates(query);
  const compiled = rdf3xJoinPatternsFor(query, aggregates);
  if (!compiled.patterns) {
    throw new Error(compiled.unsupportedReason ?? 'RDF-3X join shadow cannot compile query shape');
  }
  if ((query.groupBy?.length ?? 0) > 0) {
    const aggregateAliases = new Set(aggregates.map((aggregate) => aggregate.as));
    const having = rdf3xGroupAggregateHaving(query.having ?? [], aggregateAliases);
    return {
      kind: aggregates.every((aggregate) => aggregate.type === 'count') ? 'group-count' : 'group-aggregate',
      patterns: compiled.patterns,
      options: {
        groupBy: query.groupBy ?? [],
        aggregates,
        ...(having.length > 0 ? { having } : {}),
        ...(query.orderBy ? { orderBy: query.orderBy } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.offset !== undefined ? { offset: query.offset } : {}),
      },
    };
  }
  if (aggregates.length > 0) {
    return {
      kind: aggregates.every((aggregate) => aggregate.type === 'count') ? 'join-count' : 'join-aggregate',
      patterns: compiled.patterns,
      options: { aggregates },
    };
  }
  return {
    kind: 'join',
    patterns: compiled.patterns,
    options: {
      ...(query.select ? { project: query.select } : {}),
      ...(query.distinct ? { distinct: true } : {}),
      ...(query.orderBy ? { orderBy: query.orderBy } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    },
  };
}

function unsupportedRdf3xAggregateReason(
  query: RdfQuery,
  aggregates: RdfQueryAggregate[],
  visibleVariables: Set<string>,
): string | undefined {
  if ((query.groupBy?.length ?? 0) > 0) {
    if ((query.groupBy ?? []).some((variableName) => !visibleVariables.has(variableName))) {
      return 'RDF-3X join shadow cannot group by variables outside required BGP';
    }
    const aggregateAliases = new Set(aggregates.map((aggregate) => aggregate.as));
    if ((query.orderBy ?? []).some((entry) => !(query.groupBy ?? []).includes(entry.variable) && !aggregateAliases.has(entry.variable))) {
      return 'RDF-3X join shadow cannot order grouped aggregates by unbound variables';
    }
    if (!canCompileRdf3xGroupAggregateHaving(query.having ?? [], aggregateAliases)) {
      return 'RDF-3X join shadow cannot push this grouped HAVING shape';
    }
  } else if ((query.having?.length ?? 0) > 0) {
    return 'RDF-3X join shadow does not support non-grouped HAVING yet';
  } else if (query.orderBy?.length || query.limit !== undefined || query.offset !== undefined || query.distinct) {
    return 'RDF-3X join shadow does not support ORDER/LIMIT/DISTINCT around non-grouped aggregates yet';
  }

  for (const aggregate of aggregates) {
    if (aggregate.variable && !visibleVariables.has(aggregate.variable)) {
      return 'RDF-3X join shadow aggregate variable must be bound by required BGP';
    }
    if (aggregate.type !== 'count' && (!aggregate.variable || aggregate.distinct)) {
      return 'RDF-3X join shadow only supports non-distinct numeric aggregates over bound variables';
    }
  }
  return undefined;
}

function rdf3xJoinPatternsFor(query: RdfQuery, aggregates: RdfQueryAggregate[]): {
  patterns?: RdfQuadJoinPattern[];
  pushedFilterIndexes: Set<number>;
  unsupportedReason?: string;
} {
  const patterns: RdfQuadJoinPattern[] = [];
  const pushedFilterIndexes = new Set<number>();
  const numericAggregateVariables = new Set(aggregates
    .filter((aggregate) => aggregate.type !== 'count')
    .map((aggregate) => aggregate.variable)
    .filter((variableName): variableName is string => Boolean(variableName)));
  for (const pattern of query.patterns) {
    const compiled = rdf3xJoinPatternFor(pattern, query.filters ?? [], numericAggregateVariables);
    const unsupportedPattern = unsupportedRdf3xPatternReason(compiled.pattern);
    if (unsupportedPattern) {
      return {
        pushedFilterIndexes,
        unsupportedReason: unsupportedPattern,
      };
    }
    compiled.pushedFilterIndexes.forEach((index) => pushedFilterIndexes.add(index));
    patterns.push({
      pattern: compiled.pattern,
      variables: compiled.variables,
    });
  }
  return { patterns, pushedFilterIndexes };
}

function rdf3xJoinPatternFor(
  pattern: RdfQueryPattern,
  filters: RdfQueryFilter[],
  numericAggregateVariables: Set<string>,
): RdfQuadJoinPattern & { pushedFilterIndexes: number[] } {
  const compiledPattern: RdfQuadJoinPattern['pattern'] = {};
  const variables: RdfQuadJoinPattern['variables'] = {};
  const pushedFilterIndexes = new Set<number>();
  for (const key of ['graph', 'subject', 'predicate', 'object'] as RdfQueryPatternKey[]) {
    const value = pattern[key];
    if (!value) {
      continue;
    }
    if (isQueryVariable(value)) {
      variables[key] = value.variable;
      const pushdown = rdf3xBenchmarkPushdownFilter(value.variable, filters, numericAggregateVariables);
      if (pushdown) {
        if (pushdown.pattern !== undefined) {
          compiledPattern[key] = pushdown.pattern;
        }
        pushdown.filterIndexes.forEach((index) => pushedFilterIndexes.add(index));
      }
    } else {
      compiledPattern[key] = value;
    }
  }
  return {
    pattern: compiledPattern,
    variables,
    pushedFilterIndexes: [...pushedFilterIndexes],
  };
}

function rdf3xBenchmarkPushdownFilter(
  variableName: string,
  filters: RdfQueryFilter[],
  numericAggregateVariables: Set<string>,
): { pattern?: RdfQuadJoinPattern['pattern'][RdfQueryPatternKey]; filterIndexes: number[] } | undefined {
  const operators: Record<string, unknown> = {};
  const filterIndexes: number[] = [];
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    if (filter.variable !== variableName || filter.variable2 || filter.operand) {
      continue;
    }
    switch (filter.operator) {
      case '$eq':
      case '$sameTerm':
        if (filter.value === undefined || !isTerm(filter.value as any)) {
          return undefined;
        }
        return { pattern: filter.value as Term, filterIndexes: [index] };
      case '$in':
        if (!filter.values?.length || filter.values.some((value) => !isTerm(value as any))) {
          return undefined;
        }
        return { pattern: { $in: filter.values as Term[] }, filterIndexes: [index] };
      case '$notIn':
        if (!filter.values?.length || filter.values.some((value) => !isTerm(value as any))) {
          return undefined;
        }
        return { pattern: { $notIn: filter.values as Term[] }, filterIndexes: [index] };
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (filter.value === undefined) {
          return undefined;
        }
        operators[filter.operator] = filter.value;
        filterIndexes.push(index);
        break;
      case '$termType':
        if (filter.value !== 'numeric' || !numericAggregateVariables.has(variableName)) {
          return undefined;
        }
        filterIndexes.push(index);
        break;
      default:
        return undefined;
    }
  }
  if (Object.keys(operators).length > 0) {
    return { pattern: operators as RdfQuadJoinPattern['pattern'][RdfQueryPatternKey], filterIndexes };
  }
  return filterIndexes.length > 0
    ? { filterIndexes }
    : undefined;
}

function queryAggregates(query: RdfQuery): RdfQueryAggregate[] {
  return query.aggregates && query.aggregates.length > 0
    ? query.aggregates
    : query.aggregate
      ? [query.aggregate]
      : [];
}

function variablesInLocalPattern(pattern: RdfQueryPattern): string[] {
  return ['graph', 'subject', 'predicate', 'object']
    .map((key) => pattern[key as RdfQueryPatternKey])
    .filter(isQueryVariable)
    .map((value) => value.variable);
}

function canCompileRdf3xGroupAggregateHaving(
  having: RdfQueryFilter[],
  aggregateAliases: Set<string>,
): boolean {
  return having.every((filter) => (
    aggregateAliases.has(filter.variable)
      && !filter.operand
      && !filter.variable2
      && filter.value !== undefined
      && isGroupAggregateHavingOperator(filter.operator)
      && numericRangeValue(filter.value) !== undefined
  ));
}

function rdf3xGroupAggregateHaving(
  having: RdfQueryFilter[],
  aggregateAliases: Set<string>,
): RdfQuadJoinGroupAggregateHaving[] {
  return having.map((filter) => {
    const value = filter.value === undefined ? undefined : numericRangeValue(filter.value);
    if (
      !aggregateAliases.has(filter.variable)
        || !isGroupAggregateHavingOperator(filter.operator)
        || value === undefined
    ) {
      throw new Error('RDF-3X join shadow cannot compile grouped HAVING');
    }
    return {
      aggregate: filter.variable,
      operator: filter.operator,
      value,
    };
  });
}

function isGroupAggregateHavingOperator(
  operator: RdfQueryFilter['operator'],
): operator is RdfQuadJoinGroupAggregateHaving['operator'] {
  return operator === '$eq'
    || operator === '$ne'
    || operator === '$gt'
    || operator === '$gte'
    || operator === '$lt'
    || operator === '$lte';
}

function isQueryVariable(value: unknown): value is { variable: string } {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && 'variable' in value
    && typeof (value as { variable?: unknown }).variable === 'string';
}

function unsupportedRdf3xPatternReason(pattern: QuintPattern): string | undefined {
  for (const key of ['graph', 'subject', 'predicate', 'object'] as const) {
    const value = pattern[key];
    if (!value || isTerm(value as any)) {
      continue;
    }
    if (key === 'graph' && isGraphPrefixPattern(value)) {
      continue;
    }
    if (isRdf3xTermInPattern(value)) {
      continue;
    }
    if (isRdf3xTermNotInPattern(value)) {
      continue;
    }
    if (key === 'object' && isSupportedRdf3xObjectOperatorPattern(value)) {
      continue;
    }
    return `unsupported ${key} pattern for RDF-3X shadow`;
  }
  return undefined;
}

function rdf3xPatternFor(pattern: QuintPattern): Rdf3xTriplePattern {
  const result: Rdf3xTriplePattern = {};
  for (const key of ['graph', 'subject', 'predicate', 'object'] as const) {
    const value = pattern[key];
    if (!value) {
      continue;
    }
    if (key === 'graph' && isGraphPrefixPattern(value)) {
      result.graph = { $startsWith: value.$startsWith };
      continue;
    }
    if (isRdf3xTermInPattern(value)) {
      result[key] = value;
      continue;
    }
    if (isRdf3xTermNotInPattern(value)) {
      result[key] = value;
      continue;
    }
    if (key === 'object' && isSupportedRdf3xObjectOperatorPattern(value)) {
      result.object = value;
      continue;
    }
    if (!isTerm(value as any)) {
      throw new Error(`RDF-3X shadow benchmark only supports exact ${key} terms or graph prefixes`);
    }
    result[key] = value as import('@rdfjs/types').Term;
  }
  return result;
}

function isRdf3xTermInPattern(value: unknown): value is Rdf3xTermInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $in?: unknown }).$in)
    && ((value as { $in: unknown[] }).$in).length > 0
    && ((value as { $in: unknown[] }).$in).every((entry) => isTerm(entry as any));
}

function isRdf3xTermNotInPattern(value: unknown): value is Rdf3xTermNotInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $notIn?: unknown }).$notIn)
    && ((value as { $notIn: unknown[] }).$notIn).length > 0
    && ((value as { $notIn: unknown[] }).$notIn).every((entry) => isTerm(entry as any));
}

function isGraphPrefixPattern(value: unknown): value is { $startsWith: string } {
  return value !== null
    && typeof value === 'object'
    && '$startsWith' in value
    && typeof (value as { $startsWith?: unknown }).$startsWith === 'string';
}

function isSupportedRdf3xObjectOperatorPattern(value: unknown): value is Rdf3xObjectOperatorPattern {
  if (value === null || typeof value !== 'object' || 'termType' in value) {
    return false;
  }
  let hasOperator = false;
  for (const operator of ['$gt', '$gte', '$lt', '$lte'] as const) {
    const rangeValue = (value as Rdf3xObjectRangePattern)[operator];
    if (rangeValue === undefined) {
      continue;
    }
    hasOperator = true;
    if (!isSupportedRdf3xObjectRangeValue(rangeValue)) {
      return false;
    }
  }
  for (const operator of ['$contains', '$endsWith'] satisfies Array<keyof Rdf3xObjectTextSearchPattern>) {
    const textValue = (value as Rdf3xObjectTextSearchPattern)[operator];
    if (textValue === undefined) {
      continue;
    }
    hasOperator = true;
    if (typeof textValue !== 'string') {
      return false;
    }
  }
  return hasOperator;
}

function isSupportedRdf3xObjectRangeValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return true;
  }
  return isTerm(value as any);
}

function numericRangeValue(value: Term | string | number | boolean): number | undefined {
  if (typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value.termType !== 'Literal' || !isRdfNumericDatatype(value.datatype.value)) {
    return undefined;
  }
  const parsed = rdfNumericValue(value.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSemanticallyOrdered(options?: QueryOptions): boolean {
  return Boolean(options?.order && options.order.length > 0);
}

function isSemanticallyOrderedRdf3xJoinShape(shape: Rdf3xJoinBenchmarkShape): boolean {
  switch (shape.kind) {
    case 'join':
    case 'group-count':
    case 'group-aggregate':
      return Boolean(shape.options?.orderBy && shape.options.orderBy.length > 0);
    case 'join-count':
    case 'join-aggregate':
      return false;
    default: {
      const exhaustive: never = shape;
      throw new Error(`Unsupported RDF-3X benchmark shape: ${JSON.stringify(exhaustive)}`);
    }
  }
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

function diffBindingKeys(primaryKeys: string[], candidateKeys: string[]): RdfShadowDiff {
  const primarySet = new Set(primaryKeys);
  const candidateSet = new Set(candidateKeys);
  return {
    missingFromPrimary: Array.from(candidateSet).filter((key) => !primarySet.has(key)).sort(),
    extraInPrimary: Array.from(primarySet).filter((key) => !candidateSet.has(key)).sort(),
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
  return [
    ...testCase.expectedPlan.filter((label) => !matchesExpectedPlanLabel(label, testCase, metrics)),
    ...unresolvedPlanFailures(metrics.queryPlan ?? []),
  ];
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

function missingExpectedRdf3xPlan(testCase: RdfModelBenchmarkCase, metrics: Rdf3xIndexMetrics): string[] {
  return [
    ...testCase.expectedPlan.filter((label) => !matchesExpectedRdf3xPlanLabel(label, testCase, metrics)),
    ...unresolvedPlanFailures(metrics.queryPlan ?? []),
  ];
}

function matchesExpectedRdf3xPlanLabel(
  label: string,
  testCase: RdfModelBenchmarkCase,
  metrics: Rdf3xIndexMetrics,
): boolean {
  const pattern = testCase.query.pattern;
  const planText = (metrics.queryPlan ?? []).join('\n');
  switch (label) {
    case 'graph-scope':
      return Boolean(pattern.graph)
        && (metrics.indexChoice === 'source-membership'
          || planText.includes('GraphPrefixMembershipFilter')
          || planText.includes('GraphMembershipFilter'));
    case 'type-filter':
      return isTerm(pattern.predicate as any)
        && termToId(pattern.predicate as any) === RDF_TYPE
        && Boolean(pattern.object)
        && metrics.indexChoice !== 'none';
    case 'predicate-filter':
      return Boolean(pattern.predicate) && metrics.indexChoice !== 'none';
    case 'predicate-object-filter':
      return Boolean(pattern.predicate) && Boolean(pattern.object) && metrics.indexChoice !== 'none';
    case 'predicate-object-range-filter':
      return Boolean(pattern.predicate)
        && (planText.includes('NumericRange(') || planText.includes('LexicalRange('));
    case 'limit':
      return testCase.query.options?.limit !== undefined
        && (planText.includes('Pagination') || planText.includes('LIMIT'));
    case 'order':
      return Boolean(testCase.query.options?.order?.length)
        && (planText.includes('ORDER BY') || planText.includes('Rdf3xJoinOrder('));
    case 'text-index':
      return planText.includes('TextSearch(');
    case 'rdf-subject-join':
      return planText.includes('TextSearch(')
        && metrics.indexChoice !== 'none'
        && metrics.matchedRows >= metrics.returnedRows;
    case 'SPOG':
      return matchesRdf3xPermutation(metrics, 'SPO');
    case 'POSG':
      return matchesRdf3xPermutation(metrics, 'POS');
    case 'OSPG':
      return matchesRdf3xPermutation(metrics, 'OSP');
    case 'GSPO':
      return matchesExpectedRdf3xPlanLabel('graph-scope', testCase, metrics)
        && matchesRdf3xPermutation(metrics, 'SPO');
    case 'GPOS':
      return matchesExpectedRdf3xPlanLabel('graph-scope', testCase, metrics)
        && matchesRdf3xPermutation(metrics, 'POS');
    default:
      return false;
  }
}

function matchesRdf3xPermutation(metrics: Rdf3xIndexMetrics, permutation: Rdf3xPermutationName): boolean {
  const planText = (metrics.queryPlan ?? []).join('\n');
  return metrics.indexChoice === permutation || planText.includes(`Rdf3xPermutationScan(${permutation})`);
}

function missingExpectedQueryPlan(
  testCase: RdfModelQueryBenchmarkCase,
  metrics: RdfQueryMetrics,
  returnedRows: number,
): string[] {
  return [
    ...testCase.expectedPlan.filter((label) => !matchesExpectedQueryPlanLabel(label, metrics)),
    ...unresolvedPlanFailures(metrics.plan),
    ...minimumReturnedRowsFailures(testCase, returnedRows),
  ];
}

function unresolvedPlanFailures(plan: readonly string[]): string[] {
  return hasUnresolvedPlan(plan) ? ['resolved-terms'] : [];
}

function hasUnresolvedPlan(plan: readonly string[]): boolean {
  return plan.some((entry) => /\bunresolved\b/i.test(entry));
}

function minimumReturnedRowsFailures(
  testCase: RdfModelQueryBenchmarkCase,
  returnedRows: number,
): string[] {
  const minimum = testCase.minReturnedRows ?? 0;
  return returnedRows >= minimum ? [] : [`min-rows:${minimum}`];
}

function matchesExpectedQueryPlanLabel(label: string, metrics: RdfQueryMetrics): boolean {
  const planText = metrics.plan.join('\n');
  switch (label) {
    case 'group-count-index':
      return planText.includes('Aggregate(group-count-index)');
    case 'group-aggregate-index':
      return planText.includes('Aggregate(group-basic-multi-index)')
        || planText.includes('Aggregate(group-basic-index)');
    case 'having-pushdown':
      return (planText.includes('IndexGroupCountHaving(')
        || planText.includes('IndexGroupAggregateHaving('))
        && !planText.includes('\nHaving(');
    case 'order':
      return (planText.includes('IndexGroupCountOrder(')
        || planText.includes('IndexGroupAggregateOrder('))
        && !planText.includes('\nSort');
    case 'limit':
      return (planText.includes('IndexGroupCountLimit')
        || planText.includes('IndexGroupAggregateLimit'))
        && !planText.includes('\nLimit');
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

function missingExpectedRdf3xJoinPlan(
  testCase: RdfModelQueryBenchmarkCase,
  metrics: Rdf3xJoinMetrics,
  returnedRows: number,
): string[] {
  return [
    ...testCase.expectedPlan.filter((label) => !matchesExpectedRdf3xJoinPlanLabel(label, metrics)),
    ...unresolvedPlanFailures(metrics.queryPlan ?? []),
    ...minimumReturnedRowsFailures(testCase, returnedRows),
  ];
}

function matchesExpectedRdf3xJoinPlanLabel(label: string, metrics: Rdf3xJoinMetrics): boolean {
  const planText = (metrics.queryPlan ?? []).join('\n');
  switch (label) {
    case 'group-count-index':
      return planText.includes('Rdf3xJoinGroupCount(');
    case 'group-aggregate-index':
      return planText.includes('Rdf3xJoinGroupAggregate(')
        || planText.includes('Rdf3xJoinGroupAggregateNumeric(');
    case 'having-pushdown':
      return planText.includes('Rdf3xJoinGroupCountHaving(')
        || planText.includes('Rdf3xJoinGroupAggregateHaving(');
    case 'order':
      return planText.includes('Rdf3xJoinGroupCountOrder(')
        || planText.includes('Rdf3xJoinGroupAggregateOrder(');
    case 'limit':
      return planText.includes('Rdf3xJoinGroupCountLimit')
        || planText.includes('Rdf3xJoinGroupAggregateLimit');
    case 'join-index':
      return planText.includes('Rdf3xJoinBGP(');
    case 'join-order-pushdown':
      return planText.includes('Rdf3xJoinOrder(');
    case 'join-limit-pushdown':
      return planText.includes('Rdf3xJoinLimit');
    case 'range-filter-pushdown':
      return planText.includes('LexicalRange(') || planText.includes('NumericRange(');
    case 'join-count-index':
      return planText.includes('Rdf3xJoinCount(');
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

function serializeQueryPlan(query: RdfQuery): JsonPattern {
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
