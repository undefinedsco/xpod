# Full-text Index V2 Current Completion Audit

> Scope: current implementation evidence for [`2026-06-23-full-text-index-v2-design.md`](./2026-06-23-full-text-index-v2-design.md) and phase specs P0-P3.
> Date: 2026-06-28.

## Verification evidence

Fresh verification commands run for this audit:

```bash
bun scripts/assert-rdf-benchmark-report-gate.ts \
  --root=.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/hot-20-from-current-baseline \
  --productQLeverLikePlannerGate

bun test \
  tests/storage/rdf/PostgresRdfEngine.test.ts \
  tests/storage/rdf/PostgresRdfVectorIndex.test.ts \
  tests/storage/rdf/RdfModelsBenchmarkGate.test.ts \
  tests/storage/rdf/RdfSearchSourceFilter.test.ts \
  tests/api/service/RdfBenchmarkReportGate.test.ts \
  tests/api/service/RdfBenchmarkReportCatalog.test.ts \
  tests/cli/rdf.test.ts \
  --run

bun run test:integration

bun run build:ts

git diff --check
```

Observed results:

- Product QLever-like native-search gate: matched true. This gate includes the
  product P3 requirements and additionally requires native PostgreSQL FTS/vector
  plan evidence.
- Current QLever-like focused suite: 7 files passed, 145 tests passed, including planner-visible CPU/IO cost markers.
- Integration suite: lite passed 17 files / 87 tests with 1 skipped; full passed 4 files / 40 tests.
- TypeScript build: passed.
- Whitespace diff check: passed.

## Product-scale benchmark artifacts

Current native-search baseline artifact:

```text
.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/baseline-20/models-postgres-2026-06-28T20-45-11-857Z-5169-3fd6c4a3-8788-42cb-a372-6ef675b10d2f.json
```

QLever-like native-search gate artifact:

```text
.test-data/rdf-engine/qlever-product-current-bounded-lookahead-20260629044509/hot-20-from-current-baseline/models-postgres-2026-06-28T20-54-35-285Z-8244-acaf818a-6b43-4b43-b6ca-4d655c248243.json
```

Native-search QLever-like gate shape:

- driver: `pg`.
- scale: `large`.
- case profile: `all`.
- RDF acceleration profile: `pg-hot-operators`.
- text backend: `pg-native-fts`.
- target quads: 1,000,000.
- seed quads: 1,037,906.
- iterations / warmups / concurrency: 20 / 2 / 4.
- serving gate: matched, 49 cases.
- fusion gate: matched, 2 cases.
- native FTS evidence: present.
- native vector evidence: present.
- broad candidate rows: 320.
- broad batched candidate join: true.
- broad fusion p95: 1,974 ms vs native baseline 1,801 ms.
- warm steady query p50/p95: 41 / 53 ms.
- storage total/facts ratio: 1.700.

## P0 audit — safe retrieval foundation

| Acceptance item | Evidence | Status |
| --- | --- | --- |
| RDF raw serialization boilerplate is not default searchable body text. | `tests/storage/rdf/RdfTextIndex.test.ts`, `tests/storage/rdf/PostgresRdfTextIndex.test.ts`, and P0 report entity-projection checks. | Covered. |
| String-like RDF literals beyond `name` / `description` are searchable when policy allows. | Text-index policy and SQLite/PostgreSQL text-index tests in the focused suite. | Covered. |
| Credential/provider/token/ACL/ACR/system fields are excluded from FTS text. | Text projection policy tests and service tests in the focused suite. | Covered. |
| User search without authorization scope fails closed. | `tests/service/RdfRunContextRetriever.service.test.ts`. | Covered. |
| ACL/ACR filtering happens before final top-k. | `FusionHardFiltersBeforeRank(...)` tests and product P3 gate hard-filter requirement. | Covered. |
| Text search with `limit` avoids app-layer full materialization. | Planner evidence: `TopKPushdown(...)`, `PerSourceCap(...)`, `NoTsFullMaterialize(TextSearch)`. Covered by RDF query/text tests. | Covered. |
| Entity/path/workspace filters are pushed into text candidate generation where supported. | `RdfSearchSourceFilter`, text-index, and RDF query executor tests. | Covered. |
| Chinese long text without spaces is searchable by short Chinese keyword. | SQLite/PostgreSQL text-index tests. | Covered. |
| Fresh start and upgrade create P0 schema idempotently. | Text/vector/Postgres engine reopen and schema tests. | Covered. |
| Rebuild regenerates derived text indexes without changing authority data. | `tests/solidfs/RdfIndexSolidFsSyncer.test.ts` and text-index rebuild paths. | Covered. |

Remaining boundary: P0 still uses normalized postings, not PostgreSQL `tsvector` / BM25. That is an explicit backend limitation, not an acceptance blocker for the current P0 design.

## P1 audit — source and retrieval point hygiene

