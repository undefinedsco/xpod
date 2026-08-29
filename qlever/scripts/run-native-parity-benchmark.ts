import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type NativeParityReportEngineId,
  nativeParityReportEngineIds,
  validateNativeParityReportMatrix,
} from './native-parity-report';

export type NativeParityStageName =
  | 'parse-plan'
  | 'backend-scan'
  | 'id-table-materialization'
  | 'algebra-execution'
  | 'term-resolution'
  | 'serialization';

export type NativeParityPgStage = {
  backendBytes: number;
  backendRows: number;
  backendScanCount: number;
  name: NativeParityStageName;
  stageMs: number;
};

export type NativeParityPgDiagnostics = {
  backendRows?: number;
  backendCompressedBytes: number;
  cacheStatus: string;
  compressedCursorBatches: number;
  compressedRows: number;
  correctnessDigest?: string;
  errorCount?: number;
  executionMode?: string;
  fallbackReason?: string | null;
  intermediateBoundReason?: string | null;
  parameterized?: boolean;
  nativeOrderPageRows: number;
  peakBatchRows: number;
  projectedColumns: number;
  queryMemoryLimitBytes: number;
  rowsDecoded: number;
  seedRows?: number;
  spiQuadRows: number;
  uniqueJoinTuples?: number;
};

export type NativeParityPromotionStatus = 'pass' | 'reject' | 'cannotPromote';

export type NativeParityPromotionEvidence = {
  overall: {
    status: Exclude<NativeParityPromotionStatus, 'cannotPromote'>;
  };
  pgQleverVsRdf3x: {
    aggregatePgWarmP50Ms: number;
    aggregateRdf3xWarmP50Ms: number;
    ratio: number;
    status: Exclude<NativeParityPromotionStatus, 'cannotPromote'>;
    threshold: number;
  };
};

export type NativeParityResultRow = unknown;

export type NativeParityEngineRun = {
  elapsedMs: number;
  fixtureSha256: string;
  pgDiagnostics?: NativeParityPgDiagnostics;
  pgStages?: NativeParityPgStage[];
  rows: NativeParityResultRow[];
  timedOut?: boolean;
};

export type NativeParityEngineAdapter = {
  calls?: { phase: string; queryPath: string; repetition: number }[];
  id: NativeParityReportEngineId;
  runQuery(input: NativeParityRunQueryInput): Promise<NativeParityEngineRun>;
  version: string;
};

export type NativeParityRunQueryInput = {
  attempt?: number;
  concurrencyLevel?: number;
  fixture: NativeParityBenchmarkInput['dataset'];
  phase: 'cold' | 'warm';
  queryId: string;
  queryPath: string;
  repetition: number;
  timeoutMs: number;
};

export type NativeParityBenchmarkQuery = {
  id: string;
  path: string;
};

export type NativeParityBenchmarkInput = {
  concurrencyLevels?: number[];
  dataset: {
    name: string;
    sha256: string;
  };
  engines: NativeParityEngineAdapter[];
  p0JoinAccessScopedBaselines?: NativeParityP0JoinBaselineFile;
  p0JoinAccessScopedWorkloadIds?: readonly string[];
  queries: NativeParityBenchmarkQuery[];
  timeoutMs: number;
  warmRepetitions?: number;
};

export type NativeParityBenchmarkReportResult = {
  concurrency?: {
    level: number;
    pgDiagnostics?: NativeParityPgDiagnostics;
    p50Ms: number;
    p95Ms: number;
    requests: number;
    resultDigests?: {
      multiset: string;
      ordered: string;
    };
    rows?: number;
    throughputQps: number;
  }[];
  engineId: NativeParityReportEngineId;
  failure?: {
    message: string;
    phase: 'cold' | 'concurrency' | 'warm';
  };
  latencyMs?: {
    cold: { p50: number; p95: number };
    warm: { p50: number; p95: number };
  };
  pgStages?: NativeParityPgStage[];
  pgDiagnostics?: NativeParityPgDiagnostics;
  queryId: string;
  resultDigests?: {
    multiset: string;
    ordered: string;
  };
  rows?: number;
  status: 'failed' | 'ok';
};

export type NativeParityFullReport = {
  dataset: {
    name: string;
    sha256: string;
  };
  engines: Record<NativeParityReportEngineId, { id: NativeParityReportEngineId; version: string }>;
  promotion: NativeParityPromotionEvidence;
  queries: { id: string; sha256: string }[];
  results: NativeParityBenchmarkReportResult[];
};

export class NativeParityBenchmarkRejectedError extends Error {
  constructor(public readonly report: NativeParityFullReport) {
    const failedCells = report.results
      .filter((result) => result.status === 'failed')
      .map((result) => `${result.queryId}/${result.engineId}`);
    super(`native parity benchmark rejected: ${failedCells.join(', ')}`);
    this.name = 'NativeParityBenchmarkRejectedError';
  }
}

export type NativeParityP0JoinFixture = {
  accessScopedBaselines: Record<string, { digest: { multiset: string; ordered: string }; rows: number }>;
  baselines: Record<string, { digest: { multiset: string; ordered: string }; rows: number }>;
  fixtureDirectory: string;
  manifest: {
    factCount: number;
    actualFacts: number;
    files: { 'facts.nq': { sha256: string } };
    p0Small: boolean;
  };
  p0Small: true;
  queries: NativeParityBenchmarkQuery[];
  queryDirectory: string;
};

export type NativeParityP0JoinWorkloadSummary = {
  backendRows: number;
  c1: { p50Ms: number; p95Ms: number; qps: number };
  c8: { p50Ms: number; p95Ms: number; qps: number };
  correctnessDigest: string;
  diagnosticsByConcurrency: {
    diagnostics: NativeParityPgDiagnostics;
    level: number;
    resultDigests: { multiset: string; ordered: string };
    rows: number;
  }[];
  digest: string;
  errorCount: number;
  fallbackReason: string | null;
  id: string;
  intermediateRows: {
    c1: NativeParityP0IntermediateRowsSummary;
    c8: NativeParityP0IntermediateRowsSummary;
    topLevel: NativeParityP0IntermediateRowsSummary;
  };
  p50Ms: number;
  p95Ms: number;
  parameterized: boolean;
  peakBatchRows: number;
  qps: number;
  rows: number;
};

export type NativeParityP0JoinAcceptanceSummary = {
  accepted: boolean;
  errors: string[];
  workloads: NativeParityP0JoinWorkloadSummary[];
};

export type NativeParityP0IntermediateRowsSummary = {
  boundExceeded: boolean;
  intermediateRows: number;
  largestLogicalInputRows: number;
  ratio: number | null;
  reason: string | null;
};

export type NativeParityP0JoinBaselineFile = Record<string, { digest: { multiset: string; ordered: string }; rows: number }>;

type CliEngineId = NativeParityReportEngineId;

type SparqlJson = {
  boolean?: boolean;
  results?: {
    bindings?: unknown[];
  };
};

type SparqlBindingTerm = {
  datatype?: string;
  'xml:lang'?: string;
  type: 'bnode' | 'literal' | 'uri';
  value: string;
};

type ProcessExecutionInput = {
  attempt?: number;
  argv: string[];
  concurrencyLevel?: number;
  engineId: CliEngineId;
  env?: Record<string, string>;
  fixtureSha256: string;
  parse: (stdout: string, fixtureSha256: string) => NativeParityEngineRun;
  phase?: NativeParityRunQueryInput['phase'];
  queryId: string;
  repetition?: number;
  timeoutMs: number;
};

type NativeQleverHttpFetch = (
  input: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<Response>;

type JsonSchema = {
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  additionalProperties?: boolean;
  allOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  if?: JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  then?: JsonSchema;
  type?: string;
};

const defaultQueries: { id: string; text: string }[] = [
  {
    id: 'point-lookup',
    text: 'SELECT ?o WHERE { GRAPH ?graph { <https://example.test/entity/42> <https://schema.example.test/name> ?o } } ORDER BY ?o',
  },
  {
    id: 'exact-graph',
    text: 'SELECT ?s ?p ?o WHERE { GRAPH <https://example.test/graph/3> { ?s ?p ?o } } ORDER BY ?s ?p ?o LIMIT 100',
  },
  {
    id: 'two-hop',
    text: 'SELECT ?s ?o WHERE { GRAPH ?graph1 { ?s <https://schema.example.test/related> ?m } GRAPH ?graph2 { ?m <https://schema.example.test/name> ?o } } ORDER BY ?s ?o LIMIT 100',
  },
  {
    id: 'four-hop',
    text: 'SELECT ?a ?e WHERE { GRAPH ?graph1 { ?a <https://schema.example.test/related> ?b } GRAPH ?graph2 { ?b <https://schema.example.test/related> ?c } GRAPH ?graph3 { ?c <https://schema.example.test/related> ?d } GRAPH ?graph4 { ?d <https://schema.example.test/name> ?e } } ORDER BY ?a ?e LIMIT 100',
  },
  {
    id: 'eight-hop',
    text: 'SELECT ?a ?i WHERE { GRAPH ?graph1 { ?a <https://schema.example.test/related> ?b } GRAPH ?graph2 { ?b <https://schema.example.test/related> ?c } GRAPH ?graph3 { ?c <https://schema.example.test/related> ?d } GRAPH ?graph4 { ?d <https://schema.example.test/related> ?e } GRAPH ?graph5 { ?e <https://schema.example.test/related> ?f } GRAPH ?graph6 { ?f <https://schema.example.test/related> ?g } GRAPH ?graph7 { ?g <https://schema.example.test/related> ?h } GRAPH ?graph8 { ?h <https://schema.example.test/name> ?i } } ORDER BY ?a ?i LIMIT 100',
  },
  {
    id: 'grouped-count-order',
    text: 'SELECT ?g (COUNT(?s) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY ?g',
  },
  {
    id: 'count-distinct',
    text: 'SELECT (COUNT(DISTINCT ?s) AS ?subjects) WHERE { GRAPH ?graph { ?s ?p ?o } }',
  },
  {
    id: 'scoped-broad-join',
    text: 'SELECT ?s ?score ?name WHERE { GRAPH <https://example.test/graph/2> { ?s <https://schema.example.test/score> ?score . ?s <https://schema.example.test/name> ?name } } ORDER BY ?s LIMIT 100',
  },
];

export const nativeParityP0JoinWorkloadIds = [
  'p0-subject-star',
  'p0-two-hop-chain',
  'p0-multi-key-join',
  'p0-latest-message-by-thread',
  'p0-task-run-step',
  'p0-graph-allowed',
  'p0-graph-denied',
] as const;

export const nativeParityP0AccessScopedWorkloadIds = [
  'p0-graph-allowed',
  'p0-graph-denied',
] as const;

export const nativeParityP0ParameterizedJoinWorkloadIds = [
  'p0-subject-star',
  'p0-two-hop-chain',
  'p0-multi-key-join',
  'p0-latest-message-by-thread',
  'p0-task-run-step',
  'p0-graph-denied',
] as const;

function requiresP0ParameterizedJoin(queryId: string): boolean {
  return (nativeParityP0ParameterizedJoinWorkloadIds as readonly string[])
    .includes(queryId);
}

const p0JoinWorkloads: { id: typeof nativeParityP0JoinWorkloadIds[number]; text: string }[] = [
  {
    id: 'p0-subject-star',
    text: 'SELECT ?person ?name ?score WHERE { GRAPH <https://example.test/graph/allowed> { ?person <https://schema.example.test/name> ?name . ?person <https://schema.example.test/score> ?score . ?person <https://schema.example.test/status> "active" } } ORDER BY ?person LIMIT 2',
  },
  {
    id: 'p0-two-hop-chain',
    text: 'SELECT ?person ?managerName WHERE { GRAPH <https://example.test/graph/allowed> { ?person <https://schema.example.test/manager> ?manager . ?manager <https://schema.example.test/name> ?managerName } } ORDER BY ?person LIMIT 2',
  },
  {
    id: 'p0-multi-key-join',
    text: 'SELECT ?thread ?message ?reaction WHERE { GRAPH <https://example.test/graph/allowed> { ?message <https://schema.example.test/thread> ?thread . ?message <https://schema.example.test/createdAt> ?created . ?reaction <https://schema.example.test/reactionThread> ?thread . ?reaction <https://schema.example.test/reactionCreatedAt> ?created } } ORDER BY ?thread ?message ?reaction LIMIT 2',
  },
  {
    id: 'p0-latest-message-by-thread',
    text: 'SELECT ?thread ?message ?created WHERE { GRAPH <https://example.test/graph/allowed> { ?thread <https://schema.example.test/latestMessage> ?message . ?message <https://schema.example.test/createdAt> ?created } } ORDER BY ?thread LIMIT 2',
  },
  {
    id: 'p0-task-run-step',
    text: 'SELECT ?task ?run ?step WHERE { GRAPH <https://example.test/graph/allowed> { ?task <https://schema.example.test/run> ?run . ?run <https://schema.example.test/step> ?step . ?step <https://schema.example.test/status> "passed" } } ORDER BY ?task ?run ?step LIMIT 2',
  },
  {
    id: 'p0-graph-allowed',
    text: 'SELECT ?person ?name WHERE { GRAPH <https://example.test/graph/allowed> { ?person <https://schema.example.test/name> ?name } } ORDER BY ?person LIMIT 2',
  },
  {
    id: 'p0-graph-denied',
    text: 'SELECT ?person ?name WHERE { GRAPH <https://example.test/graph/denied> { ?person <https://schema.example.test/name> ?name . ?person <https://schema.example.test/visibleToBenchmark> "true" } } ORDER BY ?person LIMIT 2',
  },
];

const p0JoinWorkloadLimit = 2;

const p0JoinWorkloadOrderKeys: Record<typeof nativeParityP0JoinWorkloadIds[number], string[]> = {
  'p0-subject-star': ['person'],
  'p0-two-hop-chain': ['person'],
  'p0-multi-key-join': ['thread', 'message', 'reaction'],
  'p0-latest-message-by-thread': ['thread'],
  'p0-task-run-step': ['task', 'run', 'step'],
  'p0-graph-allowed': ['person'],
  'p0-graph-denied': ['person'],
};

const pgStageNames = new Set<NativeParityStageName>([
  'parse-plan',
  'backend-scan',
  'id-table-materialization',
  'algebra-execution',
  'term-resolution',
  'serialization',
]);

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertSha256(value: string, field: string, errors: string[]): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    errors.push(`${field} must be a lowercase SHA-256 digest`);
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const omitStringDatatype =
      object.type === 'literal' &&
      object.datatype === 'http://www.w3.org/2001/XMLSchema#string' &&
      object['xml:lang'] === undefined;
    const normalizeIntegerDatatype =
      object.type === 'literal' &&
      object.datatype === 'http://www.w3.org/2001/XMLSchema#int';
    return Object.fromEntries(
      Object.entries(object)
        .filter(([key]) => !omitStringDatatype || key !== 'datatype')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          key,
          normalizeIntegerDatatype && key === 'datatype'
            ? 'http://www.w3.org/2001/XMLSchema#integer'
            : normalizeValue(entry),
        ]),
    );
  }
  return value;
}

