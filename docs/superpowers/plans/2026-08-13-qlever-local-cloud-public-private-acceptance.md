# QLever Local/Cloud public-private acceptance

Date: 2026-08-13

Status: accepted

## 2026-08-24 private PG release acceptance

The private PostgreSQL 17 QLever release lane is accepted at `xpod-pro` commit
`ab3018a13f1a5e517c3cd01d57a5200bbbd6d386`.

- Runtime SDK:
  `ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:f3ad825cf541b4ff156853d36c80f781d5e1ca537c8e604f4f0a66b4873bf6c7`
- Published Guangzhou TCR image:
  `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:be5a95bade37790b28d322300554500da79b61e93ac9047fb6a425efac64c517`
- CNB pipeline: `cnb-sc8-1k0nmb2v8`.

The pipeline authenticated to TCR before spending build time, checked out the
exact private source commit, built the PG17 image, passed the packaged PG17
QLever smoke, and published the immutable digest above. The complete run took
4m45s; the packaged smoke took 3.7s and the final TCR publication took 12.3s.
Together with the focused private boundary suite (163 passed, 2 optional
live-DSN tests skipped) and the accepted native semantic conformance record,
this closes the remaining private release publication gate.

## 2026-08-19 public Local/Cloud acceptance

The corrected public boundary is accepted at Xpod commit
`628d91e3087a24c16b6dc50debb7fccd1f3ea737`. Native compilation and image
construction ran only on remote GitHub/CNB workers; the user's workstation ran
source-only and TypeScript tests.

- Runtime SDK:
  `ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:f3ad825cf541b4ff156853d36c80f781d5e1ca537c8e604f4f0a66b4873bf6c7`
- Local static runtime:
  `ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:47e14c13b40bdf112648bc6b2f4f869fb973612b6b764f2758bb583f11f6f991`
- Public Cloud PG fixture:
  `docker.io/pgvector/pgvector@sha256:7ae6051efd0e60444282c27c7e141af07f322ce033300e727a49c3dd11075e38`
- Runtime-SDK workflow: GitHub Actions run `32264528210`.
- Local-runtime build, smoke, and SQLite semantic gate: GitHub Actions run
  `32267470415`.
- Installed public Local/Cloud image gate: GitHub Actions run `32267950450`,
  artifact `rdf-installed-image-conformance-32267950450`.

The installed-image artifact reports `status=ok` for both `sqlite` and
`pg-public`. Both ran all 14 required semantic cases with no skips or failures
and produced the same canonical digest:
`sha256:9d701783bf1b8f56e1640a6f61b0d49aad137fbbbcd532b9f27be72b6915bb03`.
The public Cloud gate uses ordinary PostgreSQL plus pgvector and therefore also
proves that absence of the private PG QLever extension does not block Cloud.

The same installed artifact proves the search convergence contract:

- FTS returns the canonical text before any vector exists;
- fused search is empty before VEC, then returns the same retrieval point after
  the vector arrives;
- a locator move preserves the retrieval identity and vector point while the
  visible source converges from the old locator to the moved locator;
- the old locator and a denied source return no rows after convergence.

Focused embedding/reconciliation tests additionally passed 81/81 cases across
indexing, Pod config resolution, durable reconciliation, retrieval, and API
wiring. They cover missing configuration, quota/rate/transient retries,
blocked credentials until config-fingerprint change, restart recovery, and
Pod-wide requeue after a model change. SQLite/PostgreSQL text/vector storage
parity passed 128/128 cases, and `bun run build:ts` passed.

## Accepted boundary

- Public `xpod-jobs` owns both product deployment modes: Local and Cloud.
- Public Local owns the SQLite-backed static QLever runtime path and product-level FTS/VEC indexing and retrieval wiring.
- Public Cloud owns the PostgreSQL/RDF-3X/PG FTS/VEC path without requiring QLever.
- In this acceptance scope, private `xpod-pro` contributes only the Cloud PostgreSQL QLever module, the PostgreSQL native extension, and PG-native conformance evidence. The repository itself may later host other independently installable commercial modules behind public boundaries.
- `undefineds.co/native-builder` is only a build control plane. It checks out immutable source commits and returns artifacts; it does not mirror or own Xpod source.

## Product runtime contract

- Product SPARQL enters the active product authority through the public `RdfEngineLike` boundary.
- Local starts a fixed SQLite-backed QLever runtime with only `--sqlite-path`; no local `.so`, `--provider`, provider path, or backend selector is exposed.
- Public Cloud starts from `PostgresRdfEngine` and PostgreSQL facts/RDF-3X/PG search indexes. It must not probe or require the private QLever extension.
- Private Cloud acceleration may replace or extend the Cloud query authority through an explicit deployment component; it is not a public backend selector and not a public Cloud prerequisite.
- The product SQL API request shape is the public nested object only:
  `basePath`, `sourceUri`, `operation`, `timeoutMs`, `acceptMediaType`, `loadDocument`, `accessScope`, `vectorQuery`.
