import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Quad, Term } from '@rdfjs/types';
import { Parser as N3Parser } from 'n3';
import { Pool } from 'pg';
import {
  PostgresRdfEngine,
  type PostgresRdfEngineOptions,
} from '../src/storage/rdf/PostgresRdfEngine';
import { SolidRdfSparqlEngine } from '../src/storage/rdf/SolidRdfSparqlEngine';
import {
  buildRdfModelsBenchmarkSeed,
  buildRdfModelsSyntheticMessageBatch,
  RDF_MODELS_SYNTHETIC_MESSAGE_QUADS,
} from '../src/storage/rdf/models-benchmark';
import {
  buildCloudReplacementTopology,
  calculateCloudReplacementThroughputRatio,
  calculateCloudReplacementWeightedP95Ratio,
  canonicalCloudReplacementDigests,
  canonicalCloudReplacementRow,
  CLOUD_REPLACEMENT_GROUP_WEIGHTS,
  CLOUD_REPLACEMENT_THRESHOLDS,
  cloudReplacementWorkloads,
  compareCloudReplacementCase,
  createCloudReplacementSampleIdentitySource,
  decideCloudReplacement,
  measureCloudReplacementCase,
  measureCloudReplacementConcurrency,
  renderCloudReplacementJson,
  sanitizeCloudReplacementEnvironment,
  type CloudReplacementCacheMode,
  type CloudReplacementConcurrency,
  type CloudReplacementCorrectness,
  type CloudReplacementEngineAdapter,
  type CloudReplacementEngineId,
  type CloudReplacementErrorCategory,
  type CloudReplacementErrorEvidence,
  type CloudReplacementErrorSample,
  type CloudReplacementErrorStage,
  type CloudReplacementExecution,
  type CloudReplacementLatency,
  type CloudReplacementPgDiagnostics,
  type CloudReplacementReport,
  type CloudReplacementSampleIdentitySource,
  type CloudReplacementWorkload,
} from '../src/storage/rdf/cloud-replacement-benchmark';

const DEFAULT_TARGET_QUADS = 20_000;
const DEFAULT_ITERATIONS = 20;
const DEFAULT_WARMUP_ITERATIONS = 3;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const BENCHMARK_BUILD_SETUP_TIMEOUT_MS = 30 * 60_000;
export const BENCHMARK_DOCKER_TIMEOUT_MS = 2 * 60_000;
export const BENCHMARK_MAX_LOAD_WAVES = 16;
// Cover broad single-query joins while keeping c32 within a 12 GiB aggregate budget.
export const BENCHMARK_QLEVER_MEMORY_LIMIT_BYTES = 384 * 1024 * 1024;
const BENCHMARK_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = [ 1, 8, 32 ] as const;
const DEFAULT_IMAGE = 'xpod-rdf-postgres:pg17-smoke';
const DEFAULT_MESSAGES_PER_BATCH = 10_000;
const CONCURRENCY_DURATION_MS = 60_000;
const LOCAL_DATABASE = 'xpod_benchmark';
const BENCHMARK_SCHEMA = 'xpod_benchmark';
const BENCHMARK_SEARCH_PATH_OPTION = `-csearch_path=${BENCHMARK_SCHEMA},public`;
const EXTERNAL_DATABASE_ENV = 'XPOD_RDF_BENCHMARK_PG_URL';
const BASE_PATH = 'https://pod.example/';
const RDF3X_PERMUTATION_SCAN_MARKERS: ReadonlySet<string> = new Set([
  'Rdf3xPermutationScan(SPO)',
  'Rdf3xPermutationScan(SOP)',
  'Rdf3xPermutationScan(PSO)',
  'Rdf3xPermutationScan(POS)',
  'Rdf3xPermutationScan(OSP)',
  'Rdf3xPermutationScan(OPS)',
]);
const RDF3X_PARITY_CONTRACT = 'xpod-rdf3x-parity-adapter';
const RDF3X_PARITY_CONTRACT_VERSION = 1;
const RDF3X_PARITY_FIXTURE_MANIFEST_TABLE = 'rdf_benchmark_manifest';
const RDF3X_PARITY_FIXTURE_SHA256_KEY = 'fixture_sha256';

export type BenchmarkMode = 'local' | 'external';
export type BenchmarkExecutionLocation = 'local' | 'cluster';
export type BenchmarkTransport = 'direct' | 'port-forward';
export type BenchmarkCacheMode = CloudReplacementCacheMode | 'both';
export type BenchmarkConcurrency = 1 | 8 | 32;

export interface BenchmarkCliOptions {
  mode: BenchmarkMode;
  targetQuads: number;
  iterations: number;
  warmupIterations: number;
  workloadIds: string[];
  concurrency: BenchmarkConcurrency[];
  cacheMode: BenchmarkCacheMode;
  cacheModes: CloudReplacementCacheMode[];
  operationTimeoutMs: number;
  image: string;
  out: string;
  dryRun: boolean;
  help: boolean;
  databaseName: string;
  executionLocation: BenchmarkExecutionLocation;
  transport: BenchmarkTransport;
  benchmarkDatabaseUrl?: string;
}

export type Rdf3xParityCliOptions =
  | { mode: 'contract' }
  | { mode: 'query'; query: string; fixtureSha256: string }
  | { mode: 'prepare'; facts: string; fixtureSha256: string };

export interface SparqlJsonTerm {
  type: 'uri' | 'bnode' | 'literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

export interface SparqlJsonBindingsBody {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, SparqlJsonTerm>> };
}

export interface Rdf3xParityEnvelope {
  adapter: 'rdf3x';
  contract: typeof RDF3X_PARITY_CONTRACT;
  contractVersion: typeof RDF3X_PARITY_CONTRACT_VERSION;
  mode: 'contract' | 'query' | 'prepare';
  elapsedMs: number;
  fixtureSha256: string;
  factCount?: number;
  result: { body: SparqlJsonBindingsBody };
}

export interface Rdf3xParityPrepareEngine {
  open(): Promise<void>;
  put(quads: Quad | Quad[]): Promise<void>;
  refreshDerivedIndexes(options?: { mode?: 'full' }): Promise<unknown>;
  close(): Promise<void>;
}

export interface Rdf3xParityRuntime {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  readFile?: (file: string, encoding: BufferEncoding) => Promise<string>;
  readFixtureSha256?: (connectionString: string) => Promise<string | undefined>;
  resetBenchmarkSchema?: (connectionString: string) => Promise<void>;
  createRdf3xEngine?: (connectionString: string) => Rdf3xParityPrepareEngine;
  countFacts?: (connectionString: string) => Promise<number>;
  writeFixtureManifest?: (connectionString: string, fixtureSha256: string) => Promise<void>;
  executeRdf3xQuery?: (
    connectionString: string,
    query: string,
  ) => Promise<SparqlJsonBindingsBody>;
}

export interface BenchmarkExecutionContext {
  location: BenchmarkExecutionLocation;
  transport: BenchmarkTransport;
  databaseIdentity: string;
  runnerIdentity: 'native-rdf3x-benchmark-v2';
  engineCommit: string;
  workloadIds: string[];
}

export type BenchmarkReportExecutionContext = BenchmarkExecutionContext;

export interface BenchmarkLoadingPlan {
  targetQuads: number;
  syntheticPodCount: 32 | 128 | 512;
  messagesPerBatch: number;
  maxBatchQuads: number;
}

interface BenchmarkPutEngine {
  put(quads: Quad | Quad[]): void | Promise<void>;
}

interface BenchmarkAdapterMetrics {
  fallbackCount?: number;
  lastFallback?: { reason?: string } | null;
  lastPrimary?: {
    operation?: string;
    plan?: string[];
    indexChoices?: string[];
  };
}

export interface BenchmarkSparqlEngine {
  queryBindings(
    query: string,
    basePath: string,
    accessScope?: CloudReplacementWorkload['accessScope'],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  getMetrics(): BenchmarkAdapterMetrics;
}

export interface BenchmarkAdapterOptions {
  now?: () => number;
  timeWithoutSampleIdentity?: boolean;
  operationTimeoutMs?: number;
}

export class BenchmarkEngineExecutionError extends Error {
  public override readonly cause: unknown;

