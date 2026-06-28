# Full-text Index V2 Current Completion Audit

> Scope: current implementation evidence for [`2026-06-23-full-text-index-v2-design.md`](./2026-06-23-full-text-index-v2-design.md) and phase specs P0-P3.
> Date: 2026-06-28.

## Verification evidence

Fresh verification commands run for this audit:

```bash
bun scripts/assert-rdf-benchmark-report-gate.ts \
  --root=.test-data/rdf-engine/p3-product-pg-strict-20-from-baseline-20 \
  --productP3FusionGate

bun vitest --run \
  tests/storage/rdf \
  tests/service/RdfSearchIndexingService.service.test.ts \
  tests/service/RdfRunContextRetriever.service.test.ts \
  tests/solidfs/RdfIndexSolidFsSyncer.test.ts \
  tests/solidfs/SolidFsMetaNotes.test.ts \
  tests/api/service/RdfBenchmarkReportGate.test.ts \
  tests/api/service/RdfBenchmarkReportCatalog.test.ts \
  tests/cli/rdf.test.ts

bun run test:integration

bun run build:ts

git diff --check
```

Observed results:

- Product P3 gate: matched true.
- RDF/search/SolidFS focused suite: 23 files passed, 726 tests passed.
- Integration suite: lite passed 17 files / 87 tests with 1 skipped; full passed 4 files / 40 tests.
- TypeScript build: passed.
- Whitespace diff check: passed.

## Product-scale benchmark artifacts

Baseline artifact:

```text
.test-data/rdf-engine/p3-product-pg-baseline-20/models-postgres-2026-06-27T16-32-15-585Z-27336-f01ed322-058b-490a-ab85-0abaa218d94a.json
```

Product gate artifact:

```text
.test-data/rdf-engine/p3-product-pg-strict-20-from-baseline-20/models-postgres-2026-06-27T16-41-32-022Z-32778-977147aa-c244-4210-9b4e-36133e93b4e1.json
```

Product gate shape:

- driver: `pg`.
- scale: `large`.
- case profile: `all`.
- target quads: 1,000,000.
- seed quads: 1,037,906.
- iterations / warmups / concurrency: 20 / 2 / 4.
- serving gate: matched, 49 cases.
- fusion gate: matched, 2 cases.
- broad candidate rows: 4,099.
- broad batched candidate join: true.
- storage total/facts ratio: 1.811.

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
| Benchmarks show improvement over physical-source baseline for broad search + RDF/path/ACL + top-k. | Product gate artifact: broad fusion p95 2,005 ms vs baseline 2,472 ms, scanned rows unchanged at 20,483. | Covered for synthetic product-scale gate. |
| Planner metrics identify sources, pushed filters, and top-k. | `TextMatchSource`, `VectorMatchSource`, `RdfBgpSource`, `PathScopeSource`, `AclScopeSource`, `SourceEstimate`, `TopKPushdown`, and report gates. | Covered. |
| No planner path bypasses authorization before final ranking. | Focused unauthorized-higher-score tests plus product gate hard-filter requirement. | Covered. |
| Serving-query regressions are caught by benchmark gates. | `servingRegressionGate` required by `--productP3FusionGate`; product artifact matched 49 cases. | Covered. |
| Storage overhead and index-build cost are reported through `performanceCosts`. | Product artifact includes `storageOverhead`, `indexBuild`, and `coldStart`. | Covered. |

Remaining boundary: source ordering is still rule-driven and marker-visible, not a full cost-based optimizer. Product ranking weights still need real retrieval-quality tuning.

## Overall status

The current implementation satisfies the P0-P3 acceptance gates for the current spec boundaries and available synthetic product-scale benchmark. The remaining items are product evolution boundaries:

- run product gate on representative real user/workspace datasets once fixtures exist.
- tune ranking weights against retrieval-quality benchmarks.
- decide later whether BM25/`tsvector`, ANN, a dedicated retrieval-point table, or a summary authority table are needed.
- keep product-scale gate evidence at 20 iterations or higher; 3-iteration p95 was observed to be too noisy.
