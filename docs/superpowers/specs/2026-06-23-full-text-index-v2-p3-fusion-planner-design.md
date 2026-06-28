# Full-text Index V2 P3 Design — Product-grade Fusion Planner

> Parent: [`Full-text Index V2 Design Overview`](2026-06-23-full-text-index-v2-design.md).
> Implementation plan: [`P3 Product-grade Fusion Planner`](../plans/2026-06-23-full-text-index-v2-p3-fusion-planner.md).
> Implementation report: [`P3 Implementation Report`](./2026-06-23-full-text-index-v2-p3-implementation-report.md).

## Goal

Absorb QLever-style planner ideas after P0/P1/P2 physical sources are correct: make text, vector, RDF, path, and authorization constraints planner-visible, reorderable where safe, and measurable through benchmarks.

QLever is an algorithmic reference here, not a product dependency or public protocol requirement.

## Scope

P3 includes:

- planner-visible `TextMatchSource`, `VectorMatchSource`, `RdfBgpSource`, `PathScopeSource`, `AclScopeSource`, and entity-field sources.
- estimates for candidate count, selectivity, cost, and top-k behavior.
- safe source reordering.
- per-source/per-entity caps before final top-k.
- explicit ranking and fusion components.
- benchmark gates for fusion workloads and serving-query regressions.

P3 excludes:

- replacing authority storage.
- exposing public QLever/SPARQL+Text syntax by default.
- shipping LEANN-like vector storage before correctness and benchmark coverage exist.

## Candidate sources

Planner-visible sources:

- `TextMatchSource`: FTS/BM25/token/posting candidates.
- `VectorMatchSource`: embedding/vector candidates.
- `RdfBgpSource`: RDF fact-pattern constraints.
- `PathScopeSource`: workspace/path/source-tree constraints.
- `AclScopeSource`: authorization allowed/denied scope constraints.
- entity-field sources: exact field/predicate filters and field-level rank signals.

Each source exposes:

- estimated candidate count.
- selectivity.
- physical cost.
- supported pushdowns.
- source-local top-k behavior.
- authorization requirements.

Implementation note:

- Existing `TextSearch(...)` and `VectorSearch(...)` plan entries remain for
  compatibility with benchmark gates and older tests.
- P3 planner visibility also requires explicit `TextMatchSource(...)` and
  `VectorMatchSource(...)` entries so source identity is not inferred from the
  physical operator name.
- `PathScopeSource(...)` and `AclScopeSource(...)` must be emitted for both text
  and vector candidate sources when their scope carries path or authorization
  constraints.
- `SourceEstimate(...)` entries expose the planner's current estimate for each
  candidate source in a mixed RDF/text/vector query. At minimum they include
  source kind, estimated rows, estimated cost rows, approximate selectivity,
  source-local top-k behavior, and whether the source is connected to current
  bindings.
- The local query executor emits estimates from its source-choice planner. The
  PostgreSQL facts/fusion fallback emits the same shape from observed candidate
  counts so benchmark gates can verify source visibility before a full PG
  cost-based fusion planner exists.

## Reordering policy

Rules:

- Highly selective RDF/path/ACL constraints may run before text/vector.
- Narrow text/vector sources may run before RDF joins.
- Authorization filtering must happen before final ranking.
- Query-level top-k and source-local top-k must be reported separately. Source
  windows are reported as `TopKPushdown(TextSearch ...)` or
  `TopKPushdown(VectorSearch ...)`; query-level windows remain ordinary query
  `Limit` or backend join-limit markers.
- Unsupported pushdowns are visible in plan output, not silently ignored.

P3 should not make every operator globally reorderable on day one. It should add reorderability only where benchmarks prove value and tests can enforce correctness.

## Ranking and fusion

Rank components are explicit:

- BM25/proximity.
- field weights.
- title/name/label boost.
- path/folder weak signal.
- vector score.
- source-kind weight.
- freshness where product needs it.
- stable tie-breaker.

Rules:

- Hard ACL/path constraints are filters, not soft boosts.
- Path/title boost cannot override authorization or structural path scope.
- Fusion plans expose hard path/ACL filters that are applied before final rank,
  for example `FusionHardFiltersBeforeRank(path,acl,output:?fusionScore)`.
- Result explanation should include score components where useful.
- Fusion rank plans must expose the concrete score variables and derived output
  variable, for example
  `FusionRankInputs(text:?textScore,vector:?vectorScore,output:?fusionScore)`.
- Simple weighted-add fusion plans also expose the parsed weights, for example
  `FusionRankWeights(text:0.55,vector:0.45,output:?fusionScore)`. More complex
  formulas remain represented by the `Bind(...)` expression until they have a
  dedicated explanation shape.
- Ranking must be deterministic for equal scores. Fusion plans expose explicit
  secondary sort keys when present, for example
  `FusionRankTieBreaker(asc:?message)`.

