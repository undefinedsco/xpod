# QLever Local/Cloud public-private acceptance

Date: 2026-08-13

Status: code split verified; installed-image gate pending

## Accepted boundary

- Public `xpod-jobs` owns the shared QLever protocol/adapter surface, the SQLite/local runtime path, and product-level FTS/VEC indexing and retrieval wiring.
- Private `xpod-rdf-components` owns the PostgreSQL provider, PostgreSQL extension, PG/cloud image, and PG-only conformance evidence.
- `undefineds.co/native-builder` is only a build control plane. It checks out immutable source commits and returns artifacts; it does not mirror or own Xpod source.

## Product runtime contract

- Product SPARQL enters QLever through `RdfEngineLike.sparqlQuery`.
- Cloud PostgreSQL requires native QLever. The retired `nativeSparqlEnabled` / `nativeSparqlRequired` toggle is gone.
- Local starts a fixed SQLite-backed QLever runtime with only `--sqlite-path`; no local `.so`, `--provider`, provider path, or backend selector is exposed.
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

## Current verification evidence

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

## Remaining external gates

- Native compile/image conformance must run in the remote build lane, not on the user's Mac.
- The private PG static and semantic gates are owned by
  `xpod-rdf-components`; their installed-image execution remains a remote-only
  gate.
- Reader text-representation work that depends on newer `@undefineds.co/models` classes is blocked until that package is released or otherwise made available as a proper registry artifact.