  public constructor(
    public readonly engine: CloudReplacementEngineId,
    cause: unknown,
    public readonly stage: CloudReplacementErrorStage = benchmarkErrorStage(cause, 'query'),
  ) {
    super(`${engine} benchmark execution failed: ${errorMessage(cause)}`);
    // Preserve abort/timeout identity for callers while retaining engine
    // attribution through this wrapper type.
    this.name = cause instanceof Error ? cause.name : 'BenchmarkEngineExecutionError';
    this.cause = cause;
  }
}

function benchmarkErrorStage(
  error: unknown,
  fallback: CloudReplacementErrorStage,
): CloudReplacementErrorStage {
  if (error && typeof error === 'object' && 'stage' in error) {
    const stage = (error as { stage?: unknown }).stage;
    if (stage === 'acquire' || stage === 'query' || stage === 'materialize' ||
      stage === 'cancel' || stage === 'cleanup') {
      return stage;
    }
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError') {
    return 'cancel';
  }
  if (name === 'TimeoutError') {
    return fallback === 'materialize' ? 'materialize' : 'query';
  }
  return fallback;
}

type BenchmarkCaseMeasurementOptions = {
  prepareColdState: () => void | Promise<void>;
  warmupIterations: number;
  iterations: number;
  coldFirstEngine: CloudReplacementEngineId;
  operationTimeoutMs: number;
} & (
  | {
    cacheMode: 'off';
    identitySource: CloudReplacementSampleIdentitySource;
  }
  | {
    cacheMode: 'production';
    identitySource?: CloudReplacementSampleIdentitySource;
  }
);

export interface BenchmarkCaseMeasurement {
  correctness: CloudReplacementCorrectness;
  rdf3x: CloudReplacementLatency;
  qlever: CloudReplacementLatency;
  ignoredSteadyHelperColdMs: Record<CloudReplacementEngineId, number>;
}

interface ProvisionedDatabase {
  connectionString: string;
  container?: string;
}

interface BenchmarkCleanupClient {
  query(statement: string): Promise<unknown>;
  release(): void;
}

interface BenchmarkCleanupPool {
  connect(): Promise<BenchmarkCleanupClient>;
}

interface BenchmarkDatabaseIdentityClient {
  query<T>(statement: string): Promise<{ rows: T[] }>;
}

export interface LocalPostgresProbeOptions {
  attempts?: number;
  delayMs?: number;
  runDocker?: (args: string[]) => string;
}

interface PgStatSnapshot {
  sharedBlocksRead: number | null;
  sharedBlocksHit: number | null;
  tempBytes: number | null;
  diagnosticsUnavailable: string[];
}

interface AdapterPair {
  rdf3xStore: PostgresRdfEngine;
  qleverStore: PostgresRdfEngine;
  rdf3xSparql: SolidRdfSparqlEngine;
  qleverSparql: SolidRdfSparqlEngine;
  rdf3xAdapter: CloudReplacementEngineAdapter<'rdf3x'>;
  qleverAdapter: CloudReplacementEngineAdapter<'qlever'>;
  rdf3xBuildMs: number;
  qleverBuildMs: number;
}

export interface LatencyRecord {
  cacheMode: CloudReplacementCacheMode;
  workload: CloudReplacementWorkload;
  rdf3x: CloudReplacementLatency;
  qlever: CloudReplacementLatency;
  ignoredSteadyHelperColdMs: Record<CloudReplacementEngineId, number>;
}

export interface ConcurrencyRecord extends CloudReplacementConcurrency {
  cacheMode: CloudReplacementCacheMode;
  caseId: string;
  engine: CloudReplacementEngineId;
}

export interface SharedStorageEvidence {
  factsBytes: number;
  sharedPhysicalIndexBytes: number;
  qleverIncrementalBytes: null;
  reportStorageBytes: Record<CloudReplacementEngineId, number>;
  semantics: 'shared-not-additive';
}

export interface BenchmarkCacheModePairPlan {
  cacheMode: CloudReplacementCacheMode;
  refreshDerivedIndexes: boolean;
  recordBuildAndStorage: boolean;
}

export interface BenchmarkPgPoolConfiguration {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
}

export interface BenchmarkCorrectnessRecord {
  cacheMode: CloudReplacementCacheMode;
  caseId: string;
  correctness: CloudReplacementCorrectness;
}

export type BenchmarkDiagnosticsByCacheMode = Partial<Record<
  CloudReplacementCacheMode,
  Record<CloudReplacementEngineId, CloudReplacementPgDiagnostics>
>>;

export interface BenchmarkReportSummaryInput {
  cacheModes: readonly CloudReplacementCacheMode[];
  latencyRecords: readonly LatencyRecord[];
  concurrencyRecords: readonly ConcurrencyRecord[];
  correctnessRecords: readonly BenchmarkCorrectnessRecord[];
  correctnessFailures: readonly string[];
  diagnosticsByCacheMode: BenchmarkDiagnosticsByCacheMode;
  qleverReady: boolean;
}

export interface BenchmarkCheckpoint {
  version: 2;
  latencyContextFingerprint: string;
  concurrencyContextFingerprint: string;
  identityId: string;
  completedLatencyKeys: string[];
  completedConcurrencyKeys: string[];
  latencyRecords: LatencyRecord[];
  concurrencyRecords: ConcurrencyRecord[];
  correctnessRecords: BenchmarkCorrectnessRecord[];
  correctnessFailures: string[];
  diagnosticsByCacheMode: BenchmarkDiagnosticsByCacheMode;
  concurrencyDiagnosticsByKey: Record<string, CloudReplacementPgDiagnostics>;
}

export function benchmarkCheckpointPath(out: string): string {
  return `${path.resolve(out)}.checkpoint.json`;
}

export function buildBenchmarkExecutionContext(
  options: BenchmarkCliOptions,
  databaseIdentity: string,
): BenchmarkExecutionContext {
  return {
    location: options.executionLocation,
    transport: options.transport,
    databaseIdentity,
    runnerIdentity: 'native-rdf3x-benchmark-v2',
    engineCommit: currentCommit(),
    workloadIds: [ ...options.workloadIds ],
  };
}

export function buildBenchmarkReportExecutionContext(
  context: BenchmarkExecutionContext,
): BenchmarkReportExecutionContext {
  if (!/^[a-f0-9]{64}$/u.test(context.databaseIdentity)) {
    throw new Error('Invalid benchmark report execution context: databaseIdentity must be a sha256 hex digest');
  }
  if (context.workloadIds.length === 0 || context.workloadIds.some((id) =>
    id.length === 0 || /[\u0000-\u001F\u007F]/u.test(id))) {
    throw new Error('Invalid benchmark report execution context: workloadIds must be non-empty safe strings');
  }
  return {
    location: context.location,
    transport: context.transport,
    databaseIdentity: context.databaseIdentity,
    runnerIdentity: context.runnerIdentity,
    engineCommit: context.engineCommit,
    workloadIds: [ ...context.workloadIds ],
  };
}

export function benchmarkLatencyContextFingerprint(
  options: BenchmarkCliOptions,
  context: BenchmarkExecutionContext,
): string {
  return JSON.stringify({
    version: 2,
    lane: 'latency',
    context,
    mode: options.mode,
    targetQuads: options.targetQuads,
    iterations: options.iterations,
    warmupIterations: options.warmupIterations,
    cacheModes: options.cacheModes,
    operationTimeoutMs: options.operationTimeoutMs,
    image: options.image,
  });
}

export function benchmarkConcurrencyContextFingerprint(
  options: BenchmarkCliOptions,
  context: BenchmarkExecutionContext,
): string {
  return JSON.stringify({
    version: 2,
    lane: 'concurrency',
    checkpointGranularity: 'workload-concurrency-v1',
    context,
    mode: options.mode,
    targetQuads: options.targetQuads,
    concurrency: options.concurrency,
    cacheModes: options.cacheModes,
    operationTimeoutMs: options.operationTimeoutMs,
    image: options.image,
  });
}

export function benchmarkConcurrencyKey(
  cacheMode: CloudReplacementCacheMode,
  engine: CloudReplacementEngineId,
  workloadId: string,
  concurrency: BenchmarkConcurrency,
): string {
  return `${cacheMode}:${engine}:${workloadId}:${concurrency}`;
}

export function emptyBenchmarkCheckpoint(
  options: BenchmarkCliOptions,
  context: BenchmarkExecutionContext,
  identityId: string,
): BenchmarkCheckpoint {
  return {
    version: 2,
    latencyContextFingerprint: benchmarkLatencyContextFingerprint(options, context),
    concurrencyContextFingerprint: benchmarkConcurrencyContextFingerprint(options, context),
    identityId,
    completedLatencyKeys: [],
    completedConcurrencyKeys: [],
    latencyRecords: [],
    concurrencyRecords: [],
    correctnessRecords: [],
    correctnessFailures: [],
    diagnosticsByCacheMode: {},
    concurrencyDiagnosticsByKey: {},
  };
}

export async function loadBenchmarkCheckpoint(
  options: BenchmarkCliOptions,
  context: BenchmarkExecutionContext,
): Promise<BenchmarkCheckpoint | undefined> {
  try {
    const parsed = JSON.parse(await readFile(benchmarkCheckpointPath(options.out), 'utf8')) as
      Partial<BenchmarkCheckpoint>;
    if (parsed.version !== 2 ||
      typeof parsed.latencyContextFingerprint !== 'string' ||
      typeof parsed.concurrencyContextFingerprint !== 'string' ||
      typeof parsed.identityId !== 'string' ||
      !Array.isArray(parsed.completedLatencyKeys) ||
      !Array.isArray(parsed.completedConcurrencyKeys) ||
      !Array.isArray(parsed.latencyRecords) ||
      !Array.isArray(parsed.concurrencyRecords) ||
      !Array.isArray(parsed.correctnessRecords) ||
      !Array.isArray(parsed.correctnessFailures) ||
      typeof parsed.diagnosticsByCacheMode !== 'object' ||
      parsed.diagnosticsByCacheMode === null) {
      return undefined;
    }
    const expectedLatency = benchmarkLatencyContextFingerprint(options, context);
    const expectedConcurrency = benchmarkConcurrencyContextFingerprint(options, context);
    const latencyMatches = parsed.latencyContextFingerprint === expectedLatency;
    const concurrencyMatches = parsed.concurrencyContextFingerprint === expectedConcurrency;
    const validConcurrencyRecords = concurrencyMatches &&
      parsed.concurrencyRecords.every(isBenchmarkConcurrencyRecord) &&
      isBenchmarkDiagnosticsByKey(parsed.concurrencyDiagnosticsByKey);
    const validConcurrencyLane = validConcurrencyRecords &&
      hasCompleteConcurrencyDiagnostics(
        parsed.concurrencyRecords,
        parsed.concurrencyDiagnosticsByKey,
      );
    if (latencyMatches && validConcurrencyLane) {
      return sanitizeBenchmarkCheckpointConcurrency(parsed as BenchmarkCheckpoint);
    }
    return {
      ...emptyBenchmarkCheckpoint(options, context, parsed.identityId),
      ...(latencyMatches
        ? {
            completedLatencyKeys: parsed.completedLatencyKeys,
            latencyRecords: parsed.latencyRecords,
            correctnessRecords: parsed.correctnessRecords,
            correctnessFailures: parsed.correctnessFailures,
          }
        : {}),
      ...(validConcurrencyLane
        ? {
            completedConcurrencyKeys: completedConcurrencyKeysWithEvidence(
              parsed.completedConcurrencyKeys,
              parsed.concurrencyRecords,
              parsed.concurrencyDiagnosticsByKey,
            ),
            concurrencyRecords: parsed.concurrencyRecords,
            diagnosticsByCacheMode: rebuildBenchmarkDiagnosticsByCacheMode(
              parsed.concurrencyRecords,
              parsed.concurrencyDiagnosticsByKey,
            ),
            concurrencyDiagnosticsByKey: parsed.concurrencyDiagnosticsByKey,
          }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function sanitizeBenchmarkCheckpointConcurrency(
  checkpoint: BenchmarkCheckpoint,
): BenchmarkCheckpoint {
  return {
    ...checkpoint,
    completedConcurrencyKeys: completedConcurrencyKeysWithEvidence(
      checkpoint.completedConcurrencyKeys,
      checkpoint.concurrencyRecords,
      checkpoint.concurrencyDiagnosticsByKey,
    ),
    diagnosticsByCacheMode: rebuildBenchmarkDiagnosticsByCacheMode(
      checkpoint.concurrencyRecords,
      checkpoint.concurrencyDiagnosticsByKey,
    ),
  };
}

function completedConcurrencyKeysWithEvidence(
  keys: readonly string[],
  records: readonly ConcurrencyRecord[],
  diagnosticsByKey: Readonly<Record<string, CloudReplacementPgDiagnostics>>,
): string[] {
  const completeRecordKeys = new Set(records
    .filter((record) => !record.infrastructureFailure &&
      diagnosticsByKey[benchmarkConcurrencyKey(
        record.cacheMode,
        record.engine,
        record.caseId,
        record.concurrency,
      )] !== undefined)
    .map((record) => benchmarkConcurrencyKey(
      record.cacheMode,
      record.engine,
      record.caseId,
      record.concurrency,
    )));
  return [ ...new Set(keys) ].filter((key) => completeRecordKeys.has(key));
}

function hasCompleteConcurrencyDiagnostics(
  records: readonly unknown[],
  diagnosticsByKey: Readonly<Record<string, CloudReplacementPgDiagnostics>>,
): records is ConcurrencyRecord[] {
  return records.every((record) => {
    if (!isBenchmarkConcurrencyRecord(record)) {
      return false;
    }
    return diagnosticsByKey[benchmarkConcurrencyKey(
      record.cacheMode,
      record.engine,
      record.caseId,
      record.concurrency,
    )] !== undefined;
  });
}

function isBenchmarkDiagnosticsByKey(
  value: unknown,
): value is Record<string, CloudReplacementPgDiagnostics> {
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isBenchmarkPgDiagnostics);
}

function isBenchmarkConcurrencyRecord(value: unknown): value is ConcurrencyRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ConcurrencyRecord>;
  return isBenchmarkCacheMode(record.cacheMode) &&
    typeof record.caseId === 'string' &&
    record.caseId.length > 0 &&
    isBenchmarkEngineId(record.engine) &&
    isBenchmarkConcurrency(record.concurrency) &&
    isFiniteNonNegativeNumber(record.durationMs) &&
    isFiniteNonNegativeInteger(record.completed) &&
    isFiniteNonNegativeInteger(record.errors) &&
    isFiniteNonNegativeInteger(record.infrastructureErrors) &&
    typeof record.infrastructureFailure === 'boolean' &&
    isBenchmarkErrorEvidence(record.errorEvidence) &&
    isFiniteNonNegativeNumber(record.elapsedMs) &&
    isFiniteNonNegativeNumber(record.throughputPerSecond);
}

function isBenchmarkCacheMode(value: unknown): value is CloudReplacementCacheMode {
  return value === 'off' || value === 'production';
}

function isBenchmarkEngineId(value: unknown): value is CloudReplacementEngineId {
  return value === 'rdf3x' || value === 'qlever';
}

function isBenchmarkConcurrency(value: unknown): value is BenchmarkConcurrency {
  return value === 1 || value === 8 || value === 32;
}

function isBenchmarkErrorEvidence(value: unknown): value is CloudReplacementErrorEvidence {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const evidence = value as Partial<CloudReplacementErrorEvidence>;
  if (!evidence.counts || typeof evidence.counts !== 'object' ||
    Array.isArray(evidence.counts) || !Array.isArray(evidence.samples)) {
    return false;
  }
  const categories: CloudReplacementErrorCategory[] = [
    'timeout',
    'connection',
    'cancelled',
    'engine',
    'correctness',
    'unknown',
  ];
  const countEntries = Object.keys(evidence.counts);
  return countEntries.length === categories.length &&
    countEntries.every((key) => categories.includes(key as CloudReplacementErrorCategory)) &&
    categories.every((category) =>
      isFiniteNonNegativeInteger((evidence.counts as Record<string, unknown>)[category])) &&
    evidence.samples.every(isBenchmarkErrorSample);
}

function isBenchmarkErrorSample(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const sample = value as Partial<CloudReplacementErrorSample>;
  return isBenchmarkErrorCategory(sample.category) &&
    isBenchmarkErrorStage(sample.stage) &&
    typeof sample.name === 'string' &&
    sample.name.length > 0 &&
    (sample.code === null || typeof sample.code === 'string') &&
    typeof sample.message === 'string' &&
    sample.message.length > 0 &&
    isIsoTimestamp(sample.firstSeenAt) &&
    isIsoTimestamp(sample.lastSeenAt) &&
    isFiniteNonNegativeInteger(sample.count) &&
    typeof sample.workloadId === 'string' &&
    sample.workloadId.length > 0 &&
    isBenchmarkEngineId(sample.engine) &&
    isBenchmarkCacheMode(sample.cacheMode) &&
    isBenchmarkConcurrency(sample.concurrency);
}

function isBenchmarkErrorCategory(value: unknown): value is CloudReplacementErrorCategory {
  return value === 'timeout' || value === 'connection' || value === 'cancelled' ||
    value === 'engine' || value === 'correctness' || value === 'unknown';
}

function isBenchmarkErrorStage(value: unknown): value is CloudReplacementErrorStage {
  return value === 'acquire' || value === 'query' || value === 'materialize' ||
    value === 'cancel' || value === 'cleanup';
}

function isBenchmarkPgDiagnostics(value: unknown): value is CloudReplacementPgDiagnostics {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const diagnostics = value as Partial<CloudReplacementPgDiagnostics>;
  return (diagnostics.sharedBlocksRead === null ||
    isFiniteNonNegativeNumber(diagnostics.sharedBlocksRead)) &&
    (diagnostics.sharedBlocksHit === null ||
      isFiniteNonNegativeNumber(diagnostics.sharedBlocksHit)) &&
    (diagnostics.tempBytes === null || isFiniteNonNegativeNumber(diagnostics.tempBytes)) &&
    (diagnostics.memoryPeakBytes === null ||
      isFiniteNonNegativeNumber(diagnostics.memoryPeakBytes)) &&
    (diagnostics.memoryLimitBytes === null ||
      isFiniteNonNegativeNumber(diagnostics.memoryLimitBytes)) &&
    Array.isArray(diagnostics.diagnosticsUnavailable) &&
    diagnostics.diagnosticsUnavailable.every((entry) => typeof entry === 'string');
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export async function saveBenchmarkCheckpoint(
  options: BenchmarkCliOptions,
  checkpoint: BenchmarkCheckpoint,
): Promise<void> {
  const target = benchmarkCheckpointPath(options.out);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(compactBenchmarkCheckpoint(checkpoint), null, 2)}\n`);
  await rename(temporary, target);
}

export function compactBenchmarkCheckpoint(
  checkpoint: BenchmarkCheckpoint,
): BenchmarkCheckpoint {
  const compactCorrectness = (
    correctness: CloudReplacementCorrectness,
  ): CloudReplacementCorrectness => ({
    ...correctness,
    rdf3x: {
      ...correctness.rdf3x,
      rows: [],
      orderedDigest: '',
      multisetDigest: '',
    },
    qlever: {
      ...correctness.qlever,
      rows: [],
      orderedDigest: '',
      multisetDigest: '',
    },
  });
  return {
    ...checkpoint,
    latencyRecords: checkpoint.latencyRecords.map((record) => ({
      cacheMode: record.cacheMode,
      workload: record.workload,
      rdf3x: record.rdf3x,
      qlever: record.qlever,
      ignoredSteadyHelperColdMs: record.ignoredSteadyHelperColdMs,
    })),
    correctnessRecords: checkpoint.correctnessRecords.map((record) => ({
      ...record,
      correctness: compactCorrectness(record.correctness),
    })),
  };
}

const HELP = `Usage: bun scripts/native-rdf3x-benchmark.ts [options]

Cloud/PostgreSQL replacement evidence only; Local production keeps RDF3X.

Options:
  --mode=local|external                  Database mode. Default: local
  --executionLocation=local|cluster      Required in external mode
  --transport=direct|port-forward        Required in external mode
  --targetQuads=N                       Minimum fact count. Default: 20000
  --iterations=20                       Timed latency samples per case
  --warmupIterations=3                  Warmup samples after the cold sample
  --workloads=id,id                     Run only the selected benchmark cases
  --concurrency=1,8,32                  Sustained concurrency lanes
  --cacheMode=off|production|both       Cache evidence. Default: both
  --operationTimeoutMs=30000            Positive timeout for measured queries
  --image=xpod-rdf-postgres:pg17-smoke  Disposable local PG17/QLever image
  --out=.test-data/rdf-engine-perf-reports/...
                                         Sanitized JSON report path
  --dry-run                              Print the fixed gates and safe plan only
  --help                                 Print this help

External mode reads its URL only from XPOD_RDF_BENCHMARK_PG_URL.
The URL must name a dedicated database ending in _benchmark.
`;

export function parseArgs(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): BenchmarkCliOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  let help = false;
  const valueOptions = new Set([
    'mode',
    'executionLocation',
    'transport',
    'targetQuads',
    'iterations',
    'warmupIterations',
    'workloads',
    'concurrency',
    'cacheMode',
    'operationTimeoutMs',
    'image',
    'out',
  ]);

  for (const argument of args) {
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--help') {
      help = true;
      continue;
    }
    const match = /^--([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(argument);
    const name = match?.[1];
    if (!name || !valueOptions.has(name)) {
      throw new Error(`Unknown option --${optionName(argument)}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate --${name} option`);
    }
    values.set(name, match[2] ?? '');
  }

  const mode = enumOption(values, 'mode', [ 'local', 'external' ], 'local');
  let executionLocation: BenchmarkExecutionLocation = 'local';
  let transport: BenchmarkTransport = 'direct';
  if (mode === 'external' && !help) {
    if (!values.has('executionLocation')) {
      throw new Error('External mode requires --executionLocation');
    }
    if (!values.has('transport')) {
      throw new Error('External mode requires --transport');
    }
    executionLocation = enumOption(
      values,
      'executionLocation',
      [ 'local', 'cluster' ],
      'local',
    );
    transport = enumOption(
      values,
      'transport',
      [ 'direct', 'port-forward' ],
      'direct',
    );
  }
  const targetQuads = positiveIntegerOption(values, 'targetQuads', DEFAULT_TARGET_QUADS);
  const iterations = positiveIntegerOption(values, 'iterations', DEFAULT_ITERATIONS);
  const warmupIterations = nonNegativeIntegerOption(
    values,
    'warmupIterations',
    DEFAULT_WARMUP_ITERATIONS,
  );
  const workloadIds = workloadOption(values.get('workloads'));
  const concurrency = concurrencyOption(values.get('concurrency'));
  const cacheMode = enumOption(
    values,
    'cacheMode',
    [ 'off', 'production', 'both' ],
    'both',
  );
  const operationTimeoutMs = positiveIntegerOption(
    values,
    'operationTimeoutMs',
    DEFAULT_OPERATION_TIMEOUT_MS,
  );
  const image = nonEmptyOption(values, 'image', DEFAULT_IMAGE);
  const out = nonEmptyOption(
    values,
    'out',
    `.test-data/rdf-engine-perf-reports/cloud-replacement-${targetQuads}.json`,
  );
  const cacheModes: CloudReplacementCacheMode[] = cacheMode === 'both'
    ? [ 'off', 'production' ]
    : [ cacheMode ];

  let databaseName = LOCAL_DATABASE;
  let benchmarkDatabaseUrl: string | undefined;
  if (mode === 'external' && !help) {
    benchmarkDatabaseUrl = env[EXTERNAL_DATABASE_ENV];
    if (!benchmarkDatabaseUrl) {
      throw new Error(`External mode requires ${EXTERNAL_DATABASE_ENV}`);
    }
    databaseName = assertDedicatedBenchmarkDatabase(benchmarkDatabaseUrl);
  }

  return {
    mode,
    targetQuads,
    iterations,
    warmupIterations,
    workloadIds,
    concurrency,
    cacheMode,
    cacheModes,
    operationTimeoutMs,
    image,
    out,
    dryRun,
    help,
    databaseName,
    executionLocation,
    transport,
    ...(benchmarkDatabaseUrl ? { benchmarkDatabaseUrl } : {}),
  };
}

export function assertDedicatedBenchmarkDatabase(connectionUrl: string): string {
  try {
    const parsed = new URL(connectionUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('protocol');
    }
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) {
      throw new Error('path');
    }
    const encodedDatabase = parsed.pathname.slice(1);
    if (!encodedDatabase || encodedDatabase.includes('/')) {
      throw new Error('path');
    }
    const database = decodeURIComponent(encodedDatabase);
    if (!database || database.includes('/') || !database.endsWith('_benchmark')) {
      throw new Error('name');
    }
    return database;
  } catch {
    throw new Error(
      'External mode requires a dedicated benchmark database ending in _benchmark',
    );
  }
}

export function benchmarkCleanupSql(connectionUrl: string): [ string, string ] {
  assertDedicatedBenchmarkDatabase(connectionUrl);
  return [
    `DROP SCHEMA IF EXISTS ${BENCHMARK_SCHEMA} CASCADE`,
    `CREATE SCHEMA ${BENCHMARK_SCHEMA}`,
  ];
}

export function buildExternalBenchmarkConnectionString(connectionUrl: string): string {
  assertDedicatedBenchmarkDatabase(connectionUrl);
  const parsed = new URL(connectionUrl);
  const existingOptions = parsed.searchParams.getAll('options');
  parsed.searchParams.delete('options');
  parsed.searchParams.append(
    'options',
    [ ...existingOptions, BENCHMARK_SEARCH_PATH_OPTION ].join(' ').trim(),
  );
  return parsed.toString();
}

export function buildLocalBenchmarkConnectionString(connectionUrl: string): string {
  return connectionUrl;
}

export async function collectBenchmarkDatabaseIdentity(
  client: BenchmarkDatabaseIdentityClient,
): Promise<string> {
  let result: { rows: Array<{ system_identifier?: unknown; database_name?: unknown }> };
  try {
    result = await client.query(
      'SELECT (pg_control_system()).system_identifier::text AS system_identifier, current_database() AS database_name',
    );
  } catch {
    throw new Error('Unable to collect PostgreSQL database identity from pg_control_system()');
  }
  const row = result.rows[0];
  if (typeof row?.system_identifier !== 'string' ||
    row.system_identifier.length === 0 ||
    typeof row.database_name !== 'string' ||
    row.database_name.length === 0) {
    throw new Error('Unable to collect PostgreSQL database identity from pg_control_system()');
  }
  return createHash('sha256')
    .update(row.system_identifier)
    .update('\0')
    .update(row.database_name)
    .digest('hex');
}

export function buildBenchmarkLoadingPlan(
  targetQuads: number,
  messagesPerBatch = DEFAULT_MESSAGES_PER_BATCH,
): BenchmarkLoadingPlan {
  assertPositiveInteger(targetQuads, 'targetQuads');
  assertPositiveInteger(messagesPerBatch, 'messagesPerBatch');
  const syntheticPodCount = targetQuads >= 10_000_000
    ? 512
    : targetQuads >= 2_000_000
      ? 128
      : 32;
  return {
    targetQuads,
    syntheticPodCount,
    messagesPerBatch,
    maxBatchQuads: messagesPerBatch * RDF_MODELS_SYNTHETIC_MESSAGE_QUADS,
  };
}

export async function loadBenchmarkFacts(
  engine: BenchmarkPutEngine,
  targetQuads: number,
  options: {
    messagesPerBatch?: number;
    factCount: () => number | Promise<number>;
  },
): Promise<number> {
  const plan = buildBenchmarkLoadingPlan(
    targetQuads,
    options.messagesPerBatch ?? DEFAULT_MESSAGES_PER_BATCH,
  );
  const seed = buildRdfModelsBenchmarkSeed({
    syntheticMessages: 0,
    syntheticPodCount: plan.syntheticPodCount,
    caseProfile: 'default',
  });
  await engine.put(seed);

  const topology = buildCloudReplacementTopology(plan.syntheticPodCount);
  await engine.put(topology);

  let actualFacts = await readBenchmarkFactCount(options.factCount);
  let start = 0;
  let loadWaves = 0;
  while (actualFacts < targetQuads) {
    if (loadWaves >= BENCHMARK_MAX_LOAD_WAVES) {
      throw new Error(
        `Benchmark loading stopped ${targetQuads - actualFacts} facts below target after ` +
        `${BENCHMARK_MAX_LOAD_WAVES} load waves`,
      );
    }
    loadWaves += 1;
    let remainingMessages = Math.ceil(
      (targetQuads - actualFacts) / RDF_MODELS_SYNTHETIC_MESSAGE_QUADS,
    );
    while (remainingMessages > 0) {
      const count = Math.min(plan.messagesPerBatch, remainingMessages);
      const batch = buildRdfModelsSyntheticMessageBatch({
        start,
        count,
        syntheticPodCount: plan.syntheticPodCount,
      });
      await engine.put(batch);
      start += count;
      remainingMessages -= count;
    }
    actualFacts = await readBenchmarkFactCount(options.factCount);
  }
  return actualFacts;
}

export async function countBenchmarkFacts(
  queryable: {
    query<T>(sql: string): Promise<{ rows: T[] }>;
  },
): Promise<number> {
  const result = await queryable.query<{ count: string | number }>(
    'SELECT COUNT(*) FROM rdf_quads',
  );
  return readBenchmarkFactCount(() => Number(result.rows[0]?.count));
}

async function readBenchmarkFactCount(
  factCount: () => number | Promise<number>,
): Promise<number> {
  const count = await factCount();
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    throw new Error('Benchmark fact count must be a finite non-negative integer');
  }
  return count;
}

export function createCloudReplacementAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  engine: BenchmarkSparqlEngine,
  options: BenchmarkAdapterOptions = {},
): CloudReplacementEngineAdapter<Id> {
  const now = options.now ?? (() => performance.now());
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new Error('Benchmark adapter operationTimeoutMs must be finite and positive');
  }
  return {
    id,
    async execute(workload, sampleIdentity, signal): Promise<CloudReplacementExecution> {
      let stage: CloudReplacementErrorStage = 'query';
      let operation: { signal: AbortSignal; dispose: () => void } | undefined;
      try {
        throwIfAborted(signal);
        operation = createOperationAbortScope(signal, operationTimeoutMs);
        const query = sampleIdentity === undefined
          ? workload.sparql
          : `${workload.sparql}\n${sampleIdentity}`;
        let activeStream: unknown;
        const startedAt = now();
        const operationSignal = operation.signal;
        const rawRows = await raceWithAbort((async () => {
          stage = 'query';
          activeStream = await engine.queryBindings(
            query,
            workload.accessScope?.basePath ?? BASE_PATH,
            workload.accessScope,
            { signal: operationSignal, timeoutMs: operationTimeoutMs },
          );
          stage = 'materialize';
          return await materializeBindings(activeStream, operationSignal);
        })(), operationSignal, () => destroyStream(activeStream));
        const elapsedMs = now() - startedAt;

        const metrics = engine.getMetrics();
        const physicalPlan = [ ...(metrics.lastPrimary?.plan ?? []) ];
        assertSelectedEngineMetrics(id, metrics, physicalPlan);
        const rows = rawRows.map((binding) => canonicalCloudReplacementRow(binding));
        const digests = canonicalCloudReplacementDigests(rows);
        return {
          rows,
          ...digests,
          fallbackReason: null,
          physicalPlan,
          queryElapsedMs: sampleIdentity === undefined && !options.timeWithoutSampleIdentity
            ? null
            : elapsedMs,
        };
      } catch (error) {
        if (error instanceof BenchmarkEngineExecutionError) {
          throw error;
        }
        throw new BenchmarkEngineExecutionError(id, error, benchmarkErrorStage(error, stage));
      } finally {
        operation?.dispose();
      }
    },
  };
}

export async function measureCloudReplacementCaseWithTrueCold(
  workload: CloudReplacementWorkload,
  rdf3xAdapter: CloudReplacementEngineAdapter<'rdf3x'>,
  qleverAdapter: CloudReplacementEngineAdapter<'qlever'>,
  options: BenchmarkCaseMeasurementOptions,
): Promise<BenchmarkCaseMeasurement> {
  await options.prepareColdState();
  const adapters = options.coldFirstEngine === 'rdf3x'
    ? [ rdf3xAdapter, qleverAdapter ] as const
    : [ qleverAdapter, rdf3xAdapter ] as const;
  const coldMs: Record<CloudReplacementEngineId, number> = {
    rdf3x: 0,
    qlever: 0,
  };
  for (const adapter of adapters) {
    const sampleIdentity = options.cacheMode === 'off'
      ? options.identitySource.next(adapter.id)
      : undefined;
    const execution = await adapter.execute(workload, sampleIdentity);
    if (execution.fallbackReason !== null) {
      throw new Error(`Cloud replacement ${adapter.id} cold execution observed a fallback`);
    }
    if (execution.queryElapsedMs === null || !Number.isFinite(execution.queryElapsedMs) ||
      execution.queryElapsedMs < 0) {
      throw new Error(
        `Cloud replacement ${adapter.id} cold execution requires finite queryElapsedMs`,
      );
    }
    coldMs[adapter.id] = execution.queryElapsedMs;
  }

  const correctness = await compareCloudReplacementCase(
    workload,
    rdf3xAdapter,
    qleverAdapter,
  );
  const steady = await measureCloudReplacementCase(
    workload,
    rdf3xAdapter,
    qleverAdapter,
    {
      warmupIterations: options.warmupIterations,
      iterations: options.iterations,
      coldFirstEngine: options.coldFirstEngine,
      operationTimeoutMs: options.operationTimeoutMs,
      ...benchmarkCacheMeasurementOptions(options.cacheMode, options.identitySource),
    },
  );
  return {
    correctness,
    rdf3x: { ...steady.rdf3x, coldMs: coldMs.rdf3x },
    qlever: { ...steady.qlever, coldMs: coldMs.qlever },
    ignoredSteadyHelperColdMs: {
      rdf3x: steady.rdf3x.coldMs,
      qlever: steady.qlever.coldMs,
    },
  };
}

export async function measureCloudReplacementCaseWithTimeoutEvidence(
  workload: CloudReplacementWorkload,
  rdf3xAdapter: CloudReplacementEngineAdapter<'rdf3x'>,
  qleverAdapter: CloudReplacementEngineAdapter<'qlever'>,
  options: BenchmarkCaseMeasurementOptions,
): Promise<BenchmarkCaseMeasurement> {
  try {
    return await measureCloudReplacementCaseWithTrueCold(
      workload,
      rdf3xAdapter,
      qleverAdapter,
      options,
    );
  } catch (error) {
    const failedEngine = benchmarkTimeoutEngine(error);
    if (!failedEngine) {
      throw error;
    }
    const survivingAdapter = failedEngine === 'rdf3x' ? qleverAdapter : rdf3xAdapter;
    const timedOut = censoredTimeoutLatency(
      options.cacheMode,
      options.operationTimeoutMs,
      options.iterations,
    );
    const emptyExecution = emptyBenchmarkExecution(options.operationTimeoutMs);
    let surviving: Awaited<ReturnType<typeof measureSingleBenchmarkAdapter>>;
    try {
      surviving = await measureSingleBenchmarkAdapter(
        workload,
        survivingAdapter,
        options,
      );
    } catch (survivingError) {
      if (!(survivingError instanceof BenchmarkEngineExecutionError) ||
        !isTimeoutError(survivingError)) {
        throw survivingError;
      }
      const failures = [ failedEngine, survivingError.engine ].map((engine) =>
        `${engine}-timeout:${options.operationTimeoutMs}ms`);
      return {
        correctness: {
          correct: false,
          sameMultiset: false,
          sameOrder: false,
          failures,
          rdf3x: emptyExecution,
          qlever: emptyExecution,
        },
        rdf3x: timedOut,
        qlever: timedOut,
        ignoredSteadyHelperColdMs: {
          rdf3x: timedOut.coldMs,
          qlever: timedOut.coldMs,
        },
      };
    }
    const correctness: CloudReplacementCorrectness = {
      correct: false,
      sameMultiset: false,
      sameOrder: false,
      failures: [ `${failedEngine}-timeout:${options.operationTimeoutMs}ms` ],
      rdf3x: failedEngine === 'rdf3x' ? emptyExecution : surviving.execution,
      qlever: failedEngine === 'qlever' ? emptyExecution : surviving.execution,
    };
    const rdf3x = failedEngine === 'rdf3x' ? timedOut : surviving.latency;
    const qlever = failedEngine === 'qlever' ? timedOut : surviving.latency;
    return {
      correctness,
      rdf3x,
      qlever,
      ignoredSteadyHelperColdMs: {
        rdf3x: rdf3x.coldMs,
        qlever: qlever.coldMs,
      },
    };
  }
}

async function measureSingleBenchmarkAdapter(
  workload: CloudReplacementWorkload,
  adapter: CloudReplacementEngineAdapter,
  options: BenchmarkCaseMeasurementOptions,
): Promise<{ latency: CloudReplacementLatency; execution: CloudReplacementExecution }> {
  await options.prepareColdState();
  const execute = async (): Promise<CloudReplacementExecution> => adapter.execute(
    workload,
    options.cacheMode === 'off' ? options.identitySource.next(adapter.id) : undefined,
  );
  const cold = await execute();
  for (let index = 0; index < options.warmupIterations; index += 1) {
    await execute();
  }
  const samples: number[] = [];
  let representative = cold;
  for (let index = 0; index < options.iterations; index += 1) {
    representative = await execute();
    samples.push(finiteExecutionElapsed(representative, adapter.id));
  }
  return {
    latency: summarizeBenchmarkLatency(
      options.cacheMode,
      finiteExecutionElapsed(cold, adapter.id),
      samples,
    ),
    execution: representative,
  };
}

function finiteExecutionElapsed(
  execution: CloudReplacementExecution,
  engine: CloudReplacementEngineId,
): number {
  if (execution.queryElapsedMs === null || !Number.isFinite(execution.queryElapsedMs) ||
    execution.queryElapsedMs < 0) {
    throw new Error(`Cloud replacement ${engine} execution requires finite queryElapsedMs`);
  }
  return execution.queryElapsedMs;
}

function censoredTimeoutLatency(
  cacheMode: CloudReplacementCacheMode,
  timeoutMs: number,
  iterations: number,
): CloudReplacementLatency {
  return summarizeBenchmarkLatency(
    cacheMode,
    timeoutMs,
    Array.from({ length: iterations }, () => timeoutMs),
  );
}

function summarizeBenchmarkLatency(
  cacheMode: CloudReplacementCacheMode,
  coldMs: number,
  samplesMs: number[],
): CloudReplacementLatency {
  const sorted = [ ...samplesMs ].sort((left, right) => left - right);
  const percentile = (value: number): number => sorted.length === 0
    ? 0
    : sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]!;
  return {
    cacheMode,
    coldMs,
    samplesMs,
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

function emptyBenchmarkExecution(timeoutMs: number): CloudReplacementExecution {
  const digests = canonicalCloudReplacementDigests([]);
  return {
    rows: [],
    ...digests,
    fallbackReason: `timeout:${timeoutMs}ms`,
    physicalPlan: [],
    queryElapsedMs: timeoutMs,
  };
}

function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof DOMException && current.name === 'TimeoutError') {
      return true;
    }
    if (current instanceof Error && /timed out|timeout/iu.test(current.message)) {
      return true;
    }
    current = typeof current === 'object' && current !== null && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

export function benchmarkTimeoutEngine(
  error: unknown,
): CloudReplacementEngineId | undefined {
  if (!isTimeoutError(error)) {
    return undefined;
  }
  if (error instanceof BenchmarkEngineExecutionError) {
    return error.engine;
  }
  const message = errorMessage(error);
  const match = /cloud replacement (rdf3x|qlever) operation/iu.exec(message);
  return match?.[1] as CloudReplacementEngineId | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function benchmarkCacheMeasurementOptions(
  cacheMode: CloudReplacementCacheMode,
  identitySource?: CloudReplacementSampleIdentitySource,
): { cacheMode: 'off'; identitySource: CloudReplacementSampleIdentitySource } |
  { cacheMode: 'production' } {
  if (cacheMode === 'off') {
    if (!identitySource) {
      throw new Error('Cache-off benchmark measurements require identitySource');
    }
    return { cacheMode, identitySource };
  }
  return { cacheMode };
}

export function buildBenchmarkCacheModePairPlan(
  cacheModes: readonly CloudReplacementCacheMode[],
): BenchmarkCacheModePairPlan[] {
  return cacheModes.map((cacheMode) => ({
    cacheMode,
    refreshDerivedIndexes: false,
    recordBuildAndStorage: false,
  }));
}

export function buildBenchmarkPgPoolConfiguration(
  connectionString: string,
  timeoutMs: number,
  max: number,
): BenchmarkPgPoolConfiguration {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Benchmark pool timeoutMs must be finite and positive');
  }
  assertPositiveInteger(max, 'pool max');
  return {
    connectionString,
    max,
    connectionTimeoutMillis: BENCHMARK_CONNECTION_TIMEOUT_MS,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  };
}

export function buildBenchmarkPostgresEngineOptions(
  engine: CloudReplacementEngineId,
  connectionString: string,
  cacheMode: CloudReplacementCacheMode,
  operationTimeoutMs: number,
  createPool: (configuration: BenchmarkPgPoolConfiguration) => unknown =
    (configuration) => new Pool(configuration),
): PostgresRdfEngineOptions {
  const cacheEnabled = cacheMode === 'production';
  return {
    pool: createPool(buildBenchmarkPgPoolConfiguration(
      connectionString,
      operationTimeoutMs,
      32,
    )),
    nativeSparqlEnabled: engine === 'qlever',
    nativeSparqlMemoryLimitBytes: engine === 'qlever'
      ? BENCHMARK_QLEVER_MEMORY_LIMIT_BYTES
      : undefined,
    queryResultCacheEnabled: cacheEnabled,
    materializedResultCacheEnabled: cacheEnabled,
    deferPgCustomIndexInitialization: true,
    maintenanceIntervalMs: 0,
  };
}

export function buildSharedStorageEvidence(
  storageStats: { factsBytes: number; derivedBytes: number },
): SharedStorageEvidence {
  return {
    factsBytes: storageStats.factsBytes,
    sharedPhysicalIndexBytes: storageStats.derivedBytes,
    qleverIncrementalBytes: null,
    reportStorageBytes: {
      rdf3x: storageStats.derivedBytes,
      qlever: storageStats.derivedBytes,
    },
    semantics: 'shared-not-additive',
  };
}

export function buildBenchmarkReportSummary(input: BenchmarkReportSummaryInput) {
  const evidenceModes = selectBenchmarkEvidenceModes(input.cacheModes);
  const latencyCacheMode = evidenceModes.latency;
  const gateCacheMode = evidenceModes.concurrencyAndGates;
  const preferredLatency = input.latencyRecords.filter((record) =>
    record.cacheMode === latencyCacheMode);
  const gateLatency = input.latencyRecords.filter((record) =>
    record.cacheMode === gateCacheMode);
  const gateConcurrency = input.concurrencyRecords.filter((record) =>
    record.cacheMode === gateCacheMode);
  const resourceDiagnostics = input.diagnosticsByCacheMode[gateCacheMode];
  if (!resourceDiagnostics) {
    throw new Error(`Missing ${gateCacheMode} resource diagnostics`);
  }

  const throughputRatio = calculateCloudReplacementThroughputRatio(
    throughputMeasurements(gateConcurrency, 'rdf3x'),
    throughputMeasurements(gateConcurrency, 'qlever'),
  );
  const errorRates = {
    rdf3x: benchmarkEngineErrorRate(gateConcurrency, 'rdf3x'),
    qlever: benchmarkEngineErrorRate(gateConcurrency, 'qlever'),
  };
  const infrastructureErrorRates = {
    rdf3x: benchmarkEngineInfrastructureErrorRate(gateConcurrency, 'rdf3x'),
    qlever: benchmarkEngineInfrastructureErrorRate(gateConcurrency, 'qlever'),
  };
  const baselineValid = errorRates.rdf3x === 0;
  const evidenceComplete = gateConcurrency.every((record) => !record.infrastructureFailure);
  const cases = preferredLatency.map((record) => {
    const selectedCorrectness = input.cacheModes.map((cacheMode) => {
      const correctness = input.correctnessRecords.find((entry) =>
        entry.cacheMode === cacheMode && entry.caseId === record.workload.id)?.correctness;
      if (!correctness) {
        throw new Error(`Missing ${cacheMode} correctness for ${record.workload.id}`);
      }
      return { cacheMode, correctness };
    });
    const correctnessFailures = selectedCorrectness.flatMap(({ cacheMode, correctness }) =>
      correctness.failures.map((failure) => `${cacheMode}:${failure}`));
    const correctness = {
      correct: selectedCorrectness.every((entry) => entry.correctness.correct),
      sameMultiset: selectedCorrectness.every((entry) => entry.correctness.sameMultiset),
      sameOrder: selectedCorrectness.every((entry) => entry.correctness.sameOrder),
      failures: correctnessFailures,
    };
    return {
      id: record.workload.id,
      group: record.workload.group,
      correctnessFailures,
      correctness,
      rdf3x: {
        fallbackReason: null,
        coldMs: record.rdf3x.coldMs,
        p50Ms: record.rdf3x.p50Ms,
        p95Ms: record.rdf3x.p95Ms,
        p99Ms: record.rdf3x.p99Ms,
      },
      qlever: {
        fallbackReason: null,
        coldMs: record.qlever.coldMs,
        p50Ms: record.qlever.p50Ms,
        p95Ms: record.qlever.p95Ms,
        p99Ms: record.qlever.p99Ms,
      },
    };
  });
  const correctnessPassed = input.correctnessFailures.length === 0 &&
    cases.every((entry) => entry.correctness.correct) &&
    baselineValid &&
    evidenceComplete &&
    input.qleverReady;
  const p95Comparisons = gateLatency.map((record) => ({
    group: record.workload.group,
    rdf3xP95Ms: Math.max(record.rdf3x.p95Ms, Number.EPSILON),
    qleverP95Ms: record.qlever.p95Ms,
  }));
  const decision = decideCloudReplacement({
    correctnessPassed,
    criticalShortP95Ratios: gateLatency
      .filter((record) => record.workload.group === 'short' &&
        record.workload.concurrencyRepresentative)
      .map((record) => record.qlever.p95Ms /
        Math.max(record.rdf3x.p95Ms, Number.EPSILON)),
    weightedP95Ratio: calculateCloudReplacementWeightedP95Ratio(p95Comparisons),
    throughputRatio,
    largeCaseSpeedups: gateLatency
      .filter((record) => record.workload.group === 'large')
      .map((record) => record.rdf3x.p95Ms /
        Math.max(record.qlever.p95Ms, Number.EPSILON)),
    errorRate: errorRates.qlever,
    memoryLimitRatio: null,
    tempDiskLimitRatio: null,
  });

  return {
    source: input,
    latencyCacheMode,
    gateCacheMode,
    preferredLatency,
    gateLatency,
    gateConcurrency,
    throughputRatio,
    errorRates,
    infrastructureErrorRates,
    baselineValid,
    evidenceComplete,
    correctnessPassed,
    qleverReady: input.qleverReady,
    environment: { qleverReady: input.qleverReady },
    resourceDiagnostics,
    cases,
    decision,
  };
}

function selectBenchmarkEvidenceModes(
  cacheModes: readonly CloudReplacementCacheMode[],
): { latency: CloudReplacementCacheMode; concurrencyAndGates: CloudReplacementCacheMode } {
  if (cacheModes.length === 0) {
    throw new Error('Cloud replacement report requires at least one cache mode');
  }
  return {
    latency: cacheModes.includes('production') ? 'production' : 'off',
    concurrencyAndGates: cacheModes.includes('off') ? 'off' : 'production',
  };
}

function throughputMeasurements(
  records: readonly ConcurrencyRecord[],
  engine: CloudReplacementEngineId,
): Array<{ completed: number; elapsedMs: number }> {
  return records
    .filter((record) => record.engine === engine)
    .map((record) => ({ completed: record.completed, elapsedMs: record.elapsedMs }));
}

export function upsertBenchmarkConcurrencyRecord(
  records: readonly ConcurrencyRecord[],
  next: ConcurrencyRecord,
): ConcurrencyRecord[] {
  const nextKey = benchmarkConcurrencyKey(
    next.cacheMode,
    next.engine,
    next.caseId,
    next.concurrency,
  );
  let replaced = false;
  const updated = records.map((record) => {
    const key = benchmarkConcurrencyKey(
      record.cacheMode,
      record.engine,
      record.caseId,
      record.concurrency,
    );
    if (key !== nextKey) {
      return record;
    }
    replaced = true;
    return next;
  });
  return replaced ? updated : [ ...updated, next ];
}

export function rebuildBenchmarkDiagnosticsByCacheMode(
  records: readonly ConcurrencyRecord[],
  diagnosticsByKey: Readonly<Record<string, CloudReplacementPgDiagnostics>>,
): BenchmarkDiagnosticsByCacheMode {
  const diagnosticsByCacheMode: BenchmarkDiagnosticsByCacheMode = {};
  for (const record of records) {
    const key = benchmarkConcurrencyKey(
      record.cacheMode,
      record.engine,
      record.caseId,
      record.concurrency,
    );
    const cellDiagnostics = diagnosticsByKey[key];
    if (!cellDiagnostics) {
      throw new Error(`Missing concurrency diagnostics for ${key}`);
    }
    const modeDiagnostics = diagnosticsByCacheMode[record.cacheMode] ?? {};
    modeDiagnostics[record.engine] = modeDiagnostics[record.engine]
      ? mergeBenchmarkPgDiagnostics(modeDiagnostics[record.engine], cellDiagnostics)
      : cellDiagnostics;
    diagnosticsByCacheMode[record.cacheMode] = modeDiagnostics as Record<
      CloudReplacementEngineId,
      CloudReplacementPgDiagnostics
    >;
  }
  return diagnosticsByCacheMode;
}

function benchmarkEngineErrorRate(
  records: readonly ConcurrencyRecord[],
  engine: CloudReplacementEngineId,
): number {
  const selected = records.filter((record) => record.engine === engine);
  const completed = selected.reduce((sum, record) => sum + record.completed, 0);
  const errors = selected.reduce((sum, record) => sum + record.errors, 0);
  const operations = completed + errors;
  if (!Number.isFinite(operations) || operations <= 0) {
    throw new Error(`Cloud replacement ${engine} error rate requires completed operations`);
  }
  return errors / operations;
}

function benchmarkEngineInfrastructureErrorRate(
  records: readonly ConcurrencyRecord[],
  engine: CloudReplacementEngineId,
): number {
  const selected = records.filter((record) => record.engine === engine);
  const completed = selected.reduce((sum, record) => sum + record.completed, 0);
  const errors = selected.reduce((sum, record) => sum + record.errors, 0);
  const infrastructureErrors = selected.reduce((sum, record) =>
    sum + record.infrastructureErrors, 0);
  const operations = completed + errors + infrastructureErrors;
  if (!Number.isFinite(operations) || operations <= 0) {
    throw new Error(
      `Cloud replacement ${engine} infrastructure error rate requires attempted operations`,
    );
  }
  return infrastructureErrors / operations;
}

function createOperationAbortScope(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(outerSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  if (outerSignal?.aborted) {
    forwardAbort();
  } else {
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(
      `Benchmark operation timed out after ${timeoutMs}ms`,
      'TimeoutError',
    ));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function assertSelectedEngineMetrics(
  id: CloudReplacementEngineId,
  metrics: BenchmarkAdapterMetrics,
  plan: readonly string[],
): void {
  if (metrics.lastFallback !== undefined && metrics.lastFallback !== null) {
    throw new Error(`Cloud replacement ${id} adapter observed a fallback`);
  }
  if ((metrics.fallbackCount ?? 0) !== 0) {
    throw new Error(`Cloud replacement ${id} adapter observed a fallback`);
  }
  if (metrics.lastPrimary?.operation !== 'queryBindings') {
    throw new Error(`Cloud replacement ${id} adapter did not record a primary query`);
  }
  const selected = id === 'qlever'
    ? plan.some((entry) => entry === 'NativeSparql')
    : plan.some((entry) =>
      entry.startsWith('PostgresRdf3x') ||
      entry.startsWith('Rdf3xJoinBGP(') ||
      RDF3X_PERMUTATION_SCAN_MARKERS.has(entry) ||
      entry === 'Rdf3xMembershipScan');
  if (!selected) {
    throw new Error(`Cloud replacement ${id} adapter selected engine mismatch`);
  }
}

async function materializeBindings(
  stream: unknown,
  signal?: AbortSignal,
): Promise<Array<Readonly<Record<string, Term | undefined>>>> {
  if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    throw new Error('Cloud replacement queryBindings did not return an async iterable');
  }
  const rows: Array<Readonly<Record<string, Term | undefined>>> = [];
  for await (const binding of stream as AsyncIterable<unknown>) {
    throwIfAborted(signal);
    if (!binding || typeof (binding as Iterable<unknown>)[Symbol.iterator] !== 'function') {
      throw new Error('Cloud replacement query returned a non-binding row');
    }
    const row: Record<string, Term | undefined> = {};
    for (const entry of binding as Iterable<unknown>) {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error('Cloud replacement query returned a malformed binding');
      }
      const variable = entry[0];
      const name = typeof variable === 'string'
        ? variable
        : typeof variable === 'object' && variable !== null &&
          'value' in variable && typeof variable.value === 'string'
          ? variable.value
          : undefined;
      if (!name) {
        throw new Error('Cloud replacement query returned an unnamed variable');
      }
      row[name] = entry[1] as Term | undefined;
    }
    rows.push(row);
  }
  return rows;
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return await operation;
  }
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => {
      const primaryError = abortReason(signal);
      try {
        onAbort?.();
      } catch (cleanupError) {
        reject(new AggregateError(
          [ primaryError, cleanupError ],
          'Benchmark operation aborted and stream cleanup failed',
        ));
        return;
      }
      reject(primaryError);
    });
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function destroyStream(stream: unknown): void {
  const destroy = stream && typeof stream === 'object' && 'destroy' in stream
    ? (stream as { destroy?: () => void }).destroy
    : undefined;
  if (typeof destroy === 'function') {
    destroy.call(stream);
  }
}

function buildDryRunPlan(options: BenchmarkCliOptions): Record<string, unknown> {
  const evidenceModes = selectBenchmarkEvidenceModes(options.cacheModes);
  return {
    mode: options.mode,
    targetQuads: options.targetQuads,
    iterations: options.iterations,
    warmupIterations: options.warmupIterations,
    workloadIds: options.workloadIds,
    concurrency: options.concurrency,
    cacheModes: options.cacheModes,
    operationTimeoutMs: options.operationTimeoutMs,
    buildSetupTimeoutMs: BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
    concurrencyDurationMs: CONCURRENCY_DURATION_MS,
    image: options.image,
    out: options.out,
    engines: {
      rdf3x: {
        nativeSparqlEnabled: false,
        compatibilityFallback: false,
        cancellation: 'server-statement-timeout-plus-prompt-client-race',
      },
      qlever: {
        nativeSparqlEnabled: true,
        compatibilityFallback: false,
        cancellation: 'native-abort-signal-plus-server-statement-timeout',
      },
    },
    loading: buildBenchmarkLoadingPlan(options.targetQuads),
    workload: {
      source: 'shared-product-facts',
      coldState: 'recorded-before-correctness-with-caller-owned-query-cache-reset',
      coldFirstEngine: 'alternating-by-workload-and-cache-mode',
      cacheOffIdentitySource: 'single-run-source',
    },
    engineLifecycle: {
      buildPairCount: 1,
      measurementPairCount: options.cacheModes.length,
      initialization: 'long-timeout-build-pair-then-independent-cache-mode-pairs',
      buildTimings: 'build-pair-rdf3x-refresh-and-qlever-init-only',
    },
    storage: {
      snapshotCount: 1,
      semantics: 'shared-not-additive',
      qleverIncrementalBytes: null,
    },
    evidenceModes,
    diagnostics: {
      attribution: 'per-engine-concurrency-phases-only',
      unavailable: 'interleaved-correctness-and-latency-resource-attribution',
    },
    weights: CLOUD_REPLACEMENT_GROUP_WEIGHTS,
    thresholds: CLOUD_REPLACEMENT_THRESHOLDS,
    safety: options.mode === 'external'
      ? {
          connectionSource: EXTERNAL_DATABASE_ENV,
          databaseGuard: 'decoded-name-ends-with-_benchmark',
          cleanup: `drop-and-recreate-${BENCHMARK_SCHEMA}-schema`,
        }
      : {
          connectionSource: 'disposable-local-container',
          cleanup: 'remove-container',
        },
  };
}

async function main(): Promise<void> {
  let options: BenchmarkCliOptions | undefined;
  let parityConnectionString: string | undefined;
  try {
    const parityOptions = parseRdf3xParityArgs();
    if (parityOptions) {
      parityConnectionString = process.env[EXTERNAL_DATABASE_ENV];
      const envelope = parityOptions.mode === 'contract'
        ? await runRdf3xParityContract()
        : parityOptions.mode === 'query'
          ? await runRdf3xParityQuery(parityOptions)
          : await runRdf3xParityPrepare(parityOptions);
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
      return;
    }
    options = parseArgs();
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(buildDryRunPlan(options), null, 2)}\n`);
      return;
    }
    await runBenchmark(options);
  } catch (error) {
    process.stderr.write(`${formatBenchmarkCliFailure(
      error,
      parityConnectionString ?? options?.benchmarkDatabaseUrl,
    )}\n`);
    process.exitCode = 1;
  }
}

