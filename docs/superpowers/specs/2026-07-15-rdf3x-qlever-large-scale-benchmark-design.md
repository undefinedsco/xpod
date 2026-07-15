# RDF3X/QLever Cloud Replacement Benchmark Design

## Goal

Produce enough reproducible evidence to decide whether Cloud/PG should replace RDF3X with QLever as its default RDF query engine.

The benchmark must answer three separate questions:

1. Does QLever preserve product query correctness and authorization semantics?
2. Can QLever improve large, complex workloads without materially degrading short serving queries?
3. Is complete replacement justified, or should RDF3X remain the default while QLever evidence is retained for a future selective route?

Local/SQLite remains on RDF3X. This benchmark does not decide the Local engine.

## Current evidence and motivation

Existing 20k, 100k, and 500k-subject measurements are useful but insufficient for replacement:

- RDF3X remains materially faster for point lookups and some subject-star queries as data grows.
- QLever begins to win on selected broad joins, cold scans, and large ACL-scoped joins.
- The current workload has too few query shapes, only two graphs, and mostly uniform synthetic data.
- The existing standalone native benchmark duplicates part of the richer models benchmark infrastructure and does not yet provide a replacement gate.

The new benchmark therefore adds product-shaped data, richer algebra, realistic authorization distribution, larger scale, concurrency, and explicit decision criteria.

## Scope

### Included

- Cloud/PostgreSQL RDF3X and QLever comparison over the same GSPO facts.
- Local reproducible benchmark runs for development and regression investigation.
- One decision experiment on SealOS PostgreSQL at 2M and 10M triples.
- Latency, throughput, correctness, resource use, and physical-plan evidence.
- Product-shaped chat/task/thread/message/run data with skew and authorization scopes.
- A generated report that recommends replacement, retention, or later selective routing.

### Excluded

- Changing the Local/SQLite default engine.
- Implementing automatic per-query engine routing.
- Adding SealOS credentials, deployment configuration, or scheduled benchmark jobs to the repository.
- Making SealOS performance testing part of CI or a release gate.
- Using text search, vector search, spatial search, or other QLever-only capabilities to justify replacing RDF3X for the shared SPARQL surface.
- Treating handwritten SQL as a competing RDF engine. Direct SQL is diagnostic lower-bound evidence only.

## Execution strategy

### Local runs

Local PostgreSQL runs remain the fast, reproducible development path. They cover 20k, 100k, and 500k-scale data, correctness checks, report generation, and benchmark-runner regression tests.

Performance benchmarks remain manually invoked. CI verifies benchmark definitions, result equivalence, report parsing, and decision-gate behavior without asserting timing on shared runners.

### One-time SealOS run

SealOS PostgreSQL is used once for the replacement decision:

- scales: 2M and 10M triples;
- concurrency: 1, 8, and 32;
- one complete experiment batch, not a recurring workflow;
- three warm-up executions and twenty measured executions for latency cases;
- sixty seconds per concurrency level;
- RDF3X and QLever executed in alternating order to reduce cache and time-drift bias.

"Run once" means one experiment batch. It does not mean taking one timing sample per query.

The runner records the PG version, extension versions, relevant PostgreSQL settings, machine allocation, data seed, engine build identity, and timestamps. SealOS credentials and connection strings are supplied at runtime and never written to reports or source control.

After the report is secured, the benchmark schema and generated test data are removed from SealOS.

## Benchmark architecture

The benchmark extends the existing models benchmark infrastructure instead of growing a second independent framework.

### Shared dataset definition

One deterministic dataset generator produces RDF facts for both engines. The generator owns:

- scale and random seed;
- product entities and relationships;
- graph allocation and authorization distribution;
- skew, fan-out, and value selectivity;
- expected cardinalities used by correctness checks.

Both engines query the same PostgreSQL fact rows. Engine-specific indexes are derived state and may be rebuilt independently. No second GSPO fact copy is introduced.

### Engine adapters

RDF3X and QLever adapters expose the same benchmark operations:

- prepare or rebuild derived indexes;
- execute a parameterized SPARQL case;
- return normalized bindings;
- expose the physical plan and engine diagnostics;
- reset benchmark-local caches where supported.

An adapter must not silently route to the other engine. Unsupported queries fail the capability check and cannot contribute to a replacement recommendation.

### Runner

The runner performs these phases in order:

1. provision an isolated benchmark schema;
2. generate and load facts once;
3. build RDF3X and QLever derived indexes;
4. run PostgreSQL `ANALYZE`;
5. verify fixture counts and engine capabilities;
6. compare normalized results for every query;
7. measure cold, warm, and concurrent execution;
8. collect plans and process/database metrics;
9. calculate gates and write raw JSON plus a concise Markdown report;
10. remove the isolated schema when cleanup is requested.

