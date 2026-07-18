import type { Quad, Term } from '@rdfjs/types';
import { DataFactory } from 'n3';
import {
  RdfAccessMode,
  rdfAccessGraphAllowed,
  type RdfAccessScope,
} from './RdfAccessScope';
import {
  RDF_MODELS_SYNTHETIC_THREAD_COUNT,
  rdfModelsSyntheticPodIri,
} from './models-benchmark';

export type CloudReplacementEngineId = 'rdf3x' | 'qlever';
export type CloudReplacementWorkloadGroup = 'short' | 'large' | 'authorization';

export interface CloudReplacementWorkload {
  id: string;
  group: CloudReplacementWorkloadGroup;
  purpose: string;
  sparql: string;
  sharedSurface: true;
  orderSensitive: boolean;
  concurrencyRepresentative: boolean;
  expectedRows?: number;
  minRows?: number;
  accessScope?: RdfAccessScope;
  authorizationGraphVariables?: readonly string[];
}

export interface CloudReplacementExecution {
  rows: string[];
  orderedDigest: string;
  multisetDigest: string;
  fallbackReason: string | null;
  physicalPlan: string[];
  queryElapsedMs: number | null;
}

export interface CloudReplacementEngineAdapter<
  Id extends CloudReplacementEngineId = CloudReplacementEngineId,
> {
  readonly id: Id;
  execute(
    workload: CloudReplacementWorkload,
    sampleIdentity?: string,
    signal?: AbortSignal,
  ): Promise<CloudReplacementExecution>;
}

export interface CloudReplacementCorrectness {
  correct: boolean;
  sameMultiset: boolean;
  sameOrder: boolean;
  failures: string[];
  rdf3x: CloudReplacementExecution;
  qlever: CloudReplacementExecution;
}

export type CloudReplacementCacheMode = 'off' | 'production';

export interface CloudReplacementSampleIdentitySource {
  next(engine: CloudReplacementEngineId): string;
}

type CloudReplacementCacheMeasurementOptions =
  | {
    cacheMode: 'off';
    identitySource: CloudReplacementSampleIdentitySource;
  }
  | {
    cacheMode: 'production';
    identitySource?: CloudReplacementSampleIdentitySource;
  };

export function createCloudReplacementSampleIdentitySource(
  namespace: string,
): CloudReplacementSampleIdentitySource {
  if (namespace.length === 0 || /[\r\n]/u.test(namespace)) {
    throw new Error(
      'Cloud replacement sample identity namespace must be non-empty and contain no newlines',
    );
  }
  let counter = 0;
  return {
    next(engine) {
      const identity = `# xpod-benchmark-sample:${namespace}:${engine}:${counter}`;
      counter += 1;
      return identity;
    },
  };
}

export interface CloudReplacementLatency {
  cacheMode: CloudReplacementCacheMode;
  /**
   * First timed execution after the caller prepared cold state for this run.
   * This helper does not clear PostgreSQL shared buffers or other database caches.
   */
  coldMs: number;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export type CloudReplacementErrorCategory =
  | 'timeout'
  | 'connection'
  | 'cancelled'
  | 'engine'
  | 'correctness'
  | 'unknown';

export type CloudReplacementErrorStage =
  | 'acquire'
  | 'query'
  | 'materialize'
  | 'cancel'
  | 'cleanup';

export interface CloudReplacementErrorSample {
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
}

export interface CloudReplacementErrorEvidence {
  counts: Record<CloudReplacementErrorCategory, number>;
  samples: CloudReplacementErrorSample[];
}

export interface CloudReplacementConcurrency {
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
}

export interface CloudReplacementPgDiagnostics {
  sharedBlocksRead: number | null;
  sharedBlocksHit: number | null;
  tempBytes: number | null;
  memoryPeakBytes: number | null;
  memoryLimitBytes: number | null;
  diagnosticsUnavailable: string[];
}

export type CloudReplacementBinding = Readonly<
  Record<string, Term | undefined>
>;

type CanonicalTermTuple = [ string, string, string, string ];

function canonicalTermTuple(term: Term): CanonicalTermTuple {
  return term.termType === 'Literal'
    ? [ term.termType, term.value, term.language, term.datatype.value ]
    : [ term.termType, term.value, '', '' ];
}

export function canonicalCloudReplacementTerm(term: Term): string {
  return JSON.stringify(canonicalTermTuple(term));
}

export function canonicalCloudReplacementRow(binding: CloudReplacementBinding): string {
  const variables = Object.entries(binding)
    .filter((entry): entry is [ string, Term ] => entry[1] !== undefined)
    .sort(([ left ], [ right ]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([ variable, term ]) => [ variable, canonicalTermTuple(term) ]);
  return JSON.stringify(variables);
}

export function canonicalCloudReplacementDigests(rows: readonly string[]): {
  orderedDigest: string;
  multisetDigest: string;
} {
  return {
    orderedDigest: JSON.stringify(rows),
    multisetDigest: JSON.stringify([ ...rows ].sort()),
  };
}

interface CloudReplacementErrorClassification {
  category: CloudReplacementErrorCategory;
  stage: CloudReplacementErrorStage;
  name: string;
  code: string | null;
  message: string;
}

const CLOUD_REPLACEMENT_ERROR_CATEGORIES: readonly CloudReplacementErrorCategory[] = [
  'timeout',
  'connection',
  'cancelled',
  'engine',
  'correctness',
  'unknown',
];

const CLOUD_REPLACEMENT_ERROR_STAGES: readonly CloudReplacementErrorStage[] = [
  'acquire',
  'query',
  'materialize',
  'cancel',
  'cleanup',
];

const CLOUD_REPLACEMENT_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
]);

export function classifyCloudReplacementBenchmarkError(
  error: unknown,
): CloudReplacementErrorClassification {
  const chain = cloudReplacementErrorChain(error);
  const explicitStage = chain.map(readCloudReplacementErrorStage)
    .find((stage): stage is CloudReplacementErrorStage => stage !== undefined);
  const explicitCategory = chain.map(readCloudReplacementErrorCategory)
    .find((category): category is CloudReplacementErrorCategory => category !== undefined);
  const attributed = explicitCategory === undefined
    ? undefined
    : chain.find((entry) => readCloudReplacementErrorCategory(entry) === explicitCategory);
  const node = attributed ?? chain.find(cloudReplacementErrorLooksClassifiable) ?? error;
  const name = sanitizeCloudReplacementErrorMessage(readCloudReplacementErrorName(node));
  const code = readCloudReplacementErrorCode(node);
  const message = sanitizeCloudReplacementErrorMessage(readCloudReplacementErrorMessage(node));

  if (explicitCategory !== undefined) {
    return {
      category: explicitCategory,
      stage: explicitStage ?? defaultCloudReplacementErrorStage(explicitCategory),
      name,
      code,
      message,
    };
  }
  if (code !== null && (CLOUD_REPLACEMENT_CONNECTION_CODES.has(code) || /^08/u.test(code))) {
    return { category: 'connection', stage: explicitStage ?? 'acquire', name, code, message };
  }
  if (/connection (?:terminated|closed)|pool ended|connection ended|server closed the connection/iu
    .test(message)) {
    return { category: 'connection', stage: explicitStage ?? 'acquire', name, code, message };
  }
  if (name === 'TimeoutError' || code === '57014' || /statement timeout|timed out|timeout/iu
    .test(message)) {
    return { category: 'timeout', stage: explicitStage ?? 'query', name, code, message };
  }
  if (name === 'AbortError') {
    return { category: 'cancelled', stage: explicitStage ?? 'cancel', name, code, message };
  }
  if (error instanceof Error) {
    return { category: 'engine', stage: explicitStage ?? 'query', name, code, message };
  }
  return { category: 'unknown', stage: explicitStage ?? 'query', name, code, message };
}

function cloudReplacementErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    chain.push(current);
    const cause = readCloudReplacementErrorCause(current);
    if (cause === undefined) {
      break;
    }
    current = cause;
  }
  return chain;
}

function cloudReplacementErrorLooksClassifiable(error: unknown): boolean {
  const name = readCloudReplacementErrorName(error);
  const code = readCloudReplacementErrorCode(error);
  const message = readCloudReplacementErrorMessage(error);
  return name === 'TimeoutError' || name === 'AbortError' || code !== null ||
    /connection|pool ended|statement timeout|timed out|timeout/iu.test(message);
}

function readCloudReplacementErrorCause(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function readCloudReplacementErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name || 'Error';
  }
  if (error && typeof error === 'object' && 'name' in error &&
    typeof (error as { name?: unknown }).name === 'string') {
    return (error as { name: string }).name || 'Error';
  }
  return typeof error;
}

function readCloudReplacementErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code.toUpperCase() : null;
}

function readCloudReplacementErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error &&
    typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function readCloudReplacementErrorStage(error: unknown): CloudReplacementErrorStage | undefined {
  if (!error || typeof error !== 'object' || !('stage' in error)) {
    return undefined;
  }
  const stage = (error as { stage?: unknown }).stage;
  return typeof stage === 'string' && isCloudReplacementErrorStage(stage) ? stage : undefined;
}

function readCloudReplacementErrorCategory(
  error: unknown,
): CloudReplacementErrorCategory | undefined {
  if (!error || typeof error !== 'object' || !('category' in error)) {
    return undefined;
  }
  const category = (error as { category?: unknown }).category;
  return typeof category === 'string' && isCloudReplacementErrorCategory(category)
    ? category
    : undefined;
}

function isCloudReplacementErrorStage(value: string): value is CloudReplacementErrorStage {
  return CLOUD_REPLACEMENT_ERROR_STAGES.includes(value as CloudReplacementErrorStage);
}

function isCloudReplacementErrorCategory(value: string): value is CloudReplacementErrorCategory {
  return CLOUD_REPLACEMENT_ERROR_CATEGORIES.includes(value as CloudReplacementErrorCategory);
}

function defaultCloudReplacementErrorStage(
  category: CloudReplacementErrorCategory,
): CloudReplacementErrorStage {
  if (category === 'connection') {
    return 'acquire';
  }
  if (category === 'cancelled') {
    return 'cancel';
  }
  return 'query';
}

function sanitizeCloudReplacementErrorMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\bpostgres(?:ql)?:\/\/\S+/giu, '[redacted-url]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[redacted-url]')
    .replace(/\b(?:password|token|secret|user|username)\s*[=:]\s*\S+/giu, '[redacted-credential]')
    .replace(/\bhost\s*[=:]\s*\S+/giu, '[redacted-host]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/gu, '[redacted-endpoint]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '[redacted-endpoint]')
    .replace(/\[[0-9a-f:]+\]:\d+/giu, '[redacted-endpoint]')
    .replace(/\b[0-9a-f]{0,4}:[0-9a-f:]*:[0-9a-f:]*\b/giu, '[redacted-endpoint]')
    .replace(/\b(?:connect\s+\S+\s+|getaddrinfo\s+\S+\s+)([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?\b/giu,
      (match) => match.replace(/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?/iu, '[redacted-endpoint]'))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function parseCanonicalCloudReplacementRow(row: string): Map<string, CanonicalTermTuple> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }

  const binding = new Map<string, CanonicalTermTuple>();
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
      !isCanonicalTermTuple(entry[1]) || binding.has(entry[0])) {
      return null;
    }
    binding.set(entry[0], entry[1]);
  }
  return binding;
}

function isCanonicalTermTuple(value: unknown): value is CanonicalTermTuple {
  return Array.isArray(value) && value.length === 4 &&
    value.every((part) => typeof part === 'string');
}

function appendCloudReplacementAuthorizationFailures(
  workload: CloudReplacementWorkload,
  executions: readonly [
    readonly [ 'rdf3x', CloudReplacementExecution ],
    readonly [ 'qlever', CloudReplacementExecution ],
  ],
  failures: string[],
): void {
  if (workload.group !== 'authorization') {
    return;
  }

  const scope = workload.accessScope;
  const graphVariables = workload.authorizationGraphVariables;
  if (!scope) {
    failures.push('authorization-missing-access-scope');
  }
  if (!graphVariables?.length) {
    failures.push('authorization-missing-graph-variables');
  }
  if (!scope || !graphVariables?.length) {
    return;
  }

  for (const [ engine, execution ] of executions) {
    execution.rows.forEach((row, rowIndex) => {
      const binding = parseCanonicalCloudReplacementRow(row);
      if (!binding) {
        failures.push(`${engine}-authorization-row:${rowIndex}:malformed`);
        return;
      }
      for (const variable of graphVariables) {
        const graph = binding.get(variable);
        if (!graph) {
          failures.push(`${engine}-authorization-row:${rowIndex}:missing-graph-variable:${variable}`);
        } else if (graph[0] !== 'NamedNode') {
          failures.push(`${engine}-authorization-row:${rowIndex}:non-named-graph-variable:${variable}`);
        } else if (!rdfAccessGraphAllowed(graph[1], scope)) {
          failures.push(`${engine}-authorization-row:${rowIndex}:denied-graph:${variable}:${graph[1]}`);
        }
      }
    });
  }
}

export async function compareCloudReplacementCase(
  workload: CloudReplacementWorkload,
  rdf3xAdapter: CloudReplacementEngineAdapter<'rdf3x'>,
  qleverAdapter: CloudReplacementEngineAdapter<'qlever'>,
): Promise<CloudReplacementCorrectness> {
  assertCloudReplacementAdapterIdentity('rdf3x', rdf3xAdapter);
  assertCloudReplacementAdapterIdentity('qlever', qleverAdapter);
  const rdf3xPromise = Promise.resolve().then(() => rdf3xAdapter.execute(workload));
  const qleverPromise = Promise.resolve().then(() => qleverAdapter.execute(workload));
  const [ rdf3x, qlever ] = await Promise.all([ rdf3xPromise, qleverPromise ]);
  const failures: string[] = [];
  const rdf3xDigests = canonicalCloudReplacementDigests(rdf3x.rows);
  const qleverDigests = canonicalCloudReplacementDigests(qlever.rows);

  for (const [ engine, execution, digests ] of [
    [ 'rdf3x', rdf3x, rdf3xDigests ],
    [ 'qlever', qlever, qleverDigests ],
  ] as const) {
    if (execution.fallbackReason !== null) {
      failures.push(`${engine}-fallback:${execution.fallbackReason}`);
    }
    if (execution.orderedDigest !== digests.orderedDigest) {
      failures.push(`${engine}-invalid-ordered-digest`);
    }
    if (execution.multisetDigest !== digests.multisetDigest) {
      failures.push(`${engine}-invalid-multiset-digest`);
    }
    if (workload.expectedRows !== undefined && execution.rows.length !== workload.expectedRows) {
      failures.push(
        `${engine}-expected-rows:expected=${workload.expectedRows}:actual=${execution.rows.length}`,
      );
    }
    if (workload.minRows !== undefined && execution.rows.length < workload.minRows) {
      failures.push(`${engine}-min-rows:min=${workload.minRows}:actual=${execution.rows.length}`);
    }
  }

  appendCloudReplacementAuthorizationFailures(workload, [
    [ 'rdf3x', rdf3x ],
    [ 'qlever', qlever ],
  ], failures);

  const sameMultiset = rdf3xDigests.multisetDigest === qleverDigests.multisetDigest;
  const sameOrder = rdf3xDigests.orderedDigest === qleverDigests.orderedDigest;
  if (!sameMultiset) {
    failures.push('multiset-mismatch');
  }
  if (workload.orderSensitive && !sameOrder) {
    failures.push('order-mismatch');
  }

  return {
    correct: failures.length === 0,
    sameMultiset,
    sameOrder,
    failures,
    rdf3x,
    qlever,
  };
}

function assertCloudReplacementAdapterIdentity(
  expected: CloudReplacementEngineId,
  adapter: CloudReplacementEngineAdapter,
): void {
  if (adapter.id !== expected) {
    throw new Error(
      `Cloud replacement adapter configuration error: expected ${expected} at ${expected} position, received ${adapter.id}`,
    );
  }
}

export async function measureCloudReplacementCase(
  workload: CloudReplacementWorkload,
  rdf3xAdapter: CloudReplacementEngineAdapter<'rdf3x'>,
  qleverAdapter: CloudReplacementEngineAdapter<'qlever'>,
  options: {
    warmupIterations: number;
    iterations: number;
    coldFirstEngine: CloudReplacementEngineId;
    operationTimeoutMs: number;
  } & CloudReplacementCacheMeasurementOptions,
): Promise<{
  rdf3x: CloudReplacementLatency;
  qlever: CloudReplacementLatency;
}> {
  assertCloudReplacementAdapterIdentity('rdf3x', rdf3xAdapter);
  assertCloudReplacementAdapterIdentity('qlever', qleverAdapter);

  const warmupIterations = cloudReplacementIterationCount(
    options.warmupIterations,
    'warmupIterations',
  );
  const iterations = cloudReplacementIterationCount(options.iterations, 'iterations');
  const operationTimeoutMs = cloudReplacementOperationTimeout(options.operationTimeoutMs);
  const identitySource = cloudReplacementIdentitySource(options.cacheMode, options.identitySource);
  const cold = { rdf3x: 0, qlever: 0 };
  const samples = { rdf3x: [] as number[], qlever: [] as number[] };

  const execute = async (
    adapter: CloudReplacementEngineAdapter,
  ): Promise<number> => {
    const sampleIdentity = identitySource?.next(adapter.id);
    const execution = await executeCloudReplacementWithTimeout(
      adapter,
      workload,
      sampleIdentity,
      operationTimeoutMs,
    );
    if (execution.queryElapsedMs === null || !Number.isFinite(execution.queryElapsedMs) ||
      execution.queryElapsedMs < 0) {
      throw new Error(
        'Cloud replacement latency execution requires finite non-negative queryElapsedMs',
      );
    }
    return execution.queryElapsedMs;
  };

  const executeRound = async (
    round: number,
    phase: 'cold' | 'warmup' | 'measured',
  ): Promise<void> => {
    const coldOrder: readonly [
      CloudReplacementEngineAdapter,
      CloudReplacementEngineAdapter,
    ] = options.coldFirstEngine === 'rdf3x'
      ? [ rdf3xAdapter, qleverAdapter ]
      : [ qleverAdapter, rdf3xAdapter ];
    const adapters = round % 2 === 0 ? coldOrder : [ coldOrder[1], coldOrder[0] ];
    for (const adapter of adapters) {
      const elapsedMs = await execute(adapter);
      if (phase === 'cold') {
        cold[adapter.id] = elapsedMs;
      } else if (phase === 'measured') {
        samples[adapter.id].push(elapsedMs);
      }
    }
  };

  let round = 0;
  await executeRound(round, 'cold');
  round += 1;
  for (let warmup = 0; warmup < warmupIterations; warmup += 1, round += 1) {
    await executeRound(round, 'warmup');
  }
  for (let sample = 0; sample < iterations; sample += 1, round += 1) {
    await executeRound(round, 'measured');
  }

  return {
    rdf3x: cloudReplacementLatency(options.cacheMode, cold.rdf3x, samples.rdf3x),
    qlever: cloudReplacementLatency(options.cacheMode, cold.qlever, samples.qlever),
  };
}

