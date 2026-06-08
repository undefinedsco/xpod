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
  RdfDerivedIndexRefreshResult,
  RdfEngineLike,
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
  RdfTextChunkInput,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
  RdfShadowDiff,
} from './types';
import { canonicalQuadKey, diffQuads } from './RdfShadowComparator';
import type { SolidRdfEngine } from './SolidRdfEngine';
import { isRdfNumericDatatype, rdfNumericValue } from './RdfTermSemantics';

const { namedNode, literal, quad } = DataFactory;

export type RdfBenchmarkScale = 'small' | 'medium' | 'large';
export type RdfBenchmarkCaseProfile = 'default' | 'extreme' | 'fusion' | 'all';

export const RDF_MODELS_SYNTHETIC_MESSAGE_QUADS = 9;
export const RDF_MODELS_NATIVE_STRESS_MESSAGE_QUADS = 9;
export const RDF_MODELS_NATIVE_STRESS_MESSAGE_COUNT = 1024;

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
  benchmarkCache?: 'bypass' | 'preserve';
  minWarmupIterations?: number;
  query: RdfQuery;
  expectedPlan: string[];
}

export interface RdfModelBenchmarkRunOptions {
  cases?: readonly RdfModelBenchmarkCase[];
  queryCases?: readonly RdfModelQueryBenchmarkCase[];
  caseProfile?: RdfBenchmarkCaseProfile;
  scale?: RdfBenchmarkScale;
  iterations?: number;
}

export interface RdfModelPostgresBenchmarkRunOptions extends RdfModelBenchmarkRunOptions {
  refreshDerivedIndexes?: boolean;
  warmupIterations?: number;
  concurrency?: number;
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
  caseProfile: RdfBenchmarkCaseProfile;
  iterations: number;
  generatedAt: string;
  planMatched: boolean;
  failedPlanCases: string[];
  storage: RdfEngineStorageStats;
  cases: RdfModelBenchmarkResult[];
  queryCases: RdfModelQueryBenchmarkResult[];
}

export interface RdfModelPostgresBenchmarkReport {
  engine: 'postgres-rdf';
  scale: RdfBenchmarkScale;
  caseProfile: RdfBenchmarkCaseProfile;
  iterations: number;
  warmupIterations: number;
  concurrency: number;
  generatedAt: string;
  planMatched: boolean;
  failedPlanCases: string[];
  concurrencyGate: RdfModelPostgresConcurrencyGate;
  refresh?: RdfDerivedIndexRefreshResult;
  storage: RdfEngineStorageStats;
  cases: RdfModelBenchmarkResult[];
  queryCases: RdfModelQueryBenchmarkResult[];
}

export interface RdfModelPostgresConcurrencyGate {
  enabled: boolean;
  concurrency: number;
  cases: RdfModelPostgresConcurrencyGateCase[];
  matched: boolean;
  failedCases: string[];
}

export interface RdfModelPostgresConcurrencyGateCase {
  name: string;
  concurrency: number;
  iterationsPerLane: number;
  matched: boolean;
  planMatched: boolean;
  expectedReturnedRows: number;
  returnedRows: number[];
  expectedChecksum: string;
  checksums: string[];
  expectedOrderedChecksum: string;
  orderedChecksums: string[];
  missingPlan: string[];
  durationsMs: number[];
  p50DurationMs: number;
  p95DurationMs: number;
}

export interface RdfModelsBenchmarkSeedOptions {
  syntheticMessages: number;
  syntheticPodCount: number;
  caseProfile?: RdfBenchmarkCaseProfile;
}

