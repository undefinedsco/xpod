# Full-text Index V2 P3 Implementation Report

> Related spec: [`2026-06-23-full-text-index-v2-p3-fusion-planner-design.md`](./2026-06-23-full-text-index-v2-p3-fusion-planner-design.md)
> Related plan: [`../plans/2026-06-23-full-text-index-v2-p3-fusion-planner.md`](../plans/2026-06-23-full-text-index-v2-p3-fusion-planner.md)

## Status

P3 acceptance-gate behavior is implemented for the current planner-visible fusion subset and product-scale synthetic benchmark gate. This report records the remaining backend/product limits explicitly; it is not a completion claim for a full cost-based planner or a QLever-equivalent engine.

## Implemented P3 behavior

- Query plans expose planner-visible candidate sources for text and vector inputs:
  - `TextMatchSource(...)`
  - `VectorMatchSource(...)`
  - `SourceEstimate(...)`
- Text and vector scopes expose hard filters in the physical plan:
  - `PathScopeSource(...)`
  - `AclScopeSource(...)`
- Path and authorization scope sources also expose planner estimates:
  - `SourceEstimate(PathScopeSource#...)`
  - `SourceEstimate(AclScopeSource#...)`
- `applyRdfAccessScope(...)` applies `basePath` to graph patterns, text candidates, and vector candidates even when no explicit allow/deny graph list exists.
- Base-path-only authorization is visible as `AclScopeSource(base-path:...)`, so authorization constraints are not hidden inside generic path-prefix filters.
- Text and vector candidate plans expose bounded-source behavior:
  - `TopKPushdown(...)`
  - `PerSourceCap(...)`
  - `NoTsFullMaterialize(TextSearch)` where applicable.
- PostgreSQL facts queries now choose required RDF/text/vector sources with a conservative adaptive planner:
  - source-local windowed text/vector searches run before RDF BGP scans.
  - non-windowed text/vector searches can also run before RDF scans when their index cardinality estimate is smaller than the RDF pattern estimate.
  - after each source runs, the remaining sources are re-ranked against current bindings, connectedness, and estimated rows.
  - plans expose `PostgresPlannerSourceChoice(...)` with candidate priority, connectedness, input rows, estimated source rows, estimated output rows, and cost rows, so source choice is auditable instead of inferred from final operator order.
- Fusion query plans expose rank inputs and weights:
  - `FusionRankInputs(...)`
  - `FusionRankWeights(...)`
  - `FusionRankTieBreaker(...)`
- Fusion query plans now require hard path and authorization filtering before final fused ranking:
  - `FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)`
- `FusionHardFiltersBeforeRank(...)` is emitted only when the fused output variable is the primary `orderBy` rank key. A text/vector score `BIND` without final fused ranking, or with another primary sort key, still reports inputs and weights but not the hard-filter-before-rank invariant.
- PostgreSQL facts/fusion execution now batches broad bound-source joins:
  - large bound-source vector joins use one global candidate read plus source-key bucketing instead of one exact-source vector lookup per candidate.
  - RDF BGP joins with many bindings for the same variable use one `$in` fact scan plus binding-bucket rejoin instead of one graph-prefix membership scan per candidate.
  - plans expose these paths as `PostgresFactsSearchBatchSource(...)` and `PostgresFactsBatchScan(...)`.
- Local and PostgreSQL/PGlite query tests cover the high-risk case where an unauthorized text/vector candidate has a higher fused score than an authorized candidate. The query returns only the authorized candidate and reports `FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)`.
- The models benchmark gate for `fusion-hard-filters-before-rank` now checks for both `path` and `acl`, not only path.
- Benchmark reports expose storage/index-build cost fields through `performanceCosts.storageOverhead` and `performanceCosts.indexBuild` when the benchmark path performs refresh/index-build work.
- PostgreSQL models benchmark reports now include `servingRegressionGate` for the default serving profile:
  - every default query benchmark case is listed with plan, rows, scan count, and p95 duration evidence.
  - failures are promoted into `failedPlanCases` as `serving-regression:<case>`.
  - broad `PostgresFactsQuery` fallback fails the gate for normal serving cases.
  - numeric aggregate facts cutover is allowed only when the query case explicitly expects numeric aggregate execution.
  - explicit `servingRegressionThresholds` can enforce `maxScannedRows` and `maxP95DurationMs`; thresholds are not enabled by default.