| Acceptance item | Evidence | Status |
| --- | --- | --- |
| Same subject + facts + policy produce stable projections across RDF syntaxes. | RDF text projection tests across Turtle, N-Triples, TriG, JSON-LD, and RDF/XML. | Covered. |
| Long textual RDF fields create bounded field chunks and remain exact-searchable. | `RdfTextIndex` / `PostgresRdfTextIndex` tests. | Covered. |
| Moving a file without content change preserves source and point identity. | `moveSource(...)` text/vector index tests and SolidFS sync tests. | Covered. |
| Prefix/subtree path search uses structural path/source index, not FTS. | `localPathPrefix` source filter tests. | Covered. |
| Weak path text changes do not force content re-indexing beyond path/folder projection fields. | Move/path tests preserve content chunk and posting identities. | Covered. |
| Entity result hydration avoids N+1 fetch pattern for normal result sets. | Text index hydration tests call batch entity lookup. | Covered. |
| Agent context projection marks untrusted context and includes source/retrieval/entity provenance. | `tests/service/RdfRunContextRetriever.service.test.ts` and `PiAgentRuntimeDriver` prompt projection tests. | Covered. |

Remaining boundary: there is still no dedicated physical `rdf_retrieval_points` table. Current retrieval points are chunk-backed via existing text/vector rows. This remains acceptable until product queries need separate retrieval-point lifecycle.

## P2 audit — embedding and semantic retrieval

| Acceptance item | Evidence | Status |
| --- | --- | --- |
| FTS and vector results join through the same retrieval-point identity. | `RdfQuery` text/vector binding tests and vector index tests. | Covered. |
| Embedding model/projection changes invalidate affected vector points without authority mutation. | SQLite/PostgreSQL vector-index identity tests and `RdfSearchIndexingService` tests. | Covered. |
| Over-budget input summarizes or skips with explicit reason. | `RdfSearchIndexingService.service.test.ts`. | Covered. |
| Search results expose score components and provenance for fusion. | `RdfTextIndex`, `RdfVectorIndex`, query executor, and fusion-rank tests. | Covered. |
| Missing/expired provider credentials fail with clear reason. | `RdfSearchIndexingService.service.test.ts`. | Covered. |

Remaining boundary: summary lifecycle is currently derived from vector rows; there is no separate summary authority table. This is deferred until summary reuse/retention/migration needs it.

## P3 audit — product-grade fusion planner

| Acceptance item | Evidence | Status |
| --- | --- | --- |
| Benchmarks show improvement or bounded non-regression over physical-source baseline for broad search + RDF/path/ACL + top-k. | Current native-search QLever-like artifact: broad fusion p95 1,974 ms vs native baseline 1,801 ms, scanned rows unchanged at 1,600, with native FTS/vector evidence. | Covered for the current synthetic product-scale gate. |
| Planner metrics identify sources, source-choice rationale, pushed filters, and top-k. | `TextMatchSource`, `VectorMatchSource`, `RdfBgpSource`, `ValuesSource`, `PathScopeSource`, `AclScopeSource`, `SourceEstimate`, `PostgresPlannerSourceChoice`, `TopKPushdown`, and report gates. | Covered. |
| No planner path bypasses authorization before final ranking. | Focused unauthorized-higher-score tests plus product gate hard-filter requirement. | Covered. |
| Serving-query regressions are caught by benchmark gates. | `servingRegressionGate` is required by `--productQLeverLikePlannerGate`; current artifact matched 49 serving cases. | Covered. |
| Storage overhead and index-build cost are reported through `performanceCosts`. | Current artifact includes `storageOverhead`, `indexBuild`, and `coldStart`. | Covered. |

Remaining boundary: source ordering is now adaptive and marker-visible across
RDF, text, vector, and VALUES sources with
input/output/row-cost/CPU-cost/IO-cost/future-fanout evidence, including a
bounded multi-step suffix-cost model. The planner now emits `lookahead:full` or
`lookahead:bounded`; bounded suffixes use a greedy tail estimate instead of
enumerating every source permutation. It is still not a native QLever engine:
CPU/IO cost is now represented as a first-pass source-cost dimension, but full
statistics-driven join distribution modeling and calibrated CPU/IO weights remain
future work. The stricter native-search gate `--productQLeverLikePlannerGate`
now passes and requires product P3 evidence plus
`textSearchBackend=pg-native-fts`, native FTS plan evidence, and native vector
plan evidence.

## Overall status

The current implementation satisfies the P0-P3 acceptance gates for the current
spec boundaries, including the product-scale native-search QLever-like planner
gate. The remaining items are product evolution boundaries:

- run product gate on representative real user/workspace datasets once fixtures exist.
- tune ranking weights against retrieval-quality benchmarks.
- decide later whether BM25/`tsvector`, ANN, a dedicated retrieval-point table, or a summary authority table are needed.
- keep product-scale gate evidence at 20 iterations or higher; 3-iteration p95 was observed to be too noisy.