## QLever-style boundary

For Xpod, QLever-style value is planner integration, not adopting a separate external index by default.

Useful ideas to absorb:

- text/vector candidates enter the RDF planner instead of being post-filtered in TypeScript.
- candidate counts and selectivity influence join order.
- top-k is applied as early as correctness allows.
- text/rank operators expose enough statistics for planning.
- broad candidate joins are batched by planner-visible source keys instead of
  degenerating into one RDF or vector lookup per candidate.
- benchmark profiles cover large candidate sets, RDF/path/ACL filters, and final top-k ranking.

P0/P1/P2 physical-source baselines remain valid. P3 only becomes default when benchmark gates show improvement without serving-query regressions. Baselines should come from prior benchmark report artifacts when possible, not hand-written p95/scanned-row values.
Release validation should use the strict P3 gate (`--strictP3FusionGate`) so serving regression, fusion benchmark, and fusion baseline evidence are required together.
Thresholds should be case-specific when they are derived from benchmark artifacts. A global p95/scanned-row limit is acceptable for quick smoke runs, but release evidence should calibrate serving and fusion limits from a prior report so slow or broad cases do not hide behind thresholds meant for narrow cases.

## Benchmark profile

Benchmarks are split by workload type.

Serving profile:

- chat/task/message/run/profile/provider/model/credential queries.
- small to medium result sets.
- latency-sensitive app paths.

Fusion profile:

- broad text search plus RDF/path/ACL filters.
- vector + FTS candidate fusion.
- top-k after hard filters.
- large candidate sets where post-filtering would be expensive.

Stress profile:

- high fanout joins.
- large text hit sets.
- multiple joins plus ranking.
- storage overhead and index-build time.

Benchmark reports expose these costs through `performanceCosts`:

- `storageOverhead`: facts bytes, derived/index bytes, total bytes, and ratios.
- `indexBuild`: refresh/index-build duration and planner-stat/rebuild metadata when available.
- `coldStart`: startup duration when lifecycle data is available.

Compare against:

- P0/P1/P2 physical-source baseline.
- RDF3X serving-query baseline.
- optional QLever-like/native experiments only when implemented.

Release benchmark configuration should support two inputs:

- explicit JSON thresholds/baselines for hand-tuned gates.
- prior benchmark report artifacts that derive per-case serving/fusion thresholds and fusion baselines from measured p95/scanned-row values.

Report-derived calibration keeps scanned-row limits tight (`1.25x`) because
scan counts should be stable. p95 duration limits include a small absolute
jitter budget (`max(1.25x, +25ms)`) because small PGlite/local smoke runs can
otherwise fail on harmless millisecond-level variance. The original baseline
measurement must still be preserved for delta/ratio reporting; calibrated
limits are only pass/fail bounds.
Report-derived calibration must match the benchmark shape when the source
artifact records it: driver, scale, target quads, and case profile. A config
derived from a 50k-quads smoke report must not silently gate a 1M-quads release
run. The check applies both when generating a benchmark from a report-derived
config and when the report gate audits an existing artifact. A report-derived
source without seed shape is not sufficient for strict release evidence because
the gate cannot prove it matches the current benchmark shape.
Strict release validation must also require auditable gate configuration
sources. Thresholds and baselines are not enough by themselves; the report must
show whether those values came from an explicit config, a report-derived config,
or a baseline report. Fusion baseline evidence specifically must be
report-derived (`report-config` or `baseline-report`), not only hand-written
inside an explicit config file. That report-derived baseline source must also
record `rdfAccelerationProfile=baseline`, which is the RDF3X baseline profile
used for release comparison. Product-scale release validation should use
`--productP3FusionGate`, which adds large PostgreSQL scale requirements and
batched broad-candidate join evidence. Small smoke runs should use
`--strictP3FusionGate`; they can stay below the broad-candidate batching
threshold and therefore do not prove the product-scale batching path.

## Future tokenizer/ranking extensions

After P0 correctness is stable, P3 may add:

- Japanese and Thai no-space behavior.
- emoji boundaries.
- URL tokens.
- camelCase and snake_case optional splitting.
- phrase/proximity ranking.
- cross-source fusion.
- freshness and product-specific weights.
- anti-keyword-stuffing behavior.

These are not P0 requirements unless explicitly pulled forward by failing product cases.

## Acceptance gate

P3 is complete only when all of these are true:

- Benchmarks show improvement over P0/P1/P2 physical-source baselines for broad search + RDF/path/ACL filter + top-k workloads.
- Planner metrics identify which sources ran, which filters were pushed down, and where top-k was applied.
- No planner path bypasses authorization filtering before final ranking.
- Serving-query regressions are caught by benchmark gates.
- Storage overhead and index-build cost are reported with performance results via `performanceCosts`.
