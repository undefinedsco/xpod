# RDF Benchmark Error Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 2M RDF3X/QLever benchmark produce transport-isolated, resumable, classified error evidence, then use one cluster-direct run to establish a trustworthy RDF3X baseline before diagnosing QLever.

**Architecture:** Keep the existing benchmark runner and shared workload suite. Add a versioned execution context to checkpoints, collect bounded error evidence in the existing concurrency helper, separate infrastructure failures from engine failures, and checkpoint every workload/concurrency cell. Engine changes are gated on a cluster-direct reproducer so infrastructure failures never trigger speculative RDF engine edits.

**Tech Stack:** TypeScript, Bun test runner, PostgreSQL 17, existing RDF3X/QLever adapters, SealOS Kubernetes.

---

## File map

- Modify `src/storage/rdf/cloud-replacement-benchmark.ts` — define concurrency error evidence, classify/redact failures, and stop sustained connection-error loops.
- Modify `tests/storage/rdf/CloudReplacementBenchmark.test.ts` — lock classification, redaction, bounded samples, backoff, breaker, and engine/infrastructure counters.
- Modify `scripts/native-rdf3x-benchmark.ts` — add execution context, checkpoint v2, database identity, per-cell resume, and engine-only error-rate gates.
- Modify `tests/native/NativeRdf3xBenchmarkScript.test.ts` — lock CLI context, checkpoint isolation, per-cell keys, report semantics, and credential redaction.
- Modify `docs/rdf-cloud-engine-benchmark.md` — document direct versus port-forward evidence, new report fields, and the cluster rerun command.
- Generate only under `.test-data/rdf-engine-perf-reports/` — one-time SealOS evidence; do not commit raw credentials or cluster addresses.

### Task 1: Version checkpoints by execution and database identity

**Files:**
- Modify: `tests/native/NativeRdf3xBenchmarkScript.test.ts`
- Modify: `scripts/native-rdf3x-benchmark.ts`

- [ ] **Step 1: Add failing CLI and checkpoint-context tests**

Add tests that assert:

```ts
expect(() => benchmark.parseArgs([
  '--mode=external',
  '--targetQuads=2000000',
  '--executionLocation=cluster',
], { XPOD_RDF_BENCHMARK_PG_URL: dedicatedUrl }))
  .toThrow(/transport/iu);

const direct = benchmark.benchmarkExecutionContext({
  location: 'cluster',
  transport: 'direct',
  databaseIdentity: 'pg-system-a:xpod_benchmark',
});
const forwarded = { ...direct, transport: 'port-forward' as const };

const checkpoint = benchmark.emptyBenchmarkCheckpoint(options, direct, 'identity-a');
await benchmark.saveBenchmarkCheckpoint(options, checkpoint);
expect(await benchmark.loadBenchmarkCheckpoint(options, direct)).toEqual(checkpoint);
expect((await benchmark.loadBenchmarkCheckpoint(options, forwarded))?.concurrencyRecords)
  .toEqual([]);
```

Also assert that changing only concurrency lanes preserves matching latency evidence but clears concurrency evidence, and changing `databaseIdentity` clears both evidence sets.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts --run --timeout=300000
```

Expected: FAIL because execution-location/transport options, `BenchmarkExecutionContext`, and checkpoint v2 do not exist.

- [ ] **Step 3: Implement the minimal execution context and checkpoint v2**

Add these contracts in `scripts/native-rdf3x-benchmark.ts`:

```ts
export type BenchmarkExecutionLocation = 'local' | 'cluster';
export type BenchmarkTransport = 'direct' | 'port-forward';

export interface BenchmarkExecutionContext {
  location: BenchmarkExecutionLocation;
  transport: BenchmarkTransport;
  databaseIdentity: string;
  runnerIdentity: 'native-rdf3x-benchmark-v2';
  engineCommit: string;
  workloadIds: string[];
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
}
```

For external mode, require both `--executionLocation=local|cluster` and `--transport=direct|port-forward`; local mode derives `local/direct`. Query `pg_control_system().system_identifier` plus `current_database()`, hash that non-secret tuple with SHA-256, and pass it into `loadBenchmarkCheckpoint` only after the control pool is connected. The latency fingerprint includes latency iterations/warmup; the concurrency fingerprint includes lanes and `CONCURRENCY_DURATION_MS`; both include the execution context, target facts, cache modes, timeout, and workload IDs.

When loading checkpoint v2:

- reject malformed/version-1 files;
- retain latency/correctness only when the latency fingerprint matches;
- retain concurrency/diagnostics only when the concurrency fingerprint matches;
- clear all records when database identity, location, transport, runner identity, engine commit, or workload IDs differ.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts --run --timeout=300000
```