- PostgreSQL models benchmark reports now include `fusionBenchmarkGate` for the fusion profile:
  - every fusion query benchmark case is listed with candidate source, estimate, rank, row, scan count, and p95 duration evidence.
  - failures are promoted into `failedPlanCases` as `fusion:<case>`.
  - the gate requires `TextMatchSource`, `VectorMatchSource`, `RdfBgpSource`, `PathScopeSource`, and `AclScopeSource` visibility; focused planner tests also cover `ValuesSource` source ordering.
  - the gate requires `SourceEstimate(...)` and `PostgresPlannerSourceChoice(...)` entries, fusion rank inputs/weights/tie-breaker, hard path/ACL filtering before rank, and no result-cache masking.
  - broad candidate rows are reported as `broadCandidateRows`; if they exceed
    the exact-source lookup threshold, missing
    `PostgresFactsSearchBatchSource(...)` / `PostgresFactsBatchScan(...)`
    evidence fails the gate as `missing-batched-broad-candidate-join`.
  - explicit `fusionBenchmarkThresholds` can enforce `maxScannedRows` and `maxP95DurationMs`; thresholds are not enabled by default.
  - explicit `fusionBenchmarkBaselines` can attach P0/P1/P2 physical-source baseline rows/duration by case name; regressions are reported as `baseline-scanned-rows-regression` or `baseline-p95-regression`.
- `scripts/rdf-postgres-models-benchmark.ts` accepts `--benchmarkGateConfig=PATH` so real benchmark runs can load:
  - `servingRegressionThresholds`
  - `fusionBenchmarkThresholds`
  - `fusionBenchmarkBaselines`
- `scripts/rdf-postgres-models-benchmark.ts` also accepts `--benchmarkGateBaselineReport=PATH` to derive fusion baselines from a prior benchmark report artifact instead of hand-writing p95/scanned-row numbers. It uses `report.fusionBenchmarkGate.cases[*].name` to select fusion cases and copies matching `report.queryCases[*].p95DurationMs` / `scannedRows` into the current run's baseline comparisons.
- `--caseProfile=all` now produces one combined release-evidence report:
  - default serving query cases feed `servingRegressionGate`.
  - fusion query cases feed `fusionBenchmarkGate`.
  - fusion search/vector indexes and broad synthetic fusion RDF facts are seeded for the combined profile.
  - `--benchmarkGateBaselineReport` can attach baseline comparisons to the fusion subset in the same report.
- Benchmark report catalog and release-gate checks now surface and optionally require:
  - `servingRegressionGate`
  - `fusionBenchmarkGate`
  - fusion baseline comparisons embedded in `fusionBenchmarkGate.cases[*].baselineComparison`
- `scripts/assert-rdf-benchmark-report-gate.ts` accepts:
  - `--requireServingRegressionGate`
  - `--requireFusionBenchmarkGate`
  - `--requireFusionBaselineComparison`
  - `--strictP3FusionGate`, which requires `caseProfile=all`, at least 3
    measured iterations, at least 1 warmup iteration, configured
    serving/fusion thresholds, and all three checks above together.
- The fusion profile now contains two workload shapes:
  - a focused context query that returns the two strongest text/vector matches.
  - a broad synthetic context query with scale-aware matching search sources and a top-10 fused result window.
    - small: 32 text/vector candidates.
    - medium: 256 text/vector candidates.
    - large: 4096 text/vector candidates.

## Current benchmark boundary

The current P3 benchmark is a synthetic fusion profile with both focused and broad candidate workloads. It verifies that the benchmark report itself contains the expected candidate-source, estimate, hard-filter, and fusion-rank evidence. Product-scale PostgreSQL validation now exercises the release gate on 1M target quads, but this remains a planner/fusion benchmark artifact, not a claim that P3 is a full cost-based QLever-equivalent engine.

Smoke validation has exercised the real benchmark/report/gate CLI path with a small PGlite fusion run:

```bash
bun scripts/rdf-postgres-models-benchmark.ts \
  --driver=pglite \
  --scale=small \
  --caseProfile=fusion \
  --iterations=1 \
  --warmupIterations=0 \
  --concurrency=1 \
  --out=.test-data/rdf-engine/p3-smoke

bun scripts/assert-rdf-benchmark-report-gate.ts \
  --root=.test-data/rdf-engine/p3-smoke \
  --scale=small \
  --driver=pglite \
  --minTargetQuads=48 \
  --minSeedQuads=700 \
  --minConcurrency=1 \
  --noCopyIngest
```

The same smoke report correctly fails `--strictP3FusionGate` because no real P0/P1/P2 fusion baseline comparison was supplied. That failure is expected and protects the P3 cutover boundary.

A follow-up smoke run used `--benchmarkGateBaselineReport` against the previous smoke report. The report artifact was parsed and baseline comparisons were attached, but the run correctly failed the fusion gate because p95 was slower than the baseline. This proves the artifact-based baseline path is wired and does not silently pass regressions.

Medium-scale smoke validation has also exercised the scale-aware broad workload:

```bash
bun scripts/rdf-postgres-models-benchmark.ts \
  --driver=pglite \
  --scale=medium \
  --caseProfile=fusion \
  --iterations=1 \
  --warmupIterations=0 \
  --concurrency=1 \
  --out=.test-data/rdf-engine/p3-medium-smoke
```

The broad fusion case reported `SourceEstimate(TextMatchSource#0 rows:256 ...)` and `SourceEstimate(VectorMatchSource#0 rows:256 ...)`, so P3 no longer tests only the fixed 32-candidate small workload.

Large synthetic candidate smoke validation now exercises the 4096-candidate path:

```bash
bun scripts/rdf-postgres-models-benchmark.ts \
  --driver=pglite \
  --scale=large \
  --targetQuads=50000 \
  --caseProfile=fusion \
  --iterations=1 \
  --warmupIterations=0 \
  --concurrency=1 \
  --out=.test-data/rdf-engine/p3-large-candidate-smoke-fixed2
```

The broad fusion case completed without timing out. Evidence from the generated report:

- seed quads: 78,686.
- broad candidates: 4096 text and 4096 vector matches.
- broad case p95: 254 ms in the latest gated smoke run.
- broad case scanned rows: 20,483 in the batch-join smoke report.
- fusion gate `broadCandidateRows`: 4099.
- fusion gate `batchedBroadCandidateJoin`: true.
- broad plan length: 42 entries.
- `Rdf3xMembershipScan`: 3 entries, not one scan per candidate.
- batch markers:
  - `PostgresFactsSearchBatchSource(VectorSearch ?message:4096)`.
  - `PostgresFactsBatchScan(?message:4096)` for the three RDF BGP joins.

This proves the previous 4096-candidate timeout path was an execution-shape bug, not an unavoidable PGlite limit.

The large smoke report also passes the non-strict fusion report gate, including
the broad-candidate batch marker check:

```bash
bun scripts/assert-rdf-benchmark-report-gate.ts \
  --root=.test-data/rdf-engine/p3-large-candidate-smoke-fixed2 \
  --scale=large \
  --driver=pglite \
  --minTargetQuads=50000 \
  --minSeedQuads=78000 \
  --minConcurrency=1 \
  --noCopyIngest \
  --requireFusionBenchmarkGate
```

Strict P3 release-gate smoke now requires the combined `all` profile and an
auditable prior report as the threshold/baseline source:

```bash
bun scripts/rdf-postgres-models-benchmark.ts \
  --driver=pglite \
  --scale=small \
  --caseProfile=all \
  --iterations=3 \
  --warmupIterations=1 \
  --concurrency=1 \
  --benchmarkGateConfigFromReport=.test-data/rdf-engine/p3-all-stable-threshold-strict-smoke/models-postgres-*.json \
  --out=.test-data/rdf-engine/p3-all-config-source-strict-smoke

bun scripts/assert-rdf-benchmark-report-gate.ts \
  --root=.test-data/rdf-engine/p3-all-config-source-strict-smoke \
  --scale=small \
  --driver=pglite \
  --minTargetQuads=48 \
  --minSeedQuads=700 \
  --minConcurrency=1 \
  --noCopyIngest \
  --strictP3FusionGate
```

The generated strict-smoke report contains:

- `iterations: 3`.
- `warmupIterations: 1`.
- serving and fusion thresholds configured.
- `servingRegressionGate.enabled: true` with 44 serving cases.
- `fusionBenchmarkGate.enabled: true` with 2 fusion cases.
- baseline comparisons on both fusion cases.
- `seed.benchmarkGateConfigSources` with the report-derived config source.
- no failed plan cases.

The strict gate intentionally rejects fusion-only reports even when their fusion
gate passes, because those reports do not prove serving-query regression safety
in the same artifact. The expected failure includes
`caseProfile expected all, got fusion`.

The strict gate also rejects 1-iteration / 0-warmup smoke reports and reports
without serving/fusion thresholds. Those are useful for quick wiring checks, but
not for release evidence because p95 comparisons are too noisy and unbounded
latency/scan regressions would be invisible.

Threshold configuration can now be generated from a prior benchmark report via
`--benchmarkGateConfigFromReport=PATH`. This derives per-case serving and fusion
thresholds from the report's gate cases and reuses the same report as the fusion
baseline source. This keeps release gates tied to measured case shape instead of
one broad global threshold.

The generated baseline entries preserve the original `scannedRows` and
`p95DurationMs` for comparison telemetry, and add calibrated `maxScannedRows`
and `maxP95DurationMs` pass/fail limits. The current calibration is `1.25x` for
scan counts and `max(1.25x, +25ms)` for p95 duration.
Generated benchmark reports also record `seed.benchmarkGateConfigSources`, so a
release artifact can be audited back to the explicit config file, prior
report-derived config, or baseline report used for thresholds.
When `--benchmarkGateConfigFromReport=PATH` is used and the source report
records seed shape metadata, the benchmark CLI rejects mismatched driver, scale,
target quads, or case profile. This prevents the failure mode where a smaller
smoke artifact calibrates thresholds for a larger release target. The report
catalog/gate repeats that check when reading existing artifacts through
`seed.benchmarkGateConfigSources[*].seed`, so hand-edited or older reports cannot
silently bypass shape provenance checks. Report-derived sources without seed
shape are treated as unauditable for strict release evidence. Both
`--benchmarkGateConfigFromReport=PATH` and `--benchmarkGateBaselineReport=PATH`
record source seed shape when the source report provides it.
`--strictP3FusionGate` now requires those gate config sources to be present in
the report summary. A strict report without source provenance for its thresholds
or baselines is rejected even if the numeric serving/fusion gates pass. Strict
mode also requires the fusion baseline source to be report-derived
(`report-config` or `baseline-report`), so an explicit hand-written config alone
cannot satisfy release baseline provenance. The report-derived baseline source
must also carry `rdfAccelerationProfile=baseline`, so strict release evidence
proves comparison against the RDF3X baseline profile. Product-scale release
validation should use `--productP3FusionGate`, which includes large PostgreSQL
scale requirements and batched broad-candidate join evidence. The small strict
smoke does not enable the batched evidence requirement because its broad
candidate count can stay below the batching threshold.

A large synthetic `--scale=large --caseProfile=all` run against PGlite reached
1,037,906 seeded quads and 20,483 scanned rows for the broad fusion case. It
proved the large candidate path still emits hard path/ACL filters before fused
ranking and uses batched broad candidate joins, but it was not release evidence:
the run used a 50k-quads calibration source against a 1M-quads target and
correctly failed the strict gates.

Product-scale PostgreSQL validation has since been run with same-shape
calibration:

1. Baseline artifact:
   `.test-data/rdf-engine/p3-product-pg-baseline-20/models-postgres-2026-06-27T16-32-15-585Z-27336-f01ed322-058b-490a-ab85-0abaa218d94a.json`.
2. Product gate artifact:
   `.test-data/rdf-engine/p3-product-pg-strict-20-from-baseline-20/models-postgres-2026-06-27T16-41-32-022Z-32778-977147aa-c244-4210-9b4e-36133e93b4e1.json`.
3. Gate command:

   ```bash
   bun scripts/assert-rdf-benchmark-report-gate.ts \
     --root=.test-data/rdf-engine/p3-product-pg-strict-20-from-baseline-20 \
     --productP3FusionGate
   ```