export async function measureCloudReplacementConcurrency<Id extends CloudReplacementEngineId>(
  workload: CloudReplacementWorkload,
  adapter: CloudReplacementEngineAdapter<Id>,
  options: {
    concurrency: 1 | 8 | 32;
    durationMs: number;
    operationTimeoutMs: number;
    now?: () => number;
    wallNow?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    connectionBackoffMs?: number;
    maxConsecutiveConnectionErrors?: number;
  } & CloudReplacementCacheMeasurementOptions,
): Promise<CloudReplacementConcurrency> {
  const { cacheMode, concurrency, durationMs } = options;
  if (!Number.isFinite(durationMs)) {
    throw new Error('Cloud replacement durationMs must be finite');
  }
  const operationTimeoutMs = cloudReplacementOperationTimeout(options.operationTimeoutMs);
  const identitySource = cloudReplacementIdentitySource(cacheMode, options.identitySource);
  const sleep = options.sleep ?? cloudReplacementSleep;
  const connectionBackoffMs = options.connectionBackoffMs ?? 100;
  const maxConsecutiveConnectionErrors = options.maxConsecutiveConnectionErrors ?? 3;
  if (typeof sleep !== 'function') {
    throw new Error('Cloud replacement sleep must be a function');
  }
  if (!Number.isFinite(connectionBackoffMs) || connectionBackoffMs < 0) {
    throw new Error('Cloud replacement connectionBackoffMs must be finite and non-negative');
  }
  if (!Number.isFinite(maxConsecutiveConnectionErrors) ||
    !Number.isInteger(maxConsecutiveConnectionErrors) ||
    maxConsecutiveConnectionErrors <= 0) {
    throw new Error(
      'Cloud replacement maxConsecutiveConnectionErrors must be a finite positive integer',
    );
  }
  if (![ 1, 8, 32 ].includes(concurrency)) {
    throw new Error(`Cloud replacement concurrency must be 1, 8, or 32; received ${concurrency}`);
  }

  const emptyResult = (): CloudReplacementConcurrency => ({
    cacheMode,
    concurrency,
    durationMs,
    elapsedMs: 0,
    completed: 0,
    errors: 0,
    infrastructureErrors: 0,
    infrastructureFailure: false,
    errorEvidence: emptyCloudReplacementErrorEvidence(),
    throughputPerSecond: 0,
  });
  if (durationMs <= 0) {
    return emptyResult();
  }

  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date());
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let completed = 0;
  let errors = 0;
  let infrastructureErrors = 0;
  let consecutiveConnectionErrors = 0;
  let infrastructureFailure = false;
  const errorEvidence = emptyCloudReplacementErrorEvidence();
  const evidenceContext = {
    workloadId: workload.id,
    engine: adapter.id,
    cacheMode,
    concurrency,
  };

  const worker = async (): Promise<void> => {
    while (!infrastructureFailure && now() < deadline) {
      const sampleIdentity = identitySource?.next(adapter.id);
      try {
        const execution = await executeCloudReplacementWithTimeout(
          adapter,
          workload,
          sampleIdentity,
          operationTimeoutMs,
        );
        if (execution.fallbackReason === null) {
          completed += 1;
          consecutiveConnectionErrors = 0;
        } else {
          errors += 1;
          consecutiveConnectionErrors = 0;
          recordCloudReplacementErrorEvidence(
            errorEvidence,
            {
              category: 'engine',
              stage: 'query',
              name: 'FallbackReason',
              code: null,
              message: sanitizeCloudReplacementErrorMessage(`fallback:${execution.fallbackReason}`),
            },
            { ...evidenceContext, seenAt: wallNow().toISOString() },
          );
        }
      } catch (error) {
        const classification = classifyCloudReplacementBenchmarkError(error);
        if (classification.category === 'connection') {
          infrastructureErrors += 1;
          consecutiveConnectionErrors += 1;
        } else {
          errors += 1;
          consecutiveConnectionErrors = 0;
        }
        recordCloudReplacementErrorEvidence(
          errorEvidence,
          classification,
          { ...evidenceContext, seenAt: wallNow().toISOString() },
        );
        if (classification.category === 'connection') {
          if (consecutiveConnectionErrors >= maxConsecutiveConnectionErrors) {
            infrastructureFailure = true;
          } else if (!infrastructureFailure) {
            await sleep(connectionBackoffMs);
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = Math.max(now() - startedAt, Number.EPSILON);
  return {
    cacheMode,
    concurrency,
    durationMs,
    elapsedMs,
    completed,
    errors,
    infrastructureErrors,
    infrastructureFailure,
    errorEvidence,
    throughputPerSecond: completed / (elapsedMs / 1_000),
  };
}

function cloudReplacementSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptyCloudReplacementErrorEvidence(): CloudReplacementErrorEvidence {
  return {
    counts: {
      timeout: 0,
      connection: 0,
      cancelled: 0,
      engine: 0,
      correctness: 0,
      unknown: 0,
    },
    samples: [],
  };
}

function recordCloudReplacementErrorEvidence(
  evidence: CloudReplacementErrorEvidence,
  classification: CloudReplacementErrorClassification,
  context: {
    workloadId: string;
    engine: CloudReplacementEngineId;
    cacheMode: CloudReplacementCacheMode;
    concurrency: 1 | 8 | 32;
    seenAt: string;
  },
): void {
  evidence.counts[classification.category] += 1;
  const fingerprint = cloudReplacementErrorFingerprint(classification, context);
  const existing = evidence.samples.find((sample) =>
    cloudReplacementErrorFingerprint(sample, sample) === fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = context.seenAt;
    return;
  }
  const categorySamples = evidence.samples.filter((sample) =>
    sample.category === classification.category);
  if (categorySamples.length >= 3) {
    return;
  }
  evidence.samples.push({
    category: classification.category,
    stage: classification.stage,
    name: classification.name,
    code: classification.code,
    message: classification.message,
    firstSeenAt: context.seenAt,
    lastSeenAt: context.seenAt,
    count: 1,
    workloadId: context.workloadId,
    engine: context.engine,
    cacheMode: context.cacheMode,
    concurrency: context.concurrency,
  });
}

function cloudReplacementErrorFingerprint(
  classification: Pick<CloudReplacementErrorSample, 'category' | 'stage' | 'name' | 'code' | 'message'>,
  context: Pick<CloudReplacementErrorSample, 'workloadId' | 'engine' | 'cacheMode' | 'concurrency'>,
): string {
  return JSON.stringify([
    classification.category,
    classification.stage,
    classification.name,
    classification.code,
    classification.message,
    context.workloadId,
    context.engine,
    context.cacheMode,
    context.concurrency,
  ]);
}

function cloudReplacementIterationCount(
  value: number,
  name: 'warmupIterations' | 'iterations',
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Cloud replacement ${name} must be finite and non-negative`);
  }
  return Math.floor(value);
}

function cloudReplacementOperationTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Cloud replacement operationTimeoutMs must be finite and positive');
  }
  return value;
}

async function executeCloudReplacementWithTimeout(
  adapter: CloudReplacementEngineAdapter,
  workload: CloudReplacementWorkload,
  sampleIdentity: string | undefined,
  operationTimeoutMs: number,
): Promise<CloudReplacementExecution> {
  const controller = new AbortController();
  const timeoutError = new Error(
    `Cloud replacement ${adapter.id} operation timed out after ${operationTimeoutMs}ms`,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, operationTimeoutMs);
  });
  try {
    const executionPromise = Promise.resolve().then(() =>
      adapter.execute(workload, sampleIdentity, controller.signal));
    return await Promise.race([ executionPromise, timeoutPromise ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function cloudReplacementIdentitySource(
  cacheMode: CloudReplacementCacheMode,
  identitySource?: CloudReplacementSampleIdentitySource,
): CloudReplacementSampleIdentitySource | undefined {
  if (cacheMode === 'production') {
    return undefined;
  }
  if (!identitySource) {
    throw new Error('Cache-off cloud replacement measurements require identitySource');
  }
  return identitySource;
}

function cloudReplacementLatency(
  cacheMode: CloudReplacementCacheMode,
  coldMs: number,
  samplesMs: number[],
): CloudReplacementLatency {
  return {
    cacheMode,
    coldMs,
    samplesMs,
    p50Ms: cloudReplacementNearestRank(samplesMs, 0.50),
    p95Ms: cloudReplacementNearestRank(samplesMs, 0.95),
    p99Ms: cloudReplacementNearestRank(samplesMs, 0.99),
  };
}

function cloudReplacementNearestRank(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [ ...samples ].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? 0;
}

export const CLOUD_REPLACEMENT_GROUP_WEIGHTS = Object.freeze({
  short: 0.60,
  large: 0.30,
  authorization: 0.10,
});

export const CLOUD_REPLACEMENT_THRESHOLDS = Object.freeze({
  maxCriticalShortP95Ratio: 1.20,
  maxWeightedP95Ratio: 0.80,
  minThroughputRatio: 1.25,
  minLargeCaseSpeedup: 1.50,
  minLargeWinningCases: 2,
  maxMemoryLimitRatio: 0.85,
  maxTempDiskLimitRatio: 0.20,
  maxErrorRate: 0,
});

export interface CloudReplacementDecisionInput {
  correctnessPassed: boolean;
  criticalShortP95Ratios: number[];
  weightedP95Ratio: number;
  throughputRatio: number;
  largeCaseSpeedups: number[];
  errorRate: number;
  memoryLimitRatio: number | null;
  tempDiskLimitRatio: number | null;
}

export type CloudReplacementRecommendation =
  | 'replace'
  | 'retain-rdf3x'
  | 'selective-routing-candidate';

export interface CloudReplacementDecisionPassed {
  correctness: boolean;
  criticalShortP95: boolean;
  weightedP95: boolean;
  throughput: boolean;
  aggregatePerformance: boolean;
  largeCases: boolean;
  errorRate: boolean;
  memoryLimit: boolean;
  tempDiskLimit: boolean;
  resources: boolean;
  all: boolean;
}

export interface CloudReplacementDecision {
  recommendation: CloudReplacementRecommendation;
  passed: CloudReplacementDecisionPassed;
  observed: CloudReplacementDecisionInput;
}

export interface CloudReplacementP95Comparison {
  group: CloudReplacementWorkloadGroup;
  rdf3xP95Ms: number;
  qleverP95Ms: number;
}

export interface CloudReplacementThroughputMeasurement {
  completed: number;
  elapsedMs: number;
}

export interface CloudReplacementEnvironmentInput {
  connectionString: string;
  postgresVersion: string;
  engineCommit: string;
}

export interface CloudReplacementEnvironment {
  database: string;
  postgresVersion: string;
  engineCommit: string;
}

export interface CloudReplacementReportEngineCase {
  fallbackReason: string | null;
  coldMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CloudReplacementReportCase {
  id: string;
  group: CloudReplacementWorkloadGroup;
  correctnessFailures: string[];
  rdf3x: CloudReplacementReportEngineCase;
  qlever: CloudReplacementReportEngineCase;
}

export interface CloudReplacementReportConcurrency {
  caseId: string;
  engine: CloudReplacementEngineId;
  concurrency: 1 | 8 | 32;
  completed: number;
  errors: number;
  infrastructureErrors: number;
  infrastructureFailure: boolean;
  errorEvidence: CloudReplacementErrorEvidence;
  elapsedMs: number;
  throughputPerSecond: number;
}

export interface CloudReplacementIndexBuildAndStorage {
  buildMs: number;
  storageBytes: number;
}

export interface CloudReplacementReport {
  environment: CloudReplacementEnvironment;
  targetFacts: number;
  actualFacts: number;
  correctnessFailures: string[];
  cases: CloudReplacementReportCase[];
  concurrency: CloudReplacementReportConcurrency[];
  indexBuildAndStorage: Record<CloudReplacementEngineId, CloudReplacementIndexBuildAndStorage>;
  resourceDiagnostics: Record<CloudReplacementEngineId, CloudReplacementPgDiagnostics>;
  decision: CloudReplacementDecision;
}

export function decideCloudReplacement(
  input: CloudReplacementDecisionInput,
): CloudReplacementDecision {
  if (typeof input.correctnessPassed !== 'boolean') {
    throw new Error('Cloud replacement correctnessPassed must be boolean');
  }
  assertCloudReplacementRatioArray(
    input.criticalShortP95Ratios,
    'criticalShortP95Ratios',
  );
  assertCloudReplacementFiniteNonNegative(input.weightedP95Ratio, 'weightedP95Ratio');
  assertCloudReplacementFiniteNonNegative(input.throughputRatio, 'throughputRatio');
  assertCloudReplacementRatioArray(input.largeCaseSpeedups, 'largeCaseSpeedups');
  if (!Number.isFinite(input.errorRate) || input.errorRate < 0 || input.errorRate > 1) {
    throw new Error('Cloud replacement errorRate must be finite and between 0 and 1');
  }
  assertCloudReplacementNullableRatio(input.memoryLimitRatio, 'memoryLimitRatio');
  assertCloudReplacementNullableRatio(input.tempDiskLimitRatio, 'tempDiskLimitRatio');

  const observed: CloudReplacementDecisionInput = {
    ...input,
    criticalShortP95Ratios: [ ...input.criticalShortP95Ratios ],
    largeCaseSpeedups: [ ...input.largeCaseSpeedups ],
  };
  const criticalShortP95 = observed.criticalShortP95Ratios.length > 0 &&
    observed.criticalShortP95Ratios.every((ratio) =>
      ratio <= CLOUD_REPLACEMENT_THRESHOLDS.maxCriticalShortP95Ratio);
  const weightedP95 = observed.weightedP95Ratio <=
    CLOUD_REPLACEMENT_THRESHOLDS.maxWeightedP95Ratio;
  const throughput = observed.throughputRatio >=
    CLOUD_REPLACEMENT_THRESHOLDS.minThroughputRatio;
  const aggregatePerformance = weightedP95 || throughput;
  const largeCases = observed.largeCaseSpeedups.filter((speedup) =>
    speedup >= CLOUD_REPLACEMENT_THRESHOLDS.minLargeCaseSpeedup).length >=
    CLOUD_REPLACEMENT_THRESHOLDS.minLargeWinningCases;
  const errorRate = observed.errorRate <= CLOUD_REPLACEMENT_THRESHOLDS.maxErrorRate;
  const memoryLimit = observed.memoryLimitRatio !== null &&
    observed.memoryLimitRatio <= CLOUD_REPLACEMENT_THRESHOLDS.maxMemoryLimitRatio;
  const tempDiskLimit = observed.tempDiskLimitRatio !== null &&
    observed.tempDiskLimitRatio <= CLOUD_REPLACEMENT_THRESHOLDS.maxTempDiskLimitRatio;
  const resources = memoryLimit && tempDiskLimit;
  const all = observed.correctnessPassed && criticalShortP95 && aggregatePerformance &&
    largeCases && errorRate && resources;
  const passed: CloudReplacementDecisionPassed = {
    correctness: observed.correctnessPassed,
    criticalShortP95,
    weightedP95,
    throughput,
    aggregatePerformance,
    largeCases,
    errorRate,
    memoryLimit,
    tempDiskLimit,
    resources,
    all,
  };

  let recommendation: CloudReplacementRecommendation = 'retain-rdf3x';
  if (observed.correctnessPassed && errorRate) {
    if (all) {
      recommendation = 'replace';
    } else if (largeCases && (!criticalShortP95 || !aggregatePerformance || !resources)) {
      recommendation = 'selective-routing-candidate';
    }
  }

  return { recommendation, passed, observed };
}

export function calculateCloudReplacementWeightedP95Ratio(
  comparisons: readonly CloudReplacementP95Comparison[],
): number {
  const groups = Object.keys(CLOUD_REPLACEMENT_GROUP_WEIGHTS) as CloudReplacementWorkloadGroup[];
  for (const comparison of comparisons) {
    if (!groups.includes(comparison.group)) {
      throw new Error(`Unknown Cloud replacement workload group: ${comparison.group}`);
    }
  }

  const ratio = groups.reduce((weightedRatio, group) => {
    const cases = comparisons.filter((comparison) => comparison.group === group);
    if (cases.length === 0) {
      throw new Error(`Cloud replacement weighted p95 requires at least one case for group ${group}`);
    }
    const groupRatio = cases.reduce((total, comparison) => {
      assertCloudReplacementFinitePositiveDenominator(
        comparison.rdf3xP95Ms,
        'rdf3xP95Ms',
      );
      assertCloudReplacementFiniteNonNegative(comparison.qleverP95Ms, 'qleverP95Ms');
      const caseRatio = comparison.qleverP95Ms / comparison.rdf3xP95Ms;
      assertCloudReplacementFiniteNonNegative(caseRatio, 'weighted p95 case ratio');
      return total + caseRatio;
    }, 0) / cases.length;
    return weightedRatio + CLOUD_REPLACEMENT_GROUP_WEIGHTS[group] * groupRatio;
  }, 0);
  assertCloudReplacementFiniteNonNegative(ratio, 'weighted p95 ratio');
  return ratio;
}

export function calculateCloudReplacementThroughput(
  measurements: readonly CloudReplacementThroughputMeasurement[],
): number {
  if (measurements.length === 0) {
    throw new Error('Cloud replacement throughput requires at least one measurement');
  }
  let completed = 0;
  let elapsedMs = 0;
  for (const measurement of measurements) {
    if (!Number.isFinite(measurement.completed) || !Number.isInteger(measurement.completed) ||
      measurement.completed < 0) {
      throw new Error('Cloud replacement throughput completed must be a finite non-negative integer');
    }
    assertCloudReplacementFinitePositiveDenominator(measurement.elapsedMs, 'elapsedMs');
    completed += measurement.completed;
    elapsedMs += measurement.elapsedMs;
  }
  assertCloudReplacementFiniteNonNegative(completed, 'throughput completed total');
  assertCloudReplacementFinitePositiveDenominator(elapsedMs, 'elapsedMs total');
  const throughput = completed / (elapsedMs / 1_000);
  assertCloudReplacementFiniteNonNegative(throughput, 'calculated throughput');
  return throughput;
}

export function calculateCloudReplacementThroughputRatio(
  rdf3xMeasurements: readonly CloudReplacementThroughputMeasurement[],
  qleverMeasurements: readonly CloudReplacementThroughputMeasurement[],
): number {
  const rdf3xThroughput = calculateCloudReplacementThroughput(rdf3xMeasurements);
  const qleverThroughput = calculateCloudReplacementThroughput(qleverMeasurements);
  assertCloudReplacementFinitePositiveDenominator(rdf3xThroughput, 'RDF3X throughput');
  const ratio = qleverThroughput / rdf3xThroughput;
  assertCloudReplacementFiniteNonNegative(ratio, 'throughput ratio');
  return ratio;
}

export function sanitizeCloudReplacementEnvironment(
  input: CloudReplacementEnvironmentInput,
): CloudReplacementEnvironment {
  const url = new URL(input.connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Cloud replacement connection URL must use postgres or postgresql');
  }
  const encodedDatabase = url.pathname.replace(/^\/+/, '');
  if (encodedDatabase.length === 0) {
    throw new Error('Cloud replacement connection URL requires a database path');
  }
  const database = decodeURIComponent(encodedDatabase);
  if (database.length === 0) {
    throw new Error('Cloud replacement connection URL requires a database path');
  }
  return {
    database,
    postgresVersion: input.postgresVersion,
    engineCommit: input.engineCommit,
  };
}

export function renderCloudReplacementJson(report: CloudReplacementReport): string {
  return JSON.stringify(normalizeCloudReplacementReport(report), null, 2);
}

export function renderCloudReplacementMarkdown(report: CloudReplacementReport): string {
  const normalized = normalizeCloudReplacementReport(report);
  const lines = [
    '# Cloud RDF Replacement Benchmark',
    '',
    '## Environment',
    '',
    `- Database: ${cloudReplacementMarkdownText(normalized.environment.database)}`,
    `- PostgreSQL: ${cloudReplacementMarkdownText(normalized.environment.postgresVersion)}`,
    `- Engine commit: ${cloudReplacementMarkdownText(normalized.environment.engineCommit)}`,
    '',
    '## Dataset',
    '',
    `- Target facts: ${cloudReplacementReportNumber(normalized.targetFacts)}`,
    `- Actual facts: ${cloudReplacementReportNumber(normalized.actualFacts)}`,
    '',
    '## Correctness failures',
    '',
    ...(normalized.correctnessFailures.length > 0
      ? normalized.correctnessFailures.map((failure) =>
        `- ${cloudReplacementMarkdownText(failure)}`)
      : [ '- None' ]),
    '',
    '## Case latency',
    '',
    '| Case | Group | Engine | cold (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Fallback | Correctness failures |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];

  for (const benchmarkCase of normalized.cases) {
    for (const engine of [ 'rdf3x', 'qlever' ] as const) {
      const result = benchmarkCase[engine];
      lines.push([
        cloudReplacementMarkdownText(benchmarkCase.id),
        benchmarkCase.group,
        engine,
        cloudReplacementReportNumber(result.coldMs),
        cloudReplacementReportNumber(result.p50Ms),
        cloudReplacementReportNumber(result.p95Ms),
        cloudReplacementReportNumber(result.p99Ms),
        cloudReplacementMarkdownText(result.fallbackReason ?? 'none'),
        cloudReplacementMarkdownText(benchmarkCase.correctnessFailures.join(', ') || 'none'),
      ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |'));
    }
  }

  lines.push(
    '',
    '## Concurrency throughput',
    '',
    '| Case | Engine | Concurrency | Completed | Errors | infrastructureErrors | infrastructureFailure | Measured (ms) | Throughput (ops/s) | errorEvidence |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |',
    ...normalized.concurrency.map((measurement) => [
      cloudReplacementMarkdownText(measurement.caseId),
      measurement.engine,
      measurement.concurrency,
      cloudReplacementReportNumber(measurement.completed),
      cloudReplacementReportNumber(measurement.errors),
      cloudReplacementReportNumber(measurement.infrastructureErrors),
      String(measurement.infrastructureFailure),
      cloudReplacementReportNumber(measurement.elapsedMs),
      cloudReplacementReportNumber(measurement.throughputPerSecond),
      cloudReplacementMarkdownText(renderCloudReplacementErrorEvidenceSummary(
        measurement.errorEvidence,
      )),
    ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |')),
    '',
    '## Index build and storage',
    '',
    '| Engine | Build (ms) | Storage (bytes) |',
    '| --- | ---: | ---: |',
    ...([ 'rdf3x', 'qlever' ] as const).map((engine) => {
      const metric = normalized.indexBuildAndStorage[engine];
      return `| ${engine} | ${cloudReplacementReportNumber(metric.buildMs)} | ` +
        `${cloudReplacementReportNumber(metric.storageBytes)} |`;
    }),
    '',
    '## Resource diagnostics',
    '',
    '| Engine | sharedBlocksRead | sharedBlocksHit | tempBytes | memoryPeakBytes | memoryLimitBytes | Unavailable |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...([ 'rdf3x', 'qlever' ] as const).map((engine) => {
      const diagnostics = normalized.resourceDiagnostics[engine];
      return [
        engine,
        cloudReplacementNullableReportNumber(diagnostics.sharedBlocksRead),
        cloudReplacementNullableReportNumber(diagnostics.sharedBlocksHit),
        cloudReplacementNullableReportNumber(diagnostics.tempBytes),
        cloudReplacementNullableReportNumber(diagnostics.memoryPeakBytes),
        cloudReplacementNullableReportNumber(diagnostics.memoryLimitBytes),
        cloudReplacementMarkdownText(diagnostics.diagnosticsUnavailable.join(', ') || 'none'),
      ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |');
    }),
    '',
    '## Gates',
    '',
    '| Gate | Passed | Observed | Threshold |',
    '| --- | --- | --- | --- |',
    ...cloudReplacementGateRows(normalized.decision),
    '',
    '## Decision',
    '',
    `- Recommendation: ${normalized.decision.recommendation}`,
    '',
  );
  return lines.join('\n');
}

function renderCloudReplacementErrorEvidenceSummary(
  evidence: CloudReplacementErrorEvidence,
): string {
  const nonZeroCounts = CLOUD_REPLACEMENT_ERROR_CATEGORIES
    .filter((category) => evidence.counts[category] > 0)
    .map((category) => `${category}=${evidence.counts[category]}`);
  const samples = evidence.samples.map((sample) =>
    `${sample.category}/${sample.stage}/${sample.count}/${sample.firstSeenAt}-${sample.lastSeenAt}: ${sample.message}`);
  return [ ...nonZeroCounts, ...samples ].join('; ') || 'none';
}

function assertCloudReplacementRatioArray(value: number[], name: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`Cloud replacement ${name} must be an array`);
  }
  value.forEach((ratio, index) =>
    assertCloudReplacementFiniteNonNegative(ratio, `${name}[${index}]`));
}

function assertCloudReplacementNullableRatio(value: number | null, name: string): void {
  if (value !== null) {
    assertCloudReplacementFiniteNonNegative(value, name);
  }
}

function assertCloudReplacementFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Cloud replacement ${name} must be finite and non-negative`);
  }
}

function assertCloudReplacementFinitePositiveDenominator(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Cloud replacement ${name} denominator must be finite and positive`);
  }
}

function normalizeCloudReplacementReport(report: CloudReplacementReport): CloudReplacementReport {
  const environment = normalizeCloudReplacementReportEnvironment(report.environment);
  assertCloudReplacementReportHasNoCredentialKeys(report);
  const normalized: CloudReplacementReport = {
    environment,
    targetFacts: cloudReplacementReportInteger(report.targetFacts, 'targetFacts'),
    actualFacts: cloudReplacementReportInteger(report.actualFacts, 'actualFacts'),
    correctnessFailures: cloudReplacementReportStrings(
      report.correctnessFailures,
      'correctnessFailures',
    ),
    cases: report.cases.map((benchmarkCase, index) => ({
      id: cloudReplacementReportText(benchmarkCase.id, `cases[${index}].id`),
      group: cloudReplacementReportGroup(benchmarkCase.group),
      correctnessFailures: cloudReplacementReportStrings(
        benchmarkCase.correctnessFailures,
        `cases[${index}].correctnessFailures`,
      ),
      rdf3x: normalizeCloudReplacementReportEngineCase(
        benchmarkCase.rdf3x,
        `cases[${index}].rdf3x`,
      ),
      qlever: normalizeCloudReplacementReportEngineCase(
        benchmarkCase.qlever,
        `cases[${index}].qlever`,
      ),
    })),
    concurrency: report.concurrency.map((measurement, index) => ({
      caseId: cloudReplacementReportText(
        measurement.caseId,
        `concurrency[${index}].caseId`,
      ),
      engine: cloudReplacementReportEngine(measurement.engine),
      concurrency: cloudReplacementReportConcurrency(measurement.concurrency),
      completed: cloudReplacementReportInteger(
        measurement.completed,
        `concurrency[${index}].completed`,
      ),
      errors: cloudReplacementReportInteger(
        measurement.errors,
        `concurrency[${index}].errors`,
      ),
      infrastructureErrors: cloudReplacementReportInteger(
        measurement.infrastructureErrors,
        `concurrency[${index}].infrastructureErrors`,
      ),
      infrastructureFailure: cloudReplacementReportBoolean(
        measurement.infrastructureFailure,
        `concurrency[${index}].infrastructureFailure`,
      ),
      errorEvidence: normalizeCloudReplacementErrorEvidence(
        measurement.errorEvidence,
        `concurrency[${index}].errorEvidence`,
      ),
      elapsedMs: cloudReplacementReportNumberValue(
        measurement.elapsedMs,
        `concurrency[${index}].elapsedMs`,
      ),
      throughputPerSecond: cloudReplacementReportNumberValue(
        measurement.throughputPerSecond,
        `concurrency[${index}].throughputPerSecond`,
      ),
    })),
    indexBuildAndStorage: {
      rdf3x: normalizeCloudReplacementIndexBuildAndStorage(
        report.indexBuildAndStorage.rdf3x,
        'indexBuildAndStorage.rdf3x',
      ),
      qlever: normalizeCloudReplacementIndexBuildAndStorage(
        report.indexBuildAndStorage.qlever,
        'indexBuildAndStorage.qlever',
      ),
    },
    resourceDiagnostics: {
      rdf3x: normalizeCloudReplacementDiagnostics(
        report.resourceDiagnostics.rdf3x,
        'resourceDiagnostics.rdf3x',
      ),
      qlever: normalizeCloudReplacementDiagnostics(
        report.resourceDiagnostics.qlever,
        'resourceDiagnostics.qlever',
      ),
    },
    decision: decideCloudReplacement(report.decision.observed),
  };
  assertCloudReplacementReportHasNoCredentialText(normalized);
  return normalized;
}

function normalizeCloudReplacementReportEnvironment(
  environment: CloudReplacementEnvironment,
): CloudReplacementEnvironment {
  if (!environment || typeof environment !== 'object') {
    throw new Error('Cloud replacement report environment must contain only sanitized fields');
  }
  const expected = [ 'database', 'engineCommit', 'postgresVersion' ];
  const actual = Object.keys(environment).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Cloud replacement report environment must contain only sanitized fields');
  }
  return {
    database: cloudReplacementReportText(environment.database, 'environment.database'),
    postgresVersion: cloudReplacementReportText(
      environment.postgresVersion,
      'environment.postgresVersion',
    ),
    engineCommit: cloudReplacementReportText(environment.engineCommit, 'environment.engineCommit'),
  };
}

function normalizeCloudReplacementReportEngineCase(
  result: CloudReplacementReportEngineCase,
  path: string,
): CloudReplacementReportEngineCase {
  return {
    fallbackReason: result.fallbackReason === null
      ? null
      : cloudReplacementReportText(result.fallbackReason, `${path}.fallbackReason`),
    coldMs: cloudReplacementReportNumberValue(result.coldMs, `${path}.coldMs`),
    p50Ms: cloudReplacementReportNumberValue(result.p50Ms, `${path}.p50Ms`),
    p95Ms: cloudReplacementReportNumberValue(result.p95Ms, `${path}.p95Ms`),
    p99Ms: cloudReplacementReportNumberValue(result.p99Ms, `${path}.p99Ms`),
  };
}

function normalizeCloudReplacementIndexBuildAndStorage(
  metric: CloudReplacementIndexBuildAndStorage,
  path: string,
): CloudReplacementIndexBuildAndStorage {
  return {
    buildMs: cloudReplacementReportNumberValue(metric.buildMs, `${path}.buildMs`),
    storageBytes: cloudReplacementReportInteger(metric.storageBytes, `${path}.storageBytes`),
  };
}

function normalizeCloudReplacementDiagnostics(
  diagnostics: CloudReplacementPgDiagnostics,
  path: string,
): CloudReplacementPgDiagnostics {
  return {
    sharedBlocksRead: cloudReplacementNullableReportNumberValue(
      diagnostics.sharedBlocksRead,
      `${path}.sharedBlocksRead`,
    ),
    sharedBlocksHit: cloudReplacementNullableReportNumberValue(
      diagnostics.sharedBlocksHit,
      `${path}.sharedBlocksHit`,
    ),
    tempBytes: cloudReplacementNullableReportNumberValue(
      diagnostics.tempBytes,
      `${path}.tempBytes`,
    ),
    memoryPeakBytes: cloudReplacementNullableReportNumberValue(
      diagnostics.memoryPeakBytes,
      `${path}.memoryPeakBytes`,
    ),
    memoryLimitBytes: cloudReplacementNullableReportNumberValue(
      diagnostics.memoryLimitBytes,
      `${path}.memoryLimitBytes`,
    ),
    diagnosticsUnavailable: cloudReplacementReportStrings(
      diagnostics.diagnosticsUnavailable,
      `${path}.diagnosticsUnavailable`,
    ),
  };
}

function normalizeCloudReplacementErrorEvidence(
  evidence: CloudReplacementErrorEvidence,
  path: string,
): CloudReplacementErrorEvidence {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error(`Cloud replacement report ${path} must be an object`);
  }
  const counts = evidence.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error(`Cloud replacement report ${path}.counts must contain every error category`);
  }
  const normalizedCounts = Object.fromEntries(CLOUD_REPLACEMENT_ERROR_CATEGORIES.map((category) => [
    category,
    cloudReplacementReportInteger(
      (counts as Record<string, unknown>)[category] as number,
      `${path}.counts.${category}`,
    ),
  ])) as Record<CloudReplacementErrorCategory, number>;
  const countKeys = Object.keys(counts).sort();
  if (countKeys.length !== CLOUD_REPLACEMENT_ERROR_CATEGORIES.length ||
    countKeys.some((key) => !isCloudReplacementErrorCategory(key))) {
    throw new Error(`Cloud replacement report ${path}.counts must contain only known error categories`);
  }
  if (!Array.isArray(evidence.samples)) {
    throw new Error(`Cloud replacement report ${path}.samples must be an array`);
  }
  return {
    counts: normalizedCounts,
    samples: evidence.samples.map((sample, index) =>
      normalizeCloudReplacementErrorSample(sample, `${path}.samples[${index}]`)),
  };
}

function normalizeCloudReplacementErrorSample(
  sample: CloudReplacementErrorSample,
  path: string,
): CloudReplacementErrorSample {
  if (!sample || typeof sample !== 'object') {
    throw new Error(`Cloud replacement report ${path} must be an object`);
  }
  return {
    category: cloudReplacementReportErrorCategory(sample.category, `${path}.category`),
    stage: cloudReplacementReportErrorStage(sample.stage, `${path}.stage`),
    name: cloudReplacementReportText(sample.name, `${path}.name`),
    code: sample.code === null ? null : cloudReplacementReportText(sample.code, `${path}.code`),
    message: cloudReplacementReportText(sample.message, `${path}.message`),
    firstSeenAt: cloudReplacementReportIsoTimestamp(sample.firstSeenAt, `${path}.firstSeenAt`),
    lastSeenAt: cloudReplacementReportIsoTimestamp(sample.lastSeenAt, `${path}.lastSeenAt`),
    count: cloudReplacementReportInteger(sample.count, `${path}.count`),
    workloadId: cloudReplacementReportText(sample.workloadId, `${path}.workloadId`),
    engine: cloudReplacementReportEngine(sample.engine),
    cacheMode: cloudReplacementReportCacheMode(sample.cacheMode, `${path}.cacheMode`),
    concurrency: cloudReplacementReportConcurrency(sample.concurrency),
  };
}

function cloudReplacementReportGroup(value: CloudReplacementWorkloadGroup): CloudReplacementWorkloadGroup {
  if (![ 'short', 'large', 'authorization' ].includes(value)) {
    throw new Error(`Invalid Cloud replacement report workload group: ${value}`);
  }
  return value;
}

function cloudReplacementReportEngine(value: CloudReplacementEngineId): CloudReplacementEngineId {
  if (value !== 'rdf3x' && value !== 'qlever') {
    throw new Error(`Invalid Cloud replacement report engine: ${value}`);
  }
  return value;
}

function cloudReplacementReportConcurrency(value: 1 | 8 | 32): 1 | 8 | 32 {
  if (value !== 1 && value !== 8 && value !== 32) {
    throw new Error(`Invalid Cloud replacement report concurrency: ${value}`);
  }
  return value;
}

function cloudReplacementReportCacheMode(
  value: CloudReplacementCacheMode,
  path: string,
): CloudReplacementCacheMode {
  if (value !== 'off' && value !== 'production') {
    throw new Error(`Invalid Cloud replacement report ${path}: ${value}`);
  }
  return value;
}

function cloudReplacementReportErrorCategory(
  value: CloudReplacementErrorCategory,
  path: string,
): CloudReplacementErrorCategory {
  if (!isCloudReplacementErrorCategory(value)) {
    throw new Error(`Invalid Cloud replacement report ${path}: ${value}`);
  }
  return value;
}

function cloudReplacementReportErrorStage(
  value: CloudReplacementErrorStage,
  path: string,
): CloudReplacementErrorStage {
  if (!isCloudReplacementErrorStage(value)) {
    throw new Error(`Invalid Cloud replacement report ${path}: ${value}`);
  }
  return value;
}

function cloudReplacementReportBoolean(value: boolean, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Cloud replacement report ${path} must be boolean`);
  }
  return value;
}

