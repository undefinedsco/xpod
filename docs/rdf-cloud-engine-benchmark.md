# RDF3X/QLever Cloud replacement benchmark

## Purpose and decision boundary

`bun run benchmark:rdf-cloud-replacement` compares the current RDF3X baseline
and QLever product adapters over one deterministic PostgreSQL GSPO fact set. It
is a manual Cloud/PostgreSQL replacement experiment, not a Local/SQLite engine
decision.

- Local mode always records `executionLocation=local` and `transport=direct`.
  Local Docker runs at 20k, 100k, and 500k facts are reproducibility and
  diagnostic evidence only. They must not change a Cloud default.
- External mode requires explicit `--executionLocation=local|cluster` and
  `--transport=direct|port-forward`.
- Only an external `cluster` + `direct` run can support a Cloud replacement
  recommendation.
- `port-forward` is diagnostic evidence only. Do not use it as replacement
  decision evidence, and do not let it reuse a `cluster` + `direct` checkpoint.
- The current decision run is 2M facts with `--concurrency=1,8,32` and
  `--cacheMode=production`. This round does not run 10M.
- Historical planning discussed a 2M+10M evidence batch. Treat those statements
  as historical context, not the current decision requirement.
- Local/SQLite remains on RDF3X regardless of this report.
- The benchmark is not a CI, release-gate, or scheduled workload.

The runner loads facts once into `rdf_quads`. RDF3X
(`nativeSparqlEnabled: false`) and QLever (`nativeSparqlEnabled: true`) then use
the same `PostgresRdfEngine`/`SolidRdfSparqlEngine` product path and the same
facts. Compatibility fallback is disabled. Selected-engine metrics, normalized
bindings, authorization outcomes, and result digests must agree before timing
can support a recommendation.

Accept the RDF3X baseline first. A valid QLever analysis starts only after the
RDF3X baseline run has correct results, no fallback, and zero engine-boundary
errors. Direct SQL measurements, if collected separately, are lower-bound
diagnostics against PostgreSQL data. They are not RDF3X measurements and are
excluded from replacement gates.

No SealOS rerun result is recorded in this document. Add results only after the
external report exists and the evidence rules below pass.

## Prerequisites

- Bun and the repository dependencies are installed.
- Docker uses the `orbstack` context for local diagnostic runs.
- Local runs have the exact `xpod-rdf-postgres:pg17-smoke` image. The image must
  contain PostgreSQL 17 and report QLever native capability ABI `1` with
  `ready=true`.
- Report files stay under `.test-data/rdf-engine-perf-reports/`; they are local
  evidence and are not committed.

```bash
docker context show
docker image inspect xpod-rdf-postgres:pg17-smoke >/dev/null
bun run benchmark:rdf-cloud-replacement --help
bun run benchmark:rdf-cloud-replacement \
  --dry-run --mode=local --targetQuads=20000
```

The dry run prints the immutable methodology and sanitized safety plan. It does
not provision a database.

## Local commands

### Opt-in 20k product-path smoke

The integration module loads and typechecks on every normal test run, but it
starts Docker only when explicitly enabled:

```bash
bun test tests/integration/CloudReplacementBenchmark.integration.test.ts --run

XPOD_RUN_CLOUD_RDF_BENCHMARK_SMOKE=1 \
  bun test tests/integration/CloudReplacementBenchmark.integration.test.ts \
  --run --timeout=900000
```

The smoke uses the fixed PG17 image, loads at least 20,000 actual facts, and
requires every shared case to have matching digest summaries, correct results,
no RDF3X or QLever fallback, and `environment.qleverReady=true`. Smoke-only
iteration and cache selections keep this contract below the 900-second timeout;
they do not alter runner defaults.

### 100k and 500k diagnostic reports

Local mode does not accept an external connection URL. It automatically uses
`executionLocation=local` and `transport=direct`.

Do not reduce the declared iterations, warmups, concurrency lanes, or cache
modes when collecting these reports:

```bash
bun run benchmark:rdf-cloud-replacement \
  --mode=local --targetQuads=100000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/cloud-replacement-100k.json

bun run benchmark:rdf-cloud-replacement \
  --mode=local --targetQuads=500000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/cloud-replacement-500k.json
```

Run them sequentially so two containers do not compete for the same local CPU,
memory, and storage bandwidth. These reports characterize local behavior only.

## External Cloud commands and secret handling

External mode accepts a PostgreSQL URL from exactly one source:
`XPOD_RDF_BENCHMARK_PG_URL`. There is deliberately no connection-string CLI
option, so the secret is not placed in shell history or process arguments. Do
not repurpose `DATABASE_URL`, `CONNECTION_STRING`, or any application database
setting.

The runner automatically rejects external URLs whose decoded database name does
not end in `_benchmark`. Never point it at Xpod production, identity, billing,
gateway, Inngest, or any shared service database. The operator must still
confirm that the dedicated database runs PostgreSQL 17 with the verified QLever
extension before starting the run.

### Current decision run: 2M cluster/direct

Use this run as the only current replacement-decision evidence:

```bash
test -n "${XPOD_RDF_BENCHMARK_PG_URL:-}" || exit 1

bun run benchmark:rdf-cloud-replacement \
  --mode=external \
  --executionLocation=cluster \
  --transport=direct \
  --targetQuads=2000000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=production \
  --out=.test-data/rdf-engine-perf-reports/sealos-cloud-replacement-2m-cluster-direct.json
```

This document intentionally does not include an immediate 10M command. Historical
2M+10M planning remains background only; the current run is 2M.

### Diagnostic port-forward run

Use `port-forward` only to diagnose connectivity, extension availability, or
runtime behavior when direct cluster access is unavailable or suspect. Store it
under a separate output path and do not compare it as replacement evidence:

```bash
test -n "${XPOD_RDF_BENCHMARK_PG_URL:-}" || exit 1

bun run benchmark:rdf-cloud-replacement \
  --mode=external \
  --executionLocation=cluster \
  --transport=port-forward \
  --targetQuads=2000000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=production \
  --out=.test-data/rdf-engine-perf-reports/sealos-cloud-replacement-2m-port-forward-diagnostic.json
```

### Operator preflight

Before each external run, the operator should manually verify
`current_database()`, PostgreSQL version,
`xpod_rdf.native_sparql_capabilities()`, and the absence of unrelated tables.
This is an operator preflight, not an automatic runner guard.

The runner automatically performs only these external safety and identity
checks:

- Reads the connection URL only from `XPOD_RDF_BENCHMARK_PG_URL`.
- Rejects database names whose decoded path does not end in `_benchmark`.
- Adds `search_path=xpod_benchmark,public` internally.
- Drops and recreates only the `xpod_benchmark` schema during setup and cleanup.
- Hashes `pg_control_system().system_identifier` plus `current_database()` for
  checkpoint/report database identity.
- Reads PostgreSQL version for the sanitized report environment.

The runner does not automatically inspect all catalog contents for unrelated
tables, and external QLever capability verification remains part of operator
preflight. Persist only sanitized database name, versions, commit, execution
context, and measurements; never persist the URL, host, user, password,
namespace, pod name, cluster address, raw database name, or raw PostgreSQL
system identifier.

## Destructive safety and cleanup

External cleanup is intentionally destructive inside the dedicated benchmark
schema. The runner validates the database suffix before any cleanup. At startup
and again from the final cleanup path it executes the schema reset inside one
transaction:

```sql
BEGIN;
DROP SCHEMA IF EXISTS xpod_benchmark CASCADE;
CREATE SCHEMA xpod_benchmark;
COMMIT;
```

External connections also add `search_path=xpod_benchmark,public` to the
PostgreSQL URL internally. If a cleanup statement fails, the runner attempts
`ROLLBACK`; it also preserves the primary benchmark failure while reporting
cleanup failures. This transaction boundary does not make a wrong database
safe. The automatic guard is the decoded `_benchmark` database-name suffix; the
operator remains responsible for the preflight checks above. After a crash or
forced termination, reconnect to the dedicated database, remove any generated
schema/data, and verify the fact tables are absent before deleting the temporary
database or deployment.

Local mode creates a uniquely named disposable container with `--rm` and
force-removes it in the final path, including failed provisioning. The smoke
also removes its temporary JSON report.

## Checkpoint v2 semantics

Checkpoint files live beside the report as `<out>.checkpoint.json`.

- Version 1 checkpoints are rejected instead of migrated.
- Database identity is a SHA-256 hash of
  `pg_control_system().system_identifier` plus `current_database()`. The raw
  system identifier and database name are not stored in the checkpoint identity.
- The checkpoint context includes runner identity, current git commit, workload
  ids, transport, execution location, mode, target facts, cache modes, image,
  timeout, and database name.
- Latency and concurrency use separate context fingerprints. Changing latency
  inputs can clear latency evidence without implying concurrency reuse, and
  changing concurrency lanes clears concurrency evidence without discarding
  matching latency evidence.
- Concurrency completion is atomic per `cacheMode x engine x workload x
  concurrency` cell.
- A concurrency cell is reusable only when it has a valid record, valid
  per-cell PostgreSQL diagnostics, and no `infrastructureFailure`.
- Aggregate `diagnosticsByCacheMode` is rebuilt from per-cell diagnostics on
  load. Saved aggregate diagnostics never override per-cell evidence.
- `direct` and `port-forward` are different transport contexts. A checkpoint
  produced by one transport must not be reused by the other.

## Final report identity

Final JSON reports include a sanitized `executionContext` so decision evidence
can be audited without looking at the checkpoint file:

- `location`: `local` or `cluster`.
- `transport`: `direct` or `port-forward`.
- `databaseIdentity`: a 64-character lowercase SHA-256 hex digest.
- `runnerIdentity`: currently `native-rdf3x-benchmark-v2`.
- `engineCommit`: the git commit used by the runner.
- `workloadIds`: the non-empty workload id list used for the report.

The final report context does not include the connection URL, raw database
name, raw `pg_control_system().system_identifier`, host, user, password,
namespace, pod name, or cluster address. The separate sanitized `environment`
object contains only the database name, PostgreSQL version, engine commit, and
`qleverReady` summary.