export function parseRdf3xParityArgs(
  args: readonly string[] = process.argv.slice(2),
): Rdf3xParityCliOptions | undefined {
  if (!args.some((argument) =>
    argument === '--contract' ||
    argument === '--prepare-fixture' ||
    argument.startsWith('--prepare-fixture=') ||
    argument === '--query' ||
    argument.startsWith('--query=') ||
    argument === '--fixture-sha256' ||
    argument.startsWith('--fixture-sha256='))) {
    return undefined;
  }

  let contract = false;
  let facts: string | undefined;
  let query: string | undefined;
  let fixtureSha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--contract') {
      contract = true;
      continue;
    }
    if (argument === '--query') {
      query = requiredFollowingParityValue(args, index, 'query');
      index += 1;
      continue;
    }
    if (argument.startsWith('--query=')) {
      query = argument.slice('--query='.length);
      continue;
    }
    if (argument === '--prepare-fixture') {
      facts = requiredFollowingParityValue(args, index, 'prepare-fixture');
      index += 1;
      continue;
    }
    if (argument.startsWith('--prepare-fixture=')) {
      facts = argument.slice('--prepare-fixture='.length);
      continue;
    }
    if (argument === '--fixture-sha256') {
      fixtureSha256 = requiredFollowingParityValue(args, index, 'fixture-sha256');
      index += 1;
      continue;
    }
    if (argument.startsWith('--fixture-sha256=')) {
      fixtureSha256 = argument.slice('--fixture-sha256='.length);
      continue;
    }
    throw new Error(`Unknown RDF3X parity option --${optionName(argument)}`);
  }

  if (contract) {
    if (query !== undefined || facts !== undefined || fixtureSha256 !== undefined) {
      throw new Error('RDF3X parity --contract cannot be combined with --query or --prepare-fixture');
    }
    return { mode: 'contract' };
  }
  if (facts !== undefined) {
    if (query !== undefined) {
      throw new Error('RDF3X parity --prepare-fixture cannot be combined with --query');
    }
    if (!facts) {
      throw new Error('RDF3X parity prepare mode requires --prepare-fixture');
    }
    if (!fixtureSha256) {
      throw new Error('RDF3X parity prepare mode requires --fixture-sha256');
    }
    return {
      mode: 'prepare',
      facts: assertRdf3xParityPath(facts, 'prepare-fixture'),
      fixtureSha256: assertRdf3xParitySha256(fixtureSha256),
    };
  }
  if (!query) {
    throw new Error('RDF3X parity query mode requires --query');
  }
  if (!fixtureSha256) {
    throw new Error('RDF3X parity query mode requires --fixture-sha256');
  }
  return {
    mode: 'query',
    query: assertRdf3xParityPath(query, 'query'),
    fixtureSha256: assertRdf3xParitySha256(fixtureSha256),
  };
}