interface RdfModelsSearchFusionSource {
  source: string;
  localPath: string;
  content: string;
  embedding: number[];
  heading: string;
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
  caseProfile: RdfBenchmarkCaseProfile;
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
  caseProfile: RdfBenchmarkCaseProfile;
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

export const RDF_MODELS_BENCHMARK_POD = 'https://pod.example/alice';
const DATA = `${RDF_MODELS_BENCHMARK_POD}/.data`;
const NATIVE_STRESS_GRAPH = `${DATA}/chat/default/2026/05/18/native-stress.ttl`;
const SETTINGS = `${RDF_MODELS_BENCHMARK_POD}/settings`;
const WORKSPACE = 'file://macbook.local/Users/alice/project/';
const RDF_MODELS_SEARCH_VECTOR_MODEL = 'xpod-benchmark-embedding-v1';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const DCT_MODIFIED = 'http://purl.org/dc/terms/modified';
const DCT_DESCRIPTION = 'http://purl.org/dc/terms/description';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const DCT_TYPE = 'http://purl.org/dc/terms/type';
const DCT_CREATOR = 'http://purl.org/dc/terms/creator';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const SIOC_HAS_CONTAINER = 'http://rdfs.org/sioc/ns#has_container';
const SIOC_HAS_PARENT = 'http://rdfs.org/sioc/ns#has_parent';
const UDFS = 'https://undefineds.co/ns#';
const XPOD_AI = 'https://vocab.xpod.dev/ai#';
const XPOD_CREDENTIAL = 'https://vocab.xpod.dev/credential#';
const MEETING = 'http://www.w3.org/ns/pim/meeting#';
const SIOC = 'http://rdfs.org/sioc/ns#';
const WF_MESSAGE = 'http://www.w3.org/2005/01/wf/flow-1.0#message';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const FOAF_PERSON = 'http://xmlns.com/foaf/0.1/Person';
const FOAF_MAKER = 'http://xmlns.com/foaf/0.1/maker';
const FOAF_PRIMARY_TOPIC = 'http://xmlns.com/foaf/0.1/primaryTopic';
const VCARD_INDIVIDUAL = 'http://www.w3.org/2006/vcard/ns#Individual';
const VCARD_FN = 'http://www.w3.org/2006/vcard/ns#fn';
const LDP_INBOX = 'http://www.w3.org/ns/ldp#inbox';
const SCHEMA_PROPERTY_VALUE = 'http://schema.org/PropertyValue';
const SCHEMA_CREATIVE_WORK = 'http://schema.org/CreativeWork';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DECIMAL = 'http://www.w3.org/2001/XMLSchema#decimal';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';
const AS = 'https://www.w3.org/ns/activitystreams#';
const ODRL = 'http://www.w3.org/ns/odrl/2/';
const RDF_MODELS_SYNTHETIC_THREAD_COUNT = 64;
const PERFORMANCE_P95_MIN_ABSOLUTE_HEADROOM_MS = 25;
const PERFORMANCE_P95_MAX_RATIO = 8;
const POSTGRES_CONCURRENCY_GATE_QUERY_CASE_NAMES = [
  'modeled thread message page query',
  'scheduled task trigger keyset continuation query',
  'settings owner category keyset query',
  'provider model credential ordered join query',
] as const;

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
    name: 'threads by modeled chat relation',
    resource: 'thread',
    purpose: 'thread.chat relation follows the models SIOC has_parent predicate, not a product-local chatId field',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(SIOC_HAS_PARENT),
        object: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#this'),
        graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
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
    name: 'messages by modeled thread relation',
    resource: 'message',
    purpose: 'message.thread relation follows the models SIOC has_container predicate',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(SIOC_HAS_CONTAINER),
        object: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'chat latest message pointer',
    resource: 'chat',
    purpose: 'chat list hydration can resolve the latest-message URI stored on the Chat resource',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}lastMessage`),
        graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
      },
      options: { order: ['subject'], limit: 20 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'limit'],
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
    name: 'cron tasks due time',
    resource: 'task',
    purpose: 'task scheduler can poll active cron/interval tasks directly from the Task model fields',
    minScale: 'small',
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
    name: 'waiting input runs',
    resource: 'run',
    purpose: 'runtime steering can find runs parked for approval or client tool output',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}status`),
        object: literal('waiting_input'),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'runs by lease owner',
    resource: 'run',
    purpose: 'distributed workers can look up currently leased runs without scanning all runtime facts',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}leaseOwner`),
        object: literal('worker-1'),
        graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
      },
      options: { order: ['subject'], limit: 100 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
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
    name: 'load webid profile',
    resource: 'profile',
    purpose: 'WebID profile lookup must stay graph-scoped for profile/card reads',
    minScale: 'medium',
    query: {
      pattern: {
        subject: namedNode('https://pod.example/alice/profile/card#me'),
        predicate: namedNode(RDF_TYPE),
        object: namedNode(FOAF_PERSON),
        graph: namedNode('https://pod.example/alice/profile/card'),
      },
    },
    expectedPlan: ['graph-scope', 'type-filter'],
  },
  {
    name: 'profile public read acl',
    resource: 'acl',
    purpose: 'WebACL profile/card public read authorization lookup stays on graph + predicate/object filters',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${ACL}mode`),
        object: namedNode(`${ACL}Read`),
        graph: namedNode('https://pod.example/alice/profile/card.acl'),
      },
      options: { order: ['subject'], limit: 20 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'profile public read acr',
    resource: 'acr',
    purpose: 'ACP profile access-control relation lookup stays graph-scoped when cloud defaults to ACR',
    minScale: 'medium',
    query: {
      pattern: {
        subject: namedNode('https://pod.example/alice/profile/card'),
        predicate: namedNode(`${ACP}accessControl`),
        graph: namedNode('https://pod.example/alice/profile/.acr'),
      },
      options: { order: ['object'], limit: 20 },
    },
    expectedPlan: ['graph-scope', 'predicate-filter', 'limit'],
  },
  {
    name: 'list issues',
    resource: 'issue',
    purpose: 'shared issue resource list under the models issue base',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${UDFS}Issue`),
        graph: { $startsWith: 'https://pod.example/alice/.data/issues/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'pending approvals',
    resource: 'approval',
    purpose: 'approval request queue lookup by status under date-bucketed approval documents',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}status`),
        object: literal('pending'),
        graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'active autonomy grants',
    resource: 'grant',
    purpose: 'autonomy grant policy lookup by ODRL action under settings/autonomy',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${ODRL}action`),
        object: namedNode(`${UDFS}runTool`),
        graph: { $startsWith: 'https://pod.example/alice/settings/autonomy/grants/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'list inbox notifications',
    resource: 'inboxNotification',
    purpose: 'Solid inbox activity list uses graph-scoped type lookup rather than a pod-wide scan',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${AS}Activity`),
        graph: { $startsWith: 'https://pod.example/alice/inbox/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list providers',
    resource: 'aiProvider',
    purpose: 'AI provider settings list and provider/model relation baseline',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${XPOD_AI}Provider`),
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
        predicate: namedNode(`${XPOD_AI}isProvidedBy`),
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
        predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
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
  {
    name: 'list sessions',
    resource: 'session',
    purpose: 'runtime session list under the shared models session resource base',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${UDFS}Session`),
        graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'active sessions',
    resource: 'session',
    purpose: 'session manager active-session lookup by lifecycle status',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}sessionStatus`),
        object: literal('active'),
        graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'audit entries by actor',
    resource: 'audit',
    purpose: 'audit trail lookup by WebID actor under date-bucketed audit documents',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}actor`),
        object: namedNode('https://pod.example/alice/profile/card#me'),
        graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'list ai configs',
    resource: 'aiConfig',
    purpose: 'AI runtime singleton settings lookup under /settings/ai/config.ttl',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(`${XPOD_AI}AIConfig`),
        graph: namedNode('https://pod.example/alice/settings/ai/config.ttl'),
      },
      options: { order: ['subject'], limit: 20 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'list settings',
    resource: 'settings',
    purpose: 'settings resource list under /settings uses schema:PropertyValue with graph scoping',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(RDF_TYPE),
        object: namedNode(SCHEMA_PROPERTY_VALUE),
        graph: { $startsWith: 'https://pod.example/alice/settings/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'type-filter', 'limit'],
  },
  {
    name: 'sensitive settings',
    resource: 'settings',
    purpose: 'settings sensitivity flag uses the shared model predicate and stays exact-literal scoped',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}status`),
        object: literal('true', namedNode(XSD_BOOLEAN)),
        graph: { $startsWith: 'https://pod.example/alice/settings/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'active vector stores',
    resource: 'vectorStore',
    purpose: 'vector store registry lookup by active status',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${XPOD_AI}status`),
        object: literal('active'),
        graph: namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl'),
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'indexed files by status',
    resource: 'indexedFile',
    purpose: 'indexed-file registry lookup by indexing status',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${XPOD_AI}status`),
        object: literal('indexed'),
        graph: namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl'),
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'running agent statuses',
    resource: 'agentStatus',
    purpose: 'agent runtime status lookup by running state',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${XPOD_AI}status`),
        object: literal('running'),
        graph: namedNode('https://pod.example/alice/settings/ai/agent-status.ttl'),
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'oauth credentials expiring',
    resource: 'credential',
    purpose: 'OAuth credential rotation can find active tokens nearing expiry from the shared credential model',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${XPOD_CREDENTIAL}oauthExpiresAt`),
        object: { $lte: literal('2026-05-19T00:00:00.000Z') },
        graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
      },
      options: { order: ['object'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-range-filter', 'order', 'limit'],
  },
  {
    name: 'reply messages',
    resource: 'message',
    purpose: 'message reply chains use the semantic replyTo relation rather than local message ids',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}replyTo`),
        object: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
  },
  {
    name: 'routed messages by target agent',
    resource: 'message',
    purpose: 'multi-agent routing can locate messages assigned to an agent without scanning message content',
    minScale: 'small',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}routeTargetAgentId`),
        object: literal('secretary'),
        graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
      },
      options: { order: ['subject'], limit: 50 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-filter', 'limit'],
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
    name: 'thread message keyset page query',
    resource: 'message',
    purpose: 'date-bucketed message timeline keeps keyset cursor range, ordering, and pagination inside SQL self-join',
    minScale: 'small',
    minReturnedRows: 2,
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
      filters: [
        {
          variable: 'createdAt',
          operator: '$lt',
          value: literal('2026-05-18T01:04:03.000Z'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 2,
    },
    expectedPlan: ['join-index', 'range-filter-pushdown', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'thread context window query',
    resource: 'message',
    purpose: 'agent context assembly keeps message type/thread/created/score star join and pagination inside SQL',
    minScale: 'small',
    minReturnedRows: 2,
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
          object: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/' },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
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
      select: ['message', 'createdAt', 'score'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'modeled thread message page query',
    resource: 'message',
    purpose: 'message pagination follows the models message.thread SIOC has_container relation',
    minScale: 'small',
    minReturnedRows: 2,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_CONTAINER),
          object: namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}messageStatus`),
          object: literal('completed'),
        },
      ],
      select: ['message', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'chat latest message hydration query',
    resource: 'chat',
    purpose: 'chat list hydration joins Chat latest-message pointer to message content and status',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'chat' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}LongChat`),
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'chat' },
          predicate: namedNode(`${UDFS}lastMessage`),
          object: { variable: 'message' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_CONTENT),
          object: { variable: 'content' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}messageStatus`),
          object: literal('completed'),
        },
      ],
      select: ['chat', 'message', 'content'],
      limit: 10,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'thread chat hydration query',
    resource: 'thread',
    purpose: 'thread list joins the models thread.chat SIOC has_parent relation back to Chat metadata',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'thread' },
          predicate: namedNode(SIOC_HAS_PARENT),
          object: { variable: 'chat' },
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'thread' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('active'),
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'chat' },
          predicate: namedNode(DCT_TITLE),
          object: { variable: 'title' },
        },
      ],
      select: ['thread', 'chat', 'title'],
      orderBy: [
        {
          variable: 'thread',
          direction: 'asc',
        },
      ],
      limit: 20,
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
    name: 'task run execution detail query',
    resource: 'run',
    purpose: 'task detail hydration joins Task, Run, Thread, and RunStep facts without falling back to per-resource scans',
    minScale: 'small',
    minReturnedRows: 2,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Task`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Run`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}task`),
          object: { variable: 'task' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}inThread`),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
          subject: { variable: 'step' },
          predicate: namedNode(`${UDFS}run`),
          object: { variable: 'run' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/2026/05/' },
          subject: { variable: 'step' },
          predicate: namedNode(`${UDFS}status`),
          object: { variable: 'stepType' },
        },
      ],
      select: ['task', 'run', 'thread', 'step', 'stepType'],
      orderBy: [
        {
          variable: 'step',
          direction: 'asc',
        },
      ],
      limit: 10,
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
    name: 'scheduled task trigger query',
    resource: 'task',
    purpose: 'task scheduler joins trigger kind, active status, workspace, and nextRunAt from Task facts',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Task`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('active'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}triggerKind`),
          object: literal('cron'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode(WORKSPACE),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
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
      select: ['task', 'nextRunAt'],
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
    name: 'scheduled task trigger keyset continuation query',
    resource: 'task',
    purpose: 'task scheduler keyset continuation keeps cursor range, ordering, and pagination inside SQL self-join',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Task`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('active'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode(WORKSPACE),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/' },
          subject: { variable: 'task' },
          predicate: namedNode(`${UDFS}nextRunAt`),
          object: { variable: 'nextRunAt' },
        },
      ],
      filters: [
        {
          variable: 'nextRunAt',
          operator: '$gt',
          value: literal('2026-05-18T00:30:00.000Z'),
        },
        {
          variable: 'nextRunAt',
          operator: '$lte',
          value: literal('2026-05-18T01:30:00.000Z'),
        },
      ],
      select: ['task', 'nextRunAt'],
      orderBy: [
        {
          variable: 'nextRunAt',
          direction: 'asc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['join-index', 'range-filter-pushdown', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'leased running run query',
    resource: 'run',
    purpose: 'run recovery joins running status with worker lease and heartbeat metadata',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('running'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}leaseOwner`),
          object: literal('worker-1'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}leaseExpiresAt`),
          object: { variable: 'leaseExpiresAt' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/task/default/' },
          subject: { variable: 'run' },
          predicate: namedNode(`${UDFS}heartbeatAt`),
          object: { variable: 'heartbeatAt' },
        },
      ],
      select: ['run', 'leaseExpiresAt', 'heartbeatAt'],
      orderBy: [
        {
          variable: 'heartbeatAt',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'provider model credential join query',
    resource: 'aiProvider',
    purpose: 'provider/model/credential relation join can stay on the PostgreSQL RDF-3X join path',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      select: ['model', 'credential'],
    },
    expectedPlan: ['join-index'],
  },
  {
    name: 'provider model credential VALUES join query',
    resource: 'aiProvider',
    purpose: 'VALUES-constrained provider/model/credential relation join can stay on the RDF-3X values join path',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      values: [
        {
          variables: ['provider'],
          rows: [
            {
              provider: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
            },
          ],
        },
      ],
      select: ['model', 'credential'],
    },
    expectedPlan: ['join-index', 'values-join-pushdown'],
  },
  {
    name: 'provider model credential ordered join query',
    resource: 'aiProvider',
    purpose: 'PostgreSQL RDF-3X joins keep hidden ordering variables for paginated settings lists',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      select: ['model', 'credential'],
      orderBy: [
        {
          variable: 'provider',
          direction: 'asc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'ai credential selection query',
    resource: 'credential',
    purpose: 'shared models credential selection joins active AI credentials with provider default model metadata',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'provider' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${XPOD_AI}Provider`),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'provider' },
          predicate: namedNode(`${XPOD_AI}defaultModel`),
          object: { variable: 'model' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}status`),
          object: literal('active'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}service`),
          object: literal('ai'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}status`),
          object: literal('active'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}isDefault`),
          object: literal('true', namedNode(XSD_BOOLEAN)),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}apiKey`),
          object: { variable: 'apiKey' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}failCount`),
          object: { variable: 'failCount' },
        },
      ],
      select: ['provider', 'model', 'credential', 'apiKey', 'failCount'],
      orderBy: [
        {
          variable: 'failCount',
          direction: 'asc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'provider model credential count query',
    resource: 'aiProvider',
    purpose: 'count aggregate can stay inside the PostgreSQL RDF-3X count path',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      aggregates: [
        {
          type: 'count',
          as: 'credentialCount',
          variable: 'credential',
        },
        {
          type: 'count',
          as: 'providerCount',
          variable: 'provider',
          distinct: true,
        },
      ],
      select: ['credentialCount', 'providerCount'],
    },
    expectedPlan: ['join-count-index'],
  },
  {
    name: 'provider credential grouped count query',
    resource: 'aiProvider',
    purpose: 'grouped count aggregate can stay inside the PostgreSQL RDF-3X group count path',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      groupBy: ['provider'],
      aggregates: [
        {
          type: 'count',
          as: 'credentialCount',
          variable: 'credential',
        },
      ],
      having: [
        {
          variable: 'credentialCount',
          operator: '$gt',
          value: literal('0', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
      select: ['provider', 'credentialCount'],
      orderBy: [
        {
          variable: 'credentialCount',
          direction: 'desc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['group-count-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'provider credential single-pattern grouped count query',
    resource: 'credential',
    purpose: 'single-pattern exact graph grouped count aggregate can stay inside the PostgreSQL RDF-3X group count path',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
      ],
      groupBy: ['provider'],
      aggregates: [
        {
          type: 'count',
          as: 'credentialCount',
          variable: 'credential',
        },
      ],
      having: [
        {
          variable: 'credentialCount',
          operator: '$gt',
          value: literal('0', namedNode('http://www.w3.org/2001/XMLSchema#integer')),
        },
      ],
      select: ['provider', 'credentialCount'],
      orderBy: [
        {
          variable: 'credentialCount',
          direction: 'desc',
        },
      ],
      limit: 1,
    },
    expectedPlan: ['group-count-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'provider credential fail count aggregate query',
    resource: 'aiProvider',
    purpose: 'small grouped numeric aggregate over credential failCount can cut over from RDF-3X to facts by cost',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}provider`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}failCount`),
          object: { variable: 'failCount' },
        },
      ],
      groupBy: ['provider'],
      aggregates: [
        {
          type: 'count',
          as: 'credentialCount',
          variable: 'credential',
        },
        {
          type: 'sum',
          as: 'failCountTotal',
          variable: 'failCount',
        },
      ],
      select: ['provider', 'credentialCount', 'failCountTotal'],
    },
    expectedPlan: ['numeric-aggregate'],
  },
  {
    name: 'oauth credential expiry query',
    resource: 'credential',
    purpose: 'credential refresh jobs join service/status/token expiry fields without scanning non-OAuth credentials',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}service`),
          object: literal('github'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}status`),
          object: literal('active'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/credentials.ttl'),
          subject: { variable: 'credential' },
          predicate: namedNode(`${XPOD_CREDENTIAL}oauthExpiresAt`),
          object: { variable: 'expiresAt' },
        },
      ],
      filters: [
        {
          variable: 'expiresAt',
          operator: '$lte',
          value: literal('2026-05-19T00:00:00.000Z'),
        },
      ],
      select: ['credential', 'expiresAt'],
      orderBy: [
        {
          variable: 'expiresAt',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'range-filter-pushdown', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'profile acl authorization join query',
    resource: 'acl',
    purpose: 'WebACL authorization lookup joins access target and mode inside the ACL graph',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/profile/card.acl'),
          subject: { variable: 'authorization' },
          predicate: namedNode(`${ACL}accessTo`),
          object: namedNode('https://pod.example/alice/profile/card'),
        },
        {
          graph: namedNode('https://pod.example/alice/profile/card.acl'),
          subject: { variable: 'authorization' },
          predicate: namedNode(`${ACL}mode`),
          object: namedNode(`${ACL}Read`),
        },
      ],
      select: ['authorization'],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'profile acr authorization join query',
    resource: 'acr',
    purpose: 'ACP access-control lookup joins resource, control node, target, and mode inside the ACR graph',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/profile/.acr'),
          subject: namedNode('https://pod.example/alice/profile/card'),
          predicate: namedNode(`${ACP}accessControl`),
          object: { variable: 'accessControl' },
        },
        {
          graph: namedNode('https://pod.example/alice/profile/.acr'),
          subject: { variable: 'accessControl' },
          predicate: namedNode(`${ACP}apply`),
          object: namedNode('https://pod.example/alice/profile/card'),
        },
        {
          graph: namedNode('https://pod.example/alice/profile/.acr'),
          subject: { variable: 'accessControl' },
          predicate: namedNode(`${ACP}allow`),
          object: namedNode(`${ACP}Read`),
        },
      ],
      select: ['accessControl'],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'profile inbox activity join query',
    resource: 'inboxNotification',
    purpose: 'WebID inbox lookup joins profile inbox relation with ActivityStreams inbox notification facts',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/profile/card'),
          subject: namedNode('https://pod.example/alice/profile/card#me'),
          predicate: namedNode(LDP_INBOX),
          object: { variable: 'inbox' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/inbox/' },
          subject: { variable: 'notification' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${AS}Activity`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/inbox/' },
          subject: { variable: 'notification' },
          predicate: namedNode(`${AS}actor`),
          object: namedNode('https://pod.example/alice/profile/card#me'),
        },
      ],
      select: ['notification', 'inbox'],
      orderBy: [{ variable: 'notification' }],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'approval grant action match query',
    resource: 'approval',
    purpose: 'approval queue joins pending requests to matching autonomy grants by target workspace and action',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
          subject: { variable: 'approval' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}ApprovalRequest`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
          subject: { variable: 'approval' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('pending'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
          subject: { variable: 'approval' },
          predicate: namedNode(`${ODRL}target`),
          object: { variable: 'workspace' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
          subject: { variable: 'approval' },
          predicate: namedNode(`${ODRL}action`),
          object: { variable: 'action' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/autonomy/grants/' },
          subject: { variable: 'grant' },
          predicate: namedNode(`${ODRL}target`),
          object: { variable: 'workspace' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/autonomy/grants/' },
          subject: { variable: 'grant' },
          predicate: namedNode(`${ODRL}action`),
          object: { variable: 'action' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/autonomy/grants/' },
          subject: { variable: 'grant' },
          predicate: namedNode(`${UDFS}effect`),
          object: literal('allow'),
        },
      ],
      select: ['approval', 'grant', 'workspace', 'action'],
      orderBy: [
        {
          variable: 'approval',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'favorite target chat join query',
    resource: 'favorite',
    purpose: 'favorite list joins model favorite target URI back to the chat resource for display hydration',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/favorites/' },
          subject: { variable: 'favorite' },
          predicate: namedNode(`${UDFS}favoriteTarget`),
          object: { variable: 'chat' },
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'chat' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}LongChat`),
        },
      ],
      select: ['favorite', 'chat'],
      orderBy: [{ variable: 'favorite' }],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'contact entity profile join query',
    resource: 'contact',
    purpose: 'contact list joins vCard contact records to their represented entity URI',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/contacts/' },
          subject: { variable: 'contact' },
          predicate: namedNode(FOAF_PRIMARY_TOPIC),
          object: { variable: 'entity' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/agents/' },
          subject: { variable: 'entity' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(FOAF_AGENT),
        },
      ],
      select: ['contact', 'entity'],
      orderBy: [{ variable: 'contact' }],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'settings owner category query',
    resource: 'settings',
    purpose: 'settings screens join owner/category/key/value fields under /settings without a full Pod scan',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(SCHEMA_PROPERTY_VALUE),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(DCT_CREATOR),
          object: namedNode('https://pod.example/alice/profile/card#me'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(DCT_TYPE),
          object: literal('ai'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(`${UDFS}settingKey`),
          object: { variable: 'key' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(`${UDFS}settingValue`),
          object: { variable: 'value' },
        },
      ],
      select: ['setting', 'key', 'value'],
      orderBy: [
        {
          variable: 'key',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'settings owner category keyset query',
    resource: 'settings',
    purpose: 'settings screens keep key cursor, ordering, and pagination inside SQL self-join',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(SCHEMA_PROPERTY_VALUE),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(DCT_CREATOR),
          object: namedNode('https://pod.example/alice/profile/card#me'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(DCT_TYPE),
          object: literal('ai'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(`${UDFS}settingKey`),
          object: { variable: 'key' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/' },
          subject: { variable: 'setting' },
          predicate: namedNode(`${UDFS}settingValue`),
          object: { variable: 'value' },
        },
      ],
      filters: [
        {
          variable: 'key',
          operator: '$gt',
          value: literal('ai.defaultAssistant'),
        },
      ],
      select: ['setting', 'key', 'value'],
      orderBy: [
        {
          variable: 'key',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'range-filter-pushdown', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'active session thread hydration query',
    resource: 'session',
    purpose: 'session manager hydrates active session, chat, thread, and token usage without pod-wide scans',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}Session`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(`${UDFS}actor`),
          object: namedNode('https://pod.example/alice/profile/card#me'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(`${UDFS}sessionStatus`),
          object: literal('active'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(`${UDFS}conversation`),
          object: { variable: 'chat' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(`${UDFS}inThread`),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/sessions/' },
          subject: { variable: 'session' },
          predicate: namedNode(`${UDFS}tokenUsage`),
          object: { variable: 'tokenUsage' },
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'chat' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}LongChat`),
        },
        {
          graph: namedNode('https://pod.example/alice/.data/chat/default/index.ttl'),
          subject: { variable: 'thread' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${SIOC}Thread`),
        },
      ],
      filters: [
        {
          variable: 'tokenUsage',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      select: ['session', 'chat', 'thread', 'tokenUsage'],
      orderBy: [
        {
          variable: 'tokenUsage',
          direction: 'desc',
        },
      ],
      limit: 5,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'message reply chain query',
    resource: 'message',
    purpose: 'message detail views join replyTo and content facts across messages in the same date bucket',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'reply' },
          predicate: namedNode(`${UDFS}replyTo`),
          object: { variable: 'parent' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'reply' },
          predicate: namedNode(SIOC_CONTENT),
          object: { variable: 'replyContent' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'parent' },
          predicate: namedNode(SIOC_CONTENT),
          object: { variable: 'parentContent' },
        },
      ],
      select: ['reply', 'parent', 'replyContent', 'parentContent'],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'routed message agent query',
    resource: 'message',
    purpose: 'multi-agent coordination joins routed messages to their agent/contact index',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}routeTargetAgentId`),
          object: literal('secretary'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}coordinationId`),
          object: { variable: 'coordination' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(FOAF_MAKER),
          object: { variable: 'maker' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/agents/' },
          subject: { variable: 'maker' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(FOAF_AGENT),
        },
      ],
      select: ['message', 'maker', 'coordination'],
      orderBy: [
        {
          variable: 'message',
          direction: 'asc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'audit approval policy trace query',
    resource: 'audit',
    purpose: 'audit timeline joins actor/session approval and grant policy relations for supervision views',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${UDFS}AuditEntry`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(`${UDFS}actor`),
          object: namedNode('https://pod.example/alice/profile/card#me'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(`${UDFS}session`),
          object: { variable: 'session' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(`${UDFS}approval`),
          object: { variable: 'approval' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(`${UDFS}policy`),
          object: { variable: 'grant' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/audits/' },
          subject: { variable: 'audit' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/approvals/' },
          subject: { variable: 'approval' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('pending'),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/settings/autonomy/grants/' },
          subject: { variable: 'grant' },
          predicate: namedNode(`${UDFS}effect`),
          object: literal('allow'),
        },
      ],
      select: ['audit', 'session', 'approval', 'grant', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'ai config embedding model query',
    resource: 'aiConfig',
    purpose: 'AI runtime config joins embedding model selection back to provider model metadata',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/ai/config.ttl'),
          subject: { variable: 'config' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${XPOD_AI}AIConfig`),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/config.ttl'),
          subject: { variable: 'config' },
          predicate: namedNode(`${XPOD_AI}migrationStatus`),
          object: literal('ready'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/config.ttl'),
          subject: { variable: 'config' },
          predicate: namedNode(`${XPOD_AI}embeddingModel`),
          object: { variable: 'model' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}isProvidedBy`),
          object: { variable: 'provider' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/providers/anthropic.ttl'),
          subject: { variable: 'model' },
          predicate: namedNode(`${XPOD_AI}status`),
          object: literal('active'),
        },
      ],
      select: ['config', 'model', 'provider'],
      limit: 10,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'vector indexed file store query',
    resource: 'indexedFile',
    purpose: 'vector store settings join indexed files by chunking strategy and usage metadata',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl'),
          subject: { variable: 'store' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${XPOD_AI}VectorStore`),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl'),
          subject: { variable: 'store' },
          predicate: namedNode(`${XPOD_AI}status`),
          object: literal('active'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/vector-stores.ttl'),
          subject: { variable: 'store' },
          predicate: namedNode(`${XPOD_AI}chunkingStrategy`),
          object: { variable: 'strategy' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl'),
          subject: { variable: 'file' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${XPOD_AI}IndexedFile`),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl'),
          subject: { variable: 'file' },
          predicate: namedNode(`${XPOD_AI}status`),
          object: literal('indexed'),
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl'),
          subject: { variable: 'file' },
          predicate: namedNode(`${XPOD_AI}chunkingStrategy`),
          object: { variable: 'strategy' },
        },
        {
          graph: namedNode('https://pod.example/alice/settings/ai/indexed-files.ttl'),
          subject: { variable: 'file' },
          predicate: namedNode(`${XPOD_AI}usageBytes`),
          object: { variable: 'usageBytes' },
        },
      ],
      filters: [
        {
          variable: 'usageBytes',
          operator: '$termType',
          value: 'numeric',
        },
      ],
      select: ['store', 'file', 'strategy', 'usageBytes'],
      orderBy: [
        {
          variable: 'usageBytes',
          direction: 'desc',
        },
      ],
      limit: 20,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
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
    name: 'queued run priority numeric aggregate',
    resource: 'run',
    purpose: 'non-grouped numeric run priority aggregate stays inside SQL/RDF-3X aggregate execution',
    minScale: 'small',
    minReturnedRows: 1,
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
          predicate: namedNode(`${UDFS}priority`),
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
    },
    expectedPlan: ['join-aggregate-index'],
  },
  {
    name: 'message score by thread numeric aggregate',
    resource: 'message',
    purpose: 'small grouped numeric message score aggregate cuts over from RDF-3X to facts by cost',
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
    expectedPlan: ['numeric-aggregate'],
  },
  {
    name: 'message join count distinct',
    resource: 'message',
    purpose: 'message/thread BGP aggregate count stays on the PostgreSQL RDF-3X count path',
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

export const rdfModelsSearchFusionQueryBenchmarkCases: readonly RdfModelQueryBenchmarkCase[] = [
  {
    name: 'agent context text vector fusion query',
    resource: 'message',
    purpose: 'agent context search intersects text chunks, vector chunks, and structured message/thread/workspace RDF facts, then reranks by a fused score',
    minScale: 'small',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: 'https://pod.example/alice/.data/chat/default/2026/05/' },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode(WORKSPACE),
        },
      ],
      textSearch: [
        {
          query: 'runtime approvals',
          scope: {
            workspace: WORKSPACE,
            sourcePrefix: `${DATA}/chat/default/`,
          },
          source: 'message',
          content: 'textContent',
          score: 'textScore',
        },
      ],
      vectorSearch: [
        {
          embedding: [0.95, 0.2, 0.05],
          metric: 'cosine',
          vectorModel: RDF_MODELS_SEARCH_VECTOR_MODEL,
          scope: {
            workspace: WORKSPACE,
            sourcePrefix: `${DATA}/chat/default/`,
          },
          source: 'message',
          content: 'vectorContent',
          score: 'vectorScore',
          distance: 'vectorDistance',
          model: 'embeddingModel',
        },
      ],
      binds: [
        {
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
        },
      ],
      select: ['message', 'thread', 'textContent', 'textScore', 'vectorContent', 'vectorScore', 'vectorDistance', 'fusionScore'],
      orderBy: [
        { variable: 'fusionScore', direction: 'desc' },
        { variable: 'message' },
      ],
      limit: 10,
    },
    expectedPlan: ['text-search-source', 'vector-search-source', 'search-rdf-join', 'search-score-rerank'],
  },
];

export const rdfModelsPostgresMaterializedQueryBenchmarkCases: readonly RdfModelQueryBenchmarkCase[] = [
  postgresMaterializedQueryBenchmarkCase('latest message by thread query', {
    name: 'materialized latest message by thread query',
    purpose: 'high-frequency chat timeline view reuses the materialized latest-message result after warmup',
    materialized: {
      key: 'models/chat/default/thread_1/latest-message',
      version: '2026-05-18',
    },
  }),
  postgresMaterializedQueryBenchmarkCase('thread context window query', {
    name: 'materialized thread context window query',
    purpose: 'agent context assembly reuses a materialized thread window after warmup',
    materialized: {
      key: 'models/chat/default/thread_1/context-window',
      version: '2026-05-18',
    },
  }),
  postgresMaterializedQueryBenchmarkCase('run steps by run query', {
    name: 'materialized run steps by run query',
    purpose: 'run detail views reuse the materialized run-step list after warmup',
    materialized: {
      key: 'models/task/default/run_1/steps',
      version: '2026-05-18',
    },
  }),
  postgresMaterializedQueryBenchmarkCase('task materialization active due query', {
    name: 'materialized task materialization active due query',
    purpose: 'scheduler due-task polling reuses a cutoff-scoped materialized active schedule view after warmup',
    materialized: {
      key: 'models/task/default/due-schedules/2026-05-18T01:30:00.000Z',
      version: 'cutoff:2026-05-18T01:30:00.000Z',
    },
  }),
  postgresMaterializedQueryBenchmarkCase('provider model credential join query', {
    name: 'materialized provider model credential join query',
    purpose: 'settings/provider startup views reuse a materialized provider-model-credential relation after warmup',
    materialized: {
      key: 'models/settings/providers/anthropic/model-credentials',
      version: 'v1',
    },
  }),
];

export const rdfModelsPostgresQueryBenchmarkCases: readonly RdfModelQueryBenchmarkCase[] = [
  ...rdfModelsQueryBenchmarkCases,
  ...rdfModelsPostgresMaterializedQueryBenchmarkCases,
];

function postgresMaterializedQueryBenchmarkCase(
  baseName: string,
  options: {
    name: string;
    purpose: string;
    materialized: NonNullable<RdfQuery['cache']>['materialized'];
  },
): RdfModelQueryBenchmarkCase {
  const base = rdfModelsQueryBenchmarkCases.find((testCase) => testCase.name === baseName);
  if (!base) {
    throw new Error(`Unknown RDF models query benchmark case: ${baseName}`);
  }
  return {
    ...base,
    name: options.name,
    purpose: options.purpose,
    minReturnedRows: base.minReturnedRows ?? 1,
    benchmarkCache: 'preserve',
    minWarmupIterations: 1,
    query: {
      ...base.query,
      cache: {
        ...(base.query.cache ?? {}),
        materialized: options.materialized,
      },
    },
    expectedPlan: ['materialized-cache-hit', 'query-template-cache-hit', ...base.expectedPlan],
  };
}

export const rdfModelsExtremeBenchmarkCases: readonly RdfModelBenchmarkCase[] = [
  {
    name: 'extreme month message score range scan',
    resource: 'message',
    purpose: 'large month graph-prefix numeric score scan stresses graph membership plus object range pushdown',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(`${UDFS}score`),
        object: { $gte: literal('50', namedNode(XSD_INTEGER)) },
        graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
      },
      options: { order: ['subject'], limit: 500 },
    },
    expectedPlan: ['graph-scope', 'predicate-object-range-filter', 'order', 'limit'],
  },
  {
    name: 'extreme month message text scan',
    resource: 'message',
    purpose: 'large graph-prefix text scan validates that object text lookup reconnects through RDF subjects',
    minScale: 'medium',
    query: {
      pattern: {
        predicate: namedNode(SIOC_CONTENT),
        object: { $contains: 'synthetic searchable message' },
        graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
      },
      options: { order: ['subject'], limit: 500 },
    },
    expectedPlan: ['text-index', 'rdf-subject-join', 'order', 'limit'],
  },
];

export const rdfModelsExtremeQueryBenchmarkCases: readonly RdfModelQueryBenchmarkCase[] = [
  {
    name: 'extreme message eight-pattern star query',
    resource: 'message',
    purpose: '8-pattern subject-star BGP stresses deep custom-index joins before pagination',
    minScale: 'medium',
    minReturnedRows: 100,
    query: {
      patterns: [
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_MODIFIED),
          object: { variable: 'modifiedAt' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}score`),
          object: { variable: 'score' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}rank`),
          object: { variable: 'rank' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('indexed'),
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode(WORKSPACE),
        },
      ],
      select: ['message', 'thread', 'createdAt', 'score'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 100,
    },
    expectedPlan: ['join-index', 'subject-star-join', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'extreme message large VALUES thread query',
    resource: 'message',
    purpose: 'large VALUES-constrained fanout join checks native tuple-values pushdown against RDF-3X baseline',
    minScale: 'medium',
    minReturnedRows: 100,
    query: {
      patterns: [
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
      ],
      values: [
        {
          variables: ['thread'],
          rows: syntheticThreadValueRows(32),
        },
      ],
      select: ['message', 'thread', 'createdAt'],
      orderBy: [
        {
          variable: 'createdAt',
          direction: 'desc',
        },
      ],
      limit: 500,
    },
    expectedPlan: ['join-index', 'values-join-pushdown'],
  },
  {
    name: 'extreme message count distinct thread query',
    resource: 'message',
    purpose: 'large fanout COUNT plus COUNT DISTINCT tests the hard aggregate path where native numeric aggregate must not over-claim',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
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
      select: ['messageCount', 'threadCount'],
    },
    expectedPlan: ['join-count-index'],
  },
  {
    name: 'extreme message grouped count by thread query',
    resource: 'message',
    purpose: 'large fanout grouped count validates thread-level scheduler-style aggregation under HAVING/ORDER/LIMIT',
    minScale: 'medium',
    minReturnedRows: 10,
    query: {
      patterns: [
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
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
      ],
      having: [
        {
          variable: 'messageCount',
          operator: '$gt',
          value: literal('5', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'messageCount'],
      orderBy: [
        {
          variable: 'messageCount',
          direction: 'desc',
        },
        {
          variable: 'thread',
          direction: 'asc',
        },
      ],
      limit: 10,
    },
    expectedPlan: ['group-count-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'extreme message grouped numeric aggregate by thread query',
    resource: 'message',
    purpose: 'large fanout grouped numeric aggregate is the primary pg-custom-index native aggregate proving ground',
    minScale: 'medium',
    minReturnedRows: 10,
    query: {
      patterns: [
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}score`),
          object: { variable: 'score' },
        },
        {
          graph: { $startsWith: `${DATA}/chat/default/2026/05/` },
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('indexed'),
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
          value: literal('100', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'messageCount', 'scoreTotal', 'scoreAvg', 'scoreMax'],
      orderBy: [
        {
          variable: 'scoreTotal',
          direction: 'desc',
        },
        {
          variable: 'thread',
          direction: 'asc',
        },
      ],
      limit: 10,
    },
    expectedPlan: ['group-aggregate-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'extreme native exact graph eight-pattern join query',
    resource: 'message',
    purpose: 'high fanout exact-graph 8-pattern BGP is the custom-index native row-stream gate',
    minScale: 'medium',
    minReturnedRows: 200,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(DCT_MODIFIED),
          object: { variable: 'modifiedAt' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}score`),
          object: { variable: 'score' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}rank`),
          object: { variable: 'rank' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('indexed'),
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}workspace`),
          object: namedNode(WORKSPACE),
        },
      ],
      select: ['message', 'thread', 'createdAt', 'score'],
      limit: 256,
    },
    expectedPlan: ['join-index', 'join-limit-pushdown'],
  },
  {
    name: 'extreme native exact graph ordered-page query',
    resource: 'message',
    purpose: 'high fanout exact-graph ordered page checks native BGP row stream plus projected order pagination',
    minScale: 'medium',
    minReturnedRows: 100,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('indexed'),
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
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
      limit: 128,
    },
    expectedPlan: ['join-index', 'join-order-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'extreme native exact graph VALUES thread query',
    resource: 'message',
    purpose: 'high fanout exact-graph VALUES BGP checks native VALUES row scheduling',
    minScale: 'medium',
    minReturnedRows: 200,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(DCT_CREATED),
          object: { variable: 'createdAt' },
        },
      ],
      values: [
        {
          variables: ['thread'],
          rows: syntheticThreadValueRows(32),
        },
      ],
      select: ['message', 'thread', 'createdAt'],
      limit: 512,
    },
    expectedPlan: ['join-index', 'values-join-pushdown', 'join-limit-pushdown'],
  },
  {
    name: 'extreme native exact graph count distinct thread query',
    resource: 'message',
    purpose: 'high fanout exact-graph COUNT and COUNT DISTINCT checks native BGP count',
    minScale: 'medium',
    minReturnedRows: 1,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(RDF_TYPE),
          object: namedNode(`${MEETING}Message`),
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
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
      select: ['messageCount', 'threadCount'],
    },
    expectedPlan: ['join-count-index'],
  },
  {
    name: 'extreme native exact graph grouped count by thread query',
    resource: 'message',
    purpose: 'high fanout exact-graph grouped count checks native BGP group-count summary',
    minScale: 'medium',
    minReturnedRows: 10,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
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
      ],
      having: [
        {
          variable: 'messageCount',
          operator: '$gt',
          value: literal('8', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'messageCount'],
      orderBy: [
        {
          variable: 'messageCount',
          direction: 'desc',
        },
        {
          variable: 'thread',
          direction: 'asc',
        },
      ],
      limit: 10,
    },
    expectedPlan: ['group-count-index', 'having-pushdown', 'order', 'limit'],
  },
  {
    name: 'extreme native exact graph grouped numeric aggregate by thread query',
    resource: 'message',
    purpose: 'high fanout exact-graph grouped numeric summary checks native BGP numeric aggregate',
    minScale: 'medium',
    minReturnedRows: 10,
    query: {
      patterns: [
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(SIOC_HAS_MEMBER),
          object: { variable: 'thread' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}score`),
          object: { variable: 'score' },
        },
        {
          graph: namedNode(NATIVE_STRESS_GRAPH),
          subject: { variable: 'message' },
          predicate: namedNode(`${UDFS}status`),
          object: literal('indexed'),
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
          value: literal('100', namedNode(XSD_INTEGER)),
        },
      ],
      select: ['thread', 'messageCount', 'scoreTotal', 'scoreAvg', 'scoreMax'],
      orderBy: [
        {
          variable: 'scoreTotal',
          direction: 'desc',
        },
        {
          variable: 'thread',
          direction: 'asc',
        },
      ],
      limit: 10,
    },
    expectedPlan: ['numeric-aggregate-facts-cutover'],
  },
];