## Measurement and cache semantics

- `--iterations=20` records twenty timed steady-state samples per case after
  three warmups; cold evidence is recorded separately before correctness.
- Engine-first order alternates by workload and cache mode.
- `--concurrency=1,8,32` runs each declared representative workload for 60
  seconds per lane and reports completed operations, engine-boundary errors,
  infrastructure errors, elapsed wall time, throughput, and error evidence.
- `cacheMode=off` constructs adapters with query-result and materialized-result
  caches disabled. A single run-scoped sample-identity source prevents
  accidental cache reuse. It does not clear PostgreSQL shared buffers or the
  operating system page cache.
- `cacheMode=production` enables product query/materialized-result cache
  behavior. Use this mode for the current 2M cluster/direct decision run.
- With `cacheMode=both`, the report presents production-cache latency when
  available, while cache-off concurrency, errors, gates, and PostgreSQL
  diagnostics are the decision evidence. `latencyByCacheMode`,
  `concurrencyByCacheMode`, and `diagnosticsByCacheMode` retain both sets for
  diagnosis.
- RDF3X and QLever derived-index build times are separate. Storage values have
  `shared-not-additive` semantics because both adapters use one fact store;
  QLever incremental bytes are currently unavailable.

## Error evidence and infrastructure failures

`errors` counts engine-boundary failures only: timeouts, cancelled executions,
fallbacks, correctness-attributed failures, and unknown engine execution errors.
It does not count database connectivity failures.

`infrastructureErrors` counts connection-class failures separately. A streak of
connection failures trips `infrastructureFailure=true` for that concurrency
cell. Every concurrency record also includes `errorEvidence`:

- `counts` covers `timeout`, `connection`, `cancelled`, `engine`,
  `correctness`, and `unknown`.
- `samples` stores at most three sanitized samples per category/context, with
  category, stage, error name, code, redacted message, first/last seen
  timestamps, count, workload id, engine, cache mode, and concurrency.
- Messages are truncated and scrubbed for credentials, endpoints, private IPs,
  users, passwords, tokens, and other credential-bearing text.

Reports expose `errorRates` and `infrastructureErrorRates` separately. The
replacement gate uses the QLever engine error rate; infrastructure rate is
reported as operational evidence. Any `infrastructureFailure` makes
`evidenceComplete=false`, prevents correctness from passing, and forbids a
replacement recommendation.

## Fixed weights and replacement thresholds

These values were declared before the external experiment and must not be tuned
after observing results.

| Workload group | Weight |
| --- | ---: |
| Short serving queries | 0.60 |
| Large/complex queries | 0.30 |
| Authorization queries | 0.10 |

Cases share their group weight equally. The immutable gates are:

| Gate | Threshold |
| --- | ---: |
| Critical short-query QLever/RDF3X p95 | at most 1.20 |
| Weighted QLever/RDF3X p95 | at most 0.80 |
| QLever/RDF3X throughput | at least 1.25 |
| Representative large-query speedup | at least two cases at 1.50x |
| QLever engine error rate | 0 |
| Peak memory / memory limit | at most 0.85 |
| Peak temporary disk / disk limit | at most 0.20 |

Replacement requires correctness, the short-query gate, either weighted-p95 or
throughput improvement, the large-query gate, zero QLever engine-boundary
errors, no infrastructure failure, and both resource gates. A missing resource
ratio fails the corresponding resource gate.

## Reading the recommendation

- `replace`: every immutable correctness, serving, aggregate-performance,
  large-query, engine-error, infrastructure-completeness, and resource gate
  passed. This is meaningful for a Cloud decision only on the current external
  2M `cluster` + `direct` production-cache report.
- `retain-rdf3x`: correctness, fallback, engine-error, infrastructure, aggregate
  value, large-query, or resource evidence blocks replacement.
- `selective-routing-candidate`: at least two representative large cases show
  the declared gain while one or more short, aggregate, infrastructure, or
  resource gates block full replacement. This records a future investigation; it
  does not implement routing.

A recommendation in a local 20k/100k/500k report or in a `port-forward` report
is diagnostic only. In particular, the runner marks the external resource
sampler as unattached and cannot infer container memory or volume high-water
ratios from PostgreSQL counters alone. Attach separately sampled, sanitized
Cloud resource evidence before interpreting the external recommendation.

## Explicit exclusions

- Handwritten Direct SQL, if measured, is a diagnostic lower bound on the same
  PostgreSQL data. It is not RDF3X, is excluded from weights and gates, and
  cannot justify replacing RDF3X.
- QLever-only text, vector, spatial, or engine-specific syntax has no
  like-for-like RDF3X baseline. Such cases belong in a separate capability
  section and are excluded from replacement scoring.
- The measured phase is read-only after deterministic loading. It does not
  cover mixed read/write production traffic, sustained update/index-maintenance
  contention, failover, long-running soak stability, or operational recovery.
- Local container resource behavior is not a substitute for Cloud allocation,
  throttling, persistent-volume, or noisy-neighbor evidence.