Expected: PASS with checkpoint v2 refusing port-forward/direct and database-instance contamination.

- [ ] **Step 5: Commit only Task 1 files**

```bash
git add scripts/native-rdf3x-benchmark.ts tests/native/NativeRdf3xBenchmarkScript.test.ts
git commit -m "🛡️ Keep RDF benchmark evidence inside one execution context" \
  -m "Checkpoint latency and concurrency evidence independently while binding both to a non-secret PostgreSQL instance identity, runner version, transport, and location.

Constraint: Port-forward evidence must never be resumed by a cluster-direct runner.
Rejected: Hash only CLI options | the same options can target a different PostgreSQL instance or transport.
Confidence: high
Scope-risk: narrow
Tested: NativeRdf3xBenchmarkScript focused tests
Not-tested: SealOS cluster identity query"
```

### Task 2: Classify and redact bounded concurrency error evidence

**Files:**
- Modify: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`
- Modify: `tests/native/NativeRdf3xBenchmarkScript.test.ts`
- Modify: `scripts/native-rdf3x-benchmark.ts`

- [ ] **Step 1: Add failing classification and redaction tests**

Cover all public categories and stages:

```ts
expect(classifyCloudReplacementBenchmarkError(
  Object.assign(new Error('connect ECONNRESET 10.0.0.8:5432'), { code: 'ECONNRESET' }),
)).toMatchObject({ category: 'connection', stage: 'acquire' });

expect(classifyCloudReplacementBenchmarkError(
  new DOMException('operation timed out', 'TimeoutError'),
)).toMatchObject({ category: 'timeout', stage: 'query' });

expect(classifyCloudReplacementBenchmarkError(
  new DOMException('cancelled', 'AbortError'),
)).toMatchObject({ category: 'cancelled', stage: 'cancel' });
```

Make one adapter throw five copies of a message containing a PostgreSQL URL, password, and Pod IP. Assert the result keeps count `5`, at most three samples, and no sample contains `postgres://`, the password, or the IP.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run --timeout=300000
```

Expected: FAIL because concurrency results expose only one undifferentiated `errors` count.

- [ ] **Step 3: Add the error-evidence contracts and structural classifier**

Define:

```ts
export type CloudReplacementErrorCategory =
  | 'timeout' | 'connection' | 'cancelled' | 'engine' | 'correctness' | 'unknown';
export type CloudReplacementErrorStage =
  | 'acquire' | 'query' | 'materialize' | 'cancel' | 'cleanup';