- Legacy flat fields such as `graphPrefix`, `authorizationModel`, `accessScopeResolved`, `sourceUriPrefix`, and flattened `loadDocument*` are not supported.

## Search and embedding contract

- FTS and VEC join only on the stable retrieval identity
  `sourceKey + retrievalPointKey`; the current locator URI may differ while a
  move is converging.
- Native vector rows expose the matching text chunk as QLever's
  `TextRecordIndex`. This is the same value domain used by FTS, so a SPARQL
  variable shared by the FTS and VEC operations performs a real engine join.
- The physical stores use the stable identity to find the matching text chunk,
  then return and authorize against that text row's current locator. A stale
  vector locator therefore neither breaks a move in progress nor bypasses the
  current source scope.
- Text and vector source tables enforce `source_key TEXT NOT NULL UNIQUE` and
  never rewrite it during reindex or move. Text schema version 3 and vector
  schema version 2 are created fresh; older or malformed schemas fail closed
  without migration, backfill, or fallback.
- Every current raw source locator is also present in the RDF term dictionary,
  including after a move, so native QLever can bind the authorized current
  locator as an RDF term.
- FTS remains usable without embedding configuration.
- VEC is optional and pod-scoped. Missing config, blocked provider errors, quota/rate failures, and transient upstream errors are recorded as durable reconciliation outcomes rather than silently completing.
- Embedding model resolution uses the exact Pod AI config embedding model and
  the credential for that model's provider. No implicit default embedding
  model or unrelated default provider credential is injected.
- SolidFS/local moves update FTS and VEC source metadata in place while
  preserving `sourceKey`, retrieval-point keys, and vector point ids. A target
  locator collision is replaced deterministically; moved content is not
  re-embedded merely because its locator changed.

## Previous verification evidence

The following evidence was collected before the public/private boundary
correction that restored public Cloud as a no-QLever PostgreSQL mode. It remains
useful for Local runtime, search, embedding, and private PG-native coverage, but
does not prove the corrected public Cloud no-QLever gate.

Run from `/private/tmp/xpod-main-port.I1PUdz`:

```bash
bun vitest run tests/scripts/qlever-production-cutover.test.ts \
  tests/solidfs/LocalRdfAuthorityRecoveryConfig.test.ts \
  tests/ai/PodStoreAiConfig.test.ts \
  tests/service/RdfSearchIndexingService.service.test.ts \
  tests/api/service/RdfSearchReconciliationWorker.test.ts \
  tests/api/container/rdf.test.ts \
  tests/storage/rdf/PostgresRdfEngine.test.ts
```

Result: 7 files, 170 tests passed.

```bash
python3 -m unittest \
  qlever.tests.test_local_runtime_build_contract \
  qlever.tests.test_sqlite_backend_source_contract \
  qlever.tests.test_local_runtime_source_contract
bun test qlever/tests/QleverVectorIndexScan.test.ts \
  tests/storage/rdf/QleverSearchLocalCloudParity.test.ts \
  tests/integration/QleverProductDifferential.integration.test.ts \
  tests/scripts/check-qlever-installed-image-conformance.test.ts \
  --run --timeout=300000
bun run build:ts
bun run build:components
```

Result: SQLite/local build and source contracts 52 tests passed; focused
search/differential contracts 7 tests passed; TypeScript and Components.js
generation passed.

```bash
bun test tests/storage/rdf/RdfTextIndex.test.ts \
  tests/storage/rdf/RdfVectorIndex.test.ts \
  tests/storage/rdf/RdfQuadIndex.test.ts \
  tests/storage/rdf/PostgresRdfTextIndex.test.ts \
  tests/storage/rdf/PostgresRdfVectorIndex.test.ts \
  tests/storage/rdf/PostgresRdfEngine.test.ts --run
```

Result: 264 storage and engine tests passed, including stable-key constraints,
schema rejection, source moves, current-locator term identity, and FTS/VEC
product wiring.

Run from `/private/tmp/xpod-rdf-private-main.LDnl78` with the public SDK root:

```bash
XPOD_QLEVER_PUBLIC_SDK_ROOT=/private/tmp/xpod-main-port.I1PUdz/qlever \
  bun test qlever/tests/QleverPgExtension.test.ts --run
XPOD_QLEVER_PUBLIC_SDK_ROOT=/private/tmp/xpod-main-port.I1PUdz/qlever \
  bun test qlever/tests/QleverSemanticConformance.test.ts \
  qlever/tests/NativeParityBenchmarkRunner.test.ts --run --timeout=300000
```

Result: 165 private PG extension boundary tests passed; 2 optional tests that
require a live PostgreSQL connection were skipped. A further 69 semantic
conformance and native-parity runner tests passed.

Reader text representation is intentionally outside this index/query delivery:
Reader owns conversion of non-text resources into first-class text resources;
the accepted indexing path consumes those text resources without introducing a
second representation model or storing full text in RDF metadata.