export function rdfModelsBenchmarkCasesForProfile(profile: RdfBenchmarkCaseProfile): readonly RdfModelBenchmarkCase[] {
  switch (profile) {
    case 'default':
      return rdfModelsBenchmarkCases;
    case 'extreme':
      return rdfModelsExtremeBenchmarkCases;
    case 'fusion':
      return [];
    case 'all':
      return [...rdfModelsBenchmarkCases, ...rdfModelsExtremeBenchmarkCases];
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

export function rdfModelsQueryBenchmarkCasesForProfile(profile: RdfBenchmarkCaseProfile): readonly RdfModelQueryBenchmarkCase[] {
  switch (profile) {
    case 'default':
      return rdfModelsQueryBenchmarkCases;
    case 'extreme':
      return rdfModelsExtremeQueryBenchmarkCases;
    case 'fusion':
      return rdfModelsSearchFusionQueryBenchmarkCases;
    case 'all':
      return [...rdfModelsQueryBenchmarkCases, ...rdfModelsExtremeQueryBenchmarkCases];
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

export function rdfModelsPostgresQueryBenchmarkCasesForProfile(profile: RdfBenchmarkCaseProfile): readonly RdfModelQueryBenchmarkCase[] {
  switch (profile) {
    case 'default':
      return rdfModelsPostgresQueryBenchmarkCases;
    case 'extreme':
      return rdfModelsExtremeQueryBenchmarkCases;
    case 'fusion':
      return rdfModelsSearchFusionQueryBenchmarkCases;
    case 'all':
      return [...rdfModelsPostgresQueryBenchmarkCases, ...rdfModelsExtremeQueryBenchmarkCases];
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

export function rdfModelsBenchmarkCaseNames(): string[] {
  return rdfModelsBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsQueryBenchmarkCaseNames(): string[] {
  return rdfModelsQueryBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsPostgresQueryBenchmarkCaseNames(): string[] {
  return rdfModelsPostgresQueryBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsPostgresMaterializedQueryBenchmarkCaseNames(): string[] {
  return rdfModelsPostgresMaterializedQueryBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsSearchFusionQueryBenchmarkCaseNames(): string[] {
  return rdfModelsSearchFusionQueryBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsExtremeBenchmarkCaseNames(): string[] {
  return rdfModelsExtremeBenchmarkCases.map((testCase) => testCase.name);
}

export function rdfModelsExtremeQueryBenchmarkCaseNames(): string[] {
  return rdfModelsExtremeQueryBenchmarkCases.map((testCase) => testCase.name);
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

export function buildRdfModelsBenchmarkSeed(options: RdfModelsBenchmarkSeedOptions): Quad[] {
  const quads: Quad[] = [];

  seedChatTaskThreadRunProviderQuads(quads);
  seedAgentContactFavoriteQuads(quads);
  seedProfileAccessControlIssueQuads(quads);
  seedSessionAuditAiRuntimeQuads(quads);
  seedSettingsQuads(quads);
  seedCanonicalMessages(quads);
  seedSyntheticThreads(quads, options.syntheticPodCount);
  seedSyntheticMessages(quads, options.syntheticMessages, options.syntheticPodCount);
  if (options.caseProfile === 'extreme' || options.caseProfile === 'all') {
    seedNativeStressMessages(quads);
  }

  return quads;
}

export function rdfModelsBenchmarkProfileRequiresSearchFusion(profile: RdfBenchmarkCaseProfile): boolean {
  return profile === 'fusion';
}

export function seedRdfModelsSearchFusionIndexes(engine: {
  indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void;
  indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void;
}): void {
  for (const source of rdfModelsSearchFusionSources()) {
    const sourceInput = {
      source: source.source,
      workspace: WORKSPACE,
      localPath: source.localPath,
      contentType: 'text/markdown',
      sourceVersion: '2026-05-18',
    };
    const chunk = {
      chunkKey: 'context',
      ordinal: 0,
      level: 1,
      heading: source.heading,
      path: [source.heading],
      content: source.content,
      startOffset: 0,
      endOffset: source.content.length,
    };
    engine.indexTextSource(sourceInput, source.content, [chunk]);
    engine.indexVectorSource(sourceInput, [{
      ...chunk,
      embedding: source.embedding,
      model: RDF_MODELS_SEARCH_VECTOR_MODEL,
    }]);
  }
}

function rdfModelsSearchFusionSources(): RdfModelsSearchFusionSource[] {
  return [
    {
      source: syntheticMessageIri(DATA, 0),
      localPath: '.data/chat/default/2026/05/01/messages.ttl#synthetic_0',
      heading: 'Runtime Approvals',
      content: 'Runtime approvals mention repository context and active agent steering.',
      embedding: [0.95, 0.2, 0.05],
    },
    {
      source: syntheticMessageIri(DATA, 1),
      localPath: '.data/chat/default/2026/05/02/messages.ttl#synthetic_1',
      heading: 'Runtime Follow Up',
      content: 'Runtime approvals follow-up with workspace notes and summary context.',
      embedding: [0.9, 0.25, 0.05],
    },
    {
      source: syntheticMessageIri(DATA, 2),
      localPath: '.data/chat/default/2026/05/03/messages.ttl#synthetic_2',
      heading: 'Irrelevant Note',
      content: 'Unrelated billing and profile note without the target wording.',
      embedding: [0.05, 0.1, 0.95],
    },
  ];
}

function seedChatTaskThreadRunProviderQuads(quads: Quad[]): void {
  const chatGraph = `${DATA}/chat/default/index.ttl`;
  const chat = `${chatGraph}#this`;
  const thread = `${chatGraph}#thread_1`;
  const taskGraph = `${DATA}/task/index.ttl`;
  const task = `${taskGraph}#default`;
  const taskThreadGraph = `${DATA}/task/default/index.ttl`;
  const taskThread = `${taskThreadGraph}#thread_1`;
  const scheduleGraph = `${DATA}/task/default/2026/05/18/schedules.ttl`;
  const runGraph = `${DATA}/task/default/2026/05/18/runs.ttl`;
  const run = `${runGraph}#run_1`;
  const latestMessage = `${DATA}/chat/default/2026/05/18/messages.ttl#msg_3`;
  const provider = `${SETTINGS}/providers/anthropic.ttl`;
  const model = `${provider}#claude-sonnet-4`;
  const credentialGraph = `${SETTINGS}/credentials.ttl`;
  const credential = `${credentialGraph}#anthropic-default`;
  const standbyCredential = `${credentialGraph}#anthropic-standby`;
  const oauthCredential = `${credentialGraph}#github-oauth`;

  quads.push(
    seedQuad(chat, RDF_TYPE, iri(`${MEETING}LongChat`), chatGraph),
    seedQuad(chat, DCT_TITLE, literal('Default chat'), chatGraph),
    seedQuad(chat, DCT_MODIFIED, literal('2026-05-18T00:00:00.000Z'), chatGraph),
    seedQuad(chat, `${UDFS}favorite`, literal('true', iri(XSD_BOOLEAN)), chatGraph),
    seedQuad(chat, `${UDFS}lastActiveAt`, literal('2026-05-18T00:03:00.000Z'), chatGraph),
    seedQuad(chat, `${UDFS}lastMessage`, iri(latestMessage), chatGraph),
    seedQuad(thread, RDF_TYPE, iri(`${SIOC}Thread`), chatGraph),
    seedQuad(thread, SIOC_HAS_PARENT, iri(chat), chatGraph),
    seedQuad(thread, `${UDFS}status`, literal('active'), chatGraph),
    seedQuad(thread, DCT_CREATED, literal('2026-05-18T00:00:01.000Z'), chatGraph),
    seedQuad(thread, `${UDFS}workspace`, iri(WORKSPACE), chatGraph),
    seedQuad(task, RDF_TYPE, iri(`${UDFS}Task`), taskGraph),
    seedQuad(task, DCT_TITLE, literal('Daily repository summary'), taskGraph),
    seedQuad(task, `${UDFS}prompt`, literal('Summarize repository changes and open approvals.'), taskGraph),
    seedQuad(task, `${UDFS}status`, literal('active'), taskGraph),
    seedQuad(task, `${UDFS}workspace`, iri(WORKSPACE), taskGraph),
    seedQuad(task, `${UDFS}runner`, literal('pi'), taskGraph),
    seedQuad(task, `${UDFS}triggerKind`, literal('cron'), taskGraph),
    seedQuad(task, `${UDFS}cron`, literal('0 * * * *'), taskGraph),
    seedQuad(task, `${UDFS}nextRunAt`, literal('2026-05-18T01:00:00.000Z'), taskGraph),
    seedQuad(task, `${UDFS}lastRunAt`, literal('2026-05-18T00:00:00.000Z'), taskGraph),
    seedQuad(task, `${UDFS}inThread`, iri(taskThread), taskGraph),
    seedQuad(taskThread, RDF_TYPE, iri(`${SIOC}Thread`), taskThreadGraph),
    seedQuad(taskThread, `${UDFS}status`, literal('active'), taskThreadGraph),
    seedQuad(taskThread, DCT_CREATED, literal('2026-05-18T00:30:00.000Z'), taskThreadGraph),
    seedQuad(`${scheduleGraph}#schedule_1`, RDF_TYPE, iri(`${UDFS}Schedule`), scheduleGraph),
    seedQuad(`${scheduleGraph}#schedule_1`, `${UDFS}status`, literal('active'), scheduleGraph),
    seedQuad(`${scheduleGraph}#schedule_1`, `${UDFS}nextRunAt`, literal('2026-05-18T01:00:00.000Z'), scheduleGraph),
    seedQuad(run, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    seedQuad(run, `${UDFS}commandKind`, literal('task'), runGraph),
    seedQuad(run, `${UDFS}surfaceId`, literal('default'), runGraph),
    seedQuad(run, `${UDFS}task`, iri(task), runGraph),
    seedQuad(run, `${UDFS}inThread`, iri(taskThread), runGraph),
    seedQuad(run, `${UDFS}runner`, literal('pi'), runGraph),
    seedQuad(run, `${UDFS}prompt`, literal('Summarize repository changes and open approvals.'), runGraph),
    seedQuad(run, DCT_CREATED, literal('2026-05-18T01:00:00.000Z'), runGraph),
    seedQuad(run, `${UDFS}status`, literal('queued'), runGraph),
    seedQuad(run, `${UDFS}workspace`, iri(WORKSPACE), runGraph),
    seedQuad(run, `${UDFS}priority`, literal('10', iri(XSD_INTEGER)), runGraph),
    seedQuad(`${runGraph}#run_2`, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    seedQuad(`${runGraph}#run_2`, DCT_CREATED, literal('2026-05-18T01:05:00.000Z'), runGraph),
    seedQuad(`${runGraph}#run_2`, `${UDFS}status`, literal('queued'), runGraph),
    seedQuad(`${runGraph}#run_2`, `${UDFS}workspace`, iri(WORKSPACE), runGraph),
    seedQuad(`${runGraph}#run_2`, `${UDFS}priority`, literal('2', iri(XSD_INTEGER)), runGraph),
    seedQuad(`${runGraph}#run_3`, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    seedQuad(`${runGraph}#run_3`, DCT_CREATED, literal('2026-05-18T01:10:00.000Z'), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}status`, literal('running'), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}workspace`, iri(WORKSPACE), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}priority`, literal('8', iri(XSD_INTEGER)), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}leaseOwner`, literal('worker-1'), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}leaseExpiresAt`, literal('2026-05-18T01:15:00.000Z'), runGraph),
    seedQuad(`${runGraph}#run_3`, `${UDFS}heartbeatAt`, literal('2026-05-18T01:11:00.000Z'), runGraph),
    seedQuad(`${runGraph}#run_4`, RDF_TYPE, iri(`${UDFS}Run`), runGraph),
    seedQuad(`${runGraph}#run_4`, DCT_CREATED, literal('2026-05-18T01:20:00.000Z'), runGraph),
    seedQuad(`${runGraph}#run_4`, `${UDFS}status`, literal('waiting_input'), runGraph),
    seedQuad(`${runGraph}#run_4`, `${UDFS}workspace`, iri(WORKSPACE), runGraph),
    seedQuad(`${runGraph}#run_4`, `${UDFS}runner`, literal('pi'), runGraph),
    seedQuad(`${runGraph}#step_1`, RDF_TYPE, iri(`${UDFS}RunStep`), runGraph),
    seedQuad(`${runGraph}#step_1`, `${UDFS}run`, iri(run), runGraph),
    seedQuad(`${runGraph}#step_1`, `${UDFS}status`, literal('runtime.tool_call'), runGraph),
    seedQuad(`${runGraph}#step_1`, DCT_CREATED, literal('2026-05-18T01:00:05.000Z'), runGraph),
    seedQuad(`${runGraph}#step_2`, RDF_TYPE, iri(`${UDFS}RunStep`), runGraph),
    seedQuad(`${runGraph}#step_2`, `${UDFS}run`, iri(run), runGraph),
    seedQuad(`${runGraph}#step_2`, `${UDFS}status`, literal('run.completed'), runGraph),
    seedQuad(`${runGraph}#step_2`, DCT_CREATED, literal('2026-05-18T01:00:10.000Z'), runGraph),
    seedQuad(provider, RDF_TYPE, iri(`${XPOD_AI}Provider`), provider),
    seedQuad(provider, `${XPOD_AI}displayName`, literal('Anthropic'), provider),
    seedQuad(provider, `${XPOD_AI}baseUrl`, literal('https://api.anthropic.com/v1'), provider),
    seedQuad(provider, `${XPOD_AI}hasModel`, iri(model), provider),
    seedQuad(provider, `${XPOD_AI}defaultModel`, iri(model), provider),
    seedQuad(model, RDF_TYPE, iri(`${XPOD_AI}Model`), provider),
    seedQuad(model, `${XPOD_AI}isProvidedBy`, iri(provider), provider),
    seedQuad(model, `${XPOD_AI}status`, literal('active'), provider),
    seedQuad(model, `${XPOD_AI}modelType`, literal('chat'), provider),
    seedQuad(model, `${XPOD_AI}dimension`, literal('0', iri(XSD_INTEGER)), provider),
    seedQuad(credential, RDF_TYPE, iri(`${XPOD_CREDENTIAL}Credential`), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}provider`, iri(provider), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}service`, literal('ai'), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}status`, literal('active'), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}apiKey`, literal('sk-ant-test'), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}isDefault`, literal('true', iri(XSD_BOOLEAN)), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}lastUsedAt`, literal('2026-05-18T00:00:00.000Z'), credentialGraph),
    seedQuad(credential, `${XPOD_CREDENTIAL}failCount`, literal('15', iri(XSD_INTEGER)), credentialGraph),
    seedQuad(standbyCredential, RDF_TYPE, iri(`${XPOD_CREDENTIAL}Credential`), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}provider`, iri(provider), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}service`, literal('ai'), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}status`, literal('active'), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}apiKey`, literal('sk-ant-standby'), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}isDefault`, literal('false', iri(XSD_BOOLEAN)), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}lastUsedAt`, literal('2026-05-17T00:00:00.000Z'), credentialGraph),
    seedQuad(standbyCredential, `${XPOD_CREDENTIAL}failCount`, literal('0', iri(XSD_INTEGER)), credentialGraph),
    seedQuad(oauthCredential, RDF_TYPE, iri(`${XPOD_CREDENTIAL}Credential`), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}service`, literal('github'), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}status`, literal('active'), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}label`, literal('GitHub OAuth'), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}oauthRefreshToken`, literal('gho-refresh-test'), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}oauthAccessToken`, literal('gho-access-test'), credentialGraph),
    seedQuad(oauthCredential, `${XPOD_CREDENTIAL}oauthExpiresAt`, literal('2026-05-18T23:00:00.000Z'), credentialGraph),
  );
}

function seedSettingsQuads(quads: Quad[]): void {
  const owner = `${RDF_MODELS_BENCHMARK_POD}/profile/card#me`;
  const uiThemeGraph = `${SETTINGS}/ui.theme.ttl`;
  const aiDefaultAssistantGraph = `${SETTINGS}/ai.defaultAssistant.ttl`;
  const aiProviderSecretGraph = `${SETTINGS}/ai.providerSecret.ttl`;

  quads.push(
    seedQuad(uiThemeGraph, RDF_TYPE, iri(SCHEMA_PROPERTY_VALUE), uiThemeGraph),
    seedQuad(uiThemeGraph, `${UDFS}settingKey`, literal('ui.theme'), uiThemeGraph),
    seedQuad(uiThemeGraph, `${UDFS}settingValue`, literal('dark'), uiThemeGraph),
    seedQuad(uiThemeGraph, `${UDFS}settingType`, literal('string'), uiThemeGraph),
    seedQuad(uiThemeGraph, DCT_TYPE, literal('ui'), uiThemeGraph),
    seedQuad(uiThemeGraph, DCT_CREATOR, iri(owner), uiThemeGraph),
    seedQuad(uiThemeGraph, DCT_TITLE, literal('Theme'), uiThemeGraph),
    seedQuad(uiThemeGraph, DCT_CREATED, literal('2026-05-18T00:00:00.000Z'), uiThemeGraph),
    seedQuad(uiThemeGraph, DCT_MODIFIED, literal('2026-05-18T00:00:00.000Z'), uiThemeGraph),
    seedQuad(aiDefaultAssistantGraph, RDF_TYPE, iri(SCHEMA_PROPERTY_VALUE), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, `${UDFS}settingKey`, literal('ai.defaultAssistant'), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, `${UDFS}settingValue`, literal(`${DATA}/agents/secretary.ttl#this`), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, `${UDFS}settingType`, literal('uri'), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, DCT_TYPE, literal('ai'), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, DCT_CREATOR, iri(owner), aiDefaultAssistantGraph),
    seedQuad(aiDefaultAssistantGraph, DCT_DESCRIPTION, literal('Default AI assistant for chat and task commands.'), aiDefaultAssistantGraph),
    seedQuad(aiProviderSecretGraph, RDF_TYPE, iri(SCHEMA_PROPERTY_VALUE), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, `${UDFS}settingKey`, literal('ai.providerSecret'), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, `${UDFS}settingValue`, literal('encrypted:test'), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, `${UDFS}settingType`, literal('string'), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, DCT_TYPE, literal('ai'), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, DCT_CREATOR, iri(owner), aiProviderSecretGraph),
    seedQuad(aiProviderSecretGraph, `${UDFS}status`, literal('true', iri(XSD_BOOLEAN)), aiProviderSecretGraph),
  );
}

function seedAgentContactFavoriteQuads(quads: Quad[]): void {
  const agentGraph = `${DATA}/agents/secretary.ttl`;
  const agent = `${agentGraph}#this`;
  const contactGraph = `${DATA}/contacts/secretary.ttl`;
  const contact = contactGraph;
  const favoriteGraph = `${DATA}/favorites/2026/05/18.ttl`;
  const favorite = `${favoriteGraph}#favorite_1`;
  const chat = `${DATA}/chat/default/index.ttl#this`;

  quads.push(
    seedQuad(agent, RDF_TYPE, iri(FOAF_AGENT), agentGraph),
    seedQuad(agent, `${UDFS}provider`, literal('anthropic'), agentGraph),
    seedQuad(agent, `${UDFS}model`, literal('claude-sonnet-4'), agentGraph),
    seedQuad(contact, RDF_TYPE, iri(VCARD_INDIVIDUAL), contactGraph),
    seedQuad(contact, FOAF_PRIMARY_TOPIC, iri(agent), contactGraph),
    seedQuad(contact, `${UDFS}contactType`, literal('agent'), contactGraph),
    seedQuad(contact, `${UDFS}favorite`, literal('true'), contactGraph),
    seedQuad(favorite, RDF_TYPE, iri(SCHEMA_CREATIVE_WORK), favoriteGraph),
    seedQuad(favorite, `${UDFS}favoriteTarget`, iri(chat), favoriteGraph),
    seedQuad(favorite, `${UDFS}favoredAt`, literal('2026-05-18T02:00:00.000Z'), favoriteGraph),
  );
}

function seedProfileAccessControlIssueQuads(quads: Quad[]): void {
  const profileGraph = `${RDF_MODELS_BENCHMARK_POD}/profile/card`;
  const profile = `${profileGraph}#me`;
  const profileAclGraph = `${profileGraph}.acl`;
  const profileAclAuthorization = `${profileAclGraph}#public`;
  const profileAcrGraph = `${RDF_MODELS_BENCHMARK_POD}/profile/.acr`;
  const profileAccessControl = `${profileAcrGraph}#publicReadAccess`;
  const issueGraph = `${DATA}/issues/issue_1.ttl`;
  const issue = issueGraph;
  const approvalGraph = `${DATA}/approvals/2026/05/18.ttl`;
  const approval = `${approvalGraph}#approval_1`;
  const grantGraph = `${SETTINGS}/autonomy/grants/default.ttl`;
  const grant = grantGraph;
  const inboxGraph = `${RDF_MODELS_BENCHMARK_POD}/inbox/notification_1.ttl`;
  const inboxNotification = inboxGraph;

  quads.push(
    seedQuad(profile, RDF_TYPE, iri(FOAF_PERSON), profileGraph),
    seedQuad(profile, VCARD_FN, literal('Alice'), profileGraph),
    seedQuad(profile, LDP_INBOX, iri(`${RDF_MODELS_BENCHMARK_POD}/inbox/`), profileGraph),
    seedQuad(profileAclAuthorization, RDF_TYPE, iri(`${ACL}Authorization`), profileAclGraph),
    seedQuad(profileAclAuthorization, `${ACL}accessTo`, iri(profileGraph), profileAclGraph),
    seedQuad(profileAclAuthorization, `${ACL}mode`, iri(`${ACL}Read`), profileAclGraph),
    seedQuad(profileGraph, `${ACP}accessControl`, iri(profileAccessControl), profileAcrGraph),
    seedQuad(profileAccessControl, `${ACP}apply`, iri(profileGraph), profileAcrGraph),
    seedQuad(profileAccessControl, `${ACP}allow`, iri(`${ACP}Read`), profileAcrGraph),
    seedQuad(issue, RDF_TYPE, iri(`${UDFS}Issue`), issueGraph),
    seedQuad(issue, DCT_TITLE, literal('Profile access regression'), issueGraph),
    seedQuad(issue, `${UDFS}status`, literal('open'), issueGraph),
    seedQuad(issue, `${UDFS}assignedTo`, iri(profile), issueGraph),
    seedQuad(approval, RDF_TYPE, iri(`${UDFS}ApprovalRequest`), approvalGraph),
    seedQuad(approval, `${UDFS}status`, literal('pending'), approvalGraph),
    seedQuad(approval, `${UDFS}assignedTo`, iri(profile), approvalGraph),
    seedQuad(approval, `${ODRL}target`, iri(WORKSPACE), approvalGraph),
    seedQuad(approval, `${ODRL}action`, iri(`${UDFS}runTool`), approvalGraph),
    seedQuad(grant, RDF_TYPE, iri(`${ODRL}Policy`), grantGraph),
    seedQuad(grant, RDF_TYPE, iri(`${UDFS}AutonomyGrant`), grantGraph),
    seedQuad(grant, `${ODRL}target`, iri(WORKSPACE), grantGraph),
    seedQuad(grant, `${ODRL}action`, iri(`${UDFS}runTool`), grantGraph),
    seedQuad(grant, `${UDFS}effect`, literal('allow'), grantGraph),
    seedQuad(inboxNotification, RDF_TYPE, iri(`${AS}Activity`), inboxGraph),
    seedQuad(inboxNotification, `${AS}actor`, iri(profile), inboxGraph),
    seedQuad(inboxNotification, `${AS}object`, iri(issue), inboxGraph),
    seedQuad(inboxNotification, DCT_CREATED, literal('2026-05-18T02:30:00.000Z'), inboxGraph),
  );
}

function seedSessionAuditAiRuntimeQuads(quads: Quad[]): void {
  const profile = `${RDF_MODELS_BENCHMARK_POD}/profile/card#me`;
  const chatGraph = `${DATA}/chat/default/index.ttl`;
  const chat = `${chatGraph}#this`;
  const thread = `${chatGraph}#thread_1`;
  const message = `${DATA}/chat/default/2026/05/18/messages.ttl#msg_1`;
  const sessionGraph = `${DATA}/sessions/2026/05/18/session_1.ttl`;
  const session = sessionGraph;
  const approval = `${DATA}/approvals/2026/05/18.ttl#approval_1`;
  const grant = `${SETTINGS}/autonomy/grants/default.ttl`;
  const auditGraph = `${DATA}/audits/2026/05/18.ttl`;
  const audit = `${auditGraph}#audit_1`;
  const provider = `${SETTINGS}/providers/anthropic.ttl`;
  const model = `${provider}#claude-sonnet-4`;
  const aiConfigGraph = `${SETTINGS}/ai/config.ttl`;
  const aiConfig = `${aiConfigGraph}#default`;
  const vectorStoreGraph = `${SETTINGS}/ai/vector-stores.ttl`;
  const vectorStore = `${vectorStoreGraph}#chat-default`;
  const indexedFileGraph = `${SETTINGS}/ai/indexed-files.ttl`;
  const indexedFile = `${indexedFileGraph}#chat-default-messages`;
  const agentStatusGraph = `${SETTINGS}/ai/agent-status.ttl`;
  const agentStatus = `${agentStatusGraph}#secretary`;

  quads.push(
    seedQuad(session, RDF_TYPE, iri(`${UDFS}Session`), sessionGraph),
    seedQuad(session, `${UDFS}actor`, iri(profile), sessionGraph),
    seedQuad(session, `${UDFS}conversation`, iri(chat), sessionGraph),
    seedQuad(session, `${UDFS}inThread`, iri(thread), sessionGraph),
    seedQuad(session, `${UDFS}conversationType`, literal('direct'), sessionGraph),
    seedQuad(session, `${UDFS}sessionStatus`, literal('active'), sessionGraph),
    seedQuad(session, `${UDFS}sessionTool`, literal('codex'), sessionGraph),
    seedQuad(session, `${UDFS}tokenUsage`, literal('1500', iri(XSD_INTEGER)), sessionGraph),
    seedQuad(session, `${UDFS}messageResource`, iri(message), sessionGraph),
    seedQuad(session, `${UDFS}policy`, iri(grant), sessionGraph),
    seedQuad(session, `${UDFS}policyVersion`, literal('2026-05'), sessionGraph),
    seedQuad(session, DCT_CREATED, literal('2026-05-18T03:00:00.000Z'), sessionGraph),
    seedQuad(session, DCT_MODIFIED, literal('2026-05-18T03:10:00.000Z'), sessionGraph),
    seedQuad(audit, RDF_TYPE, iri(`${UDFS}AuditEntry`), auditGraph),
    seedQuad(audit, `${UDFS}action`, literal('runTool'), auditGraph),
    seedQuad(audit, `${UDFS}actor`, iri(profile), auditGraph),
    seedQuad(audit, `${UDFS}actorRole`, literal('owner'), auditGraph),
    seedQuad(audit, `${UDFS}onBehalfOf`, iri(profile), auditGraph),
    seedQuad(audit, `${UDFS}session`, iri(session), auditGraph),
    seedQuad(audit, `${UDFS}conversation`, iri(chat), auditGraph),
    seedQuad(audit, `${UDFS}inThread`, iri(thread), auditGraph),
    seedQuad(audit, `${UDFS}entry`, iri(`${DATA}/task/default/2026/05/18/runs.ttl#step_1`), auditGraph),
    seedQuad(audit, `${UDFS}toolCallId`, literal('call_1'), auditGraph),
    seedQuad(audit, `${UDFS}toolName`, literal('bash'), auditGraph),
    seedQuad(audit, `${UDFS}approval`, iri(approval), auditGraph),
    seedQuad(audit, `${UDFS}policy`, iri(grant), auditGraph),
    seedQuad(audit, `${UDFS}policyVersion`, literal('v1'), auditGraph),
    seedQuad(audit, DCT_CREATED, literal('2026-05-18T03:05:00.000Z'), auditGraph),
    seedQuad(aiConfig, RDF_TYPE, iri(`${XPOD_AI}AIConfig`), aiConfigGraph),
    seedQuad(aiConfig, `${XPOD_AI}embeddingModel`, iri(model), aiConfigGraph),
    seedQuad(aiConfig, `${XPOD_AI}previousModel`, iri(model), aiConfigGraph),
    seedQuad(aiConfig, `${XPOD_AI}migrationStatus`, literal('ready'), aiConfigGraph),
    seedQuad(aiConfig, `${XPOD_AI}migrationProgress`, literal('100', iri(XSD_INTEGER)), aiConfigGraph),
    seedQuad(aiConfig, `${XPOD_AI}updatedAt`, literal('2026-05-18T03:15:00.000Z'), aiConfigGraph),
    seedQuad(vectorStore, RDF_TYPE, iri(`${XPOD_AI}VectorStore`), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}name`, literal('Default chat vectors'), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}container`, iri(`${DATA}/chat/default/`), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}chunkingStrategy`, literal('markdown-heading-v1'), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}status`, literal('active'), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}createdAt`, literal('2026-05-18T03:20:00.000Z'), vectorStoreGraph),
    seedQuad(vectorStore, `${XPOD_AI}lastActiveAt`, literal('2026-05-18T03:25:00.000Z'), vectorStoreGraph),
    seedQuad(indexedFile, RDF_TYPE, iri(`${XPOD_AI}IndexedFile`), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}fileUrl`, iri(`${DATA}/chat/default/2026/05/18/messages.ttl`), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}vectorId`, literal('42', iri(XSD_INTEGER)), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}chunkingStrategy`, literal('markdown-heading-v1'), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}status`, literal('indexed'), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}usageBytes`, literal('2048', iri(XSD_INTEGER)), indexedFileGraph),
    seedQuad(indexedFile, `${XPOD_AI}indexedAt`, literal('2026-05-18T03:30:00.000Z'), indexedFileGraph),
    seedQuad(agentStatus, RDF_TYPE, iri(`${XPOD_AI}AgentStatus`), agentStatusGraph),
    seedQuad(agentStatus, `${XPOD_AI}agentId`, literal('secretary'), agentStatusGraph),
    seedQuad(agentStatus, `${XPOD_AI}status`, literal('running'), agentStatusGraph),
    seedQuad(agentStatus, `${XPOD_AI}startedAt`, literal('2026-05-18T03:35:00.000Z'), agentStatusGraph),
    seedQuad(agentStatus, `${XPOD_AI}lastActivityAt`, literal('2026-05-18T03:40:00.000Z'), agentStatusGraph),
    seedQuad(agentStatus, `${XPOD_AI}currentTaskId`, literal('default'), agentStatusGraph),
  );
}

function seedCanonicalMessages(quads: Quad[]): void {
  const chat = `${DATA}/chat/default/index.ttl#this`;
  const thread = `${DATA}/chat/default/index.ttl#thread_1`;
  const graph = `${DATA}/chat/default/2026/05/18/messages.ttl`;
  const scores = ['2', '10', '4'];
  const profile = `${RDF_MODELS_BENCHMARK_POD}/profile/card#me`;
  const agent = `${DATA}/agents/secretary.ttl#this`;

  for (let index = 0; index < 3; index += 1) {
    const message = `${graph}#msg_${index + 1}`;
    const timestamp = `2026-05-18T00:0${index + 1}:00.000Z`;
    const maker = index === 0 ? profile : agent;
    quads.push(
      seedQuad(message, RDF_TYPE, iri(`${MEETING}Message`), graph),
      seedQuad(message, SIOC_HAS_MEMBER, iri(thread), graph),
      seedQuad(message, SIOC_HAS_CONTAINER, iri(thread), graph),
      seedQuad(chat, WF_MESSAGE, iri(message), graph),
      seedQuad(message, FOAF_MAKER, iri(maker), graph),
      seedQuad(message, `${UDFS}messageType`, literal(index === 0 ? 'user' : 'assistant'), graph),
      seedQuad(message, `${UDFS}messageStatus`, literal('completed'), graph),
      seedQuad(message, DCT_CREATED, literal(timestamp), graph),
      seedQuad(message, DCT_MODIFIED, literal(timestamp), graph),
      seedQuad(message, `${UDFS}score`, literal(scores[index], namedNode(XSD_INTEGER)), graph),
      seedQuad(message, SIOC_CONTENT, literal(`canonical message ${index + 1}`), graph),
    );
  }
  quads.push(
    seedQuad(`${graph}#msg_2`, `${UDFS}replyTo`, iri(`${graph}#msg_1`), graph),
    seedQuad(`${graph}#msg_3`, `${UDFS}routeTargetAgentId`, literal('secretary'), graph),
    seedQuad(`${graph}#msg_3`, `${UDFS}coordinationId`, literal('coordination_1'), graph),
  );
}

function seedSyntheticThreads(quads: Quad[], podCount: number): void {
  const syntheticPodCount = Math.max(1, Math.floor(podCount));
  for (let podIndex = 0; podIndex < syntheticPodCount; podIndex += 1) {
    const pod = podIndex === 0 ? RDF_MODELS_BENCHMARK_POD : `https://pod.example/synthetic-${podIndex}`;
    const data = `${pod}/.data`;
    const graph = `${data}/chat/default/index.ttl`;
    for (let threadIndex = 0; threadIndex < RDF_MODELS_SYNTHETIC_THREAD_COUNT; threadIndex += 1) {
      const thread = syntheticThreadIri(data, threadIndex);
      const createdAt = new Date(Date.UTC(2026, 4, 1, 0, threadIndex, podIndex)).toISOString();
      quads.push(
        seedQuad(thread, RDF_TYPE, iri(`${SIOC}Thread`), graph),
        seedQuad(thread, `${UDFS}workspace`, iri(WORKSPACE), graph),
        seedQuad(thread, DCT_CREATED, literal(createdAt), graph),
      );
    }
  }
}

function seedSyntheticMessages(quads: Quad[], count: number, podCount: number): void {
  const syntheticPodCount = Math.max(1, Math.floor(podCount));
  for (let index = 0; index < count; index += 1) {
    const podIndex = index % syntheticPodCount;
    const pod = podIndex === 0 ? RDF_MODELS_BENCHMARK_POD : `https://pod.example/synthetic-${podIndex}`;
    const data = `${pod}/.data`;
    const thread = syntheticThreadIri(data, index % RDF_MODELS_SYNTHETIC_THREAD_COUNT);
    const dayNumber = (index % 28) + 1;
    const day = String(dayNumber).padStart(2, '0');
    const graph = `${data}/chat/default/2026/05/${day}/messages.ttl`;
    const message = syntheticMessageIri(data, index);
    const timestamp = new Date(Date.UTC(2026, 4, dayNumber, 12, 0, index)).toISOString();
    const score = String((index % 100) + 1);
    const rank = String(index + 1);
    quads.push(
      seedQuad(message, RDF_TYPE, iri(`${MEETING}Message`), graph),
      seedQuad(message, SIOC_HAS_MEMBER, iri(thread), graph),
      seedQuad(message, DCT_CREATED, literal(timestamp), graph),
      seedQuad(message, DCT_MODIFIED, literal(timestamp), graph),
      seedQuad(message, SIOC_CONTENT, literal(`synthetic searchable message ${index}`), graph),
      seedQuad(message, `${UDFS}score`, literal(score, iri(XSD_INTEGER)), graph),
      seedQuad(message, `${UDFS}rank`, literal(rank, iri(XSD_INTEGER)), graph),
      seedQuad(message, `${UDFS}status`, literal('indexed'), graph),
      seedQuad(message, `${UDFS}workspace`, iri(WORKSPACE), graph),
    );
  }
}

function seedNativeStressMessages(quads: Quad[]): void {
  for (let index = 0; index < RDF_MODELS_NATIVE_STRESS_MESSAGE_COUNT; index += 1) {
    const thread = syntheticThreadIri(DATA, index % RDF_MODELS_SYNTHETIC_THREAD_COUNT);
    const message = `${NATIVE_STRESS_GRAPH}#native_${index}`;
    const timestamp = new Date(Date.UTC(2026, 4, 18, 13, 0, index)).toISOString();
    const score = String((index % 100) + 1);
    const rank = String(index + 1);
    quads.push(
      seedQuad(message, RDF_TYPE, iri(`${MEETING}Message`), NATIVE_STRESS_GRAPH),
      seedQuad(message, SIOC_HAS_MEMBER, iri(thread), NATIVE_STRESS_GRAPH),
      seedQuad(message, DCT_CREATED, literal(timestamp), NATIVE_STRESS_GRAPH),
      seedQuad(message, DCT_MODIFIED, literal(timestamp), NATIVE_STRESS_GRAPH),
      seedQuad(message, SIOC_CONTENT, literal(`native stress searchable message ${index}`), NATIVE_STRESS_GRAPH),
      seedQuad(message, `${UDFS}score`, literal(score, iri(XSD_INTEGER)), NATIVE_STRESS_GRAPH),
      seedQuad(message, `${UDFS}rank`, literal(rank, iri(XSD_INTEGER)), NATIVE_STRESS_GRAPH),
      seedQuad(message, `${UDFS}status`, literal('indexed'), NATIVE_STRESS_GRAPH),
      seedQuad(message, `${UDFS}workspace`, iri(WORKSPACE), NATIVE_STRESS_GRAPH),
    );
  }
}

function syntheticThreadIri(data: string, threadIndex: number): string {
  return `${data}/chat/default/index.ttl#thread_${threadIndex + 1}`;
}

function syntheticMessageIri(data: string, messageIndex: number): string {
  const day = String((messageIndex % 28) + 1).padStart(2, '0');
  return `${data}/chat/default/2026/05/${day}/messages.ttl#synthetic_${messageIndex}`;
}

function syntheticThreadValueRows(count: number): RdfBindingRow[] {
  const rows: RdfBindingRow[] = [];
  const safeCount = Math.min(Math.max(0, Math.floor(count)), RDF_MODELS_SYNTHETIC_THREAD_COUNT);
  for (let index = 0; index < safeCount; index += 1) {
    rows.push({
      thread: namedNode(syntheticThreadIri(DATA, index)),
    });
  }
  return rows;
}

function seedQuad(
  subject: string,
  predicate: string,
  object: ReturnType<typeof namedNode> | ReturnType<typeof literal>,
  graph: string,
): Quad {
  return quad(namedNode(subject), namedNode(predicate), object, namedNode(graph));
}

function iri(value: string): ReturnType<typeof namedNode> {
  return namedNode(value);
}

export function runRdfModelsBenchmark(
  engine: SolidRdfEngine,
  options: RdfModelBenchmarkRunOptions = {},
): RdfModelBenchmarkReport {
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const caseProfile = options.caseProfile ?? 'default';
  const cases = (options.cases ?? rdfModelsBenchmarkCasesForProfile(caseProfile))
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const queryCases = (options.queryCases ?? rdfModelsQueryBenchmarkCasesForProfile(caseProfile))
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
    caseProfile,
    iterations,
    generatedAt: new Date().toISOString(),
    planMatched: failedPlanCases.length === 0,
    failedPlanCases,
    storage: engine.storageStats(),
    cases: results,
    queryCases: queryResults,
  };
}

