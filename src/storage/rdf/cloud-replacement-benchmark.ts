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

export interface CloudReplacementConcurrency {
  cacheMode: CloudReplacementCacheMode;
  concurrency: 1 | 8 | 32;
  durationMs: number;
  elapsedMs: number;
  completed: number;
  errors: number;
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
  } & CloudReplacementCacheMeasurementOptions,
): Promise<CloudReplacementConcurrency> {
  const { cacheMode, concurrency, durationMs } = options;
  if (!Number.isFinite(durationMs)) {
    throw new Error('Cloud replacement durationMs must be finite');
  }
  const operationTimeoutMs = cloudReplacementOperationTimeout(options.operationTimeoutMs);
  const identitySource = cloudReplacementIdentitySource(cacheMode, options.identitySource);
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
    throughputPerSecond: 0,
  });
  if (durationMs <= 0) {
    return emptyResult();
  }

  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let completed = 0;
  let errors = 0;

  const worker = async (): Promise<void> => {
    while (now() < deadline) {
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
        } else {
          errors += 1;
        }
      } catch {
        errors += 1;
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
    throughputPerSecond: completed / (elapsedMs / 1_000),
  };
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