export async function runRdf3xParityContract(
  runtime: Rdf3xParityRuntime = {},
): Promise<Rdf3xParityEnvelope> {
  const env = runtime.env ?? process.env;
  const connectionString = resolveRdf3xParityConnectionString(env);
  const now = runtime.now ?? (() => performance.now());
  const readManifest = runtime.readFixtureSha256 ?? readRdf3xParityFixtureSha256;
  const startedAt = now();
  const fixtureSha256 = await readManifest(connectionString);
  const normalizedFixtureSha256 = assertRdf3xParityManifestSha256(fixtureSha256);
  return rdf3xParityEnvelope(
    'contract',
    now() - startedAt,
    normalizedFixtureSha256,
    emptySparqlJsonBindingsBody(),
  );
}

export async function runRdf3xParityQuery(
  options: Extract<Rdf3xParityCliOptions, { mode: 'query' }>,
  runtime: Rdf3xParityRuntime = {},
): Promise<Rdf3xParityEnvelope> {
  const env = runtime.env ?? process.env;
  const connectionString = resolveRdf3xParityConnectionString(env);
  const readQuery = runtime.readFile ?? readFile;
  const readManifest = runtime.readFixtureSha256 ?? readRdf3xParityFixtureSha256;
  const executeQuery = runtime.executeRdf3xQuery ?? executeRdf3xParityProductQuery;
  const now = runtime.now ?? (() => performance.now());
  const query = await readQuery(options.query, 'utf8');
  const actualFixtureSha256 = assertRdf3xParityManifestSha256(
    await readManifest(connectionString),
  );
  const expectedFixtureSha256 = assertRdf3xParitySha256(options.fixtureSha256);
  if (actualFixtureSha256 !== expectedFixtureSha256) {
    throw new Error('RDF3X parity fixture sha256 mismatch');
  }

  const startedAt = now();
  const body = await executeQuery(connectionString, query);
  return rdf3xParityEnvelope(
    'query',
    now() - startedAt,
    actualFixtureSha256,
    body,
  );
}