export async function runRdfModelsPostgresBenchmark(
  engine: RdfEngineLike,
  options: RdfModelPostgresBenchmarkRunOptions = {},
): Promise<RdfModelPostgresBenchmarkReport> {
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const warmupIterations = Math.max(0, Math.floor(options.warmupIterations ?? 1));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const caseProfile = options.caseProfile ?? 'default';
  const refresh = options.refreshDerivedIndexes === false
    ? undefined
    : await engine.refreshDerivedIndexes();
  const storageBefore = await engine.storageStats();
  const cases = (options.cases ?? rdfModelsBenchmarkCasesForProfile(caseProfile))
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const queryCases = (options.queryCases ?? rdfModelsPostgresQueryBenchmarkCasesForProfile(caseProfile))
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const results = [];
  for (const testCase of cases) {
    results.push(await runAsyncBenchmarkCase(engine, testCase, iterations, storageBefore.facts, warmupIterations));
  }
  const queryResults = [];
  for (const testCase of queryCases) {
    queryResults.push(await runAsyncQueryBenchmarkCase(engine, testCase, iterations, storageBefore.facts, warmupIterations));
  }
  const concurrencyGate = await runPostgresConcurrencyGate(
    engine,
    queryCases,
    queryResults,
    concurrency,
    storageBefore.facts,
  );
  const failedPlanCases = [
    ...results.filter((result) => !result.planMatched).map((result) => result.name),
    ...queryResults.filter((result) => !result.planMatched).map((result) => result.name),
    ...concurrencyGate.failedCases.map((caseName) => `concurrency:${caseName}`),
  ];

  return {
    engine: 'postgres-rdf',
    scale,
    caseProfile,
    iterations,
    warmupIterations,
    concurrency,
    generatedAt: new Date().toISOString(),
    planMatched: failedPlanCases.length === 0,
    failedPlanCases,
    concurrencyGate,
    ...(refresh ? { refresh } : {}),
    storage: await engine.storageStats(),
    cases: results,
    queryCases: queryResults,
  };
}

