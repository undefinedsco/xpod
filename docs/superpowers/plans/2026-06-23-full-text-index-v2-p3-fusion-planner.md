# Full-text Index V2 P3 Plan — Product-grade Fusion Planner

> Parent spec: [`../specs/2026-06-23-full-text-index-v2-p3-fusion-planner-design.md`](../specs/2026-06-23-full-text-index-v2-p3-fusion-planner-design.md)
> Overview: [`../specs/2026-06-23-full-text-index-v2-design.md`](../specs/2026-06-23-full-text-index-v2-design.md)

## Goal

Absorb integrated-planner planner ideas after P0/P1/P2 physical sources are correct: make text, vector, RDF, path, and authorization constraints planner-visible, reorderable where safe, and measurable through benchmarks.

## Assumptions

- P0 text search is bounded and authorization-safe.
- P1 retrieval points and path/source indexes exist.
- P2 vector points exist and can be invalidated/rebuilt.
- external native planner remains an algorithmic reference unless a later benchmark proves an external/native backend is worth adopting.

## Deliverables

### 1. Candidate source abstraction

Represent these as planner-visible sources:

- `TextMatchSource`
- `VectorMatchSource`
- `RdfBgpSource`
- `PathScopeSource`
- `AclScopeSource`
- entity-field sources

Each source exposes:

- estimated candidate count.
- selectivity.
- physical cost.
- top-k behavior.
- supported pushdowns.
- authorization requirements.

Verify:

- Plan output identifies sources, filters, pushdowns, and top-k placement.
- Unsupported pushdowns are visible, not silently ignored.

### 2. Reordering and pushdown policy

Rules:

- Highly selective RDF/path/ACL constraints may run before text/vector.
- Narrow text/vector sources may run before RDF joins.
- Authorization filtering must happen before final ranking.
- Query-level top-k and source-local top-k must be reported separately.

Verify:

- Planner chooses RDF/path/ACL-first for selective filters.
- Planner chooses text/vector-first for narrow candidate queries.
- No plan path bypasses authorization before final rank.

### 3. Ranking and fusion

Make rank components explicit:

- BM25/proximity.
- field weights.
- title/name/label boost.
- path/folder weak signal.
- vector score.
- source-kind weight.
- freshness where product needs it.
- stable tie-breaker.

Verify:

- Result explanation includes score components.
- Fusion plan output includes hard path/ACL filters before final rank.
- Fusion plan output includes the text score variable, vector score variable,
  and fused output variable.
- Simple weighted-add fusion plan output includes the text/vector weights.
- Fusion plan output includes secondary sort keys when they are used as stable
  tie-breakers.
- Path/title boost cannot override hard ACL/path constraints.
- Ranking is deterministic for equal scores.

### 4. Benchmark gate

Add benchmark profiles separate from serving tests:

- serving queries: chat/task/message/run/profile/provider/model/credential.
- fusion queries: broad search + RDF/path/ACL filter + top-k.
- stress queries: high fanout, large text hit sets, multiple joins.

Compare against:

- P0/P1/P2 physical-source baseline.
- RDF3X serving-query baseline.
- optional native-planner/native experiments only when implemented.

Verify:

- P3 improves fusion workloads without regressing serving workloads beyond agreed thresholds.
- Benchmarks report storage overhead, index build time, and query latency.
- Benchmark report includes `performanceCosts.storageOverhead`.
- PostgreSQL benchmark report includes `performanceCosts.indexBuild` when a
  refresh/index-build pass ran.
- PostgreSQL fusion-profile benchmark report includes `fusionBenchmarkGate` with
  candidate-source visibility, source estimates, fusion rank evidence, and
  result-cache bypass checks.
- Fusion profile includes both focused and broad synthetic workloads. The broad
  workload is scale-aware: small indexes 32 matching search sources, medium 256,
  and large 4096, then verifies top-10 fusion through text/vector/RDF/path/ACL
  planner sources.
- PostgreSQL fusion execution batches large bound-source joins. Broad candidate
  search should not produce one vector lookup or one RDF graph-prefix membership
  scan per candidate; plans expose this with `PostgresFactsSearchBatchSource(...)`
  and `PostgresFactsBatchScan(...)`.
- PostgreSQL fusion gates expose `broadCandidateRows` and
  `batchedBroadCandidateJoin`. When broad candidate rows exceed the exact-source
  lookup threshold, missing batch markers fail the fusion gate with
  `missing-batched-broad-candidate-join`.
- PostgreSQL serving and fusion gates accept explicit `maxScannedRows` and
  `maxP95DurationMs` thresholds. Keep defaults unset until the benchmark
  environment has calibrated product thresholds.
- PostgreSQL fusion gates accept explicit `fusionBenchmarkBaselines` by case
  name. These compare p95 duration and scanned rows against caller-provided
  P0/P1/P2 physical-source baseline measurements and fail the gate on
  regressions.
- Release validation can require the whole P3 evidence bundle through
  `--strictP3FusionGate`, which requires `caseProfile=all`, at least 3 measured
  iterations, at least 1 warmup iteration, calibrated serving/fusion thresholds,
  auditable gate config sources, and serving-regression, fusion-benchmark, and
  fusion-baseline checks together. The fusion baseline source must be a report
  artifact source with `rdfAccelerationProfile=baseline`, not only an explicit
  hand-written config. Product-scale release runs should use
  `--productP3FusionGate`; small smoke runs may be below the broad-candidate
  batching threshold.
- `benchmark:rdf-models:pg` supports `--benchmarkGateConfig=PATH`, wiring the
  same thresholds and baselines into real benchmark runs.
- `benchmark:rdf-models:pg` also supports `--benchmarkGateBaselineReport=PATH`
  so the current P3 run can derive fusion baselines from a prior report artifact
  instead of relying on hand-written p95/scanned-row numbers.
- `benchmark:rdf-models:pg` supports `--benchmarkGateConfigFromReport=PATH` for
  strict-release setup: it derives per-case serving/fusion scanned-row and p95
  thresholds from the report's gate cases, and derives fusion baselines from the
  same artifact. Prefer this over global thresholds when building release
  evidence. Derived baselines keep the original p95/scanned-row measurements for
  delta/ratio reporting and attach calibrated `max*` limits for pass/fail.

## Out of scope

- Replacing authority storage.
- Exposing public external native planner/SPARQL+Text syntax by default.
- Shipping LEANN-like vector storage before correctness and benchmark coverage exist.

## Completion gate

P3 is complete only when:

1. Planner decisions are visible and testable.
2. Fusion benchmark shows concrete improvement over P0/P1/P2 baseline.
3. Serving-query regression gate passes.
4. Authorization-before-ranking invariant is enforced by tests.