export async function runRdf3xParityPrepare(
  options: Extract<Rdf3xParityCliOptions, { mode: 'prepare' }>,
  runtime: Rdf3xParityRuntime = {},
): Promise<Rdf3xParityEnvelope> {
  const env = runtime.env ?? process.env;
  const connectionString = resolveRdf3xParityPrepareConnectionString(env);
  const readFacts = runtime.readFile ?? readFile;
  const resetSchema = runtime.resetBenchmarkSchema ?? resetRdf3xParityBenchmarkSchema;
  const createEngine = runtime.createRdf3xEngine ?? createRdf3xParityPrepareEngine;
  const countFacts = runtime.countFacts ?? countRdf3xParityFacts;
  const writeManifest = runtime.writeFixtureManifest ?? writeRdf3xParityFixtureManifest;
  const readManifest = runtime.readFixtureSha256 ?? readRdf3xParityFixtureSha256;
  const now = runtime.now ?? (() => performance.now());

  const facts = await readFacts(options.facts, 'utf8');
  const actualFixtureSha256 = createHash('sha256').update(facts).digest('hex');
  const expectedFixtureSha256 = assertRdf3xParitySha256(options.fixtureSha256);
  if (actualFixtureSha256 !== expectedFixtureSha256) {
    throw new Error('RDF3X parity prepare fixture sha256 mismatch');
  }
  const quads = parseRdf3xParityNQuads(facts);

  const startedAt = now();
  await resetSchema(connectionString);
  const engine = createEngine(connectionString);
  let primaryError: unknown;
  let envelope: Rdf3xParityEnvelope | undefined;
  let factCount: number | undefined;
  try {
    await engine.open();
    await engine.put(quads);
    await engine.refreshDerivedIndexes({ mode: 'full' });
    factCount = await readBenchmarkFactCount(() => countFacts(connectionString));
    if (factCount !== quads.length) {
      throw new Error(`RDF3X parity prepare fact count mismatch: expected ${quads.length}, got ${factCount}`);
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  await captureCleanupFailure(() => engine.close(), cleanupErrors);
  throwBenchmarkFailures(primaryError, cleanupErrors);
  if (factCount === undefined) {
    throw new Error('RDF3X parity prepare failed without validated fact count');
  }

  await writeManifest(connectionString, actualFixtureSha256);
  envelope = rdf3xParityEnvelope(
    'prepare',
    now() - startedAt,
    actualFixtureSha256,
    emptySparqlJsonBindingsBody(),
    factCount,
  );
  return envelope;
}

export function buildRdf3xParityConnectionString(connectionUrl: string): string {
  assertPostgresConnectionString(connectionUrl);
  const parsed = new URL(connectionUrl);
  const existingOptions = parsed.searchParams.getAll('options');
  parsed.searchParams.delete('options');
  parsed.searchParams.append(
    'options',
    [ ...existingOptions, BENCHMARK_SEARCH_PATH_OPTION ].join(' ').trim(),
  );
  return parsed.toString();
}

export function buildRdf3xParityReadOnlyConnectionString(connectionUrl: string): string {
  const parsed = new URL(buildRdf3xParityConnectionString(connectionUrl));
  const existingOptions = parsed.searchParams.getAll('options');
  parsed.searchParams.delete('options');
  parsed.searchParams.append(
    'options',
    [ ...existingOptions, '-c default_transaction_read_only=on' ].join(' ').trim(),
  );
  return parsed.toString();
}

export async function resetRdf3xParityBenchmarkSchema(connectionUrl: string): Promise<void> {
  const pool = new Pool(buildBenchmarkPgPoolConfiguration(
    resolveRdf3xParityPrepareConnectionString(connectionUrl),
    BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
    4,
  ));
  try {
    await executeBenchmarkCleanup(pool, connectionUrl);
  } finally {
    await pool.end();
  }
}

export function createRdf3xParityPrepareEngine(connectionUrl: string): Rdf3xParityPrepareEngine {
  return new PostgresRdfEngine(buildBenchmarkPostgresEngineOptions(
    'rdf3x',
    resolveRdf3xParityPrepareConnectionString(connectionUrl),
    'off',
    BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
  ));
}

export function buildRdf3xParityQueryEngineOptions(connectionUrl: string): PostgresRdfEngineOptions {
  return {
    ...buildBenchmarkPostgresEngineOptions(
      'rdf3x',
      buildRdf3xParityReadOnlyConnectionString(connectionUrl),
      'off',
      DEFAULT_OPERATION_TIMEOUT_MS,
    ),
    readOnlyExistingSchema: true,
  };
}

export async function countRdf3xParityFacts(connectionUrl: string): Promise<number> {
  const pool = new Pool(buildBenchmarkPgPoolConfiguration(
    resolveRdf3xParityPrepareConnectionString(connectionUrl),
    DEFAULT_OPERATION_TIMEOUT_MS,
    2,
  ));
  try {
    return await countBenchmarkFacts(pool);
  } finally {
    await pool.end();
  }
}

export async function writeRdf3xParityFixtureManifest(
  connectionUrl: string,
  fixtureSha256: string,
  createPool: (configuration: BenchmarkPgPoolConfiguration) => Pick<Pool, 'connect' | 'end'> =
    (configuration) => new Pool(configuration),
): Promise<void> {
  const pool = createPool(buildBenchmarkPgPoolConfiguration(
    resolveRdf3xParityPrepareConnectionString(connectionUrl),
    DEFAULT_OPERATION_TIMEOUT_MS,
    2,
  ));
  try {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${RDF3X_PARITY_FIXTURE_MANIFEST_TABLE} (
          key text PRIMARY KEY,
          value text NOT NULL
        )
      `);
      await client.query(
        `INSERT INTO ${RDF3X_PARITY_FIXTURE_MANIFEST_TABLE} (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [ RDF3X_PARITY_FIXTURE_SHA256_KEY, assertRdf3xParitySha256(fixtureSha256) ],
      );
      const result = await client.query<{ value: unknown }>(
        `SELECT value FROM ${RDF3X_PARITY_FIXTURE_MANIFEST_TABLE} WHERE key = $1`,
        [ RDF3X_PARITY_FIXTURE_SHA256_KEY ],
      );
      if (result.rows[0]?.value !== assertRdf3xParitySha256(fixtureSha256)) {
        throw new Error('RDF3X parity fixture manifest transaction readback mismatch');
      }
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function readRdf3xParityFixtureSha256(
  connectionUrl: string,
  createPool: (configuration: BenchmarkPgPoolConfiguration) => Pick<Pool, 'query' | 'end'> =
    (configuration) => new Pool(configuration),
): Promise<string | undefined> {
  const pool = createPool(buildBenchmarkPgPoolConfiguration(
    buildRdf3xParityConnectionString(connectionUrl),
    DEFAULT_OPERATION_TIMEOUT_MS,
    2,
  ));
  try {
    for (const tableName of [
      RDF3X_PARITY_FIXTURE_MANIFEST_TABLE,
      'rdf_terms',
      'rdf_quads',
      'rdf3x_metadata',
    ]) {
      const table = await pool.query<{ name: string | null }>(
        'SELECT to_regclass($1) AS name',
        [ tableName ],
      );
      if (typeof table.rows[0]?.name !== 'string') {
        return undefined;
      }
    }
    const result = await pool.query<{ value: unknown }>(
      `SELECT value FROM ${RDF3X_PARITY_FIXTURE_MANIFEST_TABLE} WHERE key = $1`,
      [ RDF3X_PARITY_FIXTURE_SHA256_KEY ],
    );
    const value = result.rows[0]?.value;
    return typeof value === 'string' ? value : undefined;
  } finally {
    await pool.end();
  }
}

export function parseRdf3xParityNQuads(input: string): Quad[] {
  try {
    return new N3Parser({ format: 'N-Quads' }).parse(input);
  } catch (error) {
    throw new Error(`RDF3X parity prepare could not parse N-Quads: ${errorMessage(error)}`);
  }
}

async function executeRdf3xParityProductQuery(
  connectionUrl: string,
  query: string,
): Promise<SparqlJsonBindingsBody> {
  const store = new PostgresRdfEngine(buildRdf3xParityQueryEngineOptions(connectionUrl));
  try {
    await store.open();
    const sparql = new SolidRdfSparqlEngine(store);
    const stream = await sparql.queryBindings(query, BASE_PATH, undefined, {
      timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    });
    return await materializeRdf3xParityBindingsBody(stream);
  } finally {
    await store.close();
  }
}

export async function materializeRdf3xParityBindingsBody(stream: unknown): Promise<SparqlJsonBindingsBody> {
  const metadata = typeof (stream as { metadata?: unknown })?.metadata === 'function'
    ? await (stream as { metadata: () => Promise<{ variables?: Array<{ value?: unknown }> }> }).metadata()
    : undefined;
  const rows = await materializeBindings(stream);
  const variableNames = metadata?.variables
    ?.map((variable) => variable.value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const vars = variableNames && variableNames.length > 0
    ? variableNames
    : inferSparqlJsonVariables(rows);
  return {
    head: { vars },
    results: {
      bindings: rows.map((row) => sparqlJsonBinding(row, vars)),
    },
  };
}

function sparqlJsonBinding(
  row: Readonly<Record<string, Term | undefined>>,
  vars: readonly string[],
): Record<string, SparqlJsonTerm> {
  const binding: Record<string, SparqlJsonTerm> = {};
  for (const name of vars) {
    const term = row[name];
    if (term) {
      binding[name] = sparqlJsonTerm(term);
    }
  }
  return binding;
}

function sparqlJsonTerm(term: Term): SparqlJsonTerm {
  if (term.termType === 'NamedNode') {
    return { type: 'uri', value: term.value };
  }
  if (term.termType === 'BlankNode') {
    return { type: 'bnode', value: term.value };
  }
  if (term.termType === 'Literal') {
    if (term.language) {
      return { type: 'literal', value: term.value, 'xml:lang': term.language };
    }
    return {
      type: 'literal',
      value: term.value,
      datatype: term.datatype.value,
    };
  }
  throw new Error(`RDF3X parity cannot serialize ${term.termType} as a SPARQL JSON binding`);
}

function inferSparqlJsonVariables(rows: readonly Readonly<Record<string, Term | undefined>>[]): string[] {
  const vars = new Set<string>();
  for (const row of rows) {
    for (const [ name, term ] of Object.entries(row)) {
      if (term) {
        vars.add(name);
      }
    }
  }
  return [ ...vars ];
}

function rdf3xParityEnvelope(
  mode: Rdf3xParityEnvelope['mode'],
  elapsedMs: number,
  fixtureSha256: string,
  body: SparqlJsonBindingsBody,
  factCount?: number,
): Rdf3xParityEnvelope {
  return {
    adapter: 'rdf3x',
    contract: RDF3X_PARITY_CONTRACT,
    contractVersion: RDF3X_PARITY_CONTRACT_VERSION,
    mode,
    elapsedMs,
    fixtureSha256,
    ...(factCount === undefined ? {} : { factCount }),
    result: { body },
  };
}

function emptySparqlJsonBindingsBody(): SparqlJsonBindingsBody {
  return {
    head: { vars: [] },
    results: { bindings: [] },
  };
}

function resolveRdf3xParityConnectionString(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const connectionString = env[EXTERNAL_DATABASE_ENV];
  if (!connectionString) {
    throw new Error(`RDF3X parity contract requires ${EXTERNAL_DATABASE_ENV}`);
  }
  assertPostgresConnectionString(connectionString);
  return connectionString;
}

function resolveRdf3xParityPrepareConnectionString(
  envOrConnectionString: Readonly<Record<string, string | undefined>> | string,
): string {
  const connectionString = typeof envOrConnectionString === 'string'
    ? envOrConnectionString
    : envOrConnectionString[EXTERNAL_DATABASE_ENV];
  if (!connectionString) {
    throw new Error(`RDF3X parity prepare requires ${EXTERNAL_DATABASE_ENV}`);
  }
  assertDedicatedBenchmarkDatabase(connectionString);
  return buildExternalBenchmarkConnectionString(connectionString);
}

function assertPostgresConnectionString(connectionUrl: string): void {
  try {
    const parsed = new URL(connectionUrl);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new Error('protocol');
    }
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) {
      throw new Error('path');
    }
    const encodedDatabase = parsed.pathname.slice(1);
    if (!encodedDatabase || encodedDatabase.includes('/')) {
      throw new Error('path');
    }
  } catch {
    throw new Error(`RDF3X parity contract requires a valid ${EXTERNAL_DATABASE_ENV} PostgreSQL URL`);
  }
}

function assertRdf3xParityManifestSha256(value: string | undefined): string {
  if (value === undefined) {
    throw new Error(
      `RDF3X parity requires ${RDF3X_PARITY_FIXTURE_MANIFEST_TABLE}.${RDF3X_PARITY_FIXTURE_SHA256_KEY}`,
    );
  }
  return assertRdf3xParitySha256(value);
}

function assertRdf3xParitySha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('RDF3X parity requires a 64-hex fixture sha256');
  }
  return normalized;
}

function assertRdf3xParityPath(value: string, name: string): string {
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new Error(`Invalid --${name}; expected a non-empty single-line value`);
  }
  return value;
}

function requiredFollowingParityValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`RDF3X parity --${name} requires a value`);
  }
  return value;
}

async function runBenchmark(options: BenchmarkCliOptions): Promise<void> {
  const provisioned = await provisionDatabase(options);
  let controlPool: Pool | undefined;
  let setup: PostgresRdfEngine | undefined;
  let primaryError: unknown;
  try {
    controlPool = new Pool(buildBenchmarkPgPoolConfiguration(
      provisioned.connectionString,
      BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
      4,
    ));
    if (options.mode === 'external') {
      await executeBenchmarkCleanup(controlPool, provisioned.connectionString);
    }

    setup = new PostgresRdfEngine(buildBenchmarkPostgresEngineOptions(
      'rdf3x',
      provisioned.connectionString,
      'off',
      BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
    ));
    await setup.open();
    const actualFacts = await loadBenchmarkFacts(setup, options.targetQuads, {
      factCount: () => countBenchmarkFacts(controlPool!),
    });
    await controlPool.query('ANALYZE rdf_terms');
    await controlPool.query('ANALYZE rdf_quads');
    await setup.close();
    setup = undefined;

    const report = await collectBenchmarkReport(
      options,
      provisioned,
      controlPool,
      actualFacts,
    );
    const target = path.resolve(options.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    await rm(benchmarkCheckpointPath(options.out), { force: true });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  await captureCleanupFailure(() => setup?.close(), cleanupErrors);
  if (options.mode === 'external' && controlPool) {
    await captureCleanupFailure(
      () => executeBenchmarkCleanup(controlPool!, provisioned.connectionString),
      cleanupErrors,
    );
  }
  await captureCleanupFailure(() => controlPool?.end(), cleanupErrors);
  if (provisioned.container) {
    try {
      removeLocalBenchmarkContainer(provisioned.container);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwBenchmarkFailures(primaryError, cleanupErrors);
}

async function collectBenchmarkReport(
  options: BenchmarkCliOptions,
  provisioned: ProvisionedDatabase,
  pool: Pool,
  actualFacts: number,
): Promise<Record<string, unknown>> {
  const selectedWorkloadIds = new Set(options.workloadIds);
  const workloads = cloudReplacementWorkloads().filter(({ id }) =>
    selectedWorkloadIds.has(id));
  const workloadById = new Map(workloads.map((workload) => [ workload.id, workload ]));
  const databaseIdentity = await collectBenchmarkDatabaseIdentity(pool);
  const context = buildBenchmarkExecutionContext(options, databaseIdentity);
  const checkpoint = await loadBenchmarkCheckpoint(options, context) ?? emptyBenchmarkCheckpoint(
    options,
    context,
    `run-${process.pid}-${randomUUID()}`,
  );
  const identitySource = createCloudReplacementSampleIdentitySource(
    checkpoint.identityId,
  );
  const latencyRecords: LatencyRecord[] = checkpoint.latencyRecords.map((record) => ({
    ...record,
    workload: workloadById.get(record.workload.id) ?? record.workload,
  }));
  let concurrencyRecords = [ ...checkpoint.concurrencyRecords ];
  const correctnessRecords = [ ...checkpoint.correctnessRecords ];
  const correctnessFailures = [ ...checkpoint.correctnessFailures ];
  let diagnosticsByCacheMode = { ...checkpoint.diagnosticsByCacheMode };
  const concurrencyDiagnosticsByKey = { ...checkpoint.concurrencyDiagnosticsByKey };
  const completedLatencyKeys = new Set(checkpoint.completedLatencyKeys);
  const completedConcurrencyKeys = new Set(checkpoint.completedConcurrencyKeys);
  let orderIndex = 0;

  const buildPair = await openAdapterPair(
    provisioned.connectionString,
    BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
    {
      cacheMode: 'off',
      refreshDerivedIndexes: true,
      recordBuildAndStorage: true,
    },
  );
  const buildEvidence = await useAdapterPair(buildPair, async () => ({
    rdf3xBuildMs: buildPair.rdf3xBuildMs,
    qleverBuildMs: buildPair.qleverBuildMs,
    storage: buildSharedStorageEvidence(await buildPair.rdf3xStore.storageStats()),
    qleverReady: true,
  }));

  for (const pairPlan of buildBenchmarkCacheModePairPlan(options.cacheModes)) {
    const { cacheMode } = pairPlan;
    const pair = await openAdapterPair(
      provisioned.connectionString,
      options.operationTimeoutMs,
      pairPlan,
    );
    await useAdapterPair(pair, async () => {
      for (const workload of workloads) {
        const latencyKey = `${cacheMode}:${workload.id}`;
        const coldFirstEngine = orderIndex % 2 === 0 ? 'rdf3x' : 'qlever';
        orderIndex += 1;
        if (completedLatencyKeys.has(latencyKey)) {
          process.stderr.write(`[benchmark] resume latency ${latencyKey}\n`);
          continue;
        }
        process.stderr.write(`[benchmark] latency ${latencyKey}\n`);
        const measured = await measureCloudReplacementCaseWithTimeoutEvidence(
          workload,
          pair.rdf3xAdapter,
          pair.qleverAdapter,
          {
            prepareColdState: () => prepareColdState(pair),
            warmupIterations: options.warmupIterations,
            iterations: options.iterations,
            coldFirstEngine,
            operationTimeoutMs: options.operationTimeoutMs,
            ...benchmarkCacheMeasurementOptions(cacheMode, identitySource),
          },
        );
        const { correctness, ...latencyMeasurement } = measured;
        correctnessRecords.push({
          cacheMode,
          caseId: workload.id,
          correctness,
        });
        correctnessFailures.push(...correctness.failures.map((failure) =>
          `${cacheMode}:${workload.id}:${failure}`));
        latencyRecords.push({ cacheMode, workload, ...latencyMeasurement });
        completedLatencyKeys.add(latencyKey);
        checkpoint.completedLatencyKeys = [ ...completedLatencyKeys ];
        checkpoint.latencyRecords = latencyRecords;
        checkpoint.correctnessRecords = correctnessRecords;
        checkpoint.correctnessFailures = correctnessFailures;
        await saveBenchmarkCheckpoint(options, checkpoint);
      }

      for (const engineId of [ 'rdf3x', 'qlever' ] as const) {
        const adapter = engineId === 'rdf3x' ? pair.rdf3xAdapter : pair.qleverAdapter;
        const pendingCells = workloads
          .filter((entry) => entry.concurrencyRepresentative)
          .flatMap((workload) => options.concurrency.map((concurrency) => ({
            workload,
            concurrency,
            key: benchmarkConcurrencyKey(cacheMode, engineId, workload.id, concurrency),
          })))
          .filter(({ key }) => !completedConcurrencyKeys.has(key));
        if (pendingCells.length === 0) {
          process.stderr.write(`[benchmark] resume concurrency ${cacheMode}:${engineId}\n`);
          continue;
        }
        await prepareColdState(pair);
        for (const { workload, concurrency, key } of pendingCells) {
          process.stderr.write(`[benchmark] concurrency ${key}\n`);
          const cell = await captureAttributedPgPhase(async () => {
            const measured = await measureCloudReplacementConcurrency(
              workload,
              adapter,
              {
                concurrency,
                durationMs: CONCURRENCY_DURATION_MS,
                operationTimeoutMs: options.operationTimeoutMs,
                ...benchmarkCacheMeasurementOptions(cacheMode, identitySource),
              },
            );
            return {
              ...measured,
              cacheMode,
              caseId: workload.id,
              engine: engineId,
            };
          }, () => snapshotPgStatDatabase(pool));
          concurrencyRecords = upsertBenchmarkConcurrencyRecord(
            concurrencyRecords,
            cell.result,
          );
          concurrencyDiagnosticsByKey[key] = cell.diagnostics;
          diagnosticsByCacheMode = rebuildBenchmarkDiagnosticsByCacheMode(
            concurrencyRecords,
            concurrencyDiagnosticsByKey,
          );
          if (!cell.result.infrastructureFailure) {
            completedConcurrencyKeys.add(key);
          } else {
            completedConcurrencyKeys.delete(key);
          }
          checkpoint.completedConcurrencyKeys = [ ...completedConcurrencyKeys ];
          checkpoint.concurrencyRecords = concurrencyRecords;
          checkpoint.diagnosticsByCacheMode = diagnosticsByCacheMode;
          checkpoint.concurrencyDiagnosticsByKey = concurrencyDiagnosticsByKey;
          await saveBenchmarkCheckpoint(options, checkpoint);
        }
      }
    });
  }

  const summary = buildBenchmarkReportSummary({
    cacheModes: options.cacheModes,
    latencyRecords,
    concurrencyRecords,
    correctnessRecords,
    correctnessFailures,
    diagnosticsByCacheMode,
    qleverReady: buildEvidence.qleverReady,
  });
  const versionResult = await pool.query<{ server_version: string }>('SHOW server_version');
  const environment = sanitizeCloudReplacementEnvironment({
    connectionString: provisioned.connectionString,
    postgresVersion: versionResult.rows[0]?.server_version ?? 'unknown',
    engineCommit: currentCommit(),
  });
  const report: CloudReplacementReport = {
    environment,
    targetFacts: options.targetQuads,
    actualFacts,
    correctnessFailures,
    cases: summary.cases.map(({ correctness: _correctness, ...benchmarkCase }) =>
      benchmarkCase),
    concurrency: summary.gateConcurrency.map((record) => ({
      caseId: record.caseId,
      engine: record.engine,
      concurrency: record.concurrency,
      completed: record.completed,
      errors: record.errors,
      infrastructureErrors: record.infrastructureErrors,
      infrastructureFailure: record.infrastructureFailure,
      errorEvidence: record.errorEvidence,
      elapsedMs: record.elapsedMs,
      throughputPerSecond: record.throughputPerSecond,
    })),
    indexBuildAndStorage: {
      rdf3x: {
        buildMs: buildEvidence.rdf3xBuildMs,
        storageBytes: buildEvidence.storage.reportStorageBytes.rdf3x,
      },
      qlever: {
        buildMs: buildEvidence.qleverBuildMs,
        storageBytes: buildEvidence.storage.reportStorageBytes.qlever,
      },
    },
    resourceDiagnostics: summary.resourceDiagnostics,
    decision: summary.decision,
  };
  const sanitized = JSON.parse(renderCloudReplacementJson(report)) as CloudReplacementReport;
  return {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    cacheModes: options.cacheModes,
    evidenceModes: {
      latency: summary.latencyCacheMode,
      concurrencyAndGates: summary.gateCacheMode,
    },
    weights: CLOUD_REPLACEMENT_GROUP_WEIGHTS,
    thresholds: CLOUD_REPLACEMENT_THRESHOLDS,
    ...sanitized,
    executionContext: buildBenchmarkReportExecutionContext(context),
    environment: {
      ...sanitized.environment,
      qleverReady: summary.environment.qleverReady,
    },
    cases: sanitized.cases.map((benchmarkCase, index) => {
      const correctness = summary.cases[index]?.correctness;
      if (!correctness) {
        throw new Error(`Missing correctness summary for report case ${index}`);
      }
      return { ...benchmarkCase, correctness };
    }),
    errorRates: summary.errorRates,
    infrastructureErrorRates: summary.infrastructureErrorRates,
    baselineValid: summary.baselineValid,
    evidenceComplete: summary.evidenceComplete,
    storage: {
      factsBytes: buildEvidence.storage.factsBytes,
      sharedPhysicalIndexBytes: buildEvidence.storage.sharedPhysicalIndexBytes,
      qleverIncrementalBytes: buildEvidence.storage.qleverIncrementalBytes,
      reportStorageBytes: buildEvidence.storage.reportStorageBytes,
      semantics: buildEvidence.storage.semantics,
    },
    latencyByCacheMode: latencyRecords.map((record) => ({
      cacheMode: record.cacheMode,
      caseId: record.workload.id,
      rdf3x: record.rdf3x,
      qlever: record.qlever,
      ignoredSteadyHelperColdMs: record.ignoredSteadyHelperColdMs,
    })),
    concurrencyByCacheMode: concurrencyRecords,
    diagnosticsByCacheMode,
    methodology: {
      buildSetupTimeoutMs: BENCHMARK_BUILD_SETUP_TIMEOUT_MS,
      operationTimeoutMs: options.operationTimeoutMs,
      concurrencyDurationMs: CONCURRENCY_DURATION_MS,
      coldState: 'recorded before correctness; caller-owned query-cache reset; PostgreSQL shared buffers are not cleared',
      ignoredCold: 'the post-correctness cold emitted by the steady-state helper is retained only as ignored diagnostic evidence',
      cacheOffIdentitySource: 'one identity source reused for the entire run; cache misses do not depend on its SPARQL comment',
      cacheOff: 'query-result and materialized-result caches disabled when the off pair is constructed',
      coldFirstEngine: 'alternated by workload/cache-mode call',
      engineLifecycle: 'long-timeout build pair followed by independent operation-timeout cache-mode pairs',
      cancellation: 'RDF3X uses PostgreSQL statement_timeout plus prompt client race; QLever also receives the native AbortSignal',
      storage: 'one final shared physical storageStats snapshot; per-engine bytes are non-additive and QLever incremental bytes are unavailable',
      diagnosticsAttribution: 'separate pg_stat_database deltas for each cache-mode and engine concurrency phase',
      evidenceModes: 'production latency when selected; cache-off concurrency, errors, gates, and diagnostics when selected',
      externalResourceSampler: 'not attached',
    },
  };
}

async function openAdapterPair(
  connectionString: string,
  operationTimeoutMs: number,
  pairPlan: BenchmarkCacheModePairPlan,
): Promise<AdapterPair> {
  const rdf3xStore = new PostgresRdfEngine(buildBenchmarkPostgresEngineOptions(
    'rdf3x',
    connectionString,
    pairPlan.cacheMode,
    operationTimeoutMs,
  ));
  const qleverStore = new PostgresRdfEngine(buildBenchmarkPostgresEngineOptions(
    'qlever',
    connectionString,
    pairPlan.cacheMode,
    operationTimeoutMs,
  ));
  try {
    await rdf3xStore.open();
    let rdf3xBuildMs = 0;
    if (pairPlan.refreshDerivedIndexes) {
      const rdf3xStartedAt = performance.now();
      await rdf3xStore.refreshDerivedIndexes({ mode: 'full' });
      rdf3xBuildMs = performance.now() - rdf3xStartedAt;
    }

    const qleverStartedAt = performance.now();
    await qleverStore.open();
    const qleverBuildMs = pairPlan.recordBuildAndStorage
      ? performance.now() - qleverStartedAt
      : 0;
    const rdf3xSparql = new SolidRdfSparqlEngine(rdf3xStore);
    const qleverSparql = new SolidRdfSparqlEngine(qleverStore);
    return {
      rdf3xStore,
      qleverStore,
      rdf3xSparql,
      qleverSparql,
      rdf3xAdapter: createCloudReplacementAdapter('rdf3x', rdf3xSparql, {
        timeWithoutSampleIdentity: true,
        operationTimeoutMs,
      }),
      qleverAdapter: createCloudReplacementAdapter('qlever', qleverSparql, {
        timeWithoutSampleIdentity: true,
        operationTimeoutMs,
      }),
      rdf3xBuildMs,
      qleverBuildMs,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await captureCleanupFailure(() => qleverStore.close(), cleanupErrors);
    await captureCleanupFailure(() => rdf3xStore.close(), cleanupErrors);
    throwBenchmarkFailures(error, cleanupErrors);
    throw error;
  }
}

async function closeAdapterPair(pair: AdapterPair): Promise<void> {
  const cleanupErrors: unknown[] = [];
  await captureCleanupFailure(() => pair.qleverStore.close(), cleanupErrors);
  await captureCleanupFailure(() => pair.rdf3xStore.close(), cleanupErrors);
  throwBenchmarkFailures(undefined, cleanupErrors);
}

async function useAdapterPair<T>(pair: AdapterPair, run: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  let primaryError: unknown;
  try {
    result = await run();
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  await captureCleanupFailure(() => closeAdapterPair(pair), cleanupErrors);
  throwBenchmarkFailures(primaryError, cleanupErrors);
  return result as T;
}

async function captureCleanupFailure(
  run: () => void | Promise<void> | undefined,
  errors: unknown[],
): Promise<void> {
  try {
    await run();
  } catch (error) {
    errors.push(error);
  }
}

async function prepareColdState(pair: AdapterPair): Promise<void> {
  await pair.rdf3xStore.invalidateQueryResultCache();
  await pair.qleverStore.invalidateQueryResultCache();
  pair.rdf3xSparql.resetMetrics();
  pair.qleverSparql.resetMetrics();
}

async function provisionDatabase(options: BenchmarkCliOptions): Promise<ProvisionedDatabase> {
  if (options.mode === 'external') {
    const connectionString = options.benchmarkDatabaseUrl;
    if (!connectionString) {
      throw new Error(`External mode requires ${EXTERNAL_DATABASE_ENV}`);
    }
    assertDedicatedBenchmarkDatabase(connectionString);
    return {
      connectionString: buildExternalBenchmarkConnectionString(connectionString),
    };
  }

  const container = `xpod-rdf-cloud-benchmark-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    docker([
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', `POSTGRES_DB=${LOCAL_DATABASE}`,
      '-p', '127.0.0.1::5432',
      options.image,
    ]);
    await waitForLocalPostgres(container);
    const port = docker([ 'port', container, '5432/tcp' ])
      .trim()
      .split(':')
      .at(-1);
    if (!port || !/^\d+$/u.test(port)) {
      throw new Error('Docker did not publish the benchmark PostgreSQL port');
    }
    return {
      connectionString: buildLocalBenchmarkConnectionString(
        `postgres://postgres@127.0.0.1:${port}/${LOCAL_DATABASE}`,
      ),
      container,
    };
  } catch (error) {
    try {
      removeLocalBenchmarkContainer(container);
    } catch (cleanupError) {
      throw new AggregateError(
        [ error, cleanupError ],
        'Failed to remove disposable benchmark container after provisioning failed',
      );
    }
    throw error;
  }
}

export async function waitForLocalPostgres(
  container: string,
  options: LocalPostgresProbeOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 120;
  const delayMs = options.delayMs ?? 500;
  const runDocker = options.runDocker ?? docker;
  assertPositiveInteger(attempts, 'startup probe attempts');
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('Benchmark startup probe delayMs must be finite and non-negative');
  }
  let lastProbeFailure: unknown = new Error('PostgreSQL startup probe did not run');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runDocker([ 'exec', container, 'pg_isready', '-U', 'postgres', '-d', LOCAL_DATABASE ]);
      const capabilities = runDocker([
        'exec', container,
        'psql', '-U', 'postgres', '-d', LOCAL_DATABASE, '-Atc',
        `SELECT xpod_rdf.native_sparql_capabilities()->>'abiVersion', ` +
          `xpod_rdf.native_sparql_capabilities()->>'ready'`,
      ]).trim();
      if (capabilities === '1|true') {
        return;
      }
      lastProbeFailure = new Error(`native capability probe returned ${JSON.stringify(capabilities)}`);
    } catch (error) {
      lastProbeFailure = error;
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    'Disposable PostgreSQL/QLever image did not become ready; final probe failure: ' +
    sanitizeError(lastProbeFailure),
  );
}

export function removeLocalBenchmarkContainer(
  container: string,
  runDocker: (args: string[]) => string = docker,
): void {
  const cleanupErrors: unknown[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      runDocker([ 'rm', '-f', container ]);
    } catch (error) {
      cleanupErrors.push(error);
      // Verification below decides whether a failed removal left a container behind.
    }
    try {
      runDocker([ 'inspect', '--format={{.Id}}', container ]);
      cleanupErrors.push(new Error('Disposable benchmark container still exists'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such (?:container|object)/iu.test(message)) {
        return;
      }
      cleanupErrors.push(error);
    }
  }
  throw new AggregateError(
    cleanupErrors,
    'Failed to remove disposable benchmark container after 3 attempts',
  );
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    timeout: BENCHMARK_DOCKER_TIMEOUT_MS,
  });
}