async function runPostgresConcurrencyGate(
  engine: RdfEngineLike,
  queryCases: readonly RdfModelQueryBenchmarkCase[],
  baselineResults: readonly RdfModelQueryBenchmarkResult[],
  concurrency: number,
  indexStats: RdfIndexStats,
): Promise<RdfModelPostgresConcurrencyGate> {
  if (concurrency <= 1) {
    return {
      enabled: false,
      concurrency,
      cases: [],
      matched: true,
      failedCases: [],
    };
  }

  const baselineByName = new Map(baselineResults.map((result) => [result.name, result]));
  const selectedCases = selectPostgresConcurrencyGateCases(queryCases, baselineByName);
  const cases: RdfModelPostgresConcurrencyGateCase[] = [];

  for (const testCase of selectedCases) {
    const baseline = baselineByName.get(testCase.name);
    if (!baseline) {
      cases.push({
        name: testCase.name,
        concurrency,
        iterationsPerLane: 1,
        matched: false,
        planMatched: false,
        expectedReturnedRows: 0,
        returnedRows: [],
        expectedChecksum: '',
        checksums: [],
        expectedOrderedChecksum: '',
        orderedChecksums: [],
        missingPlan: ['missing serial benchmark baseline'],
        durationsMs: [],
        p50DurationMs: 0,
        p95DurationMs: 0,
      });
      continue;
    }

    const laneResults = await Promise.all(Array.from({ length: concurrency }, () => (
      runAsyncQueryBenchmarkCase(engine, testCase, 1, indexStats, 0)
    )));
    const returnedRows = laneResults.map((result) => result.returnedRows);
    const checksums = laneResults.map((result) => result.checksum);
    const orderedChecksums = laneResults.map((result) => result.orderedChecksum);
    const durationsMs = laneResults.flatMap((result) => result.durationsMs);
    const missingPlan = [...new Set(laneResults.flatMap((result) => result.missingPlan))];
    const planMatched = laneResults.every((result) => result.planMatched);
    const matched = planMatched
      && returnedRows.every((rowCount) => rowCount === baseline.returnedRows)
      && checksums.every((value) => value === baseline.checksum)
      && orderedChecksums.every((value) => value === baseline.orderedChecksum);

    cases.push({
      name: testCase.name,
      concurrency,
      iterationsPerLane: 1,
      matched,
      planMatched,
      expectedReturnedRows: baseline.returnedRows,
      returnedRows,
      expectedChecksum: baseline.checksum,
      checksums,
      expectedOrderedChecksum: baseline.orderedChecksum,
      orderedChecksums,
      missingPlan,
      durationsMs,
      p50DurationMs: percentile(durationsMs, 0.5),
      p95DurationMs: percentile(durationsMs, 0.95),
    });
  }

  const failedCases = cases.filter((result) => !result.matched).map((result) => result.name);
  return {
    enabled: true,
    concurrency,
    cases,
    matched: failedCases.length === 0,
    failedCases,
  };
}