4. Gate result:
   - matched: true.
   - driver/scale/profile: `pg` / `large` / `all`.
   - seed/target quads: 1,037,906 / 1,000,000.
   - measured iterations / warmups / concurrency: 20 / 2 / 4.
   - serving gate: 49 cases matched with thresholds.
   - fusion gate: 2 cases matched with thresholds and baseline comparison.
   - focused fusion p95: 2,135 ms vs baseline 2,179 ms.
   - broad fusion p95: 2,005 ms vs baseline 2,472 ms.
   - broad candidates: 4,099 rows with batched broad-candidate join evidence.
   - storage total/facts ratio: 1.811.

The first product-scale attempt used a 3-iteration baseline and failed on p95
noise despite unchanged scan counts. The accepted release artifact therefore
uses a 20-iteration baseline and a 20-iteration strict run. This keeps the gate
strict without changing product code or weakening thresholds.

The required benchmark shape remains:

- broad text/vector candidates.
- RDF/path/ACL hard filters before final rank.
- top-k after hard filters.
- fusion benchmark gate with candidate-source, estimate, and rank evidence.
- optional baseline comparison against caller-provided P0/P1/P2 physical-source measurements.
- serving-query regression gate against RDF3X serving-path expectations.
- storage overhead and index-build cost reporting.

`--productP3FusionGate` proves the P3 logical planner boundary. It is not by
itself a completion gate for a full QLever-like planner because it can pass with
the postings text backend. The stricter `--productQLeverLikePlannerGate` is now
the native-search gate shape: it includes the product P3 requirements and also
requires `textSearchBackend=pg-native-fts` plus `PostgresNativeFts(...)` plan
evidence and `PostgresNativeVector(...)` plan evidence. PostgreSQL fusion
benchmark construction also routes vector search to the PostgreSQL vector index
when `--driver=pg`, so native-text/native-vector/RDF fusion can be measured in
one product-scale run instead of mixing PG RDF facts with an in-memory vector
side index.

Full native-search validation has since passed the product-scale gate. The
latest current-state rerun was performed after the pgvector ANN candidate
tie-breaker fix, so the baseline and hot artifacts below are from the same
current code revision:

1. Native baseline artifact:
   `.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/baseline-20/models-postgres-2026-06-28T20-45-11-857Z-5169-3fd6c4a3-8788-42cb-a372-6ef675b10d2f.json`.
2. QLever-like planner artifact:
   `.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/hot-20-from-current-baseline/models-postgres-2026-06-28T20-54-35-285Z-8244-acaf818a-6b43-4b43-b6ca-4d655c248243.json`.
3. Gate command:

   ```bash
   bun scripts/assert-rdf-benchmark-report-gate.ts \
     --root=.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/hot-20-from-current-baseline \
     --productQLeverLikePlannerGate
   ```

4. Gate result:
   - matched: true.
   - driver/scale/profile: `pg` / `large` / `all`.
   - RDF acceleration profile: `pg-hot-operators`.
   - text backend: `pg-native-fts`.
   - seed/target quads: 1,037,906 / 1,000,000.
   - measured iterations / warmups / concurrency: 20 / 2 / 4.
   - serving gate: matched, 49 cases.
   - fusion gate: matched, 2 cases.
   - native FTS and native vector plan evidence: present.
   - broad fusion p95: 1,974 ms vs native baseline 1,801 ms, scanned rows unchanged at 1,600.
   - broad candidate rows: 320 with batched broad-candidate join evidence.
   - warm steady query p50/p95: 41 / 53 ms.
   - storage total/facts ratio: 1.700.

The vector candidate window is deterministic in the current run: pgvector ANN
orders equal-distance rows by `(distance, source.id, chunk.ordinal)`. This keeps
text and vector candidate windows aligned under tied synthetic vectors and
prevents broad fusion from dropping all rows before final ranking.

The multi-step source-choice lookahead is also bounded in the current run.
Planner markers expose `lookahead:full` for fully explored suffixes and
`lookahead:bounded` when the source count exceeds the configured depth/width
guard. Beyond that guard the planner uses a greedy suffix estimate instead of
enumerating all source permutations, so large required-source lists cannot
degrade into factorial planning work.

The release gate now records report-derived `maxDurationMs` outlier ceilings in
addition to p95 thresholds. This is intentionally narrow: p95 is still enforced
unless plan, scan count, and p50 remain healthy and the observed max duration is
within the baseline-derived checkpoint/outlier allowance. This prevents local
PostgreSQL WAL checkpoint spikes from being mistaken for planner regressions
while still failing central-latency or scan/plan regressions.