export interface CloudReplacementErrorSample {
  category: CloudReplacementErrorCategory;
  stage: CloudReplacementErrorStage;
  name: string;
  code: string | null;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface CloudReplacementErrorEvidence {
  counts: Record<CloudReplacementErrorCategory, number>;
  samples: CloudReplacementErrorSample[];
}
```

Extend `CloudReplacementConcurrency` with `infrastructureErrors`, `infrastructureFailure`, and `errorEvidence`; keep `errors` as engine-boundary errors only. Classify nested `cause` values, PostgreSQL SQLSTATE `08*` and Node connection codes as `connection`, `TimeoutError`/statement timeout as `timeout`, and `AbortError` as `cancelled`. Unknown thrown failures after adapter entry are `engine`. Limit samples globally to three per category, merge identical `(category, stage, name, code, redacted message)` values, cap messages at 240 characters, and redact URLs, userinfo, IP/port pairs, credentials, and control characters.

Update `BenchmarkEngineExecutionError` to carry the stage at which `createCloudReplacementAdapter` failed. Set `query` before `queryBindings`, `materialize` before stream materialization, and preserve `cancel` for aborted operations.

- [ ] **Step 4: Run both focused suites and verify GREEN**

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts \
  tests/native/NativeRdf3xBenchmarkScript.test.ts --run --timeout=300000
```

Expected: PASS; no error sample contains test credentials or IP addresses.

- [ ] **Step 5: Commit only Task 2 files**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts \
  scripts/native-rdf3x-benchmark.ts \
  tests/native/NativeRdf3xBenchmarkScript.test.ts
git commit -m "🔎 Attribute RDF benchmark failures without leaking endpoints" \
  -m "Preserve bounded failure categories and execution stages so infrastructure faults are distinguishable from RDF engine defects.

Constraint: Reports must retain diagnostic value without storing connection URLs, credentials, Pod IPs, or user data.
Rejected: Persist raw exceptions | unsafe and unbounded.
Confidence: high
Scope-risk: moderate
Tested: CloudReplacementBenchmark and NativeRdf3xBenchmarkScript focused tests
Not-tested: Live PostgreSQL driver error variants"
```

### Task 3: Back off and break sustained connection failures

**Files:**
- Modify: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`

- [ ] **Step 1: Add failing backoff and circuit-breaker tests**

Inject a deterministic `sleep` function and assert:

```ts
const sleeps: number[] = [];
const result = await measureCloudReplacementConcurrency(workload, disconnectingAdapter, {
  concurrency: 1,
  durationMs: 60_000,
  operationTimeoutMs: 1_000,
  cacheMode: 'production',
  connectionBackoffMs: 100,
  maxConsecutiveConnectionErrors: 3,
  sleep: async (ms) => { sleeps.push(ms); },
});

expect(result).toMatchObject({
  completed: 0,
  errors: 0,
  infrastructureErrors: 3,
  infrastructureFailure: true,
});
expect(sleeps).toEqual([ 100, 100 ]);
```

Add a second test where one connection error is followed by success; the breaker must reset and not stop the workload. Preserve the existing test that ordinary engine failures continue until the deadline.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run --timeout=300000
```

Expected: FAIL because the worker currently retries every failure immediately.

- [ ] **Step 3: Implement connection-only backoff and shared breaker**

Add optional test seams to the existing options object:

```ts
sleep?: (ms: number) => Promise<void>;
connectionBackoffMs?: number;
maxConsecutiveConnectionErrors?: number;
```

Default to 100ms and three consecutive connection failures. Reset the shared streak after a completed operation. On a connection failure, increment `infrastructureErrors`, record evidence, sleep only while below the threshold, and stop all workers once the threshold is reached. Timeout, cancellation, fallback, engine, correctness, and unknown errors do not trigger the connection breaker and remain engine-boundary evidence.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run --timeout=300000
```

Expected: PASS; sustained disconnection ends after three samples instead of generating an error flood.

- [ ] **Step 5: Commit Task 3 files**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts
git commit -m "🧯 Stop disconnected RDF benchmarks from manufacturing failures" \
  -m "Back off connection failures and stop the affected concurrency cell after a bounded sustained outage while leaving engine failures measurable.

Constraint: Infrastructure failures must not enter the engine error-rate denominator.
Rejected: Back off every error | would distort legitimate engine throughput measurements.
Confidence: high
Scope-risk: narrow
Tested: CloudReplacementBenchmark focused tests
Not-tested: Kubernetes network partition timing"
```

### Task 4: Checkpoint each workload/concurrency cell and gate on engine errors only

**Files:**
- Modify: `tests/native/NativeRdf3xBenchmarkScript.test.ts`
- Modify: `scripts/native-rdf3x-benchmark.ts`
- Modify: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`

- [ ] **Step 1: Add failing per-cell resume and report tests**

Add a stable key assertion:

```ts
expect(benchmark.benchmarkConcurrencyKey(
  'production', 'rdf3x', 'latest-message-by-thread', 32,
)).toBe('production:rdf3x:latest-message-by-thread:32');
```

Seed a checkpoint containing only that key and record, then assert resume skips only that cell, not the other workloads or lanes. Build a report summary with 100 completed, two engine errors, and 50 infrastructure errors; assert engine error rate is `2 / 102`, infrastructure error rate is `50 / 152`, and `baselineValid` depends only on the engine error rate.

- [ ] **Step 2: Run both focused suites and verify RED**

Run:

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts --run --timeout=300000
```

Expected: FAIL because completion is stored at whole engine/cache-phase granularity and report normalization drops detailed evidence.

- [ ] **Step 3: Replace phase completion with per-cell completion**

Use `completedConcurrencyKeys`. For every representative workload and lane:

1. skip only an exact completed key;
2. snapshot PostgreSQL diagnostics around that cell;
3. append the result and merge diagnostics by summing counters, taking maxima for peaks, and de-duplicating unavailable reasons;
4. update checkpoint fields;
5. call the existing atomic `saveBenchmarkCheckpoint` immediately.

Do not save rows or full result digests in checkpoints.

- [ ] **Step 4: Preserve evidence in report normalization and gates**

Extend `CloudReplacementReportConcurrency` and its normalizer/renderer with `infrastructureErrors`, `infrastructureFailure`, and `errorEvidence`. Compute:

```ts
engineErrorRate = engineErrors / (completed + engineErrors);
infrastructureErrorRate = infrastructureErrors /
  (completed + engineErrors + infrastructureErrors);
```

Only `engineErrorRate` participates in replacement gates. A cell with `infrastructureFailure: true` makes the evidence batch incomplete and prevents a replacement recommendation; it does not make RDF3X appear incorrect.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts --run --timeout=300000
```

Expected: PASS with per-cell resume and separate engine/infrastructure rates.

- [ ] **Step 6: Commit Task 4 files**

```bash
git add scripts/native-rdf3x-benchmark.ts \
  tests/native/NativeRdf3xBenchmarkScript.test.ts \
  src/storage/rdf/cloud-replacement-benchmark.ts \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts
git commit -m "💾 Resume RDF evidence at the smallest measured cell" \
  -m "Persist each workload/concurrency result atomically and keep infrastructure outages out of engine replacement gates.

Constraint: OOM or runner restart must not force a completed engine phase to be remeasured.
Rejected: Save after each operation | excessive I/O and checkpoint growth.
Confidence: high
Scope-risk: moderate
Tested: Native and shared benchmark focused tests
Not-tested: Live runner restart during atomic rename"
```

### Task 5: Verify the benchmark harness and document the evidence boundary

**Files:**
- Modify: `docs/rdf-cloud-engine-benchmark.md`

- [ ] **Step 1: Update the operator documentation**

Document:

- external runs must declare `--executionLocation` and `--transport`;
- `port-forward` is diagnostic only and cannot be reused as cluster-direct evidence;
- checkpoint v2 uses a hashed PostgreSQL system/database identity;
- `errors` means engine-boundary errors and `infrastructureErrors` is reported separately;
- samples are bounded and redacted;
- the 2M decision run uses `cluster/direct`, concurrency `1,8,32`, and no 10M run.

- [ ] **Step 2: Run the complete local verification set**

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts \
  tests/native/NativeRdf3xBenchmarkScript.test.ts \
  tests/api/service/RdfBenchmarkReportGate.test.ts --run --timeout=300000
bun run build:ts
bun run test:integration
```

Expected: all commands exit 0. If `test:integration` fails from stale local credentials, refresh only the test fixture credentials described in `AGENTS.md`; do not weaken authentication assertions.

- [ ] **Step 3: Commit the documentation and any directly required gate-test updates**

```bash
git add docs/rdf-cloud-engine-benchmark.md tests/api/service/RdfBenchmarkReportGate.test.ts
git commit -m "📝 Define trustworthy RDF replacement evidence" \
  -m "Document transport isolation, bounded failure evidence, and the one-time cluster-direct 2M acceptance run.

Confidence: high
Scope-risk: narrow
Tested: benchmark unit suites, TypeScript build, integration suite
Not-tested: 2M SealOS run"
```

### Task 6: Establish the cluster-direct RDF3X baseline

**Files:**
- Generate: `.test-data/rdf-engine-perf-reports/sealos-rdf3x-baseline-2m.json`
- Create only if a genuine engine error exists: `docs/superpowers/specs/2026-07-18-rdf3x-<error-code>-design.md`
- Create only if a genuine engine error exists: `docs/superpowers/plans/2026-07-18-rdf3x-<error-code>.md`

- [ ] **Step 1: Deploy a disposable benchmark database and runner in SealOS CN**

Use `/Users/ganlu/develop/undefineds/config/kubeconfig.cn.yaml`, namespace `ns-iknkxtc8`, the already published RDF PostgreSQL image, a dedicated database ending in `_benchmark`, and an in-cluster runner using the same source commit. Do not use port-forward for measured operations. Mount a small PVC only for report/checkpoint survival; do not recreate the removed 10M resources.

- [ ] **Step 2: Run one cluster-direct 2M evidence pass**

Inside the runner:

```bash
bun scripts/native-rdf3x-benchmark.ts \
  --mode=external \
  --executionLocation=cluster \
  --transport=direct \
  --targetQuads=2000000 \
  --iterations=5 \
  --warmupIterations=1 \
  --concurrency=1,8,32 \
  --cacheMode=production \
  --operationTimeoutMs=30000 \
  --out=.test-data/rdf-engine-perf-reports/sealos-rdf3x-baseline-2m.json
```

Expected: no `infrastructureFailure`; every RDF3X non-zero engine error has a category, stage, code/name, and redacted sample.

- [ ] **Step 3: Apply the evidence gate before touching RDF3X**

Run a report assertion that fails unless:

```ts
rdf3xInfrastructureErrors === 0
&& rdf3xUnknownErrors === 0
&& everyRdf3xErrorHasSample
```

If `rdf3xEngineErrors === 0`, record RDF3X baseline accepted and do not modify the engine. If engine errors are non-zero, reduce one sampled `(workload, stage, code)` into a deterministic PostgreSQL integration test, write a focused design/plan named with that error code, implement the minimal fix with TDD, and rerun only that reproducer before repeating the same 2M report command from its per-cell checkpoint.

- [ ] **Step 4: Remove disposable SealOS resources after copying sanitized evidence**

Verify with `kubectl get pod,sts,svc,pvc,secret` that no benchmark-labelled resources remain. Keep only sanitized JSON under `.test-data`; do not commit database URLs, kubeconfig content, Pod IPs, or Secret manifests.

### Task 7: Diagnose and fix QLever on the accepted RDF3X baseline

**Files:**
- Create from observed evidence: `docs/superpowers/specs/2026-07-18-qlever-<failure-class>-design.md`
- Create from observed evidence: `docs/superpowers/plans/2026-07-18-qlever-<failure-class>.md`
- Modify only the QLever adapter/extension files named by the reproducer.
- Add focused tests next to the affected QLever adapter/extension test suite.

- [ ] **Step 1: Group QLever evidence in this order**

1. correctness: order, LIMIT/keyset, aggregate, ACL deny;
2. plan: missing binding pushdown, intermediate explosion, wrong join order;
3. lifecycle: acquire, query timeout, materialization, cancellation, cleanup.

Do not combine unrelated categories into one patch.

- [ ] **Step 2: Create one deterministic reproducer per observed failure class**

Use the exact existing workload SPARQL and the smallest fact subset that still fails. The test must execute the product QLever path and compare rows/digests against the accepted RDF3X baseline. Verify RED before implementation.

- [ ] **Step 3: Implement and review each focused QLever fix**

For each reproducer, follow its dedicated plan with `subagent-driven-development`: implement, run the focused test, run spec-compliance review, run code-quality review, and repeat until approved. Do not reintroduce a second durable GSPO store or bypass ACL/ACR pushdown.

- [ ] **Step 4: Rerun the same cluster-direct 2M command and publish the comparison**

Acceptance:

- RDF3X engine error rate remains zero;
- no infrastructure-failed cell enters the replacement decision;
- QLever correctness passes every shared workload;
- remaining QLever non-zero error rates are classified and reproducible;
- the report states whether QLever wins a measured large-data/concurrency region, rather than inferring from direct SQL.

- [ ] **Step 5: Run final repository verification**

Run:

```bash
bun run build:ts
bun run test:integration
git diff --check
git status --short
```

Expected: build and integration tests pass, `git diff --check` is clean, and only intentional files are staged or committed.