function selectPostgresConcurrencyGateCases(
  queryCases: readonly RdfModelQueryBenchmarkCase[],
  baselineByName: ReadonlyMap<string, RdfModelQueryBenchmarkResult>,
): RdfModelQueryBenchmarkCase[] {
  const preferred = POSTGRES_CONCURRENCY_GATE_QUERY_CASE_NAMES
    .map((name) => queryCases.find((testCase) => testCase.name === name))
    .filter((testCase): testCase is RdfModelQueryBenchmarkCase => Boolean(testCase))
    .filter((testCase) => baselineByName.has(testCase.name));
  if (preferred.length > 0) {
    return preferred;
  }
  return queryCases
    .filter((testCase) => baselineByName.has(testCase.name))
    .slice(0, Math.min(4, queryCases.length));
}

export async function runRdfModelsShadowBenchmark(
  engine: SolidRdfEngine,
  compatibilityStore: QuintStore,
  options: RdfModelShadowBenchmarkRunOptions = {},
): Promise<RdfModelShadowBenchmarkReport> {
  const scale = options.scale ?? 'small';
  const iterations = Math.max(1, Math.floor(options.iterations ?? 1));
  const caseProfile = options.caseProfile ?? 'default';
  const cases = (options.cases ?? rdfModelsBenchmarkCasesForProfile(caseProfile))
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
    caseProfile,
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
  const caseProfile = options.caseProfile ?? 'default';
  const cases = (options.cases ?? rdfModelsBenchmarkCasesForProfile(caseProfile))
    .filter((testCase) => scaleRank(testCase.minScale) <= scaleRank(scale));
  const queryCases = (options.queryCases ?? rdfModelsQueryBenchmarkCasesForProfile(caseProfile))
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
    caseProfile,
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

async function runAsyncBenchmarkCase(
  engine: RdfEngineLike,
  testCase: RdfModelBenchmarkCase,
  iterations: number,
  indexStats: RdfIndexStats,
  warmupIterations = 0,
): Promise<RdfModelBenchmarkResult> {
  const durationsMs: number[] = [];
  let metrics: RdfIndexMetrics | undefined;
  let keys: string[] = [];

  for (let i = 0; i < warmupIterations; i += 1) {
    await engine.scan(testCase.query);
  }

  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    const result = await engine.scan(testCase.query);
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
    indexStats,
  };
}