## Backend limitations

- P3 currently exposes QLever-style planner evidence and partial source integration; it is not a native QLever backend.
- Source ordering is adaptive and marker-visible, with a bounded multi-step
  suffix-cost model for join fanout. PostgreSQL currently uses connectedness,
  text/vector index cardinality, bound-source estimates, RDF pattern estimates,
  disconnected cross-product output estimates, and future fanout cost for
  required-source ordering. `VALUES` sources are now part of the same PostgreSQL
  required-source planner instead of being forced before text/vector/RDF sources.
  Planner markers now expose row cost plus first-pass CPU and IO cost dimensions
  for each candidate. It is still not a full native QLever optimizer: full
  statistics-driven join distribution modeling and calibrated CPU/IO weights are
  not yet implemented.
- Text ranking in the QLever-like product artifact uses PostgreSQL native FTS
  (`PostgresNativeFts(...)`) rather than the postings backend.
- Vector retrieval is integrated as a PostgreSQL vector candidate source in the
  QLever-like product artifact (`PostgresNativeVector(...)`).
- Fusion scoring is explicit in the plan, but product ranking weights still need workload-driven tuning.

## Acceptance gate audit

| Gate | Current evidence | Status |
| --- | --- | --- |
| Benchmarks show improvement or bounded non-regression over physical-source baselines for broad search + RDF/path/ACL filter + top-k workloads. | Fusion benchmark gate accepts caller-provided baseline rows and p95 duration and fails on baseline regressions. Product-scale PostgreSQL `--productQLeverLikePlannerGate` now passes against a same-shape current-code 20-iteration native FTS/vector baseline report; broad fusion was 1,974 ms p95 vs 1,801 ms baseline with unchanged 1,600 scanned rows and batched broad-candidate join evidence. | Covered for the current synthetic product-scale native-search gate; real workload ranking weights still need product tuning. |
| Planner metrics identify which sources ran, why a source was chosen, which filters were pushed down, and where top-k was applied. | Fusion benchmark cases assert `TextMatchSource`, `VectorMatchSource`, `RdfBgpSource`, `PathScopeSource`, `AclScopeSource`, `SourceEstimate(...)`, `PostgresPlannerSourceChoice(...)`, `TopKPushdown(...)`, and final `PostgresFactsLimit`/sort evidence. Focused planner tests additionally assert `ValuesSource` participates in cost-based ordering against selective text sources and that planner choices expose `cpu:` / `io:` cost dimensions. | Covered by focused planner/benchmark tests. |
| No planner path bypasses authorization filtering before final ranking. | Local and PostgreSQL tests include unauthorized higher-score candidates and require `FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)` before returning top-k results. Product-scale `--productP3FusionGate` also requires fusion hard-filter evidence together with broad-candidate batching evidence. | Covered by focused query tests and product-scale gate evidence. |
| Serving-query regressions are caught by benchmark gates. | `servingRegressionGate` summarizes serving cases, supports scanned-row/p95 thresholds, and release-gate checks can require it. `--caseProfile=all` now emits serving and fusion gates in one report, and `--strictP3FusionGate` passes against the combined smoke artifact when a fusion baseline report is supplied. | Covered by benchmark report/gate tests and strict smoke. |
| Storage overhead and index-build cost are reported with performance results via `performanceCosts`. | Fusion benchmark report tests assert `performanceCosts.storageOverhead` and `performanceCosts.indexBuild` and cross-check them against storage and refresh benchmark fields. | Covered by focused benchmark tests. |

## Required follow-up after the native-search product gate

- Keep the 20-iteration product gate artifact as the minimum release evidence shape; 3-iteration p95 is too noisy for this gate.
- Run the same gate on real user/workspace datasets once representative fixtures exist. Current evidence is product-scale synthetic data.
- Tune product ranking weights with real retrieval-quality benchmarks; current fusion weights are explicit and measurable, not product-final.
- Calibrate default CI/runtime thresholds before default cutover. Threshold enforcement exists, but release evidence still uses explicit benchmark artifacts.
- Continue comparing against the RDF3X serving-query baseline when changing planner, text, vector, path, or ACL logic.