function cloudReplacementReportIsoTimestamp(value: string, path: string): string {
  const text = cloudReplacementReportText(value, path);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`Cloud replacement ${path} must be an ISO timestamp`);
  }
  return text;
}

function cloudReplacementReportText(value: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cloud replacement report ${path} must be a non-empty string`);
  }
  return value;
}

function cloudReplacementReportStrings(value: string[], path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Cloud replacement report ${path} must be an array`);
  }
  return value.map((entry, index) =>
    cloudReplacementReportText(entry, `${path}[${index}]`));
}

function cloudReplacementReportNumberValue(value: number, path: string): number {
  assertCloudReplacementFiniteNonNegative(value, `report ${path}`);
  return value;
}

function cloudReplacementReportInteger(value: number, path: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Cloud replacement report ${path} must be a non-negative integer`);
  }
  return cloudReplacementReportNumberValue(value, path);
}

function cloudReplacementNullableReportNumberValue(
  value: number | null,
  path: string,
): number | null {
  return value === null ? null : cloudReplacementReportNumberValue(value, path);
}

function assertCloudReplacementReportHasNoCredentialKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertCloudReplacementReportHasNoCredentialKeys);
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [ key, entry ] of Object.entries(value)) {
    if (cloudReplacementCredentialKey(key)) {
      throw new Error('Cloud replacement report contains credential fields');
    }
    assertCloudReplacementReportHasNoCredentialKeys(entry);
  }
}

function cloudReplacementCredentialKey(key: string): boolean {
  return /^(?:connectionString|host|hostname|user|username|password|passwd|authorization|token|secret|credential|credentials|query|hash)$/iu.test(key) ||
    /(?:^|[_-])(?:token|secret|key)s?$/iu.test(key) ||
    /(?:Token|Secret|Key)s?$/u.test(key);
}

function cloudReplacementCredentialAssignmentKey(key: string): boolean {
  return /^(?:password|passwd|token|secret|credentials?|access[_-]?token|refresh[_-]?token|(?:client|private|api)[_-]?(?:secret|key)|secret[_-]?key)$/iu.test(key);
}

function cloudReplacementTextHasCredentialAssignment(value: string): boolean {
  const assignments = value.matchAll(
    /(?:^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*\S+/gu,
  );
  return Array.from(assignments).some((match) =>
    cloudReplacementCredentialAssignmentKey(match[1] ?? ''));
}

function assertCloudReplacementReportHasNoCredentialText(value: unknown): void {
  if (typeof value === 'string') {
    const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@/iu;
    const bearerHeader = /\bauthorization\s*:\s*bearer\s+\S+/iu;
    const postgresUrl = /\bpostgres(?:ql)?:\/\//iu;
    if (credentialUrl.test(value) || bearerHeader.test(value) || postgresUrl.test(value) ||
      cloudReplacementTextHasCredentialAssignment(value)) {
      throw new Error('Cloud replacement report contains credential-bearing text');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertCloudReplacementReportHasNoCredentialText);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(assertCloudReplacementReportHasNoCredentialText);
  }
}

function cloudReplacementGateRows(decision: CloudReplacementDecision): string[] {
  const observed: Record<keyof CloudReplacementDecisionPassed, string> = {
    correctness: String(decision.observed.correctnessPassed),
    criticalShortP95: decision.observed.criticalShortP95Ratios.join(', '),
    weightedP95: String(decision.observed.weightedP95Ratio),
    throughput: String(decision.observed.throughputRatio),
    aggregatePerformance: `p95=${decision.observed.weightedP95Ratio}, throughput=${decision.observed.throughputRatio}`,
    largeCases: decision.observed.largeCaseSpeedups.join(', '),
    errorRate: String(decision.observed.errorRate),
    memoryLimit: String(decision.observed.memoryLimitRatio),
    tempDiskLimit: String(decision.observed.tempDiskLimitRatio),
    resources: `memory=${decision.observed.memoryLimitRatio}, temp=${decision.observed.tempDiskLimitRatio}`,
    all: '-',
  };
  const threshold: Record<keyof CloudReplacementDecisionPassed, string> = {
    correctness: 'true',
    criticalShortP95: `non-empty; each <= ${CLOUD_REPLACEMENT_THRESHOLDS.maxCriticalShortP95Ratio}`,
    weightedP95: `<= ${CLOUD_REPLACEMENT_THRESHOLDS.maxWeightedP95Ratio}`,
    throughput: `>= ${CLOUD_REPLACEMENT_THRESHOLDS.minThroughputRatio}`,
    aggregatePerformance: 'weightedP95 OR throughput',
    largeCases: `>= ${CLOUD_REPLACEMENT_THRESHOLDS.minLargeWinningCases} at ` +
      `>= ${CLOUD_REPLACEMENT_THRESHOLDS.minLargeCaseSpeedup}x`,
    errorRate: `<= ${CLOUD_REPLACEMENT_THRESHOLDS.maxErrorRate}`,
    memoryLimit: `non-null; <= ${CLOUD_REPLACEMENT_THRESHOLDS.maxMemoryLimitRatio}`,
    tempDiskLimit: `non-null; <= ${CLOUD_REPLACEMENT_THRESHOLDS.maxTempDiskLimitRatio}`,
    resources: 'memoryLimit AND tempDiskLimit',
    all: 'all replacement gates',
  };
  return (Object.keys(decision.passed) as Array<keyof CloudReplacementDecisionPassed>)
    .map((gate) => `| ${gate} | ${decision.passed[gate] ? 'pass' : 'fail'} | ` +
      `${cloudReplacementMarkdownText(observed[gate])} | ` +
      `${cloudReplacementMarkdownText(threshold[gate])} |`);
}

function cloudReplacementReportNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 12 });
}

function cloudReplacementNullableReportNumber(value: number | null): string {
  return value === null ? 'unknown' : cloudReplacementReportNumber(value);
}

function cloudReplacementMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\r\n]+/gu, ' ');
}

const SPARQL_PREFIXES = [
  'PREFIX sioc: <http://rdfs.org/sioc/ns#>',
  'PREFIX dct: <http://purl.org/dc/terms/>',
  'PREFIX udfs: <https://undefineds.co/ns#>',
  'PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>',
  'PREFIX ai: <https://vocab.xpod.dev/ai#>',
].join('\n');

const QUERY_BODIES = {
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
  'authorization-inherited-prefix': 'SELECT ?g ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'authorization-explicit-allow': 'SELECT ?g1 ?g2 ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'authorization-explicit-deny': 'SELECT ?g (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?g ORDER BY ?g',
  'authorization-scoped-broad-join': 'SELECT ?g ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
} as const;

function query(body: string): string {
  return `${SPARQL_PREFIXES}\n${body}`;
}

function benchmarkQuad(subject: string, predicate: string, object: string, graph: string): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    DataFactory.namedNode(object),
    DataFactory.namedNode(graph),
  );
}

export function buildCloudReplacementTopology(podCount: number): Quad[] {
  const quads: Quad[] = [];
  for (let podIndex = 0; podIndex < Math.max(1, Math.floor(podCount)); podIndex += 1) {
    const pod = rdfModelsSyntheticPodIri(podIndex);
    const data = `${pod}/.data`;
    const graph = `${data}/chat/default/index.ttl`;
    const chat = `${graph}#this`;
    const workspaceGraph = `${data}/workspaces/default/index.ttl`;
    const workspace = `${workspaceGraph}#this`;
    const owner = `${pod}/profile/card#me`;
    const provider = `${pod}/settings/providers/benchmark.ttl`;
    const model = `${provider}#benchmark-model`;
    const capability = `${provider}#capability-agent`;
    const category = 'urn:xpod-benchmark:category:agent';

    for (let threadIndex = 0; threadIndex < RDF_MODELS_SYNTHETIC_THREAD_COUNT; threadIndex += 1) {
      quads.push(DataFactory.quad(
        DataFactory.namedNode(`${graph}#thread_${threadIndex + 1}`),
        DataFactory.namedNode('http://rdfs.org/sioc/ns#has_parent'),
        DataFactory.namedNode(chat),
        DataFactory.namedNode(graph),
      ));
    }
    quads.push(
      benchmarkQuad(chat, 'https://undefineds.co/ns#workspace', workspace, graph),
      benchmarkQuad(workspace, 'https://undefineds.co/ns#owner', owner, workspaceGraph),
      benchmarkQuad(owner, 'https://undefineds.co/ns#provider', provider, provider),
      benchmarkQuad(provider, 'https://vocab.xpod.dev/ai#hasModel', model, provider),
      benchmarkQuad(model, 'https://undefineds.co/ns#capability', capability, provider),
      benchmarkQuad(capability, 'https://undefineds.co/ns#category', category, provider),
    );
  }
  return quads;
}