function normalizedRow(row: unknown): string {
  return JSON.stringify(normalizeValue(row));
}

export function digestResultRows(rows: unknown[]): { multiset: string; ordered: string } {
  const normalizedRows = rows.map((row) => normalizedRow(row));
  return {
    ordered: sha256(`${normalizedRows.join('\n')}\n`),
    multiset: sha256(`${[...normalizedRows].sort().join('\n')}\n`),
  };
}

function binding(value: string): SparqlBindingTerm {
  if (value.startsWith('https://')) {
    return { type: 'uri', value };
  }
  return { type: 'literal', value };
}

function resultRow(entries: Record<string, string>): Record<string, SparqlBindingTerm> {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, binding(value)]));
}

const p0JoinSmallFacts = [
  '<https://example.test/person/alice> <https://schema.example.test/name> "Alice" <https://example.test/graph/allowed> .',
  '<https://example.test/person/alice> <https://schema.example.test/score> "10" <https://example.test/graph/allowed> .',
  '<https://example.test/person/alice> <https://schema.example.test/status> "active" <https://example.test/graph/allowed> .',
  '<https://example.test/person/alice> <https://schema.example.test/manager> <https://example.test/person/maya> <https://example.test/graph/allowed> .',
  '<https://example.test/person/bob> <https://schema.example.test/name> "Bob" <https://example.test/graph/allowed> .',
  '<https://example.test/person/bob> <https://schema.example.test/score> "20" <https://example.test/graph/allowed> .',
  '<https://example.test/person/bob> <https://schema.example.test/status> "active" <https://example.test/graph/allowed> .',
  '<https://example.test/person/bob> <https://schema.example.test/manager> <https://example.test/person/maya> <https://example.test/graph/allowed> .',
  '<https://example.test/person/chris> <https://schema.example.test/name> "Chris" <https://example.test/graph/allowed> .',
  '<https://example.test/person/chris> <https://schema.example.test/score> "30" <https://example.test/graph/allowed> .',
  '<https://example.test/person/chris> <https://schema.example.test/status> "active" <https://example.test/graph/allowed> .',
  '<https://example.test/person/chris> <https://schema.example.test/manager> <https://example.test/person/noor> <https://example.test/graph/allowed> .',
  '<https://example.test/person/drew> <https://schema.example.test/name> "Drew" <https://example.test/graph/allowed> .',
  '<https://example.test/person/drew> <https://schema.example.test/score> "40" <https://example.test/graph/allowed> .',
  '<https://example.test/person/drew> <https://schema.example.test/status> "active" <https://example.test/graph/allowed> .',
  '<https://example.test/person/maya> <https://schema.example.test/name> "Maya" <https://example.test/graph/allowed> .',
  '<https://example.test/thread/alpha> <https://schema.example.test/latestMessage> <https://example.test/message/a2> <https://example.test/graph/allowed> .',
  '<https://example.test/thread/beta> <https://schema.example.test/latestMessage> <https://example.test/message/b1> <https://example.test/graph/allowed> .',
  '<https://example.test/message/a1> <https://schema.example.test/thread> <https://example.test/thread/alpha> <https://example.test/graph/allowed> .',
  '<https://example.test/message/a1> <https://schema.example.test/createdAt> "2026-07-25T00:00:01Z" <https://example.test/graph/allowed> .',
  '<https://example.test/message/a2> <https://schema.example.test/thread> <https://example.test/thread/alpha> <https://example.test/graph/allowed> .',
  '<https://example.test/message/a2> <https://schema.example.test/createdAt> "2026-07-25T00:00:02Z" <https://example.test/graph/allowed> .',
  '<https://example.test/message/b1> <https://schema.example.test/thread> <https://example.test/thread/beta> <https://example.test/graph/allowed> .',
  '<https://example.test/message/b1> <https://schema.example.test/createdAt> "2026-07-25T00:00:03Z" <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r1> <https://schema.example.test/reactionThread> <https://example.test/thread/alpha> <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r1> <https://schema.example.test/reactionCreatedAt> "2026-07-25T00:00:01Z" <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r2> <https://schema.example.test/reactionThread> <https://example.test/thread/alpha> <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r2> <https://schema.example.test/reactionCreatedAt> "2026-07-25T00:00:02Z" <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r3> <https://schema.example.test/reactionThread> <https://example.test/thread/beta> <https://example.test/graph/allowed> .',
  '<https://example.test/reaction/r3> <https://schema.example.test/reactionCreatedAt> "2026-07-25T00:00:03Z" <https://example.test/graph/allowed> .',
  '<https://example.test/task/t1> <https://schema.example.test/run> <https://example.test/run/r1> <https://example.test/graph/allowed> .',
  '<https://example.test/task/t2> <https://schema.example.test/run> <https://example.test/run/r2> <https://example.test/graph/allowed> .',
  '<https://example.test/run/r1> <https://schema.example.test/step> <https://example.test/step/s1> <https://example.test/graph/allowed> .',
  '<https://example.test/run/r1> <https://schema.example.test/step> <https://example.test/step/s2> <https://example.test/graph/allowed> .',
  '<https://example.test/run/r2> <https://schema.example.test/step> <https://example.test/step/s3> <https://example.test/graph/allowed> .',
  '<https://example.test/step/s1> <https://schema.example.test/status> "passed" <https://example.test/graph/allowed> .',
  '<https://example.test/step/s2> <https://schema.example.test/status> "passed" <https://example.test/graph/allowed> .',
  '<https://example.test/step/s3> <https://schema.example.test/status> "passed" <https://example.test/graph/allowed> .',
  '<https://example.test/person/secret> <https://schema.example.test/name> "Secret" <https://example.test/graph/denied> .',
  '<https://example.test/person/secret> <https://schema.example.test/visibleToBenchmark> "true" <https://example.test/graph/denied> .',
].join('\n') + '\n';

const p0JoinSmallBaselineRows: Record<typeof nativeParityP0JoinWorkloadIds[number], unknown[]> = {
  'p0-subject-star': [
    resultRow({ person: 'https://example.test/person/alice', name: 'Alice', score: '10' }),
    resultRow({ person: 'https://example.test/person/bob', name: 'Bob', score: '20' }),
    resultRow({ person: 'https://example.test/person/chris', name: 'Chris', score: '30' }),
    resultRow({ person: 'https://example.test/person/drew', name: 'Drew', score: '40' }),
  ],
  'p0-two-hop-chain': [
    resultRow({ person: 'https://example.test/person/alice', managerName: 'Maya' }),
    resultRow({ person: 'https://example.test/person/bob', managerName: 'Maya' }),
  ],
  'p0-multi-key-join': [
    resultRow({ thread: 'https://example.test/thread/alpha', message: 'https://example.test/message/a1', reaction: 'https://example.test/reaction/r1' }),
    resultRow({ thread: 'https://example.test/thread/alpha', message: 'https://example.test/message/a2', reaction: 'https://example.test/reaction/r2' }),
    resultRow({ thread: 'https://example.test/thread/beta', message: 'https://example.test/message/b1', reaction: 'https://example.test/reaction/r3' }),
  ],
  'p0-latest-message-by-thread': [
    resultRow({ thread: 'https://example.test/thread/alpha', message: 'https://example.test/message/a2', created: '2026-07-25T00:00:02Z' }),
    resultRow({ thread: 'https://example.test/thread/beta', message: 'https://example.test/message/b1', created: '2026-07-25T00:00:03Z' }),
  ],
  'p0-task-run-step': [
    resultRow({ task: 'https://example.test/task/t1', run: 'https://example.test/run/r1', step: 'https://example.test/step/s1' }),
    resultRow({ task: 'https://example.test/task/t1', run: 'https://example.test/run/r1', step: 'https://example.test/step/s2' }),
    resultRow({ task: 'https://example.test/task/t2', run: 'https://example.test/run/r2', step: 'https://example.test/step/s3' }),
  ],
  'p0-graph-allowed': [
    resultRow({ person: 'https://example.test/person/alice', name: 'Alice' }),
    resultRow({ person: 'https://example.test/person/bob', name: 'Bob' }),
    resultRow({ person: 'https://example.test/person/chris', name: 'Chris' }),
    resultRow({ person: 'https://example.test/person/drew', name: 'Drew' }),
    resultRow({ person: 'https://example.test/person/maya', name: 'Maya' }),
  ],
  'p0-graph-denied': [
    resultRow({ person: 'https://example.test/person/secret', name: 'Secret' }),
  ],
};

const p0JoinSmallAccessScopedRows: Record<typeof nativeParityP0JoinWorkloadIds[number], unknown[]> = {
  ...p0JoinSmallBaselineRows,
  'p0-graph-denied': [],
};

function p0BaselineSortValue(row: unknown, key: string): string {
  const term = jsonObject(row)[key];
  if (term && typeof term === 'object' && !Array.isArray(term)) {
    const value = (term as Record<string, unknown>).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function p0OrderedLimitedRows(
  workloadId: typeof nativeParityP0JoinWorkloadIds[number],
  rows: unknown[],
): unknown[] {
  const orderKeys = p0JoinWorkloadOrderKeys[workloadId];
  return [...rows]
    .sort((left, right) => {
      for (const key of orderKeys) {
        const comparison = p0BaselineSortValue(left, key)
          .localeCompare(p0BaselineSortValue(right, key));
        if (comparison !== 0) {
          return comparison;
        }
      }
      return normalizedRow(left).localeCompare(normalizedRow(right));
    })
    .slice(0, p0JoinWorkloadLimit);
}

function p0BaselineEntry(
  workloadId: typeof nativeParityP0JoinWorkloadIds[number],
  rows: Record<typeof nativeParityP0JoinWorkloadIds[number], unknown[]>,
): { digest: { multiset: string; ordered: string }; rows: number } {
  const limitedRows = p0OrderedLimitedRows(workloadId, rows[workloadId]);
  return {
    digest: digestResultRows(limitedRows),
    rows: limitedRows.length,
  };
}

function extractRows(payload: unknown): unknown[] {
  const object = jsonObject(payload) as SparqlJson;
  if (Array.isArray(object.results?.bindings)) {
    return object.results.bindings;
  }
  if (typeof object.boolean === 'boolean') {
    return [{ boolean: object.boolean }];
  }
  return [];
}

function qleverVariableName(variable: unknown): string {
  if (typeof variable !== 'string' || variable.length === 0) {
    throw new Error('invalid QLever selected variable');
  }
  return variable.startsWith('?') ? variable.slice(1) : variable;
}

function findClosingQuote(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== '"') {
      continue;
    }
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === '\\'; previous -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return index;
    }
  }
  throw new Error(`invalid QLever literal cell ${JSON.stringify(value)}`);
}

function decodeRdfString(value: string): string {
  return value.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|["\\tnrbf])/g, (_match, escape: string) => {
    if (escape[0] === 'u' || escape[0] === 'U') {
      return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    }
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    return escapes[escape] ?? escape;
  });
}

function qleverCellToSparqlTerm(cell: unknown): SparqlBindingTerm | undefined {
  if (cell === '' || cell === null) {
    return undefined;
  }
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    const object = cell as Record<string, unknown>;
    if (typeof object.type === 'string' && typeof object.value === 'string') {
      return object as SparqlBindingTerm;
    }
  }
  if (typeof cell !== 'string') {
    throw new Error(`unsupported QLever result cell ${JSON.stringify(cell)}`);
  }
  if (cell.startsWith('<') && cell.endsWith('>')) {
    return { type: 'uri', value: cell.slice(1, -1) };
  }
  if (cell.startsWith('_:')) {
    return { type: 'bnode', value: cell.slice(2) };
  }
  if (!cell.startsWith('"')) {
    throw new Error(`unsupported QLever result cell ${JSON.stringify(cell)}`);
  }
  const closingQuote = findClosingQuote(cell);
  const value = decodeRdfString(cell.slice(1, closingQuote));
  const suffix = cell.slice(closingQuote + 1);
  const datatype = suffix.match(/^\^\^<(.+)>$/);
  if (datatype) {
    return { type: 'literal', value, datatype: datatype[1] };
  }
  const lang = suffix.match(/^@([A-Za-z]+(?:-[A-Za-z0-9]+)*)$/);
  if (lang) {
    return { type: 'literal', value, 'xml:lang': lang[1] };
  }
  if (suffix.length === 0) {
    return { type: 'literal', value };
  }
  throw new Error(`unsupported QLever literal suffix ${JSON.stringify(suffix)}`);
}

function qleverTermToBoolean(term: SparqlBindingTerm | undefined): boolean {
  if (!term || term.type !== 'literal') {
    throw new Error('invalid QLever ASK result cell');
  }
  if (term.datatype !== 'http://www.w3.org/2001/XMLSchema#boolean') {
    throw new Error('invalid QLever ASK datatype');
  }
  if (term.value === 'true' || term.value === '1') {
    return true;
  }
  if (term.value === 'false' || term.value === '0') {
    return false;
  }
  throw new Error('invalid QLever ASK boolean value');
}