async function runAsyncQueryBenchmarkCase(
  engine: RdfEngineLike,
  testCase: RdfModelQueryBenchmarkCase,
  iterations: number,
  indexStats: RdfIndexStats,
  warmupIterations = 0,
): Promise<RdfModelQueryBenchmarkResult> {
  const durationsMs: number[] = [];
  let metrics: RdfQueryMetrics | undefined;
  let keys: string[] = [];
  const query = asyncBenchmarkQueryFor(testCase);
  const effectiveWarmupIterations = Math.max(
    warmupIterations,
    Math.max(0, Math.floor(testCase.minWarmupIterations ?? 0)),
  );

  for (let i = 0; i < effectiveWarmupIterations; i += 1) {
    await engine.query(query);
  }

  for (let i = 0; i < iterations; i += 1) {
    const start = Date.now();
    const result = await engine.query(query);
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
    query: serializeQueryPlan(query),
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
    indexStats,
  };
}

function asyncBenchmarkQueryFor(testCase: RdfModelQueryBenchmarkCase): RdfQuery {
  if (testCase.benchmarkCache === 'preserve') {
    return testCase.query;
  }
  return {
    ...testCase.query,
    cache: {
      ...(testCase.query.cache ?? {}),
      mode: 'bypass',
    },
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
      return Boolean(pattern.graph)
        && (metrics.indexChoice.includes('G')
          || metrics.indexChoice === 'source-membership'
          || planText.includes('GraphPrefixMembershipFilter')
          || planText.includes('GraphMembershipFilter')
          || planText.includes('Rdf3xMembershipScan')
          || planText.includes('scan.graph_prefix'));
    case 'type-filter':
      return isTerm(pattern.predicate as any)
        && termToId(pattern.predicate as any) === RDF_TYPE
        && Boolean(pattern.object)
        && metrics.indexChoice !== 'full-scan'
        && metrics.indexChoice !== 'facts-post-filter';
    case 'predicate-filter':
      return Boolean(pattern.predicate)
        && (metrics.indexChoice.includes('P')
          || metrics.indexChoice === 'source-membership'
          || planText.includes('Rdf3xPermutationScan('));
    case 'predicate-object-filter':
      return Boolean(pattern.predicate)
        && Boolean(pattern.object)
        && (metrics.indexChoice.includes('P')
          || metrics.indexChoice === 'source-membership'
          || planText.includes('Rdf3xPermutationScan('));
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
      return metrics.indexChoice === label || matchesPgPermutationPlan(label, testCase, metrics);
    default:
      return false;
  }
}