export async function executeBenchmarkCleanup(
  pool: BenchmarkCleanupPool,
  connectionString: string,
): Promise<void> {
  const statements = benchmarkCleanupSql(connectionString);
  const client = await pool.connect();
  let transactionStarted = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    primaryError = error;
    if (transactionStarted) {
      await captureCleanupFailure(async () => {
        await client.query('ROLLBACK');
      }, cleanupErrors);
    }
  }
  await captureCleanupFailure(() => client.release(), cleanupErrors);
  throwBenchmarkFailures(primaryError, cleanupErrors);
}

export async function captureAttributedPgPhase<T>(
  run: () => Promise<T>,
  snapshot: () => Promise<PgStatSnapshot>,
): Promise<{ result: T; diagnostics: CloudReplacementPgDiagnostics }> {
  const before = await snapshot();
  const outcome = await run().then(
    (result) => ({ completed: true as const, result }),
    (error: unknown) => ({ completed: false as const, error }),
  );
  let after: PgStatSnapshot;
  try {
    after = await snapshot();
  } catch (diagnosticsError) {
    if ('error' in outcome) {
      throw new AggregateError(
        [ outcome.error, diagnosticsError ],
        'Benchmark engine phase and trailing diagnostics snapshot both failed',
      );
    }
    throw diagnosticsError;
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return {
    result: outcome.result,
    diagnostics: calculatePgDiagnosticsDelta(before, after),
  };
}

async function snapshotPgStatDatabase(pool: Pool): Promise<PgStatSnapshot> {
  try {
    const result = await pool.query<{
      blks_read: string | number;
      blks_hit: string | number;
      temp_bytes: string | number;
    }>(`
      SELECT blks_read, blks_hit, temp_bytes
      FROM pg_stat_database
      WHERE datname = current_database()
    `);
    const row = result.rows[0];
    if (!row) {
      throw new Error('missing row');
    }
    return {
      sharedBlocksRead: finiteCounter(row.blks_read),
      sharedBlocksHit: finiteCounter(row.blks_hit),
      tempBytes: finiteCounter(row.temp_bytes),
      diagnosticsUnavailable: [],
    };
  } catch {
    return {
      sharedBlocksRead: null,
      sharedBlocksHit: null,
      tempBytes: null,
      diagnosticsUnavailable: [ 'pg_stat_database counters unavailable' ],
    };
  }
}

function finiteCounter(value: string | number): number {
  const counter = Number(value);
  if (!Number.isFinite(counter) || counter < 0) {
    throw new Error('invalid PostgreSQL counter');
  }
  return counter;
}

export function calculatePgDiagnosticsDelta(
  before: PgStatSnapshot,
  after: PgStatSnapshot,
): CloudReplacementPgDiagnostics {
  const counterResets: string[] = [];
  return {
    sharedBlocksRead: counterDelta(
      'sharedBlocksRead', before.sharedBlocksRead, after.sharedBlocksRead, counterResets,
    ),
    sharedBlocksHit: counterDelta(
      'sharedBlocksHit', before.sharedBlocksHit, after.sharedBlocksHit, counterResets,
    ),
    tempBytes: counterDelta('tempBytes', before.tempBytes, after.tempBytes, counterResets),
    memoryPeakBytes: null,
    memoryLimitBytes: null,
    diagnosticsUnavailable: [
      ...before.diagnosticsUnavailable,
      ...after.diagnosticsUnavailable,
      ...counterResets,
      'Interleaved correctness and latency phases are excluded from per-engine attribution',
      'PostgreSQL does not expose per-engine memory high-water marks',
      'Memory limits require the external resource sampler',
      'Temp-disk limits require the external resource sampler',
    ],
  };
}

export function mergeBenchmarkPgDiagnostics(
  existing: CloudReplacementPgDiagnostics,
  next: CloudReplacementPgDiagnostics,
): CloudReplacementPgDiagnostics {
  return {
    sharedBlocksRead: sumKnownDiagnosticsCounter(
      existing.sharedBlocksRead,
      next.sharedBlocksRead,
    ),
    sharedBlocksHit: sumKnownDiagnosticsCounter(
      existing.sharedBlocksHit,
      next.sharedBlocksHit,
    ),
    tempBytes: sumKnownDiagnosticsCounter(existing.tempBytes, next.tempBytes),
    memoryPeakBytes: maxKnownDiagnosticsValue(
      existing.memoryPeakBytes,
      next.memoryPeakBytes,
    ),
    memoryLimitBytes: minKnownDiagnosticsValue(
      existing.memoryLimitBytes,
      next.memoryLimitBytes,
    ),
    diagnosticsUnavailable: [
      ...new Set([
        ...existing.diagnosticsUnavailable,
        ...next.diagnosticsUnavailable,
      ]),
    ],
  };
}

function sumKnownDiagnosticsCounter(left: number | null, right: number | null): number | null {
  return typeof left === 'number' && Number.isFinite(left) &&
    typeof right === 'number' && Number.isFinite(right)
    ? left + right
    : null;
}

function maxKnownDiagnosticsValue(left: number | null, right: number | null): number | null {
  if (typeof left === 'number' && Number.isFinite(left) &&
    typeof right === 'number' && Number.isFinite(right)) {
    return Math.max(left, right);
  }
  if (typeof left === 'number' && Number.isFinite(left)) {
    return left;
  }
  if (typeof right === 'number' && Number.isFinite(right)) {
    return right;
  }
  return null;
}

function minKnownDiagnosticsValue(left: number | null, right: number | null): number | null {
  if (typeof left === 'number' && Number.isFinite(left) &&
    typeof right === 'number' && Number.isFinite(right)) {
    return Math.min(left, right);
  }
  if (typeof left === 'number' && Number.isFinite(left)) {
    return left;
  }
  if (typeof right === 'number' && Number.isFinite(right)) {
    return right;
  }
  return null;
}

function counterDelta(
  name: 'sharedBlocksRead' | 'sharedBlocksHit' | 'tempBytes',
  before: number | null,
  after: number | null,
  diagnosticsUnavailable: string[],
): number | null {
  if (before === null || after === null) {
    return null;
  }
  if (after < before) {
    diagnosticsUnavailable.push(`pg_stat_database ${name} counter reset during phase`);
    return null;
  }
  return after - before;
}

export function throwBenchmarkFailures(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [ primaryError, ...cleanupErrors ],
      'Benchmark failed and cleanup also failed',
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([ ...cleanupErrors ], 'Benchmark cleanup failed');
  }
}