If correctness differs, measurement for that case is retained for diagnosis but the replacement gate fails immediately. Infrastructure failures remain distinct from engine failures in the report.

## Dataset shape

The dataset uses existing shared models rather than generic triples alone. It includes:

- chats and tasks;
- threads, messages, runs, and steps;
- agents, users, workspaces, and providers where required by queries;
- graph/container relationships used by ACL/ACR scope resolution.

The distribution is intentionally non-uniform:

- a small set of hot threads contains many messages;
- most users contain modest data while a long tail contains much larger histories;
- relationship fan-out varies by entity;
- query predicates have low, medium, and high selectivity;
- most resources inherit authorization from a parent container;
- a small minority has explicit allow or deny overrides.

The 2M and 10M targets refer to loaded RDF facts, not subject counts.

## Workloads

### Short-query protection group

These cases guard the serving path that RDF3X already handles well:

- exact point lookup;
- subject-star lookup;
- latest message in a thread;
- cursor/keyset pagination;
- exact single-graph query;
- selective predicate-object lookup.

### Large-query candidate group

These cases test the region where a full planner and native execution can justify QLever:

- two-, four-, and eight-hop chain joins;
- high-fan-out star and snowflake joins;
- many-to-many joins;
- joins with low, medium, and high selectivity;
- `GROUP BY`, numeric aggregates, and `COUNT DISTINCT`;
- `ORDER BY` with and without a selective `LIMIT`;
- `OPTIONAL`, `UNION`, `FILTER`, `EXISTS`, and bounded subqueries;
- broad scans that return small final results after join or aggregation.

### Authorization group

Authorization cases reflect product behavior rather than uniformly assigning unique ACLs:

- inherited parent scope across many graphs;
- a small explicit allow set;
- a small explicit deny set;
- graph-prefix scope;
- scoped joins that would otherwise scan a broad candidate set.

Every authorization case verifies that denied bindings are absent before its timing is considered valid.

### QLever-only capabilities

Text, vector, spatial, and QLever-specific query features may be measured in a separate report section. They do not affect the RDF3X replacement gate because RDF3X cannot provide a like-for-like baseline for those capabilities.

## Measurement

Each shared query reports:

- cold first execution;
- warm p50, p95, and p99 latency;
- throughput and error rate at concurrency 1, 8, and 32;
- returned binding count and normalized result digest;
- physical plan and estimated/actual candidate counts where available;
- PostgreSQL CPU time, memory high-water mark, temporary bytes, and relevant buffer statistics;
- index build duration and derived-index storage size.

Product-path measurements include SPARQL parsing, planning, PostgreSQL/extension calls, execution, and result materialization. Engine-internal timings may be recorded as diagnostics but cannot replace the product-path result.

Cache-off and production-cache-on modes are reported separately. Results from one mode are never compared with results from the other.

## Replacement decision

QLever is recommended as the Cloud default only if all of these gates pass:

1. All shared query results and authorization outcomes match RDF3X.
2. Critical short-query p95 is no greater than 1.20 times RDF3X.
3. The weighted product workload either improves p95 by at least 20% or improves throughput by at least 25%.
4. At least two representative large-query cases improve by at least 1.5 times.
5. No case introduces unacceptable failure rate, memory pressure, temporary-disk growth, or operational instability.

Workload weights are declared in the benchmark definition before the SealOS run. They cannot be changed after results are observed.

The report produces exactly one of these recommendations:

- **Replace**: all replacement gates pass.
- **Retain RDF3X**: correctness fails, short-query regression is too large, or aggregate value is absent.
- **Selective-routing candidate**: QLever has repeatable gains in identifiable query classes but does not pass complete-replacement gates. This records evidence only; it does not implement routing.

## Persisted artifacts

The repository keeps:

- shared dataset/workload definitions;
- RDF3X and QLever benchmark adapters;
- local manual benchmark commands;
- correctness and report-gate tests;
- a sanitized one-time SealOS raw report and concise decision report.

It does not keep:

- SealOS credentials or connection URLs;
- generated 2M/10M fixture data;
- benchmark databases or dumps;
- a scheduled SealOS workflow;
- timing assertions in CI.

## Acceptance criteria

Implementation is ready for the one-time experiment when:

- the same local fixture executes through both engines without fallback;
- every shared query compares normalized result digests before timing;
- local 20k, 100k, and 500k runs generate the same report schema;
- all workload weights and replacement gates are visible in the report;
- a dry run proves credentials are redacted and cleanup targets only the isolated benchmark schema;
- unit/integration tests cover dataset determinism, adapter selection, correctness mismatch, report calculation, and cleanup command generation.

The task is complete only after the 2M/10M SealOS batch has run, the sanitized evidence is preserved, and the report makes an explicit engine recommendation under the predeclared gates.