function extractQleverResultRows(payload: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(payload.selected) || !Array.isArray(payload.res)) {
    return undefined;
  }
  const selected = payload.selected.map((variable) => qleverVariableName(variable));
  if (selected.length === 1 && selected[0] === 'result') {
    if (payload.res.length !== 1 || !Array.isArray(payload.res[0]) || payload.res[0].length !== 1) {
      throw new Error('invalid QLever ASK result shape');
    }
    return [{ boolean: qleverTermToBoolean(qleverCellToSparqlTerm(payload.res[0][0])) }];
  }
  return payload.res.map((row) => {
    if (!Array.isArray(row) || row.length !== selected.length) {
      throw new Error('invalid QLever result row shape');
    }
    const bindings: Record<string, SparqlBindingTerm> = {};
    row.forEach((cell, index) => {
      const term = qleverCellToSparqlTerm(cell);
      if (term) {
        bindings[selected[index]] = term;
      }
    });
    return bindings;
  });
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function schemaTypeMatches(schemaType: string, value: unknown): boolean {
  if (schemaType === 'object') {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
  if (schemaType === 'array') {
    return Array.isArray(value);
  }
  if (schemaType === 'string') {
    return typeof value === 'string';
  }
  if (schemaType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (schemaType === 'integer') {
    return Number.isInteger(value);
  }
  return true;
}

function resolveSchemaRef(root: JsonSchema, schema: JsonSchema): JsonSchema {
  if (!schema.$ref) {
    return schema;
  }
  const match = schema.$ref.match(/^#\/\$defs\/([^/]+)$/);
  if (!match) {
    throw new Error(`unsupported schema ref ${schema.$ref}`);
  }
  const resolved = root.$defs?.[match[1]];
  if (!resolved) {
    throw new Error(`missing schema ref ${schema.$ref}`);
  }
  return resolved;
}

function schemaConditionMatches(root: JsonSchema, schema: JsonSchema, value: unknown): boolean {
  const resolved = resolveSchemaRef(root, schema);
  const object = jsonObject(value);
  for (const [property, propertySchema] of Object.entries(resolved.properties ?? {})) {
    const resolvedProperty = resolveSchemaRef(root, propertySchema);
    if ('const' in resolvedProperty && object[property] !== resolvedProperty.const) {
      return false;
    }
  }
  return true;
}

function validateJsonSchemaSubset(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  location: string,
  errors: string[],
): void {
  const resolved = resolveSchemaRef(root, schema);
  if (resolved.type && !schemaTypeMatches(resolved.type, value)) {
    errors.push(`schema type violation at ${location}: expected ${resolved.type}`);
    return;
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`schema enum violation at ${location}`);
  }
  if ('const' in resolved && value !== resolved.const) {
    errors.push(`schema const violation at ${location}`);
  }
  if (resolved.pattern && (typeof value !== 'string' || !new RegExp(resolved.pattern).test(value))) {
    errors.push(`schema pattern violation at ${location}`);
  }
  if (resolved.minimum !== undefined && (typeof value !== 'number' || value < resolved.minimum)) {
    errors.push(`schema minimum violation at ${location}`);
  }
  if (resolved.maximum !== undefined && (typeof value !== 'number' || value > resolved.maximum)) {
    errors.push(`schema maximum violation at ${location}`);
  }
  if (resolved.minLength !== undefined && (typeof value !== 'string' || value.length < resolved.minLength)) {
    errors.push(`schema minLength violation at ${location}`);
  }

  if (
    resolved.type === 'object' ||
    resolved.required !== undefined ||
    resolved.properties !== undefined ||
    resolved.additionalProperties !== undefined
  ) {
    const object = jsonObject(value);
    for (const required of resolved.required ?? []) {
      if (!(required in object)) {
        errors.push(`schema required violation at ${location}: ${required}`);
      }
    }
    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!allowed.has(key)) {
          errors.push(`schema additionalProperties violation at ${location}: ${key}`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(resolved.properties ?? {})) {
      if (key in object) {
        validateJsonSchemaSubset(root, propertySchema, object[key], `${location}.${key}`, errors);
      }
    }
  }

  if (resolved.type === 'array') {
    const array = value as unknown[];
    if (resolved.minItems !== undefined && array.length < resolved.minItems) {
      errors.push(`schema minItems violation at ${location}`);
    }
    if (resolved.items) {
      for (let index = 0; index < array.length; index += 1) {
        validateJsonSchemaSubset(root, resolved.items, array[index], `${location}[${index}]`, errors);
      }
    }
  }

  for (const nested of resolved.allOf ?? []) {
    if (nested.if && nested.then && schemaConditionMatches(root, nested.if, value)) {
      validateJsonSchemaSubset(root, nested.then, value, location, errors);
    } else if (!nested.if) {
      validateJsonSchemaSubset(root, nested, value, location, errors);
    }
  }
}

export function validateNativeParityReportAgainstSchema(report: unknown): string[] {
  const schemaPath = path.resolve(import.meta.dir, '../reports/native-parity-report.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema;
  const errors: string[] = [];
  validateJsonSchemaSubset(schema, schema, report, '$', errors);
  return errors;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    throw new Error('cannot compute percentile of an empty sample');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function summarizeLatency(cold: number, warm: number[]): NativeParityFullReport['results'][number]['latencyMs'] {
  return {
    cold: { p50: cold, p95: cold },
    warm: {
      p50: percentile(warm, 0.5),
      p95: percentile(warm, 0.95),
    },
  };
}

function concurrencySummary(
  level: number,
  runs: NativeParityEngineRun[],
  wallMs: number,
  expectedDigests: { multiset: string; ordered: string },
  rows: number,
): NonNullable<NativeParityBenchmarkReportResult['concurrency']>[number] {
  const latency = runs.map((run) => run.elapsedMs);
  return {
    level,
    p50Ms: percentile(latency, 0.5),
    p95Ms: percentile(latency, 0.95),
    requests: runs.length,
    resultDigests: expectedDigests,
    rows,
    throughputQps: runs.length * 1_000 / Math.max(wallMs, 0.001),
  };
}

function concurrencySummaryWithPgEvidence(
  level: number,
  runs: NativeParityEngineRun[],
  wallMs: number,
  queryId: string,
  label: string,
  expectedDigests: { multiset: string; ordered: string },
  rows: number,
): NonNullable<NativeParityBenchmarkReportResult['concurrency']>[number] {
  return {
    ...concurrencySummary(level, runs, wallMs, expectedDigests, rows),
    pgDiagnostics: {
      ...summarizeWarmPgDiagnostics(runs, queryId, label),
      correctnessDigest: expectedDigests.ordered,
    },
    resultDigests: expectedDigests,
    rows,
  };
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function pgStageValidationErrors(stages: unknown, label: string): string[] {
  if (!Array.isArray(stages)) {
    return [`missing pgStages for ${label}`];
  }
  if (stages.length !== pgStageNames.size) {
    return [`incomplete pgStages for ${label}`];
  }

  const seen = new Set<NativeParityStageName>();
  const errors: string[] = [];
  for (const stage of stages) {
    const stageRecord = stage as Partial<NativeParityPgStage>;
    if (!pgStageNames.has(stageRecord.name as NativeParityStageName)) {
      errors.push(`invalid PG stage name for ${label}`);
      continue;
    }
    const stageName = stageRecord.name as NativeParityStageName;
    if (seen.has(stageName)) {
      errors.push(`duplicate PG stage ${stageName} for ${label}`);
    }
    seen.add(stageName);
    if (!isNonNegativeNumber(stageRecord.stageMs)) {
      errors.push(`invalid PG stageMs for ${label}`);
    }
    if (!isNonNegativeInteger(stageRecord.backendScanCount)) {
      errors.push(`invalid PG backendScanCount for ${label}`);
    }
    if (!isNonNegativeNumber(stageRecord.backendRows)) {
      errors.push(`invalid PG backendRows for ${label}`);
    }
    if (!isNonNegativeNumber(stageRecord.backendBytes)) {
      errors.push(`invalid PG backendBytes for ${label}`);
    }
  }

  for (const stageName of pgStageNames) {
    if (!seen.has(stageName)) {
      errors.push(`missing PG stage ${stageName} for ${label}`);
    }
  }
  return errors;
}

function assertPgStages(stages: unknown, label: string): NativeParityPgStage[] {
  const errors = pgStageValidationErrors(stages, label);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  const byName = new Map((stages as NativeParityPgStage[]).map((stage) => [stage.name, stage]));
  return Array.from(pgStageNames, (stageName) => byName.get(stageName)!);
}

function summarizeWarmPgStages(warmRuns: NativeParityEngineRun[], queryId: string): NativeParityPgStage[] {
  const stagesByRun = warmRuns.map((run, index) => assertPgStages(run.pgStages, `${queryId}/pg-qlever warm#${index + 1}`));
  return Array.from(pgStageNames, (stageName, stageIndex) => ({
    name: stageName,
    stageMs: median(stagesByRun.map((stages) => stages[stageIndex].stageMs)),
    backendScanCount: median(stagesByRun.map((stages) => stages[stageIndex].backendScanCount)),
    backendRows: median(stagesByRun.map((stages) => stages[stageIndex].backendRows)),
    backendBytes: median(stagesByRun.map((stages) => stages[stageIndex].backendBytes)),
  }));
}

function assertPgDiagnosticsPresent(
  diagnostics: unknown,
  label: string,
): NativeParityPgDiagnostics {
  const value = diagnostics as NativeParityPgDiagnostics | undefined;
  if (!value) {
    throw new Error(`missing PG diagnostics for ${label}`);
  }
  return value;
}

function assertPgRunDiagnosticsContract(
  diagnostics: unknown,
  label: string,
  resultRowCount: number,
): NativeParityPgDiagnostics {
  const value = assertPgDiagnosticsPresent(diagnostics, label);
  if (!value.cacheStatus || value.cacheStatus.startsWith('cached')) {
    throw new Error(`result cache hit in PG run: ${value.cacheStatus}`);
  }
  if (
    resultRowCount > 0 &&
    value.spiQuadRows <= 0 &&
    value.nativeOrderPageRows <= 0
  ) {
    throw new Error(`PG run did not use the atomic B-tree scan path for ${label}`);
  }
  if (value.compressedCursorBatches !== 0 || value.compressedRows !== 0) {
    throw new Error(`PG run used retired compressed-index diagnostics for ${label}`);
  }
  return {
    ...value,
    nativeOrderPageRows: value.nativeOrderPageRows ?? 0,
  };
}

function summarizeWarmPgDiagnostics(
  warmRuns: NativeParityEngineRun[],
  queryId: string,
  label: string,
): NativeParityPgDiagnostics {
  const requiresParameterizedJoin = requiresP0ParameterizedJoin(queryId);
  const diagnostics = warmRuns.map((run, index) => assertPgRunDiagnosticsContract(
    run.pgDiagnostics,
    `${queryId}/${label} warm#${index + 1}`,
    run.rows.length,
  ));
  const nativeOnly = diagnostics.every((entry) => entry.executionMode === 'native-qlever-tree');
  if (requiresParameterizedJoin && !nativeOnly) {
    const missing: string[] = [];
    for (const [index, entry] of diagnostics.entries()) {
      const runLabel = `${queryId}/${label} warm#${index + 1}`;
      if (typeof entry.backendRows !== 'number') missing.push(`missing backendRows for ${runLabel}`);
      if (typeof entry.errorCount !== 'number') missing.push(`missing errorCount for ${runLabel}`);
      if (!('fallbackReason' in entry)) missing.push(`missing fallbackReason for ${runLabel}`);
      if (typeof entry.parameterized !== 'boolean') missing.push(`missing parameterized for ${runLabel}`);
      if (typeof entry.seedRows !== 'number') missing.push(`missing seedRows for ${runLabel}`);
      if (typeof entry.uniqueJoinTuples !== 'number') missing.push(`missing uniqueJoinTuples for ${runLabel}`);
      if (
        typeof entry.seedRows === 'number' &&
        typeof entry.uniqueJoinTuples === 'number' &&
        typeof entry.backendRows === 'number'
      ) {
        const largestLogicalInputRows = Math.max(entry.seedRows, entry.uniqueJoinTuples);
        const intermediateRows = Math.max(entry.compressedRows, entry.backendRows);
        const reason = typeof entry.intermediateBoundReason === 'string' && entry.intermediateBoundReason.trim().length > 0
          ? entry.intermediateBoundReason
          : null;
        const boundExceeded = largestLogicalInputRows === 0
          ? intermediateRows !== 0
          : intermediateRows > largestLogicalInputRows * 10;
        if (boundExceeded && !reason) {
          missing.push(`intermediate rows exceeded 10x logical input for ${runLabel} without diagnostic reason: ${intermediateRows} > 10 * ${largestLogicalInputRows}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(missing.join('\n'));
    }
  }
  const cacheStatuses = new Set(diagnostics.map((entry) => entry.cacheStatus));
  const fallbackReasons = new Set(diagnostics.map((entry) => entry.fallbackReason).filter((entry) => entry !== undefined));
  const intermediateBoundReasons = new Set(diagnostics.map((entry) => entry.intermediateBoundReason).filter((entry) => entry !== undefined));
  const summary: NativeParityPgDiagnostics = {
    backendRows: diagnostics.every((entry) => typeof entry.backendRows === 'number')
      ? median(diagnostics.map((entry) => entry.backendRows!))
      : median(diagnostics.map((entry) => entry.compressedRows)),
    backendCompressedBytes: median(diagnostics.map((entry) => entry.backendCompressedBytes)),
    cacheStatus: cacheStatuses.size === 1 ? diagnostics[0].cacheStatus : [...cacheStatuses].join(','),
    compressedCursorBatches: median(diagnostics.map((entry) => entry.compressedCursorBatches)),
    compressedRows: median(diagnostics.map((entry) => entry.compressedRows)),
    errorCount: diagnostics.every((entry) => typeof entry.errorCount === 'number')
      ? median(diagnostics.map((entry) => entry.errorCount!))
      : 0,
    fallbackReason: fallbackReasons.size === 0
      ? null
      : fallbackReasons.size === 1 ? [...fallbackReasons][0]! : [...fallbackReasons].join(','),
    nativeOrderPageRows: median(diagnostics.map((entry) => entry.nativeOrderPageRows)),
    parameterized: !nativeOnly && diagnostics.every((entry) => entry.parameterized === true),
    peakBatchRows: median(diagnostics.map((entry) => entry.peakBatchRows)),
    projectedColumns: median(diagnostics.map((entry) => entry.projectedColumns)),
    queryMemoryLimitBytes: median(diagnostics.map((entry) => entry.queryMemoryLimitBytes)),
    rowsDecoded: median(diagnostics.map((entry) => entry.rowsDecoded)),
    spiQuadRows: median(diagnostics.map((entry) => entry.spiQuadRows)),
  };
  const executionModes = new Set(diagnostics.map((entry) => entry.executionMode).filter((entry) => entry !== undefined));
  if (executionModes.size > 0) {
    summary.executionMode = executionModes.size === 1 ? [...executionModes][0]! : 'mixed';
  }
  if (diagnostics.every((entry) => typeof entry.seedRows === 'number')) {
    summary.seedRows = median(diagnostics.map((entry) => entry.seedRows!));
  }
  if (diagnostics.every((entry) => typeof entry.uniqueJoinTuples === 'number')) {
    summary.uniqueJoinTuples = median(diagnostics.map((entry) => entry.uniqueJoinTuples!));
  }
  if (intermediateBoundReasons.size > 0) {
    summary.intermediateBoundReason = intermediateBoundReasons.size === 1
      ? [...intermediateBoundReasons][0]!
      : [...intermediateBoundReasons].join(',');
  }
  return summary;
}

function promotionEvidence(report: NativeParityFullReport): NativeParityPromotionEvidence {
  const rdf3xThreshold = 1.25;
  const hasFailedRequiredCell = report.results.some((result) => result.status === 'failed');
  let aggregatePgWarmP50Ms = 0;
  let aggregateRdf3xWarmP50Ms = 0;

  for (const query of report.queries) {
    const pg = report.results.find((result) => result.queryId === query.id && result.engineId === 'pg-qlever');
    const rdf3x = report.results.find((result) => result.queryId === query.id && result.engineId === 'rdf3x');
    if (!pg?.latencyMs || !rdf3x?.latencyMs) {
      continue;
    }
    aggregatePgWarmP50Ms += pg.latencyMs.warm.p50;
    aggregateRdf3xWarmP50Ms += rdf3x.latencyMs.warm.p50;
  }

  const ratio = aggregatePgWarmP50Ms / Math.max(aggregateRdf3xWarmP50Ms, Number.MIN_VALUE);
  const pgQleverVsRdf3x = {
    aggregatePgWarmP50Ms,
    aggregateRdf3xWarmP50Ms,
    ratio,
    status: !hasFailedRequiredCell && ratio <= rdf3xThreshold ? 'pass' as const : 'reject' as const,
    threshold: rdf3xThreshold,
  };
  return {
    overall: { status: pgQleverVsRdf3x.status },
    pgQleverVsRdf3x,
  };
}

function requireEngineMatrix(engines: NativeParityEngineAdapter[]): Record<NativeParityReportEngineId, NativeParityEngineAdapter> {
  const byId = new Map<NativeParityReportEngineId, NativeParityEngineAdapter>();
  for (const engine of engines) {
    if (byId.has(engine.id)) {
      throw new Error(`duplicate engine adapter ${engine.id}`);
    }
    byId.set(engine.id, engine);
  }

  for (const engineId of nativeParityReportEngineIds) {
    if (!byId.has(engineId)) {
      throw new Error(`missing engine adapter ${engineId}`);
    }
  }

  return Object.fromEntries(nativeParityReportEngineIds.map((engineId) => [engineId, byId.get(engineId)!])) as Record<
    NativeParityReportEngineId,
    NativeParityEngineAdapter
  >;
}

function assertNotTimedOut(run: NativeParityEngineRun, engineId: string, queryId: string, phase: string): void {
  if (run.timedOut) {
    throw new Error(`timeout from ${engineId} for ${queryId} ${phase}`);
  }
}

function assertFixtureHash(
  run: NativeParityEngineRun,
  expectedSha256: string,
  engineId: string,
  queryId: string,
): void {
  if (run.fixtureSha256 !== expectedSha256) {
    throw new Error(`fixture hash mismatch for ${queryId}/${engineId}: expected ${expectedSha256}, got ${run.fixtureSha256}`);
  }
}

function assertMatchingResultDigests(report: NativeParityFullReport): void {
  const accessScopedIds = new Set<string>(nativeParityP0AccessScopedWorkloadIds);
  for (const query of report.queries) {
    const rows = report.results.filter((result) => result.queryId === query.id && result.status === 'ok' && result.resultDigests);
    const [baseline] = rows;
    if (!baseline) {
      continue;
    }
    if (accessScopedIds.has(query.id)) {
      continue;
    }
    for (const result of rows.slice(1)) {
      if (
        result.resultDigests!.ordered !== baseline.resultDigests!.ordered ||
        result.resultDigests!.multiset !== baseline.resultDigests!.multiset
      ) {
        throw new Error(
          `result digest mismatch for ${query.id}: ${baseline.engineId} ordered=${baseline.resultDigests!.ordered} multiset=${baseline.resultDigests!.multiset}, ${result.engineId} ordered=${result.resultDigests!.ordered} multiset=${result.resultDigests!.multiset}`,
        );
      }
    }
  }
}

function resultLabel(queryId: string, engineId: string, phase: string): string {
  return `${queryId}/${engineId} ${phase}`;
}

function assertRunDigest(
  run: NativeParityEngineRun,
  expected: { multiset: string; ordered: string },
  label: string,
): void {
  const actual = digestResultRows(run.rows);
  if (actual.ordered !== expected.ordered || actual.multiset !== expected.multiset) {
    throw new Error(
      `result digest mismatch for ${label}: expected ordered=${expected.ordered} multiset=${expected.multiset}, got ordered=${actual.ordered} multiset=${actual.multiset}`,
    );
  }
}

const kPromotionFloatTolerance = 1e-9;

function promotionNumberMismatch(
  label: string,
  expected: number | undefined,
  actual: number | undefined,
  errors: string[],
): void {
  if (expected === undefined) {
    return;
  }
  if (actual === undefined || Math.abs(expected - actual) > kPromotionFloatTolerance) {
    errors.push(`promotion ${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function promotionStringMismatch(
  label: string,
  expected: string | undefined,
  actual: string | undefined,
  errors: string[],
): void {
  if (expected !== actual) {
    errors.push(`promotion ${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function pgDiagnosticsContractErrors(
  diagnostics: NativeParityPgDiagnostics | undefined,
  label: string,
  resultRowCount: number,
): string[] {
  if (!diagnostics) {
    return [`missing pgDiagnostics for ${label}`];
  }
  const errors: string[] = [];
  if (!diagnostics.cacheStatus || diagnostics.cacheStatus.startsWith('cached')) {
    errors.push(`result cache hit in PG run: ${diagnostics.cacheStatus}`);
  }
  if (diagnostics.queryMemoryLimitBytes <= 0) {
    errors.push(`invalid queryMemoryLimitBytes for ${label}`);
  }
  if (resultRowCount > 0 && diagnostics.peakBatchRows <= 0) {
    errors.push(`invalid peakBatchRows for ${label}`);
  }
  const nativeOrderPage = diagnostics.nativeOrderPageRows > 0;
  if (resultRowCount > 0 && diagnostics.spiQuadRows <= 0 && !nativeOrderPage) {
    errors.push(`PG run did not use the atomic B-tree scan path for ${label}`);
  }
  if (diagnostics.compressedCursorBatches !== 0 || diagnostics.compressedRows !== 0) {
    errors.push(`PG run used retired compressed-index diagnostics for ${label}`);
  }
  if (diagnostics.projectedColumns < 0 || diagnostics.projectedColumns > 4) {
    errors.push(`PG projectedColumns must be in 0..4 for ${label}`);
  }
  return errors;
}

function validatePromotionEvidence(report: NativeParityFullReport): string[] {
  if (!report.promotion) {
    return ['missing promotion evidence'];
  }
  const expected = promotionEvidence(report);
  const actual = report.promotion;
  const errors: string[] = [];
  promotionStringMismatch('pgQleverVsRdf3x.status', expected.pgQleverVsRdf3x.status, actual.pgQleverVsRdf3x?.status, errors);
  promotionNumberMismatch('pgQleverVsRdf3x.aggregatePgWarmP50Ms', expected.pgQleverVsRdf3x.aggregatePgWarmP50Ms, actual.pgQleverVsRdf3x?.aggregatePgWarmP50Ms, errors);
  promotionNumberMismatch('pgQleverVsRdf3x.aggregateRdf3xWarmP50Ms', expected.pgQleverVsRdf3x.aggregateRdf3xWarmP50Ms, actual.pgQleverVsRdf3x?.aggregateRdf3xWarmP50Ms, errors);
  promotionNumberMismatch('pgQleverVsRdf3x.ratio', expected.pgQleverVsRdf3x.ratio, actual.pgQleverVsRdf3x?.ratio, errors);
  promotionNumberMismatch('pgQleverVsRdf3x.threshold', expected.pgQleverVsRdf3x.threshold, actual.pgQleverVsRdf3x?.threshold, errors);
  promotionStringMismatch('overall.status', expected.overall.status, actual.overall?.status, errors);
  return errors;
}

export function validateNativeParityBenchmarkReport(report: NativeParityFullReport): string[] {
  const errors = validateNativeParityReportMatrix(report);
  if (!report.dataset) {
    errors.push('missing dataset');
  } else {
    if (!report.dataset.name) errors.push('dataset.name must be non-empty');
    assertSha256(report.dataset.sha256, 'dataset.sha256', errors);
  }

  for (const query of report.queries ?? []) {
    assertSha256(query.sha256, `query ${query.id} sha256`, errors);
  }

  for (const engineId of nativeParityReportEngineIds) {
    const engine = report.engines?.[engineId];
    if (!engine) {
      errors.push(`missing engine identity ${engineId}`);
    } else {
      if (engine.id !== engineId) errors.push(`engine identity mismatch for ${engineId}`);
      if (!engine.version) errors.push(`missing engine version for ${engineId}`);
    }
  }

  for (const result of report.results ?? []) {
    if (result.status !== 'ok' && result.status !== 'failed') {
      errors.push(`invalid status for ${result.queryId}/${result.engineId}`);
    }
    if (result.status === 'failed') {
      if (!result.failure) {
        errors.push(`missing failure for ${result.queryId}/${result.engineId}`);
      } else {
        if (!['cold', 'warm', 'concurrency'].includes(result.failure.phase)) {
          errors.push(`invalid failure phase for ${result.queryId}/${result.engineId}`);
        }
        if (!result.failure.message) {
          errors.push(`missing failure message for ${result.queryId}/${result.engineId}`);
        }
      }
      errors.push(`failed required result cell ${result.queryId}/${result.engineId}`);
      continue;
    }
    if (!result.latencyMs) {
      errors.push(`missing latencyMs for ${result.queryId}/${result.engineId}`);
    } else {
      for (const phase of ['cold', 'warm'] as const) {
        const latency = result.latencyMs[phase];
        if (!isNonNegativeNumber(latency?.p50)) {
          errors.push(`invalid ${phase}.p50 latency for ${result.queryId}/${result.engineId}`);
        }
        if (!isNonNegativeNumber(latency?.p95)) {
          errors.push(`invalid ${phase}.p95 latency for ${result.queryId}/${result.engineId}`);
        }
      }
    }
    if (!result.resultDigests) {
      errors.push(`missing resultDigests for ${result.queryId}/${result.engineId}`);
    } else {
      assertSha256(result.resultDigests.ordered, `ordered result digest for ${result.queryId}/${result.engineId}`, errors);
      assertSha256(result.resultDigests.multiset, `multiset result digest for ${result.queryId}/${result.engineId}`, errors);
    }
    if ('rows' in result && !isNonNegativeInteger(result.rows)) {
      errors.push(`invalid rows for ${result.queryId}/${result.engineId}`);
    } else if (!('rows' in result)) {
      errors.push(`missing rows for ${result.queryId}/${result.engineId}`);
    }
    for (const entry of result.concurrency ?? []) {
      const label = `${result.queryId}/${result.engineId} c${entry.level}`;
      if (!entry.resultDigests) {
        errors.push(`missing concurrency resultDigests for ${label}`);
      } else {
        assertSha256(entry.resultDigests.ordered, `ordered concurrency result digest for ${label}`, errors);
        assertSha256(entry.resultDigests.multiset, `multiset concurrency result digest for ${label}`, errors);
        if (result.resultDigests && (
          entry.resultDigests.ordered !== result.resultDigests.ordered ||
          entry.resultDigests.multiset !== result.resultDigests.multiset
        )) {
          errors.push(`concurrency result digest mismatch for ${label}`);
        }
      }
      if (entry.rows === undefined) {
        errors.push(`missing concurrency rows for ${label}`);
      } else if (!isNonNegativeInteger(entry.rows)) {
        errors.push(`invalid concurrency rows for ${label}`);
      } else if (entry.rows !== result.rows) {
        errors.push(`concurrency row count mismatch for ${label}: expected ${result.rows}, got ${entry.rows}`);
      }
    }
    if (result.engineId === 'pg-qlever') {
      errors.push(...pgStageValidationErrors(result.pgStages, `${result.queryId}/pg-qlever`));
      errors.push(...pgDiagnosticsContractErrors(result.pgDiagnostics, `${result.queryId}/pg-qlever`, result.rows ?? 0));
    }
  }


  errors.push(...validatePromotionEvidence(report));

  return errors;
}

function assertValidReport(report: NativeParityFullReport): void {
  const errors = [
    ...validateNativeParityReportAgainstSchema(report),
    ...validateNativeParityBenchmarkReport(report),
  ];
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  assertMatchingResultDigests(report);
}

function assertWritableReport(report: NativeParityFullReport): void {
  const errors = [
    ...validateNativeParityReportAgainstSchema(report),
    ...validateNativeParityReportMatrix(report),
  ];
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

function assertCompletedReportEvidence(report: NativeParityFullReport): void {
  const errors = validateNativeParityBenchmarkReport(report)
    .filter((error) => !error.startsWith('failed required result cell '));
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  assertMatchingResultDigests(report);
}

export async function runNativeParityBenchmark(input: NativeParityBenchmarkInput): Promise<NativeParityFullReport> {
  const warmRepetitions = input.warmRepetitions ?? 5;
  const concurrencyLevels = input.concurrencyLevels ?? [];
  if (concurrencyLevels.some((level) => !Number.isInteger(level) || level < 1)) {
    throw new Error('concurrency levels must be positive integers');
  }
  if (new Set(concurrencyLevels).size !== concurrencyLevels.length) {
    throw new Error('concurrency levels must be unique');
  }
  const engines = requireEngineMatrix(input.engines);
  const querySpecs = input.queries.map((query) => ({
    id: query.id,
    path: query.path,
    sha256: sha256(readFileSync(query.path)),
  }));

  const report: NativeParityFullReport = {
    dataset: input.dataset,
    engines: {
      'native-qlever': { id: 'native-qlever', version: engines['native-qlever'].version },
      'pg-qlever': { id: 'pg-qlever', version: engines['pg-qlever'].version },
      rdf3x: { id: 'rdf3x', version: engines.rdf3x.version },
    },
    promotion: {
      overall: { status: 'reject' },
      pgQleverVsRdf3x: {
        aggregatePgWarmP50Ms: 0,
        aggregateRdf3xWarmP50Ms: 0,
        ratio: 0,
        status: 'pass',
        threshold: 1.25,
      },
    },
    queries: querySpecs.map(({ id, sha256: querySha }) => ({ id, sha256: querySha })),
    results: [],
  };

  for (const query of querySpecs) {
    const accessScopedWorkloadIds = new Set<string>(input.p0JoinAccessScopedWorkloadIds ?? nativeParityP0AccessScopedWorkloadIds);
    const accessScopedBaseline = accessScopedWorkloadIds.has(query.id)
      ? input.p0JoinAccessScopedBaselines?.[query.id]
      : undefined;
    let coldBaseline: {
      digests: { multiset: string; ordered: string };
      engineId: NativeParityReportEngineId;
      rows: NativeParityResultRow[];
    } | undefined;
    for (const engineId of nativeParityReportEngineIds) {
      const engine = engines[engineId];
      let cellPhase: 'cold' | 'concurrency' | 'warm' = 'cold';
      try {
        const cold = await engine.runQuery({
          attempt: 1,
          concurrencyLevel: 1,
          fixture: input.dataset,
          phase: 'cold',
          queryId: query.id,
          queryPath: query.path,
          repetition: 0,
          timeoutMs: input.timeoutMs,
        });
        assertNotTimedOut(cold, engineId, query.id, 'cold');
        assertFixtureHash(cold, input.dataset.sha256, engineId, query.id);
        if (engineId === 'pg-qlever') {
          assertPgStages(cold.pgStages, `${query.id}/pg-qlever cold`);
          assertPgRunDiagnosticsContract(cold.pgDiagnostics, `${query.id}/pg-qlever cold`, cold.rows.length);
        }
        const coldDigests = digestResultRows(cold.rows);
        if (accessScopedBaseline && engineId === 'pg-qlever') {
          if (
            cold.rows.length !== accessScopedBaseline.rows ||
            coldDigests.ordered !== accessScopedBaseline.digest.ordered ||
            coldDigests.multiset !== accessScopedBaseline.digest.multiset
          ) {
            throw new Error(
              `access-scoped baseline mismatch for ${query.id}/${engineId}: expected rows=${accessScopedBaseline.rows} ordered=${accessScopedBaseline.digest.ordered} multiset=${accessScopedBaseline.digest.multiset}, got rows=${cold.rows.length} ordered=${coldDigests.ordered} multiset=${coldDigests.multiset}`,
            );
          }
        } else if (!accessScopedBaseline && !coldBaseline) {
          coldBaseline = {
            digests: coldDigests,
            engineId,
            rows: cold.rows,
          };
        } else if (!accessScopedBaseline && coldBaseline && (
          coldDigests.ordered !== coldBaseline.digests.ordered ||
          coldDigests.multiset !== coldBaseline.digests.multiset
        )) {
          throw new Error(
            `result digest mismatch for ${query.id}: ${coldBaseline.engineId} rows=${coldBaseline.rows.length} preview=${JSON.stringify(coldBaseline.rows.slice(0, 3))} ordered=${coldBaseline.digests.ordered} multiset=${coldBaseline.digests.multiset}, ${engineId} rows=${cold.rows.length} preview=${JSON.stringify(cold.rows.slice(0, 3))} ordered=${coldDigests.ordered} multiset=${coldDigests.multiset}`,
          );
        }
        if (accessScopedBaseline && !coldBaseline && engineId === 'pg-qlever') {
          coldBaseline = {
            digests: accessScopedBaseline.digest,
            engineId,
            rows: cold.rows,
          };
        }

        const warmRuns: NativeParityEngineRun[] = [];
        let warmWallMs = 0;
        cellPhase = 'warm';
        for (let repetition = 1; repetition <= warmRepetitions; repetition += 1) {
          const warmStartedAt = performance.now();
          const warm = await engine.runQuery({
            attempt: 1,
            concurrencyLevel: 1,
            fixture: input.dataset,
            phase: 'warm',
            queryId: query.id,
            queryPath: query.path,
            repetition,
            timeoutMs: input.timeoutMs,
          });
          warmWallMs += performance.now() - warmStartedAt;
          assertNotTimedOut(warm, engineId, query.id, `warm#${repetition}`);
          assertFixtureHash(warm, input.dataset.sha256, engineId, query.id);
          if (engineId === 'pg-qlever') {
            assertPgStages(warm.pgStages, `${query.id}/pg-qlever warm#${repetition}`);
            assertPgRunDiagnosticsContract(warm.pgDiagnostics, `${query.id}/pg-qlever warm#${repetition}`, warm.rows.length);
          }
          assertRunDigest(warm, coldDigests, resultLabel(query.id, engineId, `warm#${repetition}`));
          warmRuns.push(warm);
        }

        const concurrency = [] as NonNullable<NativeParityBenchmarkReportResult['concurrency']>;
        cellPhase = 'concurrency';
        for (const level of concurrencyLevels) {
          if (level === 1) {
            concurrency.push(engineId === 'pg-qlever'
              ? concurrencySummaryWithPgEvidence(1, warmRuns, warmWallMs, query.id, 'pg-qlever', coldDigests, cold.rows.length)
              : concurrencySummary(1, warmRuns, warmWallMs, coldDigests, cold.rows.length));
            continue;
          }
          const startedAt = performance.now();
          const runs = await Promise.all(Array.from({ length: level }, (_, requestIndex) => engine.runQuery({
            attempt: requestIndex + 1,
            concurrencyLevel: level,
            fixture: input.dataset,
            phase: 'warm',
            queryId: query.id,
            queryPath: query.path,
            repetition: warmRepetitions + requestIndex + 1,
            timeoutMs: input.timeoutMs,
          })));
          const wallMs = performance.now() - startedAt;
          for (const [requestIndex, run] of runs.entries()) {
            const label = `concurrency-${level}#${requestIndex + 1}`;
            assertNotTimedOut(run, engineId, query.id, label);
            assertFixtureHash(run, input.dataset.sha256, engineId, query.id);
            if (engineId === 'pg-qlever') {
              assertPgStages(run.pgStages, `${query.id}/pg-qlever ${label}`);
              assertPgRunDiagnosticsContract(run.pgDiagnostics, `${query.id}/pg-qlever ${label}`, run.rows.length);
            }
            assertRunDigest(run, coldDigests, resultLabel(query.id, engineId, label));
          }
          concurrency.push(engineId === 'pg-qlever'
            ? concurrencySummaryWithPgEvidence(level, runs, wallMs, query.id, `pg-qlever c${level}`, coldDigests, cold.rows.length)
            : concurrencySummary(level, runs, wallMs, coldDigests, cold.rows.length));
        }

        report.results.push({
          ...(concurrency.length > 0 ? { concurrency } : {}),
          engineId,
          latencyMs: summarizeLatency(cold.elapsedMs, warmRuns.map((run) => run.elapsedMs)),
          ...(engineId === 'pg-qlever' ? {
            pgDiagnostics: {
              ...summarizeWarmPgDiagnostics(warmRuns, query.id, 'pg-qlever'),
              correctnessDigest: coldDigests.ordered,
            },
            pgStages: summarizeWarmPgStages(warmRuns, query.id),
          } : {}),
          queryId: query.id,
          resultDigests: coldDigests,
          rows: cold.rows.length,
          status: 'ok',
        });
      } catch (error) {
        report.results.push({
          engineId,
          failure: {
            message: error instanceof Error ? error.message : String(error),
            phase: cellPhase,
          },
          queryId: query.id,
          status: 'failed',
        });
      }
    }

  }

  report.promotion = promotionEvidence(report);
  assertWritableReport(report);
  if (report.results.some((result) => result.status === 'failed')) {
    throw new NativeParityBenchmarkRejectedError(report);
  }
  assertCompletedReportEvidence(report);
  assertValidReport(report);
  return report;
}

export function generateNativeParityMarkdown(report: NativeParityFullReport): string {
  assertWritableReport(report);
  const lines = [
    '# Native QLever Parity Benchmark',
    '',
    `Dataset: ${report.dataset.name}`,
    '',
    '## PG Stage Contributions',
    '',
    '| Query | Stage | Stage ms | Contribution |',
    '| --- | --- | ---: | ---: |',
  ];

  for (const query of report.queries) {
    const pg = report.results.find((result) => result.queryId === query.id && result.engineId === 'pg-qlever');
    if (pg?.status === 'failed') {
      continue;
    }
    if (!pg?.pgStages) {
      throw new Error(`missing PG stage evidence for ${query.id}`);
    }
    const totalStageMs = pg.pgStages.reduce((sum, stage) => sum + stage.stageMs, 0);
    const ranked = [...pg.pgStages].sort((left, right) => right.stageMs - left.stageMs);
    for (const stage of ranked) {
      const contribution = totalStageMs === 0 ? 0 : (stage.stageMs / totalStageMs) * 100;
      lines.push(`| ${query.id} | ${stage.name} | ${stage.stageMs.toFixed(3)} | ${contribution.toFixed(2)}% |`);
    }
  }

  lines.push(
    '',
    '## PG Warm Diagnostics',
    '',
    '| Query | Source | Cache | Retired compressed batches | Retired compressed rows | Bytes | Rows decoded | Columns | Memory bytes | Peak rows | Atomic SPI rows |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const query of report.queries) {
    const pg = report.results.find((result) => result.queryId === query.id && result.engineId === 'pg-qlever');
    if (pg?.status === 'failed') {
      continue;
    }
    if (!pg?.pgDiagnostics) {
      throw new Error(`missing PG diagnostics evidence for ${query.id}`);
    }
    const diagnosticRows: [string, NativeParityPgDiagnostics][] = [
      ['atomic-btree', pg.pgDiagnostics],
    ];
    for (const [source, diagnostics] of diagnosticRows) {
      lines.push(`| ${query.id} | ${source} | ${diagnostics.cacheStatus} | ${diagnostics.compressedCursorBatches.toFixed(0)} | ${diagnostics.compressedRows.toFixed(0)} | ${diagnostics.backendCompressedBytes.toFixed(0)} | ${diagnostics.rowsDecoded.toFixed(0)} | ${diagnostics.projectedColumns.toFixed(0)} | ${diagnostics.queryMemoryLimitBytes.toFixed(0)} | ${diagnostics.peakBatchRows.toFixed(0)} | ${diagnostics.spiQuadRows.toFixed(0)} |`);
    }
  }

  if (report.results.some((result) => result.concurrency?.length)) {
    lines.push(
      '',
      '## Concurrency',
      '',
      '| Query | Engine | Concurrency | Requests | p50 ms | p95 ms | Throughput qps |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const result of report.results) {
      if (result.status === 'failed') {
        continue;
      }
      for (const load of result.concurrency ?? []) {
        lines.push(`| ${result.queryId} | ${result.engineId} | ${load.level} | ${load.requests} | ${load.p50Ms.toFixed(3)} | ${load.p95Ms.toFixed(3)} | ${load.throughputQps.toFixed(3)} |`);
      }
    }
  }

  lines.push(
    '',
    '## Failed Cells',
    '',
    '| Query | Engine | Phase | Message |',
    '| --- | --- | --- | --- |',
  );
  for (const result of report.results) {
    if (result.status === 'failed') {
      const message = (result.failure?.message ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\r\n|\r|\n/g, '<br>')
        .replace(/\|/g, '\\|');
      lines.push(`| ${result.queryId} | ${result.engineId} | ${result.failure?.phase ?? 'unknown'} | ${message} |`);
    }
  }

  lines.push(
    '',
    '## Promotion Gate',
    '',
    `PG QLever vs RDF3X: ${report.promotion.pgQleverVsRdf3x.status}; ` +
      `pgWarmP50Sum=${report.promotion.pgQleverVsRdf3x.aggregatePgWarmP50Ms.toFixed(3)} ms; ` +
      `rdf3xWarmP50Sum=${report.promotion.pgQleverVsRdf3x.aggregateRdf3xWarmP50Ms.toFixed(3)} ms; ` +
      `ratio=${report.promotion.pgQleverVsRdf3x.ratio.toFixed(3)}; ` +
      `threshold=${report.promotion.pgQleverVsRdf3x.threshold.toFixed(3)}.`,
    `Overall: ${report.promotion.overall.status}.`,
    '',
  );
  return lines.join('\n');
}

export function nativeParityReportPaths(datasetName: string, date: string): {
  dataPath: string;
  markdownPath: string;
} {
  return {
    dataPath: path.join('qlever/reports/data', `${datasetName}-${date}.json`),
    markdownPath: path.join('qlever/reports', `${date}-${datasetName}.md`),
  };
}

async function writeNativeParityReports(report: NativeParityFullReport, date: string): Promise<void> {
  assertWritableReport(report);
  const markdown = generateNativeParityMarkdown(report);
  const { dataPath, markdownPath } = nativeParityReportPaths(report.dataset.name, date);
  await mkdir(path.dirname(dataPath), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, markdown, 'utf8');
}

export type NativeParityProcessExecutor = (input: ProcessExecutionInput) => Promise<NativeParityEngineRun>;

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function qleverRuntimeMs(payload: Record<string, unknown>): number {
  const runtime = jsonObject(payload.runtimeInformation);
  const tree = jsonObject(runtime.query_execution_tree ?? runtime.queryExecutionTree);
  return numberFrom(tree.total_time ?? tree.totalTime, 0);
}

export function parseNativeQleverRun(stdout: string, fixtureSha256: string): NativeParityEngineRun {
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  return {
    elapsedMs: qleverRuntimeMs(payload),
    fixtureSha256,
    rows: extractQleverResultRows(payload) ?? extractRows(payload),
  };
}

function stagesFromDiagnostics(diagnostics: unknown): NativeParityPgStage[] {
  const object = jsonObject(diagnostics);
  if (Array.isArray(object.pgStages)) {
    return assertPgStages(object.pgStages, 'SQL envelope');
  }
  const stageMs = jsonObject(object.stageMs);
  const errors: string[] = [];
  for (const stageName of pgStageNames) {
    if (!(stageName in stageMs)) {
      errors.push(`missing PG stage ${stageName} for SQL envelope`);
    } else if (!isNonNegativeNumber(stageMs[stageName])) {
      errors.push(`invalid PG stageMs for SQL envelope`);
    }
  }
  if (!isNonNegativeInteger(object.backendScanCount)) {
    errors.push('invalid PG backendScanCount for SQL envelope');
  }
  if (!isNonNegativeNumber(object.backendRows)) {
    errors.push('invalid PG backendRows for SQL envelope');
  }
  if (!isNonNegativeNumber(object.backendBytes)) {
    errors.push('invalid PG backendBytes for SQL envelope');
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return Array.from(pgStageNames, (name) => ({
    backendBytes: name === 'backend-scan' ? object.backendBytes as number : 0,
    backendRows: name === 'backend-scan' ? object.backendRows as number : 0,
    backendScanCount: name === 'backend-scan' ? object.backendScanCount as number : 0,
    name,
    stageMs: stageMs[name] as number,
  }));
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rawFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function rawOutputPrefix(input: {
  attempt?: number;
  concurrencyLevel?: number;
  engineId: string;
  phase?: string;
  queryId: string;
  repetition?: number;
}): string {
  return [
    rawFileSegment(input.engineId),
    rawFileSegment(input.queryId),
    rawFileSegment(input.phase ?? 'run'),
    `r${input.repetition ?? 0}`,
    `c${input.concurrencyLevel ?? 1}`,
    `a${input.attempt ?? 1}`,
  ].join('-');
}

function rawLimitBytes(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key] ?? process.env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function secretValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (!value || value.length < 3) continue;
    if (/(PASSWORD|TOKEN|SECRET|AUTHORIZATION|AUTH|API_KEY|ACCESS_KEY)/i.test(key)) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactRawText(
  text: string,
  env: Record<string, string | undefined>,
  extraSecrets: readonly string[] = [],
): { redacted: boolean; text: string } {
  let redacted = false;
  let output = text
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, () => {
      redacted = true;
      return 'Authorization: Bearer [REDACTED]';
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, () => {
      redacted = true;
      return 'Bearer [REDACTED]';
    });
  const secrets = new Set(secretValues(env));
  for (const secret of extraSecrets) {
    if (secret.length >= 3) {
      secrets.add(secret);
    }
  }
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    const next = output.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    if (next !== output) {
      redacted = true;
      output = next;
    }
  }
  return { redacted, text: output };
}

async function rawDirectoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { recursive: true })) {
    const filePath = path.join(root, String(entry));
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) {
        total += fileStat.size;
      }
    } catch {
      // Raw capture is best-effort diagnostics; racing cleanup should not fail the benchmark.
    }
  }
  return total;
}

async function writeRawCapture(
  rawOutputDir: string,
  filename: string,
  content: string,
  env: Record<string, string | undefined> = {},
  extraSecrets: readonly string[] = [],
): Promise<void> {
  await mkdir(rawOutputDir, { recursive: true });
  const mergedEnv = { ...process.env, ...env };
  const perFileLimit = rawLimitBytes(mergedEnv, 'NATIVE_PARITY_RAW_FILE_LIMIT_BYTES', 1024 * 1024);
  const dirLimit = rawLimitBytes(mergedEnv, 'NATIVE_PARITY_RAW_DIR_LIMIT_BYTES', 64 * 1024 * 1024);
  const redacted = redactRawText(content, mergedEnv, extraSecrets);
  const encoded = Buffer.from(redacted.text, 'utf8');
  const currentBytes = await rawDirectoryBytes(rawOutputDir);
  const remainingBytes = Math.max(0, dirLimit - currentBytes);
  const byteLimit = Math.min(perFileLimit, remainingBytes);
  const written = encoded.subarray(0, byteLimit);
  const truncated = written.length < encoded.length;
  await writeFile(path.join(rawOutputDir, filename), written, 'utf8');
  await writeFile(path.join(rawOutputDir, `${filename}.metadata.json`), `${JSON.stringify({
    dirLimitBytes: dirLimit,
    originalBytes: encoded.length,
    perFileLimitBytes: perFileLimit,
    redacted: redacted.redacted,
    truncated,
    writtenBytes: written.length,
  }, null, 2)}\n`, 'utf8');
}

function cacheStatusFromProfile(profile: unknown): string {
  const object = jsonObject(profile);
  const root = jsonObject(object.root);
  return stringFrom(root.cacheStatus);
}

function assertPgRunDiagnostics(
  diagnostics: unknown,
  profile: unknown,
  resultRowCount = 0,
): NativeParityPgDiagnostics {
  const object = jsonObject(diagnostics);
  const profileObject = jsonObject(profile);
  const profileRoot = jsonObject(profileObject.root);
  const profileDetails = jsonObject(profileRoot.details);
  const executionMode = stringFrom(object.executionMode) || stringFrom(profileObject.executionMode);
  const nativeOnly = executionMode === 'native-qlever-tree';
  const cacheStatus = cacheStatusFromProfile(profile);
  const errors: string[] = [];
  if (!cacheStatus) {
    errors.push('missing PG cacheStatus');
  } else if (cacheStatus.startsWith('cached')) {
    errors.push(`result cache hit in PG run: ${cacheStatus}`);
  }
  const requiredNumbers = [
    'compressedCursorBatches',
    'compressedRows',
    'spiQuadRows',
    'peakBatchRows',
    'backendCompressedBytes',
    'rowsDecoded',
    'projectedColumns',
    'queryMemoryLimitBytes',
  ] as const;
  for (const key of requiredNumbers) {
    if (!isNonNegativeNumber(object[key])) {
      errors.push(`invalid PG ${key}`);
    }
  }
  const nativeOrderPageRows = isNonNegativeNumber(object.nativeOrderPageRows)
    ? object.nativeOrderPageRows
    : 0;
  const projectedColumns =
    object.columnsDecompressed === 0 && object.projectedColumns !== 0
      ? 0
      : object.projectedColumns;
  const batchSize = isNonNegativeNumber(object.batchSize) && object.batchSize > 0
    ? object.batchSize
    : 65536;
  if (
    resultRowCount > 0 &&
    (!isNonNegativeNumber(object.spiQuadRows) || object.spiQuadRows <= 0) &&
    nativeOrderPageRows <= 0
  ) {
    errors.push('PG run did not use the atomic B-tree scan path');
  }
  if (
    resultRowCount > 0 &&
    (object.compressedCursorBatches !== 0 || object.compressedRows !== 0)
  ) {
    errors.push('PG run used retired compressed-index diagnostics');
  }
  if (isNonNegativeNumber(object.peakBatchRows) && object.peakBatchRows > batchSize) {
    errors.push('PG peakBatchRows exceeded requested batch size');
  }
  if (
    isNonNegativeNumber(projectedColumns) &&
    (projectedColumns < 0 || projectedColumns > 4)
  ) {
    errors.push('PG projectedColumns must be in 0..4');
  }
  if (isNonNegativeNumber(object.queryMemoryLimitBytes) && object.queryMemoryLimitBytes <= 0) {
    errors.push('PG queryMemoryLimitBytes must be positive');
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return {
    ...(isNonNegativeNumber(profileDetails.dependentBackendRows)
      ? { backendRows: profileDetails.dependentBackendRows as number }
      : isNonNegativeNumber(object.backendRows) ? { backendRows: object.backendRows as number } : {}),
    backendCompressedBytes: object.backendCompressedBytes as number,
    cacheStatus,
    compressedCursorBatches: object.compressedCursorBatches as number,
    compressedRows: object.compressedRows as number,
    errorCount: isNonNegativeNumber(object.errorCount) ? object.errorCount as number : 0,
    ...(executionMode ? { executionMode } : {}),
    ...(typeof profileDetails.fallbackReason === 'string' || profileDetails.fallbackReason === null
      ? { fallbackReason: profileDetails.fallbackReason as string | null }
      : nativeOnly ? { fallbackReason: null } : {}),
    ...(typeof profileDetails.intermediateBoundReason === 'string' || profileDetails.intermediateBoundReason === null
      ? { intermediateBoundReason: profileDetails.intermediateBoundReason as string | null }
      : {}),
    ...(typeof profileDetails.parameterized === 'boolean'
      ? { parameterized: profileDetails.parameterized as boolean }
      : nativeOnly ? { parameterized: false } : {}),
    nativeOrderPageRows,
    peakBatchRows: object.peakBatchRows as number,
    projectedColumns: projectedColumns as number,
    queryMemoryLimitBytes: object.queryMemoryLimitBytes as number,
    rowsDecoded: object.rowsDecoded as number,
    ...(isNonNegativeNumber(profileDetails.seedRows) ? { seedRows: profileDetails.seedRows as number } : {}),
    spiQuadRows: object.spiQuadRows as number,
    ...(isNonNegativeNumber(profileDetails.uniqueJoinTuples) ? { uniqueJoinTuples: profileDetails.uniqueJoinTuples as number } : {}),
  };
}

function parseSqlEnvelope(
  stdout: string,
  fixtureSha256: string,
  includeStages: boolean,
): NativeParityEngineRun {
  const payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const resultEnvelope = jsonObject(payload.result);
  const status = stringFrom(resultEnvelope.status);
  if (includeStages && status !== 'ok') {
    throw new Error(`PG query status missing or not ok: ${stringFrom(resultEnvelope.error) || status || 'missing'}`);
  }
  const body = typeof resultEnvelope.body === 'string'
    ? JSON.parse(resultEnvelope.body)
    : resultEnvelope.body && typeof resultEnvelope.body === 'object' && !Array.isArray(resultEnvelope.body)
      ? resultEnvelope.body as Record<string, unknown>
      : resultEnvelope;
  const rows = extractRows(body);
  const diagnostics = payload.diagnostics ?? resultEnvelope.diagnostics;
  const profile = resultEnvelope.profile ?? payload.profile;
  return {
    elapsedMs: numberFrom(payload.elapsedMs, 0),
    fixtureSha256,
    ...(includeStages ? {
      pgDiagnostics: assertPgRunDiagnostics(diagnostics, profile, rows.length),
      pgStages: stagesFromDiagnostics(diagnostics),
    } : {}),
    rows,
  };
}

export function parsePgQleverRun(stdout: string, fixtureSha256: string): NativeParityEngineRun {
  return parseSqlEnvelope(stdout, fixtureSha256, true);
}

export function parseRdf3xRun(stdout: string, fixtureSha256: string): NativeParityEngineRun {
  return parseSqlEnvelope(stdout, fixtureSha256, false);
}

export async function executeProcess(input: ProcessExecutionInput): Promise<NativeParityEngineRun> {
  const subprocess = Bun.spawn(input.argv, {
    detached: true,
    env: {
      ...process.env,
      ...(input.env ?? {}),
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  let timedOut = false;
  const terminateGroup = (signal: NodeJS.Signals): void => {
    const pid = subprocess.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        subprocess.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  };
  const killDelayMs = Math.min(100, Math.max(10, input.timeoutMs));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateGroup('SIGTERM');
    killTimer = setTimeout(() => terminateGroup('SIGKILL'), killDelayMs);
    killTimer.unref?.();
  }, input.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  clearTimeout(timeout);
  if (killTimer) {
    clearTimeout(killTimer);
  }
  const rawOutputDir = input.env?.NATIVE_PARITY_RAW_OUTPUT_DIR ?? process.env.NATIVE_PARITY_RAW_OUTPUT_DIR;
  if (rawOutputDir) {
    const prefix = rawOutputPrefix(input);
    await Promise.all([
      writeRawCapture(rawOutputDir, `${prefix}.stdout.json`, stdout, input.env),
      writeRawCapture(rawOutputDir, `${prefix}.stderr.log`, stderr, input.env),
    ]);
  }
  if (timedOut) {
    throw new Error(`timeout from ${input.engineId} for ${input.queryId}`);
  }
  if (exitCode !== 0) {
    throw new Error(`${input.engineId} command failed for ${input.queryId}: ${stderr.trim() || stdout.trim()}`);
  }
  try {
    return input.parse(stdout, input.fixtureSha256);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.engineId} result parsing failed for ${input.queryId}: ${message}`, {
      cause: error,
    });
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pgQleverAccessOptionEntries(queryId: string): string[] {
  if (queryId === 'p0-graph-denied') {
    return [
      "'accessScope'",
      `jsonb_build_object('basePath', ${sqlLiteral('https://example.test/')}, 'mode', 'read', 'resolved', true, 'deniedGraphUrls', jsonb_build_array(${sqlLiteral('https://example.test/graph/denied')}))`,
    ];
  }
  if (queryId === 'p0-graph-allowed') {
    return [
      "'accessScope'",
      `jsonb_build_object('basePath', ${sqlLiteral('https://example.test/')}, 'mode', 'read', 'resolved', true, 'allowedGraphUrls', jsonb_build_array(${sqlLiteral('https://example.test/graph/allowed')}))`,
    ];
  }
  return [];
}

function pgQleverSql(
  queryText: string,
  timeoutMs: number,
  queryId = '',
  memoryLimitBytes?: number,
): string {
  const optionEntries = [
    "'includeDiagnostics'", 'true',
    "'basePath'", sqlLiteral('https://example.test/'),
    "'timeoutMs'", String(timeoutMs),
    ...(memoryLimitBytes === undefined
      ? []
      : ["'memoryLimitBytes'", String(memoryLimitBytes)]),
    ...pgQleverAccessOptionEntries(queryId),
  ];
  const options = `jsonb_build_object(${optionEntries.join(', ')})`;
  return `WITH started AS (SELECT clock_timestamp() AS t), result AS (SELECT xpod_qlever_query_result(${sqlLiteral(queryText)}, ${options}) AS result FROM started) SELECT jsonb_build_object('elapsedMs', EXTRACT(EPOCH FROM (clock_timestamp() - (SELECT t FROM started))) * 1000, 'result', result.result, 'diagnostics', result.result->'diagnostics') FROM result`;
}

export function createNativeQleverSmokeAdapter(input: {
  execute?: NativeParityProcessExecutor;
  factsPath: string;
  fixtureSha256: string;
  runnerPath?: string;
  version?: string;
}): NativeParityEngineAdapter {
  const execute = input.execute ?? executeProcess;
  return {
    id: 'native-qlever',
    version: input.version ?? 'native-parity.sh',
    async runQuery(runInput) {
      return execute({
        argv: [input.runnerPath ?? '/usr/local/bin/native-parity', input.factsPath, runInput.queryPath, '-'],
        engineId: 'native-qlever',
        fixtureSha256: input.fixtureSha256,
        parse: parseNativeQleverRun,
        attempt: runInput.attempt,
        concurrencyLevel: runInput.concurrencyLevel,
        phase: runInput.phase,
        queryId: runInput.queryId,
        repetition: runInput.repetition,
        timeoutMs: runInput.timeoutMs,
      });
    },
  };
}

export const createNativeQleverAdapter = createNativeQleverSmokeAdapter;

export function createNativeQleverHttpAdapter(input: {
  accessToken?: string;
  fetch?: NativeQleverHttpFetch;
  fixtureSha256: string;
  rawOutputDir?: string;
  url: string;
  version?: string;
}): NativeParityEngineAdapter {
  const fetchImpl = input.fetch ?? fetch;
  const rawExtraSecrets = input.accessToken ? [input.accessToken] : [];
  return {
    id: 'native-qlever',
    version: input.version ?? 'http:qlever-server',
    async runQuery(runInput) {
      const queryText = readFileSync(runInput.queryPath, 'utf8');
      const url = new URL(input.url);
      url.searchParams.set('send', '5000');
      url.searchParams.set('query', queryText);
      if (input.accessToken) {
        url.searchParams.set('access-token', input.accessToken);
      }

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), runInput.timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), {
          headers: { Accept: 'application/qlever-results+json' },
          signal: abort.signal,
        });
        const responseText = await response.text();
        if (input.rawOutputDir) {
          const prefix = rawOutputPrefix({
            attempt: runInput.attempt,
            concurrencyLevel: runInput.concurrencyLevel,
            engineId: 'native-qlever',
            phase: runInput.phase,
            queryId: runInput.queryId,
            repetition: runInput.repetition,
          });
          await writeRawCapture(input.rawOutputDir, `${prefix}.response.json`, responseText, {}, rawExtraSecrets);
        }
        if (!response.ok) {
          if (input.rawOutputDir) {
            const prefix = rawOutputPrefix({
              attempt: runInput.attempt,
              concurrencyLevel: runInput.concurrencyLevel,
              engineId: 'native-qlever',
              phase: runInput.phase,
              queryId: runInput.queryId,
              repetition: runInput.repetition,
            });
            await writeRawCapture(input.rawOutputDir, `${prefix}.error.log`, `HTTP ${response.status}\n${responseText}`, {}, rawExtraSecrets);
          }
          throw new Error(`native-qlever HTTP ${response.status} for ${runInput.queryId}`);
        }
        return parseNativeQleverRun(responseText, input.fixtureSha256);
      } catch (error) {
        if (abort.signal.aborted) {
          if (input.rawOutputDir) {
            await mkdir(input.rawOutputDir, { recursive: true });
            const prefix = rawOutputPrefix({
              attempt: runInput.attempt,
              concurrencyLevel: runInput.concurrencyLevel,
              engineId: 'native-qlever',
              phase: runInput.phase,
            queryId: runInput.queryId,
            repetition: runInput.repetition,
          });
            await writeRawCapture(input.rawOutputDir, `${prefix}.error.log`, `timeout from native-qlever for ${runInput.queryId}`, {}, rawExtraSecrets);
          }
          throw new Error(`timeout from native-qlever for ${runInput.queryId}`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createPgQleverAdapter(input: {
  databaseUrl: string;
  execute?: NativeParityProcessExecutor;
  fixtureSha256: string;
  memoryLimitBytes?: number;
  psqlPath?: string;
  rawOutputDir?: string;
  version?: string;
}): NativeParityEngineAdapter {
  const execute = input.execute ?? executeProcess;
  return {
    id: 'pg-qlever',
    version: input.version ?? 'psql:xpod_qlever_query_result',
    async runQuery(runInput) {
      const queryText = readFileSync(runInput.queryPath, 'utf8');
      return execute({
        argv: [input.psqlPath ?? 'psql', input.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', pgQleverSql(queryText, runInput.timeoutMs, runInput.queryId, input.memoryLimitBytes)],
        engineId: 'pg-qlever',
        ...(input.rawOutputDir ? {
          env: { NATIVE_PARITY_RAW_OUTPUT_DIR: input.rawOutputDir },
        } : {}),
        fixtureSha256: input.fixtureSha256,
        parse: parsePgQleverRun,
        attempt: runInput.attempt,
        concurrencyLevel: runInput.concurrencyLevel,
        phase: runInput.phase,
        queryId: runInput.queryId,
        repetition: runInput.repetition,
        timeoutMs: runInput.timeoutMs,
      });
    },
  };
}

export function createRdf3xAdapter(input: {
  benchmarkArgv: string[];
  execute?: NativeParityProcessExecutor;
  fixtureSha256: string;
  version?: string;
}): NativeParityEngineAdapter {
  const execute = input.execute ?? executeProcess;
  return {
    id: 'rdf3x',
    version: input.version ?? 'argv:rdf3x-product-benchmark',
    async runQuery(runInput) {
      return execute({
        argv: [
          ...input.benchmarkArgv,
          '--query',
          runInput.queryPath,
          '--fixture-sha256',
          input.fixtureSha256,
          '--operation-timeout-ms',
          String(runInput.timeoutMs),
        ],
        engineId: 'rdf3x',
        fixtureSha256: input.fixtureSha256,
        parse: parseRdf3xRun,
        attempt: runInput.attempt,
        concurrencyLevel: runInput.concurrencyLevel,
        phase: runInput.phase,
        queryId: runInput.queryId,
        repetition: runInput.repetition,
        timeoutMs: runInput.timeoutMs,
      });
    },
  };
}

function parseArgvJson(value: string, name: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`BLOCKED_ON_RUNTIME: ${name} must be a non-empty JSON string array`);
  }
  return parsed;
}

export async function probeRdf3xBenchmarkContract(
  benchmarkArgv: string[],
  execute: NativeParityProcessExecutor = executeProcess,
  timeoutMs = 30_000,
): Promise<void> {
  await execute({
    argv: [...benchmarkArgv, '--contract'],
    engineId: 'rdf3x',
    fixtureSha256: 'a'.repeat(64),
    parse: parseRdf3xRun,
    queryId: 'contract',
    timeoutMs,
  });
}

export function createProcessEngineAdapter(
  engineId: CliEngineId,
  env: Record<string, string | undefined> = process.env,
): NativeParityEngineAdapter {
  const fixtureSha256 = env.NATIVE_PARITY_FIXTURE_SHA256;
  if (!fixtureSha256) {
    throw new Error('BLOCKED_ON_RUNTIME: missing NATIVE_PARITY_FIXTURE_SHA256');
  }
  if (engineId === 'native-qlever') {
    const url = env.NATIVE_QLEVER_URL;
    if (!url) {
      throw new Error('BLOCKED_ON_RUNTIME: missing NATIVE_QLEVER_URL for pre-started native QLever server; positional native-parity runner is smoke-only');
    }
    return createNativeQleverHttpAdapter({
      accessToken: env.NATIVE_QLEVER_ACCESS_TOKEN ?? 'native-parity',
      fixtureSha256,
      rawOutputDir: env.NATIVE_PARITY_RAW_OUTPUT_DIR,
      url,
    });
  }
  if (engineId === 'pg-qlever') {
    const databaseUrl = env.PG_QLEVER_DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('BLOCKED_ON_RUNTIME: missing PG_QLEVER_DATABASE_URL');
    }
    return createPgQleverAdapter({
      databaseUrl,
      fixtureSha256,
      memoryLimitBytes: env.NATIVE_PARITY_PG_MEMORY_LIMIT_BYTES
        ? Number(env.NATIVE_PARITY_PG_MEMORY_LIMIT_BYTES)
        : undefined,
      psqlPath: env.PSQL_PATH,
      rawOutputDir: env.NATIVE_PARITY_RAW_OUTPUT_DIR,
    });
  }
  const benchmarkArgv = env.RDF3X_BENCHMARK_ARGV;
  if (!benchmarkArgv) {
    throw new Error('BLOCKED_ON_RUNTIME: missing RDF3X_BENCHMARK_ARGV');
  }
  return createRdf3xAdapter({
    benchmarkArgv: parseArgvJson(benchmarkArgv, 'RDF3X_BENCHMARK_ARGV'),
    fixtureSha256,
  });
}

async function prepareDefaultQueries(root: string): Promise<NativeParityBenchmarkQuery[]> {
  await mkdir(root, { recursive: true });
  const queries: NativeParityBenchmarkQuery[] = [];
  for (const query of defaultQueries) {
    const queryPath = path.join(root, `${query.id}.rq`);
    await writeFile(queryPath, `${query.text}\n`, 'utf8');
    queries.push({ id: query.id, path: queryPath });
  }
  return queries;
}

async function prepareP0JoinQueries(root: string): Promise<NativeParityBenchmarkQuery[]> {
  await mkdir(root, { recursive: true });
  const queries: NativeParityBenchmarkQuery[] = [];
  for (const query of p0JoinWorkloads) {
    const queryPath = path.join(root, `${query.id}.rq`);
    await writeFile(queryPath, `${query.text}\n`, 'utf8');
    queries.push({ id: query.id, path: queryPath });
  }
  return queries;
}

export async function generateP0JoinSmallFixture(root: string): Promise<NativeParityP0JoinFixture> {
  const fixtureDirectory = path.join(root, 'fixture');
  const queryDirectory = path.join(root, 'queries');
  await mkdir(fixtureDirectory, { recursive: true });
  const factsPath = path.join(fixtureDirectory, 'facts.nq');
  await writeFile(factsPath, p0JoinSmallFacts, 'utf8');
  const manifest = {
    actualFacts: p0JoinSmallFacts.trimEnd().split('\n').length,
    factCount: p0JoinSmallFacts.trimEnd().split('\n').length,
    files: {
      'facts.nq': { sha256: sha256(p0JoinSmallFacts) },
    },
    p0Small: true as const,
  };
  const accessScopedBaselines = Object.fromEntries(
    nativeParityP0JoinWorkloadIds.map((id) => [
      id,
      p0BaselineEntry(id, p0JoinSmallAccessScopedRows),
    ]),
  ) as NativeParityP0JoinBaselineFile;
  await writeFile(path.join(fixtureDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(fixtureDirectory, 'p0-join-access-scoped-baselines.json'),
    `${JSON.stringify(accessScopedBaselines, null, 2)}\n`,
    'utf8',
  );
  return {
    accessScopedBaselines,
    baselines: Object.fromEntries(
      nativeParityP0JoinWorkloadIds.map((id) => [
        id,
        p0BaselineEntry(id, p0JoinSmallBaselineRows),
      ]),
    ),
    fixtureDirectory,
    manifest,
    p0Small: true,
    queries: await prepareP0JoinQueries(queryDirectory),
    queryDirectory,
  };
}

export async function appendP0JoinSemanticFactsToFixture(fixtureDirectory: string): Promise<{
  accessScopedBaselines: NativeParityP0JoinBaselineFile;
  manifest: { actualFacts: number; factCount: number; files: { 'facts.nq': { sha256: string } }; p0Small: false };
}> {
  const factsPath = path.join(fixtureDirectory, 'facts.nq');
  const manifestPath = path.join(fixtureDirectory, 'manifest.json');
  const existingFacts = readFileSync(factsPath, 'utf8');
  const separator = existingFacts.endsWith('\n') ? '' : '\n';
  const combinedFacts = `${existingFacts}${separator}${p0JoinSmallFacts}`;
  await writeFile(factsPath, combinedFacts, 'utf8');
  const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    actualFacts?: number;
    factCount?: number;
    files?: { 'facts.nq'?: { sha256?: string } };
  };
  const addedFacts = p0JoinSmallFacts.trimEnd().split('\n').length;
  const previousFacts = Number.isInteger(currentManifest.actualFacts)
    ? currentManifest.actualFacts!
    : Number.isInteger(currentManifest.factCount) ? currentManifest.factCount! : 0;
  const manifest = {
    ...currentManifest,
    actualFacts: previousFacts + addedFacts,
    factCount: previousFacts + addedFacts,
    files: {
      ...(currentManifest.files ?? {}),
      'facts.nq': { sha256: sha256(combinedFacts) },
    },
    p0Small: false as const,
  };
  const accessScopedBaselines = Object.fromEntries(
    nativeParityP0JoinWorkloadIds.map((id) => [
      id,
      p0BaselineEntry(id, p0JoinSmallAccessScopedRows),
    ]),
  ) as NativeParityP0JoinBaselineFile;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(fixtureDirectory, 'p0-join-access-scoped-baselines.json'),
    `${JSON.stringify(accessScopedBaselines, null, 2)}\n`,
    'utf8',
  );
  return { accessScopedBaselines, manifest };
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOrNullFromRecord(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function booleanFromRecord(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function p0JoinConcurrency(
  result: NativeParityBenchmarkReportResult,
  level: number,
): NonNullable<NativeParityBenchmarkReportResult['concurrency']>[number] | undefined {
  const entry = result.concurrency?.find((candidate) => candidate.level === level);
  return entry;
}

function p0JoinConcurrencyMetrics(
  entry: NonNullable<NativeParityBenchmarkReportResult['concurrency']>[number] | undefined,
): { p50Ms: number; p95Ms: number; qps: number } | undefined {
  if (!entry) return undefined;
  return { p50Ms: entry.p50Ms, p95Ms: entry.p95Ms, qps: entry.throughputQps };
}

function p0IntermediateRowsSummary(
  diagnostics: Record<string, unknown>,
  workloadId: string,
  label: 'topLevel' | 'c1' | 'c8',
  requiresParameterized: boolean,
  errors: string[],
): NativeParityP0IntermediateRowsSummary {
  const labelPrefix = label === 'topLevel' ? '' : `${label} `;
  const seedRows = numberFromRecord(diagnostics, 'seedRows');
  const uniqueJoinTuples = numberFromRecord(diagnostics, 'uniqueJoinTuples');
  const backendRows = numberFromRecord(diagnostics, 'backendRows');
  const compressedRows = numberFromRecord(diagnostics, 'compressedRows');
  if (requiresParameterized) {
    if (seedRows === undefined) errors.push(`missing ${labelPrefix}seedRows for ${workloadId}`);
    if (uniqueJoinTuples === undefined) errors.push(`missing ${labelPrefix}uniqueJoinTuples for ${workloadId}`);
    if (backendRows === undefined) errors.push(`missing ${labelPrefix}backendRows for ${workloadId}`);
  }
  const largestLogicalInputRows = Math.max(seedRows ?? 0, uniqueJoinTuples ?? 0);
  const intermediateRows = Math.max(compressedRows ?? 0, backendRows ?? 0);
  const ratio = largestLogicalInputRows === 0
    ? intermediateRows === 0 ? 0 : null
    : Number((intermediateRows / largestLogicalInputRows).toFixed(4));
  const boundExceeded = largestLogicalInputRows === 0
    ? intermediateRows !== 0
    : intermediateRows > largestLogicalInputRows * 10;
  const reason = stringOrNullFromRecord(diagnostics, 'intermediateBoundReason');
  const normalizedReason = typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
  if (requiresParameterized && boundExceeded && !normalizedReason) {
    errors.push(`intermediate rows exceeded 10x logical input for ${workloadId} ${label} without diagnostic reason: ${intermediateRows} > 10 * ${largestLogicalInputRows}`);
  }
  return {
    boundExceeded,
    intermediateRows,
    largestLogicalInputRows,
    ratio,
    reason: normalizedReason,
  };
}

export function summarizeP0JoinAcceptance(
  report: NativeParityFullReport,
  input: {
    expectedDigests?: Record<string, string>;
    expectedRows?: Record<string, number>;
    expectedWorkloadIds?: readonly string[];
    requiredExecutionMode?: string;
  } = {},
): NativeParityP0JoinAcceptanceSummary {
  const expectedWorkloadIds = [...(input.expectedWorkloadIds ?? nativeParityP0JoinWorkloadIds)];
  const errors: string[] = [];
  const queryIds = new Set((report.queries ?? []).map((query) => query.id));
  const workloads: NativeParityP0JoinWorkloadSummary[] = [];

  for (const workloadId of expectedWorkloadIds) {
    if (!queryIds.has(workloadId)) {
      errors.push(`missing P0 join workload ${workloadId}`);
      continue;
    }
    const result = report.results.find((entry) => entry.queryId === workloadId && entry.engineId === 'pg-qlever');
    if (!result) {
      errors.push(`missing pg-qlever result for ${workloadId}`);
      continue;
    }

    const diagnostics = jsonObject(result.pgDiagnostics);
    if (input.requiredExecutionMode && diagnostics.executionMode !== input.requiredExecutionMode) {
      errors.push(`executionMode was not ${input.requiredExecutionMode} for ${workloadId}`);
    }
    const c1 = p0JoinConcurrency(result, 1);
    const c8 = p0JoinConcurrency(result, 8);
    if (!c1) errors.push(`missing c1 concurrency metrics for ${workloadId}`);
    if (!c8) errors.push(`missing c8 concurrency metrics for ${workloadId}`);
    const diagnosticsByConcurrency: NativeParityP0JoinWorkloadSummary['diagnosticsByConcurrency'] = [];

    const digest = result.resultDigests.ordered;
    const expectedDigest = input.expectedDigests?.[workloadId];
    const expectedRows = input.expectedRows?.[workloadId];
    if (expectedRows !== undefined && result.rows !== expectedRows) {
      errors.push(`row count mismatch for ${workloadId}: expected ${expectedRows}, got ${result.rows ?? 'missing'}`);
    }
    if (expectedDigest && digest !== expectedDigest) {
      errors.push(`correctness digest mismatch for ${workloadId}: expected ${expectedDigest}, got ${digest}`);
    }
    if (typeof diagnostics.correctnessDigest !== 'string') {
      errors.push(`missing correctnessDigest for ${workloadId}`);
    }
    const correctnessDigest = typeof diagnostics.correctnessDigest === 'string'
      ? diagnostics.correctnessDigest
      : '';
    if (expectedDigest && correctnessDigest !== expectedDigest) {
      errors.push(`diagnostic correctness digest mismatch for ${workloadId}: expected ${expectedDigest}, got ${correctnessDigest}`);
    }

    const nativeOnly = diagnostics.executionMode === 'native-qlever-tree';
    const requiresParameterized = requiresP0ParameterizedJoin(workloadId) && !nativeOnly;
    if (requiresParameterized &&
        booleanFromRecord(diagnostics, 'parameterized') === undefined) {
      errors.push(`missing parameterized for ${workloadId}`);
    }
    const parameterized = booleanFromRecord(diagnostics, 'parameterized') ?? false;
    if (requiresParameterized && !parameterized) {
      errors.push(`workload was not parameterized: ${workloadId}`);
    }
    if (!('fallbackReason' in diagnostics)) {
      errors.push(`missing fallbackReason for ${workloadId}`);
    }
    const fallbackReason = stringOrNullFromRecord(diagnostics, 'fallbackReason');
    if (fallbackReason !== null) {
      errors.push(`unexpected fallback for ${workloadId}: ${fallbackReason ?? 'missing fallbackReason'}`);
    }
    if (numberFromRecord(diagnostics, 'errorCount') === undefined) {
      errors.push(`missing errorCount for ${workloadId}`);
    }
    const errorCount = numberFromRecord(diagnostics, 'errorCount') ?? Number.NaN;
    if (errorCount !== 0) {
      errors.push(`non-zero error count for ${workloadId}: ${errorCount}`);
    }

    if (numberFromRecord(diagnostics, 'backendRows') === undefined) {
      errors.push(`missing backendRows for ${workloadId}`);
    }
    const backendRows = numberFromRecord(diagnostics, 'backendRows') ?? 0;
    const peakBatchRows = result.pgDiagnostics?.peakBatchRows ?? 0;
    if (backendRows <= 0 && (expectedRows ?? 0) > 0) {
      errors.push(`missing backendRows for ${workloadId}`);
    }
    if (peakBatchRows <= 0 && (expectedRows ?? 0) > 0) {
      errors.push(`missing peakBatchRows for ${workloadId}`);
    }
    const topLevelIntermediateRows = p0IntermediateRowsSummary(
      diagnostics,
      workloadId,
      'topLevel',
      requiresParameterized,
      errors,
    );
    let c1IntermediateRows: NativeParityP0IntermediateRowsSummary = {
      boundExceeded: false,
      intermediateRows: 0,
      largestLogicalInputRows: 0,
      ratio: 0,
      reason: null,
    };
    let c8IntermediateRows: NativeParityP0IntermediateRowsSummary = {
      boundExceeded: false,
      intermediateRows: 0,
      largestLogicalInputRows: 0,
      ratio: 0,
      reason: null,
    };
    for (const entry of [c1, c8]) {
      if (!entry) continue;
      const concurrencyDiagnostics = jsonObject(entry.pgDiagnostics);
      const levelLabel = `c${entry.level}`;
      if (input.requiredExecutionMode && concurrencyDiagnostics.executionMode !== input.requiredExecutionMode) {
        errors.push(`${levelLabel} executionMode was not ${input.requiredExecutionMode} for ${workloadId}`);
      } else if (!input.requiredExecutionMode && nativeOnly && concurrencyDiagnostics.executionMode !== 'native-qlever-tree') {
        errors.push(`${levelLabel} executionMode was not native-qlever-tree for ${workloadId}`);
      }
      if (!entry.resultDigests) {
        errors.push(`missing ${levelLabel} resultDigests for ${workloadId}`);
      }
      if (entry.rows === undefined) {
        errors.push(`missing ${levelLabel} rows for ${workloadId}`);
      } else if (expectedRows !== undefined && entry.rows !== expectedRows) {
        errors.push(`${levelLabel} row count mismatch for ${workloadId}: expected ${expectedRows}, got ${entry.rows}`);
      }
      if (!entry.pgDiagnostics) {
        errors.push(`missing ${levelLabel} pgDiagnostics for ${workloadId}`);
        continue;
      }
      if (expectedDigest && entry.resultDigests?.ordered !== expectedDigest) {
        errors.push(`${levelLabel} correctness digest mismatch for ${workloadId}: expected ${expectedDigest}, got ${entry.resultDigests?.ordered ?? 'missing'}`);
      }
      if (typeof concurrencyDiagnostics.correctnessDigest !== 'string') {
        errors.push(`missing ${levelLabel} correctnessDigest for ${workloadId}`);
      } else if (expectedDigest && concurrencyDiagnostics.correctnessDigest !== expectedDigest) {
        errors.push(`${levelLabel} diagnostic correctness digest mismatch for ${workloadId}: expected ${expectedDigest}, got ${concurrencyDiagnostics.correctnessDigest}`);
      }
      if (requiresParameterized &&
          booleanFromRecord(concurrencyDiagnostics, 'parameterized') === undefined) {
        errors.push(`missing ${levelLabel} parameterized for ${workloadId}`);
      } else if (requiresParameterized &&
          booleanFromRecord(concurrencyDiagnostics, 'parameterized') !== true) {
        errors.push(`${levelLabel} workload was not parameterized: ${workloadId}`);
      }
      if (!('fallbackReason' in concurrencyDiagnostics)) {
        errors.push(`missing ${levelLabel} fallbackReason for ${workloadId}`);
      } else if (stringOrNullFromRecord(concurrencyDiagnostics, 'fallbackReason') !== null) {
        errors.push(`unexpected ${levelLabel} fallback for ${workloadId}: ${stringOrNullFromRecord(concurrencyDiagnostics, 'fallbackReason') ?? 'missing fallbackReason'}`);
      }
      if (numberFromRecord(concurrencyDiagnostics, 'errorCount') === undefined) {
        errors.push(`missing ${levelLabel} errorCount for ${workloadId}`);
      } else if (numberFromRecord(concurrencyDiagnostics, 'errorCount') !== 0) {
        errors.push(`non-zero ${levelLabel} error count for ${workloadId}: ${numberFromRecord(concurrencyDiagnostics, 'errorCount')}`);
      }
      const intermediateRows = p0IntermediateRowsSummary(
        concurrencyDiagnostics,
        workloadId,
        entry.level === 8 ? 'c8' : 'c1',
        requiresParameterized,
        errors,
      );
      if (entry.level === 8) {
        c8IntermediateRows = intermediateRows;
      } else {
        c1IntermediateRows = intermediateRows;
      }
      if (entry.pgDiagnostics && entry.resultDigests && entry.rows !== undefined) {
        diagnosticsByConcurrency.push({
          diagnostics: entry.pgDiagnostics,
          level: entry.level,
          resultDigests: entry.resultDigests,
          rows: entry.rows,
        });
      }
    }
    const c1Metrics = p0JoinConcurrencyMetrics(c1);
    const c8Metrics = p0JoinConcurrencyMetrics(c8);

    workloads.push({
      backendRows,
      c1: c1Metrics ?? { p50Ms: 0, p95Ms: 0, qps: 0 },
      c8: c8Metrics ?? { p50Ms: 0, p95Ms: 0, qps: 0 },
      correctnessDigest,
      diagnosticsByConcurrency,
      digest,
      errorCount,
      fallbackReason: fallbackReason ?? null,
      id: workloadId,
      intermediateRows: {
        c1: c1IntermediateRows,
        c8: c8IntermediateRows,
        topLevel: topLevelIntermediateRows,
      },
      p50Ms: c1?.p50Ms ?? result.latencyMs.warm.p50,
      p95Ms: c1?.p95Ms ?? result.latencyMs.warm.p95,
      parameterized,
      peakBatchRows,
      qps: c1Metrics?.qps ?? 0,
      rows: expectedRows ?? result.rows ?? 0,
    });
  }

  return {
    accepted: errors.length === 0,
    errors,
    workloads,
  };
}

function loadP0AccessScopedBaselines(fixtureManifestPath: string): NativeParityP0JoinBaselineFile {
  const baselinePath = path.join(path.dirname(fixtureManifestPath), 'p0-join-access-scoped-baselines.json');
  if (!existsSync(baselinePath)) {
    throw new Error(`BLOCKED_ON_RUNTIME: missing P0 access-scoped baseline file: ${baselinePath}`);
  }
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as NativeParityP0JoinBaselineFile;
  const errors: string[] = [];
  for (const workloadId of nativeParityP0JoinWorkloadIds) {
    const baseline = parsed[workloadId];
    if (!baseline) {
      errors.push(`missing access-scoped baseline for ${workloadId}`);
      continue;
    }
    if (!Number.isInteger(baseline.rows) || baseline.rows < 0) {
      errors.push(`invalid access-scoped rows for ${workloadId}`);
    }
    if (!/^[a-f0-9]{64}$/.test(baseline.digest?.ordered ?? '')) {
      errors.push(`invalid access-scoped ordered digest for ${workloadId}`);
    }
    if (!/^[a-f0-9]{64}$/.test(baseline.digest?.multiset ?? '')) {
      errors.push(`invalid access-scoped multiset digest for ${workloadId}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return parsed;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    args[arg.slice(2)] = argv[index + 1] ?? '';
    index += 1;
  }
  return args;
}

type NativeParityCliDependencies = {
  probeRdf3xContract?: typeof probeRdf3xBenchmarkContract;
  runBenchmark?: typeof runNativeParityBenchmark;
  writeReports?: typeof writeNativeParityReports;
};

export async function runNativeParityBenchmarkCli(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  dependencies: NativeParityCliDependencies = {},
): Promise<void> {
  const args = parseArgs(argv);
  const fixtureManifestPath = args['fixture-manifest'] ?? env.NATIVE_PARITY_FIXTURE_MANIFEST;
  if (!fixtureManifestPath || !existsSync(fixtureManifestPath)) {
    throw new Error('BLOCKED_ON_RUNTIME: missing --fixture-manifest or NATIVE_PARITY_FIXTURE_MANIFEST');
  }

  const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8')) as {
    actualFacts?: number;
    factCount?: number;
    files: { 'facts.nq': { sha256: string } };
    p0Small?: boolean;
  };
  const fixtureSha256 = manifest.files['facts.nq'].sha256;
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const ownsQueryRoot = !args['query-dir'];
  const queryRoot = args['query-dir'] ?? await mkdtemp(path.join(os.tmpdir(), 'xpod-native-parity-queries-'));
  const useP0JoinWorkloads = args['p0-join-workloads'] === 'true' || env.NATIVE_PARITY_P0_JOIN_WORKLOADS === '1';
  try {
    const queries = useP0JoinWorkloads
      ? await prepareP0JoinQueries(queryRoot)
      : await prepareDefaultQueries(queryRoot);
    const engineEnv: Record<string, string | undefined> = {
      ...env,
      NATIVE_PARITY_FIXTURE_SHA256: fixtureSha256,
      ...(args['raw-output-dir'] ? { NATIVE_PARITY_RAW_OUTPUT_DIR: args['raw-output-dir'] } : {}),
    };
    if (engineEnv.RDF3X_BENCHMARK_ARGV) {
      await (dependencies.probeRdf3xContract ?? probeRdf3xBenchmarkContract)(
        parseArgvJson(engineEnv.RDF3X_BENCHMARK_ARGV, 'RDF3X_BENCHMARK_ARGV'),
        executeProcess,
        Number(args['contract-timeout-ms'] ?? env.NATIVE_PARITY_CONTRACT_TIMEOUT_MS ?? 30_000),
      );
    }
    const engines = nativeParityReportEngineIds.map((engineId) => createProcessEngineAdapter(engineId, engineEnv));

    const requestedConcurrencyLevels = (args['concurrency-levels'] ?? env.NATIVE_PARITY_CONCURRENCY_LEVELS ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
    const concurrencyLevels = useP0JoinWorkloads && requestedConcurrencyLevels.length === 0
      ? [1, 8]
      : requestedConcurrencyLevels;
    if (useP0JoinWorkloads && concurrencyLevels.join(',') !== '1,8') {
      throw new Error('P0 join workloads require concurrency levels 1,8');
    }
    if (useP0JoinWorkloads && manifest.p0Small === true && Number(env.TARGET_FACTS) === 2_000_000) {
      throw new Error('P0 join 2M acceptance cannot use p0Small fixture evidence');
    }
    const p0AccessScopedBaselines = useP0JoinWorkloads
      ? loadP0AccessScopedBaselines(fixtureManifestPath)
      : undefined;

    let report: NativeParityFullReport;
    let rejected: NativeParityBenchmarkRejectedError | undefined;
    try {
      report = await (dependencies.runBenchmark ?? runNativeParityBenchmark)({
        concurrencyLevels,
        dataset: {
          name: args['dataset-name'] ?? 'native-parity-20k',
          sha256: fixtureSha256,
        },
        engines,
        ...(p0AccessScopedBaselines ? {
          p0JoinAccessScopedBaselines: p0AccessScopedBaselines,
          p0JoinAccessScopedWorkloadIds: nativeParityP0AccessScopedWorkloadIds,
        } : {}),
        queries,
        timeoutMs: Number(args['timeout-ms'] ?? env.NATIVE_PARITY_TIMEOUT_MS ?? 300_000),
      });
    } catch (error) {
      if (!(error instanceof NativeParityBenchmarkRejectedError)) {
        throw error;
      }
      report = error.report;
      rejected = error;
    }

    await (dependencies.writeReports ?? writeNativeParityReports)(report, date);
    if (rejected) {
      throw rejected;
    }
    const gateErrors = validateNativeParityBenchmarkReport(report)
      .filter((error) => error.startsWith('failed required result cell '));
    if (gateErrors.length > 0) {
      throw new Error(gateErrors.join('\n'));
    }

    if (useP0JoinWorkloads) {
      const baselines = p0AccessScopedBaselines!;
      const acceptance = summarizeP0JoinAcceptance(report, {
        expectedDigests: Object.fromEntries(
          nativeParityP0JoinWorkloadIds.map((id) => [id, baselines[id].digest.ordered]),
        ),
        expectedRows: Object.fromEntries(
          nativeParityP0JoinWorkloadIds.map((id) => [id, baselines[id].rows]),
        ),
        expectedWorkloadIds: nativeParityP0JoinWorkloadIds,
        requiredExecutionMode: 'native-qlever-tree',
      });
      if (!acceptance.accepted) {
        throw new Error(`P0 join acceptance failed\n${acceptance.errors.join('\n')}`);
      }
    }
  } finally {
    if (ownsQueryRoot) {
      await rm(queryRoot, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  await runNativeParityBenchmarkCli();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