export function cloudReplacementWorkloads(): CloudReplacementWorkload[] {
  const aliceChatPrefix = 'https://pod.example/alice/.data/chat/';
  const aliceChatIndex = `${aliceChatPrefix}default/index.ttl`;
  const dayOne = `${aliceChatPrefix}default/2026/05/01/messages.ttl`;
  const deniedDay = `${aliceChatPrefix}default/2026/05/05/messages.ttl`;
  const authorizationScopes: RdfAccessScope[] = [
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      version: 'inherited-prefix',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      allowedGraphUrls: [ dayOne, aliceChatIndex ],
      version: 'explicit-allow',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      deniedGraphUrls: [ deniedDay ],
      version: 'explicit-deny',
    },
    {
      basePath: aliceChatPrefix,
      mode: RdfAccessMode.READ,
      principal: 'urn:xpod-benchmark:alice',
      deniedGraphPrefixes: [ `${aliceChatPrefix}default/2026/05/05/` ],
      version: 'scoped-broad-join',
    },
  ];

  return [
    {
      id: 'point-lookup',
      group: 'short',
      purpose: 'Measure a selective message property lookup.',
      sparql: query(QUERY_BODIES['point-lookup']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'subject-star',
      group: 'short',
      purpose: 'Measure full property expansion for one message.',
      sparql: query(QUERY_BODIES['subject-star']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      expectedRows: 9,
    },
    {
      id: 'latest-message',
      group: 'short',
      purpose: 'Measure latest-message retrieval for one thread.',
      sparql: query(QUERY_BODIES['latest-message']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'keyset-page',
      group: 'short',
      purpose: 'Measure an ordered keyset page over message ranks.',
      sparql: query(QUERY_BODIES['keyset-page']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      expectedRows: 50,
    },
    {
      id: 'exact-graph',
      group: 'short',
      purpose: 'Measure message lookup within one exact graph.',
      sparql: query(QUERY_BODIES['exact-graph']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'selective-po',
      group: 'short',
      purpose: 'Measure a selective predicate-object conjunction.',
      sparql: query(QUERY_BODIES['selective-po']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'two-hop-chain',
      group: 'large',
      purpose: 'Measure the message-to-thread-to-chat relationship chain.',
      sparql: query(QUERY_BODIES['two-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'four-hop-chain',
      group: 'large',
      purpose: 'Measure the message-to-owner relationship chain.',
      sparql: query(QUERY_BODIES['four-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      minRows: 1,
    },
    {
      id: 'eight-hop-chain',
      group: 'large',
      purpose: 'Measure the full message-to-capability-category chain.',
      sparql: query(QUERY_BODIES['eight-hop-chain']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      minRows: 1,
    },
    {
      id: 'message-star',
      group: 'large',
      purpose: 'Measure a broad multi-property message star.',
      sparql: query(QUERY_BODIES['message-star']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'message-snowflake',
      group: 'large',
      purpose: 'Measure a message and thread snowflake join.',
      sparql: query(QUERY_BODIES['message-snowflake']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'bounded-many-to-many',
      group: 'large',
      purpose: 'Measure a bounded many-to-many thread join.',
      sparql: query(QUERY_BODIES['bounded-many-to-many']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'low-selectivity-filter',
      group: 'large',
      purpose: 'Measure a low-selectivity score filter.',
      sparql: query(QUERY_BODIES['low-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'medium-selectivity-filter',
      group: 'large',
      purpose: 'Measure a medium-selectivity score filter.',
      sparql: query(QUERY_BODIES['medium-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'high-selectivity-filter',
      group: 'large',
      purpose: 'Measure a high-selectivity score filter.',
      sparql: query(QUERY_BODIES['high-selectivity-filter']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'count-distinct-threads',
      group: 'large',
      purpose: 'Measure a distinct thread aggregate over messages.',
      sparql: query(QUERY_BODIES['count-distinct-threads']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: true,
      expectedRows: 1,
    },
    {
      id: 'ordered-top-k',
      group: 'large',
      purpose: 'Measure ordered top-k message retrieval.',
      sparql: query(QUERY_BODIES['ordered-top-k']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      expectedRows: 100,
    },
    {
      id: 'optional-content',
      group: 'large',
      purpose: 'Measure optional message content expansion.',
      sparql: query(QUERY_BODIES['optional-content']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'union-status-score',
      group: 'large',
      purpose: 'Measure a union across status and score access paths.',
      sparql: query(QUERY_BODIES['union-status-score']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'top-thread-aggregate',
      group: 'large',
      purpose: 'Measure grouped and stably ordered thread counts.',
      sparql: query(QUERY_BODIES['top-thread-aggregate']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      minRows: 1,
    },
    {
      id: 'authorization-inherited-prefix',
      group: 'authorization',
      purpose: 'Measure an inherited-prefix scope on the message star workload.',
      sparql: query(QUERY_BODIES['authorization-inherited-prefix']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
      accessScope: authorizationScopes[0],
      authorizationGraphVariables: [ 'g' ],
    },
    {
      id: 'authorization-explicit-allow',
      group: 'authorization',
      purpose: 'Measure an explicit graph allow on the two-hop workload.',
      sparql: query(QUERY_BODIES['authorization-explicit-allow']),
      sharedSurface: true,
      orderSensitive: false,
      concurrencyRepresentative: false,
      minRows: 1,
      accessScope: authorizationScopes[1],
      authorizationGraphVariables: [ 'g1', 'g2' ],
    },
    {
      id: 'authorization-explicit-deny',
      group: 'authorization',
      purpose: 'Measure an explicit graph deny on the distinct-count workload.',
      sparql: query(QUERY_BODIES['authorization-explicit-deny']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: false,
      minRows: 1,
      accessScope: authorizationScopes[2],
      authorizationGraphVariables: [ 'g' ],
    },
    {
      id: 'authorization-scoped-broad-join',
      group: 'authorization',
      purpose: 'Measure a denied-prefix scope on the ordered broad workload.',
      sparql: query(QUERY_BODIES['authorization-scoped-broad-join']),
      sharedSurface: true,
      orderSensitive: true,
      concurrencyRepresentative: true,
      expectedRows: 100,
      accessScope: authorizationScopes[3],
      authorizationGraphVariables: [ 'g' ],
    },
  ];
}