function currentCommit(): string {
  try {
    return execFileSync('git', [ 'rev-parse', 'HEAD' ], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'ignore' ],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function sanitizeError(error: unknown, knownUrl?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (knownUrl) {
    message = message.replaceAll(knownUrl, '[redacted benchmark URL]');
    try {
      const parsed = new URL(knownUrl);
      const encodedDatabase = parsed.pathname.replace(/^\/+/, '');
      let decodedDatabase = '';
      try {
        decodedDatabase = decodeURIComponent(encodedDatabase);
      } catch {
        // The full known URL was already redacted; malformed path encodings add no safe sentinel.
      }
      const sentinels = [
        parsed.host,
        parsed.hostname,
        parsed.username,
        parsed.password,
        parsed.pathname,
        encodedDatabase,
        decodedDatabase,
        decodeURIComponent(parsed.username),
        decodeURIComponent(parsed.password),
      ].filter((sentinel, index, values) =>
        sentinel.length > 0 && values.indexOf(sentinel) === index)
        .sort((left, right) => right.length - left.length);
      for (const sentinel of sentinels) {
        message = message.replaceAll(sentinel, '[redacted connection sentinel]');
      }
    } catch {
      // The full known URL was already redacted; malformed URLs have no safe sentinels to parse.
    }
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted benchmark URL]')
    .replace(/(?:password|secret|token)=\S+/giu, '[redacted credential]');
}

export function formatBenchmarkCliFailure(error: unknown, knownUrl?: string): string {
  const lines: string[] = [];
  appendBenchmarkCliFailure(lines, error, 'failure', knownUrl);
  return [
    'RDF cloud replacement benchmark failed:',
    ...lines.map((line) => `- ${line}`),
  ].join('\n');
}

function appendBenchmarkCliFailure(
  lines: string[],
  error: unknown,
  category: string,
  knownUrl?: string,
): void {
  lines.push(`${category}: ${sanitizeError(error, knownUrl)}`);
  if (!(error instanceof AggregateError)) {
    return;
  }
  const children = Array.from(error.errors as Iterable<unknown>);
  const combinedFailure = category === 'failure' &&
    error.message === 'Benchmark failed and cleanup also failed';
  const cleanupFailure = category === 'failure' && error.message === 'Benchmark cleanup failed';
  children.forEach((child, index) => {
    const childCategory = combinedFailure
      ? index === 0 ? 'primary' : `cleanup[${index}]`
      : cleanupFailure
        ? `cleanup[${index + 1}]`
        : `${category}.cause[${index + 1}]`;
    appendBenchmarkCliFailure(lines, child, childCategory, knownUrl);
  });
}

function optionName(argument: string): string {
  const withoutPrefix = argument.startsWith('--') ? argument.slice(2) : 'argument';
  return withoutPrefix.split('=', 1)[0] || 'argument';
}

function enumOption<const T extends string>(
  values: ReadonlyMap<string, string>,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = values.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid --${name}; expected ${allowed.join(' or ')}`);
  }
  return value as T;
}

function positiveIntegerOption(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = values.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  assertPositiveInteger(value, name);
  return value;
}

function nonNegativeIntegerOption(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
): number {
  const raw = values.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid --${name}; expected a finite non-negative integer`);
  }
  return value;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid --${name}; expected a finite positive integer`);
  }
}

function nonEmptyOption(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: string,
): string {
  const value = values.get(name);
  if (value === undefined) {
    return fallback;
  }
  if (value.length === 0 || /[\r\n\0]/u.test(value)) {
    throw new Error(`Invalid --${name}; expected a non-empty single-line value`);
  }
  return value;
}

function workloadOption(raw?: string): string[] {
  const available = cloudReplacementWorkloads().map(({ id }) => id);
  if (raw === undefined) {
    return available;
  }
  const selected = raw.split(',');
  const known = new Set(available);
  if (selected.length === 0 || selected.some((id) => !id || !known.has(id))) {
    throw new Error('Unknown benchmark workload in --workloads');
  }
  if (new Set(selected).size !== selected.length) {
    throw new Error('Invalid --workloads; expected unique workload ids');
  }
  return selected;
}

function concurrencyOption(raw?: string): BenchmarkConcurrency[] {
  if (raw === undefined) {
    return [ ...DEFAULT_CONCURRENCY ];
  }
  const parts = raw.split(',');
  const values = parts.map(Number);
  const allowed = new Set<number>(DEFAULT_CONCURRENCY);
  if (parts.length === 0 || values.some((value) =>
    !Number.isInteger(value) || !allowed.has(value)) || new Set(values).size !== values.length) {
    throw new Error('Invalid --concurrency; expected unique lanes chosen from 1, 8, and 32');
  }
  return values as BenchmarkConcurrency[];
}

if (import.meta.main) {
  await main();
}