function matchesPgPermutationPlan(
  label: string,
  testCase: RdfModelBenchmarkCase,
  metrics: RdfIndexMetrics,
): boolean {
  const planText = (metrics.queryPlan ?? []).join('\n');
  const graphScoped = matchesExpectedPlanLabel('graph-scope', testCase, metrics);
  switch (label) {
    case 'SPOG':
      return metrics.indexChoice === 'SPO' || planText.includes('Rdf3xPermutationScan(SPO)');
    case 'POSG':
      return metrics.indexChoice === 'POS' || planText.includes('Rdf3xPermutationScan(POS)');
    case 'OSPG':
      return metrics.indexChoice === 'OSP' || planText.includes('Rdf3xPermutationScan(OSP)');
    case 'GSPO':
      return graphScoped && (metrics.indexChoice === 'SPO' || planText.includes('Rdf3xPermutationScan(SPO)'));
    case 'GPOS':
      return graphScoped && (metrics.indexChoice === 'POS' || planText.includes('Rdf3xPermutationScan(POS)'));
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
    case 'materialized-cache-hit':
      return planText.includes('PostgresMaterializedResultHit');
    case 'materialized-cache-miss':
      return planText.includes('PostgresMaterializedResultMiss')
        || planText.includes('PostgresMaterializedResultRefresh');
    case 'materialized-cache-store':
      return planText.includes('PostgresMaterializedResultStore');
    case 'query-template-cache-hit':
      return planText.includes('PostgresQueryTemplateCacheHit');
    case 'query-template-cache-miss':
      return planText.includes('PostgresQueryTemplateCacheMiss');
    case 'query-template-cache-bypass':
      return planText.includes('PostgresQueryTemplateCacheBypass');
    case 'group-count-index':
      return planText.includes('Aggregate(group-count-index)')
        || planText.includes('PostgresRdf3xGroupCount');
    case 'group-aggregate-index':
      return planText.includes('Aggregate(group-basic-multi-index)')
        || planText.includes('Aggregate(group-basic-index)')
        || planText.includes('Aggregate(group-basic-multi)')
        || planText.includes('Aggregate(group-basic)')
        || planText.includes('PostgresRdf3xGroupAggregate');
    case 'join-aggregate-index':
      return (
        (planText.includes('Aggregate(join-basic-multi-index)')
          || planText.includes('Aggregate(join-basic-index)'))
        && (planText.includes('IndexJoinAggregate(')
          || planText.includes('Rdf3xPrimaryJoinAggregate('))
      ) || planText.includes('PostgresRdf3xJoinAggregate');
    case 'numeric-aggregate':
      return planText.includes('JoinGroupAggregateNumeric(')
        || planText.includes('Aggregate(group-basic-multi)')
        || planText.includes('Aggregate(group-basic-index)')
        || planText.includes('Rdf3xJoinGroupAggregateNumeric(')
        || planText.includes('PostgresRdf3xGroupAggregate')
        || planText.includes('PostgresNumericAggregateFactsCutover(');
    case 'numeric-aggregate-facts-cutover':
      return planText.includes('PostgresFactsQuery')
        && planText.includes('PostgresNumericAggregateFactsCutover(')
        && !planText.includes('PostgresRdf3xGroupAggregate');
    case 'having-pushdown':
      return (planText.includes('IndexGroupCountHaving(')
        || planText.includes('IndexGroupAggregateHaving(')
        || planText.includes('PostgresRdf3xAggregateHaving(')
        || planText.includes('PostgresRdfNativeCustomIndexAggregateHaving('))
        && !planText.includes('\nHaving(')
        && !planText.includes('\nPostgresFactsHaving(');
    case 'order':
      return (planText.includes('IndexGroupCountOrder(')
        || planText.includes('IndexGroupAggregateOrder(')
        || planText.includes('PostgresRdf3xAggregateOrder(')
        || planText.includes('PostgresRdfNativeCustomIndexAggregateOrder('))
        && !planText.includes('\nSort')
        && !planText.includes('\nPostgresFactsSort(');
    case 'limit':
      return (planText.includes('IndexGroupCountLimit')
        || planText.includes('IndexGroupAggregateLimit')
        || planText.includes('PostgresRdf3xAggregateLimit')
        || planText.includes('PostgresRdfNativeCustomIndexAggregateLimit'))
        && !planText.includes('\nLimit')
        && !planText.includes('\nPostgresFactsLimit');
    case 'join-index':
      return planText.includes('IndexJoin(')
        && !planText.includes('\nIndexScan(')
        || planText.includes('PostgresRdf3xJoin(')
        || planText.includes('PostgresRdfNativeCustomIndexBgpJoin(')
        || planText.includes('PostgresRdfNativeCustomIndexValuesJoin(')
        || localIndexScanCount(planText) >= 2;
    case 'subject-star-join':
      return planText.includes('SubjectStarJoin(')
        || planText.includes('PostgresRdf3xSubjectStarJoin(');
    case 'values-recheck':
      return (planText.includes('Rdf3xJoinTupleValues(') || planText.includes('Values('))
        && !planText.includes('PostgresFactsValues(');
    case 'values-join-pushdown':
      return (planText.includes('Rdf3xJoinTupleValues(') || planText.includes('Values('))
        && !planText.includes('PostgresFactsValues(');
    case 'join-order-pushdown':
      return (planText.includes('IndexJoinOrder(')
        || planText.includes('Rdf3xJoinOrder(')
        || planText.includes('Rdf3xJoinOrderBy(')
        || planText.includes('PostgresRdfNativeCustomIndexBgpOrderPage('))
        && !planText.includes('\nSort')
        && !planText.includes('\nPostgresFactsSort(');
    case 'join-limit-pushdown':
      return (planText.includes('IndexJoinLimit')
        || planText.includes('Rdf3xJoinLimit')
        || planText.includes('PostgresRdf3xJoinLimit')
        || planText.includes('PostgresRdfNativeCustomIndexBgpLimit')
        || planText.includes('PostgresRdfNativeCustomIndexValuesJoinLimit'))
        && !planText.includes('\nLimit')
        && !planText.includes('\nPostgresFactsLimit');
    case 'range-filter-pushdown':
      return (metrics.filtersPushedDown > 0 || planText.includes('PostgresMaterializedResultHit'))
        && (planText.includes('LexicalRange(') || planText.includes('NumericRange('));
    case 'join-count-index':
      return planText.includes('Aggregate(join-count-distinct-index)')
        && planText.includes('IndexJoinCount(')
        && !planText.includes('\nIndexScan(')
        || planText.includes('PostgresRdf3xJoinCount');
    case 'text-search-source':
      return planText.includes('TextSearch(')
        && metrics.indexChoices.includes('text-chunk');
    case 'vector-search-source':
      return planText.includes('VectorSearch(')
        && metrics.indexChoices.includes('vector-chunk');
    case 'search-rdf-join':
      return planText.includes('TextSearch(')
        && planText.includes('VectorSearch(')
        && (planText.includes('IndexJoin(')
          || planText.includes('PostgresRdf3xJoin(')
          || planText.includes('PostgresFactsScan(')
          || localIndexScanCount(planText) >= 1);
    case 'search-score-rerank':
      return planText.includes('Bind(?fusionScore:=')
        && planText.includes('Sort');
    default:
      return false;
  }
}

function localIndexScanCount(planText: string): number {
  return planText.match(/\bIndexScan\(/g)?.length ?? 0;
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
    case 'numeric-aggregate':
      return planText.includes('Rdf3xJoinGroupAggregateNumeric(')
        || planText.includes('Rdf3xJoinAggregateNumeric(');
    case 'join-aggregate-index':
      return planText.includes('Rdf3xJoinAggregate(')
        || planText.includes('Rdf3xJoinAggregateNumeric(');
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
    case 'subject-star-join':
      return planText.includes('SubjectStarJoin(');
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
