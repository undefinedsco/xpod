# Local QLever and Embedding Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Local SQLite and Cloud PostgreSQL expose one QLever SPARQL semantic surface, then give Local the same FTS-first and optional-VEC retrieval contract as Cloud.

**Architecture:** Reuse the existing `RdfEngineLike.sparqlQuery` boundary. Cloud keeps `PostgresRdfEngine.sparqlQuery -> xpod_rdf.native_sparql_query -> QLever`; Local adds `SolidRdfEngine.sparqlQuery -> LocalQleverNativeSparqlClient -> native-only QLever runtime -> SQLite physical backend`. The product `SparqlEngine` becomes QLever-required and fail-closed. Existing SQLite/PostgreSQL text and vector indexes remain the sole derived-search stores; the physical providers expose them as optional candidate capabilities without becoming another SPARQL evaluator.

**Tech Stack:** TypeScript/Bun/Vitest, C++20/CMake, QLever physical-backend ABI v7, SQLite, PostgreSQL 17, existing `RdfEngineLike` and `RdfNativeSparqlResult`, existing `RdfTextIndex`/`RdfVectorIndex`, Docker/OCI release artifacts.

---

## 2026-08-12 execution checkpoint

The PostgreSQL/QLever prerequisite is complete. The immutable PG17 candidate
passed the 14-case native-only semantic corpus with no failures, skips, or
authorization leakage, and the denied second mutation rollback probe left no
business facts or data-version advance. The accepted digest and runtime lock
are recorded in
`/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/reports/2026-08-12-pg17-semantic-acceptance.md`.

The repository boundary was finalized on 2026-08-13:

- public `xpod-jobs` owns the provider-neutral ABI/adapter, the SQLite physical
  backend, the statically linked Local runtime, Local FTS/VEC implementation,
  product wiring, and public runtime-SDK/local-runtime workflows;
- private `xpod-rdf-components` owns only the PostgreSQL provider, PostgreSQL
  extension, and Cloud/PG image;
- `undefineds.co/native-builder` is a build control plane. It receives a source
  repository plus immutable commit and returns artifacts; it does not mirror or
  own either source tree.

The Local delivery is one static executable. TypeScript starts it with only
`--sqlite-path`; there is no loadable Local `.so`, `--provider`, provider path,
or backend selector. Native compilation and image construction must not run on
the user's machine.

The task bodies below preserve the approved test-first sequence, but all
per-task commit commands and pre-2026-08-13 repository paths are historical
only. The file map and repository-boundary checkpoint above are authoritative.
Do not run an older command when it conflicts with that boundary. Preserve the
dirty worktrees and create one final squash commit after all Local/Cloud gates
pass.

---

## Non-negotiable invariants

- Product SPARQL always enters QLever; native absence or contract failure returns a structured error.
- No RDF3X, Quint, Comunica, TypeScript planner, syntax routing, or per-request fallback remains.
- SQLite and PostgreSQL store physical term keys, not QLever vocabulary positions.
- The common corpus must pass PostgreSQL/QLever before SQLite implementation is accepted.
- Local starts and queries without PostgreSQL, Cloud credentials, or Cloud fusion modules.
- FTS is usable without an embedding model; late VEC uses the existing `sourceKey + retrievalPointKey` identities.
- A missing embedding configuration, exhausted quota, transient Provider
  failure, or model change leaves durable reconciliation work; it is never
  converted into a completed SolidFS journal item with no later recovery path.
- Local SQLite is file-authority derived state. The Local runtime rejects
  persistent `operation=execute` updates. QLever `prepareUpdate` may use a
  rollback-only SQLite transaction to preserve sequential multi-operation
  semantics, but only `MixDataAccessor` commits the resulting delta to source
  files and refreshes the index.
- Full image conformance runs once at the end; focused ABI/provider/runtime/product tests must already be green.
- No migration, compatibility alias, feature toggle, backend selector, or new CLI option is introduced.
- Local ships one static runtime executable plus its manifest, with no adapter
  or SQLite provider shared library.
- The Local process accepts only `--sqlite-path` for backend construction; its
  backend is fixed at build time.
- Public and private sources remain in their authoritative Git repositories;
  the remote builder only checks out immutable revisions and returns artifacts.
- No native compilation or Docker image build runs on the user's machine.
- No intermediate commits are created; delivery is one reviewed squash commit.

## Mandatory remote-build precondition

Before the first native acceptance build:

1. use the dedicated CNB build lane, with SealOS only as the documented
   capacity fallback;
2. bind a persistent QLever source/object cache and container-layer cache;
3. cap and report CPU/memory so the user's desktop is not a hidden worker;
4. provide one wrapper that uploads only source deltas, runs focused targets,
   and returns compact logs plus immutable artifacts;
5. prove a no-op cached focused build before compiling the SQLite provider;
6. pass the public or private source repository and exact commit to the build
   job; never upload or maintain a second source copy in `native-builder`.

Every later `cmake`, `cmake --build`, QLever link, or `docker build` command in
this plan runs inside that remote lane. Local commands are limited to small
read-only checks and source-only tests that do not compile native code.

## File map

### `/Users/ganlu/develop/xpod-jobs`

- Own `qlever/rdf_protocol`, `qlever/qlever_adapter`, upstream patch series and
  the shared semantic/candidate contracts at ABI v7.
- Own `qlever/rdf_sqlite_backend`, `qlever/qlever_local_runtime`, their source
  contract tests, and the focused static-build scripts.
- Own `docker/qlever-runtime-sdk`, `docker/qlever-local-runtime`, and both
  publication workflows. The final Local artifact contains one executable and
  a manifest, not `.so` files.
- Create `src/storage/rdf/LocalQleverNativeSparqlClient.ts` and its test.
- Modify `src/storage/rdf/SolidRdfEngine.ts` to delegate its existing `sparqlQuery` seam to that client.
- Create `src/storage/rdf/QleverSparqlEngine.ts`; delete `SolidRdfSparqlEngine.ts` and its fallback types/tests.
- Modify `PostgresRdfEngine.ts` so Cloud QLever is required rather than gated by `nativeSparqlEnabled`.
- Wire existing Local `RdfTextIndex` and `RdfVectorIndex` to the same SQLite file used by the RDF facts.
- Remove compatibility/Quint/RDF3X product routing and obsolete configuration.
- Add product differential, Local startup, search-parity, and installed-image tests.

### `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend`

- Consume the public SDK by immutable image digest or an explicit public SDK
  source root during source-only tests.
- Own `qlever/rdf_pg_backend`, `qlever/qlever_pg_extension`, PG17 image files,
  Cloud release verification, and PG-only evidence.
- Do not contain the shared adapter/protocol, SQLite provider, Local runtime,
  or public runtime SDK source.

### `https://cnb.cool/undefineds.co/native-builder`

- Own only remote-build routing, cache policy, resource limits, and artifact
  transfer.
- Accept `XPOD_SOURCE_REPOSITORY` and `XPOD_SOURCE_COMMIT`; do not mirror Xpod
  source or become a third component repository.

### Task 1: Freeze one provider-neutral contract and complete corpus

**Files:**
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverBackendContract.test.ts`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/scripts/check-qlever-backend-contract.cjs`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/backend_contract/src/xpod_rdf_backend_contract.cpp`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/rdf_pg_backend/src/xpod_rdf_pg_backend.cpp`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverPgBackendProvider.test.ts`
- Delete: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/scripts/check-qlever-rdf3x-independence.cjs`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/ownership/atomic-backend-contract.json`
- Create: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/fixtures/qlever-semantic-conformance.cjs`
- Create: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverSemanticConformance.test.ts`

- [ ] **Step 1: Write RED backend-selection tests**

Replace the current SQLite rejection with assertions that `--backend=pg` and
`--backend=sqlite` are the only accepted values. With no live target, each
returns explicit pending evidence for its own missing input; an unknown backend
exits non-zero. Delete the standalone PG provider's retired
`scan_block_metadata` callback and feature bit, which still references the
already-removed CRv2 `perm_index_blocks` SQL surface. Add a `sqlite` ownership
entry whose required callback list is exactly the resulting PostgreSQL
21-callback list, initially `pending` with no claimed artifact.

Delete the obsolete `check-qlever-rdf3x-independence` evidence path as well: it
executes the already-removed `xpod_rdf.bgp_count` whole-query lane and therefore
cannot prove the current RDF3X product path. Do not replace it with ordinary SQL
under the old RDF3X name; RDF3X verification remains owned by its actual engine
boundary.

- [ ] **Step 2: Freeze the complete semantic corpus**

Export an immutable array from `qlever-semantic-conformance.cjs`. Every case has
`id`, file-authority `documents`, real SPARQL `updates`, `query`,
`acceptMediaType`, `accessScope`, and `expectedCanonical`. Documents enter the
RDF engine through source replacement; only entries in `updates` exercise
prepared-update authority. The required IDs are:

```ts
const REQUIRED_CASES = [
  'term/same-term-vs-value-equality',
  'term/numeric-promotion',
  'term/boolean-ebv',
  'term/nan-infinity-order',
  'term/date-time-order',
  'term/language-literal',
  'term/incompatible-relational-error',
  'term/unbound-expression-error',
  'algebra/optional-union-minus-exists',
  'algebra/aggregation-order-pagination-bag',
  'graph/default-and-named',
  'scope/graph-denied',
  'scope/source-denied',
  'update/insert-delete-where',
] as const
```

Expected results are checked in. They are never generated by another query
engine. Expression errors record their exact SPARQL binding disposition: a
FILTER error removes the mapping, while a BIND error leaves its target unbound;
they must not be promoted to fake query-level error categories. Scope cases seed
allowed and denied rows and prove denied keys never enter scans, term lookup,
caches, or final bindings.

- [ ] **Step 3: Run RED**

```bash
cd /Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend
bun test qlever/tests/QleverBackendContract.test.ts qlever/tests/QleverSemanticConformance.test.ts
```

Expected: FAIL because SQLite is rejected and the corpus is absent.

- [ ] **Step 4: Generalize selection only**

Keep one provider-neutral public contract/exerciser and one evidence schema.
The public runner exercises the compiled-in SQLite backend; the private PG
runner consumes the public contract and exercises `rdf_pg_backend`. This is a
test-harness selection only, not a product runtime selector.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun test qlever/tests/QleverBackendContract.test.ts qlever/tests/QleverSemanticConformance.test.ts
git add qlever/tests/QleverBackendContract.test.ts qlever/tests/QleverSemanticConformance.test.ts qlever/tests/fixtures/qlever-semantic-conformance.cjs qlever/scripts/check-qlever-backend-contract.cjs qlever/ownership/atomic-backend-contract.json
git diff --cached --check
git commit -m "🧭 Hold both stores to one QLever contract" -m "Freeze the complete semantic corpus before SQLite can claim product support." -m "Constraint: Expected results are checked in, never generated by a fallback evaluator" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: backend selection and semantic-corpus shape"
```

### Task 2: Prove the PostgreSQL/QLever baseline first

**Files:**
- Create: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/scripts/check-qlever-semantic-conformance.cjs`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverSemanticConformance.test.ts`
- Create: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/reports/data/pg-semantic-conformance.json`
- Modify: `/Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/package.json`

- [ ] **Step 1: Write the RED evidence test**

The test reads the committed artifact and asserts:

```ts
expect(artifact.backend).toBe('pg')
expect(artifact.engine).toBe('qlever-native-only')
expect(artifact.skipped).toEqual([])
expect(artifact.caseIds).toEqual(REQUIRED_CASES)
expect(artifact.failed).toEqual([])
expect(artifact.authorization.deniedRowsObserved).toBe(0)
expect(artifact.canonicalDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
```

- [ ] **Step 2: Run RED**

```bash
bun test qlever/tests/QleverSemanticConformance.test.ts
```

Expected: FAIL because the live PG artifact does not exist.

- [ ] **Step 3: Implement the PG lane**

`check-qlever-semantic-conformance.cjs --backend=pg` must require
`XPOD_QLEVER_PG_DSN`, reset an isolated schema, execute every setup/query through
`xpod_rdf.native_sparql_query`, canonicalize SPARQL JSON/N-Triples, compare the
checked-in expectation, and write the artifact. Missing DSN is an error, never a
skip. Add `check:qlever-semantic-conformance` to `package.json`.

- [ ] **Step 4: Run the live PG gate**

Use the existing PG17 QLever image fixture from
`docker/postgres17-qlever`; do not rebuild the final Xpod image:

```bash
XPOD_QLEVER_PG_DSN=postgres://postgres:xpod@127.0.0.1:55432/xpod bun run check:qlever-semantic-conformance -- --backend=pg
bun test qlever/tests/QleverSemanticConformance.test.ts
```

The PostgreSQL container must already be the verified QLever PG17 fixture. If
the corpus exposes a PG/QLever defect, fix that adapter/provider/extension defect
and rerun this gate before starting SQLite.

- [ ] **Step 5: Commit**

```bash
git add package.json qlever/scripts/check-qlever-semantic-conformance.cjs qlever/tests/QleverSemanticConformance.test.ts qlever/reports/data/pg-semantic-conformance.json
git diff --cached --check
git commit -m "🧪 Freeze PostgreSQL QLever semantics before Local" -m "A live native-only artifact now proves the complete common corpus and authorization boundary." -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: live PG17 semantic conformance"
```

### Task 3: Implement and exercise the public SQLite physical backend

**Files:**
- Create: `/Users/ganlu/develop/xpod-jobs/qlever/rdf_sqlite_backend/CMakeLists.txt`
- Create: `/Users/ganlu/develop/xpod-jobs/qlever/rdf_sqlite_backend/include/xpod_rdf_sqlite_backend.h`
- Create: `/Users/ganlu/develop/xpod-jobs/qlever/rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp`
- Create source/build contract tests under `/Users/ganlu/develop/xpod-jobs/qlever/tests/`.
- Modify the public backend contract and ABI checks under `/Users/ganlu/develop/xpod-jobs/qlever/`.

- [ ] **Step 1: Write RED source, build, and live-contract tests**

Assert the compiled-in backend links SQLite, uses ABI v7, and registers the
exact required callbacks. Do not mention
nonexistent text/vector cursor APIs. Initially `text_search`,
`estimate_text_search`, `vector_search`, and `estimate_vector_search` return
`XPOD_RDF_STATUS_UNSUPPORTED`, and their feature bits are absent.

The live test creates a temporary SQLite database with the production schema,
runs the shared backend contract, and requires all 21 callback statuses to be
`exercised`; pending evidence fails.

- [ ] **Step 2: Run RED**

```bash
bun test qlever/tests/QleverSqliteBackendProvider.test.ts qlever/tests/QleverBackendContract.test.ts
```

- [ ] **Step 3: Implement against the actual Local schema**

Use these existing columns exactly:

```text
rdf_terms: id, kind, value, value_head, datatype_id, lang, hash,
           normalized_text, numeric_value
rdf_sources: id, source, workspace, local_path, content_type,
             source_version, source_hash, updated_at
rdf_quads: graph_id, subject_id, predicate_id, object_id,
           source_file_id, source_line_no
rdf_index_metadata: key, value
```

The provider must:

- scan the eight existing permutation indexes and never create a second facts table;
- resolve datatype IDs losslessly and return lexical value/language exactly;
- keep term identity separate from numeric/date/value comparison;
- use snapshots/facts version to invalidate caches;
- apply graph/source/access scope in SQL before returning keys;
- expose the ABI transaction/mutation callbacks only for rollback-only
  `prepareUpdate` evaluation; a successful preparation always rolls back its
  temporary SQLite transaction before returning the prepared delta;
- reject durable/direct mutation execution from the Local runtime, so a crash
  cannot make SQLite diverge from the Pod authority files;
- preserve sequential visibility inside a multi-operation prepared update and
  prove that the rolled-back staging transaction leaves facts/data version
  unchanged until the authority applies the delta;
- fail startup on an incompatible schema version; do not migrate it;
- declare only capabilities it actually implements.

- [ ] **Step 4: Run the fast native gate**

Run these inside the upgraded remote build workspace, through its focused-build
wrapper; do not execute them on the user's machine:

```bash
cmake -S qlever/qlever_local_runtime -B .test-data/qlever-local-runtime
cmake --build .test-data/qlever-local-runtime --target xpod_qlever_local_runtime --parallel 2
bun run check:qlever-backend-contract -- --backend=sqlite
python3 -m unittest qlever.tests.test_sqlite_backend_source_contract qlever.tests.test_local_runtime_build_contract
```

Expected: the focused build emits one statically linked Local runtime; no
SQLite provider shared library is emitted or loaded. Its callbacks and ABI
match the public contract.

- [ ] **Step 5: Commit**

```bash
git add qlever/rdf_sqlite_backend qlever/tests/QleverSqliteBackendProvider.test.ts qlever/scripts/check-qlever-backend-contract.cjs qlever/ownership/atomic-backend-contract.json qlever/reports/data/sqlite-backend-contract.json
git diff --cached --check
git commit -m "🗄️ Serve Local facts through the physical QLever ABI" -m "SQLite now fulfills the same required scan, vocabulary, scope, and mutation contract as PostgreSQL." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: focused CMake provider build and exercised SQLite backend contract"
```

### Task 4: Add one public, static, native-only Local QLever runtime

**Files:**
- Create: `/Users/ganlu/develop/xpod-jobs/qlever/qlever_local_runtime/CMakeLists.txt`
- Create: `/Users/ganlu/develop/xpod-jobs/qlever/qlever_local_runtime/src/xpod_qlever_local_runtime.cpp`
- Modify: `/Users/ganlu/develop/xpod-jobs/qlever/scripts/check-qlever-real-runtime.cjs`
- Create source/build/runtime contract tests under `/Users/ganlu/develop/xpod-jobs/qlever/tests/`.
- Modify: `/Users/ganlu/develop/xpod-jobs/package.json`

- [ ] **Step 1: Write RED protocol and policy tests**

The runtime emits one ready line, accepts request-correlated JSONL, and returns
the existing native envelope:

```json
{"type":"ready","abiVersion":1,"physicalBackendAbiVersion":7,"backend":"sqlite"}
{"id":"1","type":"query","sparql":"ASK {}","options":{"basePath":"http://localhost/","operation":"queryBoolean","acceptMediaType":"application/sparql-results+json"}}
{"id":"1","type":"result","result":{"status":"ok","mediaType":"application/sparql-results+json","body":"{\"boolean\":true}","profile":{}}}
```

Malformed input yields a correlated structured error; provider load, ABI, or
adapter initialization failure exits non-zero. Source and runtime evidence must
contain `XPOD_QLEVER_EXECUTION_NATIVE_ONLY` and must not contain a compatibility
policy. A SPARQL update with `operation=execute` returns a structured
`update_authority_required` error. The same update with
`operation=prepareUpdate` returns the prepared-delta media type and leaves the
SQLite facts/data version unchanged.

- [ ] **Step 2: Run RED**

```bash
bun test qlever/tests/QleverLocalRuntime.test.ts
```

- [ ] **Step 3: Implement the real process boundary**

`qlever_local_runtime/CMakeLists.txt` is a real CMake root. It compiles the
adapter and SQLite backend into `xpod_qlever_local_runtime` and statically links
the same locked/patched upstream QLever objects used by
`check-qlever-real-runtime.cjs`. Extend that existing script with
`--local-runtime` so it reuses `.test-data/qlever-full-build` rather than
configuring or recompiling QLever from scratch. The binary constructs SQLite
from `--sqlite-path`; it has no dynamic-provider option.

- [ ] **Step 4: Run cheap gates before one cached full link**

```bash
bun test qlever/tests/QleverLocalRuntime.test.ts qlever/tests/QleverSqliteBackendProvider.test.ts
bun run check:rdf-protocol-abi
bun run check:qlever-real-runtime -- --local-runtime --qlever-source "$XPOD_QLEVER_SOURCE_DIR"
```

The last command may perform the one necessary cached QLever build/link in the
remote builder. Do not build a Docker image yet, do not execute it locally, and
do not delete the remote `.test-data/qlever-full-build` cache between
iterations.

- [ ] **Step 5: Commit**

```bash
git add package.json qlever/qlever_local_runtime qlever/scripts/check-qlever-real-runtime.cjs qlever/tests/QleverLocalRuntime.test.ts
git diff --cached --check
git commit -m "🚇 Expose SQLite QLever through a native-only process" -m "Reuse the locked adapter and isolate native crashes without adding a Node ABI or second evaluator." -m "Rejected: Node native addon | process isolation avoids Node release coupling" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: protocol, ABI, provider, and cached real-QLever runtime link"
```

### Task 5: Require live SQLite/PostgreSQL semantic equality

**Files:**
- Create: `/Users/ganlu/develop/xpod-jobs/scripts/check-qlever-sqlite-semantic-conformance.ts`
- Create: `/Users/ganlu/develop/xpod-jobs/src/acceptance/QleverSemanticConformance.ts`
- Create the SQLite semantic artifact in the public acceptance workspace.
- Read the immutable PostgreSQL semantic artifact from private PG acceptance;
  do not move PG source into the public repository.

- [ ] **Step 1: Write the RED differential assertions**

The test requires both live artifacts, the exact same case IDs, no skips or
failures, and equality of per-case canonical values/error categories. It also
requires an aggregate cross-backend digest:

```ts
expect(sqlite.caseResults).toEqual(pg.caseResults)
expect(sqlite.authorization).toEqual(pg.authorization)
expect(cross.status).toBe('passed')
expect(cross.sqliteDigest).toBe(cross.postgresqlDigest)
```

- [ ] **Step 2: Run RED**

```bash
cd /Users/ganlu/develop/xpod-jobs
bun test tests/helpers/rdf/LocalQleverSemanticAuthorityHarness.test.ts --run
```

Expected: FAIL because the SQLite and cross-backend artifacts are absent.

- [ ] **Step 3: Add the SQLite lane to the same runner**

The public harness creates a production-shaped temporary SQLite database and
starts the static `xpod_qlever_local_runtime` with only `--sqlite-path`.
Fixture setup uses
the canonical test authority writer. The update case calls
`operation=prepareUpdate`, applies the returned delta through that authority
writer, refreshes the same SQLite index, and then queries the result. It never
uses Local `operation=execute`. The runner shares one canonicalizer with the PG
lane. It requires an explicit path to the built runtime and fails if it is
missing; there is no provider-path input and it never skips.

- [ ] **Step 4: Run the live differential gate**

```bash
XPOD_QLEVER_SQLITE_RUNTIME_COMMAND=.test-data/qlever-local-runtime/xpod_qlever_local_runtime bun scripts/check-qlever-sqlite-semantic-conformance.ts
XPOD_QLEVER_PG_DSN=postgres://postgres:xpod@127.0.0.1:55432/xpod bun run check:qlever-semantic-conformance -- --backend=pg
bun test tests/helpers/rdf/LocalQleverSemanticAuthorityHarness.test.ts --run
```

All 14 cases and both scope denials must match. A mismatch is fixed in the
physical backend/adapter, never by result normalization that erases semantic
differences.

- [ ] **Step 5: Commit**

```bash
git add qlever/scripts/check-qlever-semantic-conformance.cjs qlever/tests/QleverSemanticConformance.test.ts qlever/reports/data/sqlite-semantic-conformance.json qlever/reports/data/cross-backend-semantic-conformance.json
git diff --cached --check
git commit -m "⚖️ Prove Local and Cloud share QLever semantics" -m "The complete native-only corpus now has byte-stable canonical equality across SQLite and PostgreSQL." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: live cross-backend semantic conformance with no skipped cases"
```

### Task 6: Reuse the existing native-SPARQL seam in Xpod

**Files:**
- Create: `src/storage/rdf/LocalQleverNativeSparqlClient.ts`
- Create: `src/storage/rdf/QleverSparqlEngine.ts`
- Delete: `src/storage/rdf/SolidRdfSparqlEngine.ts`
- Modify: `src/storage/rdf/SolidRdfEngine.ts`
- Modify: `src/storage/rdf/PostgresRdfEngine.ts`
- Modify: `src/storage/rdf/types.ts`
- Modify: `src/storage/rdf/index.ts`
- Modify: `src/index.ts`
- Create: `tests/fixtures/fake-qlever-native-runtime.js`
- Create: `tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts`
- Create: `tests/storage/rdf/QleverSparqlEngine.test.ts`
- Delete: `tests/storage/rdf/SolidRdfSparqlEngine.test.ts`
- Modify: `tests/storage/rdf/SolidRdfEngine.test.ts`
- Modify: `tests/storage/rdf/PostgresRdfEngine.test.ts`

- [ ] **Step 1: Write RED process-client tests**

The fake runtime covers ready, SELECT, ASK, graph, update, correlated error,
malformed JSON, startup timeout, unexpected exit, abort, and request timeout.
The client returns `RdfNativeSparqlResult` directly; no public result codec or
health abstraction is introduced.

```ts
await expect(client.query('ASK {}', options)).resolves.toMatchObject({
  status: 'ok',
  mediaType: 'application/sparql-results+json',
})
await expect(missingRuntime.query('ASK {}', options)).rejects.toMatchObject({
  code: 'qlever_runtime_unavailable',
})
```

- [ ] **Step 2: Write RED QLever-only product-engine tests**

`QleverSparqlEngine` accepts only an `RdfEngineLike` whose `sparqlQuery` is
callable. Test bindings, boolean, quads, construct/listGraphs, access-scope
forwarding, timeout/abort, and close. Direct `queryVoid` update fails with
`update_authority_required`; a product HTTP update is separately proven to call
`MixDataAccessor.executeSparqlUpdate -> prepareSparqlUpdate -> authority
commit`. Missing native support, `unsupported`, and `error` all fail explicitly.
The constructor has no `fallback`, `shadowStore`, `enablePrimary`, or
adapter/compiler option.

- [ ] **Step 3: Run RED**

```bash
bun run test:run -- tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts tests/storage/rdf/QleverSparqlEngine.test.ts
```

- [ ] **Step 4: Implement the minimum seam**

- `LocalQleverNativeSparqlClient` owns one persistent child process and request map.
- `SolidRdfEngineOptions.nativeSparqlClient` accepts that client; its public
  `sparqlQuery` delegates to it and returns a structured unavailable error when
  omitted. RDF facts, text/vector indexing, and `RdfQuery` methods stay in the
  existing engine.
- `PostgresRdfEngine.sparqlQuery` becomes an always-present method. Remove
  `nativeSparqlEnabled`; opening Cloud validates
  `xpod_rdf.native_sparql_capabilities()` and fails closed when absent.
- `QleverSparqlEngine` keeps only the existing native envelope parsing and CSS
  `SparqlEngine` adaptation. It refuses direct updates so the handler/accessor
  authority path is mandatory. Delete embedded `RdfSparqlAdapter` compilation,
  fallback counters/budgets, compatibility engine calls, and product-view
  query rewrites from the old class.
- Delete `SolidRdfSparqlEngine`; do not leave a re-export or alias.

- [ ] **Step 5: Run GREEN**

```bash
bun run test:run -- tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts tests/storage/rdf/QleverSparqlEngine.test.ts tests/storage/rdf/SolidRdfEngine.test.ts tests/storage/rdf/PostgresRdfEngine.test.ts
bun run build:ts
! rg "SolidRdfSparqlEngine|SolidRdfSparqlFallback|fallbackWith" src tests/storage/rdf config
```

- [ ] **Step 6: Commit**

```bash
git add src/storage/rdf/LocalQleverNativeSparqlClient.ts src/storage/rdf/QleverSparqlEngine.ts src/storage/rdf/SolidRdfSparqlEngine.ts src/storage/rdf/SolidRdfEngine.ts src/storage/rdf/PostgresRdfEngine.ts src/storage/rdf/types.ts src/storage/rdf/index.ts src/index.ts tests/fixtures/fake-qlever-native-runtime.js tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts tests/storage/rdf/QleverSparqlEngine.test.ts tests/storage/rdf/SolidRdfSparqlEngine.test.ts tests/storage/rdf/SolidRdfEngine.test.ts tests/storage/rdf/PostgresRdfEngine.test.ts
git diff --cached --check
git commit -m "🚦 Make QLever the only product SPARQL engine" -m "Reuse the native envelope seam in both editions and fail closed instead of compiling or routing queries elsewhere." -m "Rejected: New QleverRdfEngine | it would duplicate storage and indexing responsibilities" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: process failures, all SPARQL result shapes, storage delegation, and TypeScript build"
```

### Task 7: Expose existing Local FTS and optional VEC through QLever

**Prerequisite:** Reader plan Tasks 8-10 have made `sourceKey + retrievalPointKey`
the shared text/vector identity and removed duplicate chunking.

**Files:**
- Modify: `/Users/ganlu/develop/xpod-jobs/qlever/rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp`
- Modify public SQLite candidate source-contract tests under `/Users/ganlu/develop/xpod-jobs/qlever/tests/`.
- Modify: `/Users/ganlu/develop/xpod-jobs/scripts/check-qlever-sqlite-semantic-conformance.ts`
- Modify: `config/local.json`
- Modify: `src/api/container/rdf.ts`
- Modify: `tests/storage/rdf/RdfTextIndex.test.ts`
- Modify: `tests/storage/rdf/RdfVectorIndex.test.ts`
- Modify: `tests/service/RdfRunContextRetriever.service.test.ts`
- Modify: `tests/api/container/rdf.test.ts`
- Create: `tests/storage/rdf/QleverSearchLocalCloudParity.test.ts`

- [ ] **Step 1: Write RED callback and product tests**

Native tests require the exact ABI fields:

```cpp
backend.text_search = sqlite_text_search;
backend.estimate_text_search = sqlite_estimate_text_search;
backend.vector_search = sqlite_vector_search;
backend.estimate_vector_search = sqlite_estimate_vector_search;
backend.resolve_retrieval_points = sqlite_resolve_retrieval_points;
```

Product tests create one SQLite file containing facts plus the already existing
`rdf_text_*` and `rdf_vector_*` tables. Assert FTS works with zero vector rows,
adding vectors later preserves every key, QLever candidate results use the
composite identity, denied sources never appear, and Local/Cloud canonical
candidate/result shapes match.

- [ ] **Step 2: Run RED**

```bash
cd /Users/ganlu/develop/xpod-jobs
python3 -m unittest qlever.tests.test_sqlite_backend_source_contract
bun run test:run -- tests/storage/rdf/QleverSearchLocalCloudParity.test.ts tests/service/RdfRunContextRetriever.service.test.ts tests/api/container/rdf.test.ts
```

- [ ] **Step 3: Implement optional candidate callbacks over existing tables**

Do not add tables in `RdfQuadIndex`. Read the schemas already owned by
`RdfTextIndex` and `RdfVectorIndex`. Advertise text/vector feature bits only
after the corresponding tables/schema versions are present. Missing vector
tables/model rows return an empty supported candidate set so FTS remains usable;
schema mismatch returns a contract error. Candidate rows carry score,
`sourceKey`, `retrievalPointKey`, current source URI, and snapshot/facts version.

- [ ] **Step 4: Wire Local indexes without a backend switch**

In `config/local.json`, construct `RdfTextIndex` and `RdfVectorIndex` with the
same `rdfIndexPath` as `SolidRdfEngine` and inject both. Construct the Local
native client and inject it as `nativeSparqlClient`. `src/api/container/rdf.ts`
must return the Local indexing service/retriever even when embedding is absent;
only vector generation is optional.

- [ ] **Step 5: Run GREEN**

```bash
cd /Users/ganlu/develop/xpod-jobs
python3 -m unittest qlever.tests.test_sqlite_backend_source_contract
bun run test:run -- tests/storage/rdf/RdfTextIndex.test.ts tests/storage/rdf/RdfVectorIndex.test.ts tests/storage/rdf/QleverSearchLocalCloudParity.test.ts tests/service/RdfRunContextRetriever.service.test.ts tests/api/container/rdf.test.ts
bun run build:ts
```

- [ ] **Step 6: Include native and product changes in the final public squash**

```bash
cd /Users/ganlu/develop/xpod-jobs
git add qlever/rdf_sqlite_backend/src/xpod_rdf_sqlite_backend.cpp qlever/tests/QleverSqliteCandidateBackend.test.ts qlever/scripts/check-qlever-semantic-conformance.cjs
git diff --cached --check
```

```bash
cd /Users/ganlu/develop/xpod-jobs
git add config/local.json src/api/container/rdf.ts tests/storage/rdf/RdfTextIndex.test.ts tests/storage/rdf/RdfVectorIndex.test.ts tests/storage/rdf/QleverSearchLocalCloudParity.test.ts tests/service/RdfRunContextRetriever.service.test.ts tests/api/container/rdf.test.ts
git diff --cached --check
```

Do not commit here; the commands only enumerate the eventual squash scope.

### Task 8: Ship the Local runtime and wire both editions without toggles

**Public native artifact files:**
- Create: `docker/qlever-local-runtime/Dockerfile`
- Create: `qlever/tests/QleverLocalRuntimeImage.test.ts`
- Create: `.github/workflows/publish-qlever-local-runtime.yml`

**Xpod files:**
- Modify: `Dockerfile`
- Modify: `config/local.json`
- Modify: `config/cloud.json`
- Modify: `config/xpod.base.json`
- Modify: `config/xpod.json`
- Modify: `config/bun.json`
- Modify: `config/cli.json`
- Modify: `config/resolver.json`
- Modify: `tests/integration/NativeRdfProductHttp.integration.test.ts`
- Create: `tests/integration/QleverLocalStartup.integration.test.ts`
- Create: `tests/integration/QleverProductDifferential.integration.test.ts`

- [ ] **Step 1: Write RED packaging and configuration tests**

The native image test requires exactly one Local executable plus a manifest:

```text
/opt/xpod/qlever/bin/xpod_qlever_local_runtime
/opt/xpod/qlever/manifest.json
```

It also asserts that `libxpod_qlever_adapter.so` and
`libxpod_rdf_sqlite_backend.so` are absent.

The Xpod config tests require `QleverSparqlEngine` in Local and Cloud, a Local
native client, Cloud `PostgresRdfEngine`, and absence of
`CompatibilitySparqlEngine`, `ShadowRdfQuintStore`, `enablePrimary`, fallback,
and `rdfNativeSparqlEnabled`. Local startup must succeed with all PG/Cloud env
variables removed and answer SELECT/ASK through the runtime.

- [ ] **Step 2: Run RED**

```bash
cd /Users/ganlu/develop/xpod-jobs
bun test qlever/tests/QleverLocalRuntimeImage.test.ts
bun run test:run -- tests/integration/QleverLocalStartup.integration.test.ts tests/integration/QleverProductDifferential.integration.test.ts tests/integration/NativeRdfProductHttp.integration.test.ts
```

- [ ] **Step 3: Build a self-contained OCI artifact from the existing SDK**

The public Dockerfile uses the immutable
`ghcr.io/undefinedsco/xpod-qlever-sdk` build stage, builds only the
statically linked Local runtime, and emits a Debian-glibc runtime artifact with a
machine-readable ABI/QLever/source digest manifest. Its smoke stage runs the
binary with `--sqlite-path`, checks every dynamic dependency, and fails if a
Local adapter/provider `.so` was emitted.

The workflow publishes only immutable `sha-<40 hex>` tags and a digest output.
This is the artifact boundary between repositories; do not copy sibling build
directories or commit native binaries into Xpod.

- [ ] **Step 4: Wire Xpod to a pinned artifact**

Use a Docker build stage:

```dockerfile
ARG XPOD_QLEVER_LOCAL_RUNTIME_IMAGE
FROM ${XPOD_QLEVER_LOCAL_RUNTIME_IMAGE} AS qlever-local-runtime
```

Build and runtime stages both use Debian/glibc variants, then copy
`/opt/xpod/qlever` from that stage. `config/local.json` uses the fixed packaged
binary and the same `rdfIndexPath`; its runtime args are exactly
`["--sqlite-path", rdfIndexPath]`. No new CLI or ENV configuration is added.
Delete the obsolete `rdfNativeSparqlEnabled` entries from `cli.json` and
`resolver.json`. Cloud calls the PG extension and does not copy/load the SQLite
provider.

Before a release commit, replace the build argument default with the exact
published OCI digest. A mutable tag or placeholder must never be committed.
Publishing that artifact is an explicit external release gate; local
verification may pass a locally built image tag through `--build-arg`.

- [ ] **Step 5: Prove product differential behavior before the image gate**

`QleverProductDifferential.integration.test.ts` reuses the native corpus and
runs it through the actual Xpod `QleverSparqlEngine` instances: Local runtime +
SQLite and Cloud PG extension + PostgreSQL. It compares canonical results,
scope denials, FTS-only results, and late-vector results. No missing runtime/PG
condition is skipped; the command must supply both fixtures.

- [ ] **Step 6: Run GREEN and commit each repository**

```bash
cd /Users/ganlu/develop/xpod-jobs
bun test qlever/tests/QleverLocalRuntimeImage.test.ts
docker build -f docker/qlever-local-runtime/Dockerfile -t xpod-qlever-local-runtime:dev .
```

```bash
cd /Users/ganlu/develop/xpod-jobs
bun run test:run -- tests/integration/QleverLocalStartup.integration.test.ts tests/integration/QleverProductDifferential.integration.test.ts tests/integration/NativeRdfProductHttp.integration.test.ts
bun run build:components
bun run build:ts
```

```bash
cd /Users/ganlu/develop/xpod-jobs
git add docker/qlever-local-runtime/Dockerfile qlever/tests/QleverLocalRuntimeImage.test.ts .github/workflows/publish-qlever-local-runtime.yml Dockerfile config/local.json config/cloud.json config/xpod.base.json config/xpod.json config/bun.json config/cli.json config/resolver.json tests/integration/NativeRdfProductHttp.integration.test.ts tests/integration/QleverLocalStartup.integration.test.ts tests/integration/QleverProductDifferential.integration.test.ts
git diff --cached --check
git commit -m "🔌 Ship one QLever boundary in Local and Cloud" -m "Public Xpod owns the static SQLite runtime while private components own only the PG extension; neither exposes an engine selector." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: static runtime image, Local startup, product differential, Components.js, and TypeScript build"
```

### Task 9: Delete obsolete product routing and run final acceptance

**Files:**
- Delete: `src/storage/rdf/ShadowRdfQuintStore.ts`
- Delete: `tests/storage/rdf/ShadowRdfQuintStore.test.ts`
- Modify: `src/storage/rdf/SolidRdfEngine.ts`
- Modify: `src/storage/rdf/index.ts`
- Modify: `src/index.ts`
- Modify: `tests/storage/rdf/DefaultRdfImport.test.ts`
- Create: `scripts/check-qlever-installed-image-conformance.ts`
- Modify: `package.json`
- Modify: `docs/COMPONENTS.md`
- Modify: `docs/rdf-engine-spec.md`

- [ ] **Step 1: Write RED absence and installed-image tests**

The source/config test proves no product import/config references the old
shadow/compatibility engine or native feature toggle. The installed-image
script requires an explicit Xpod image and PG17 QLever image, starts Local with
no PostgreSQL, starts Cloud with PG17, runs the complete semantic/search corpus,
compares digests, checks scope denial, and rejects logs containing product
fallback markers.

- [ ] **Step 2: Remove obsolete routing, not operational benchmarks**

Delete `ShadowRdfQuintStore` and all product configuration/export references.
Remove `rdf3xPrimary`, automatic RDF3X selection, compatibility-store shadow
writes, and their options from `SolidRdfEngine`. RDF3X source/benchmark files may
remain only as an explicitly non-product operational benchmark allowed by the
approved spec; Local/Cloud runtime config and product SPARQL imports must not
reference them.

The separate terminal remote-endpoint ACL adapter now talks to SPARQL Protocol
directly over HTTP; do not reintroduce `CompatibilitySparqlEngine`, a Comunica
alias, or a fallback bridge.

- [ ] **Step 3: Run cheap absence/focused gates**

```bash
! rg "ShadowRdfQuintStore|SolidRdfSparqlEngine|fallbackWith|rdfNativeSparqlEnabled|enablePrimary" src/storage/rdf config/local.json config/cloud.json config/xpod.base.json config/xpod.json config/bun.json
bun run test:run -- tests/storage/rdf/DefaultRdfImport.test.ts tests/storage/rdf/QleverSparqlEngine.test.ts tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts tests/storage/rdf/QleverSearchLocalCloudParity.test.ts tests/integration/QleverLocalStartup.integration.test.ts tests/integration/QleverProductDifferential.integration.test.ts
bun run build
bun run typecheck:test
```

- [ ] **Step 4: Run native verification in dependency order**

```bash
cd /Users/ganlu/develop/xpod-jobs
python3 -m unittest qlever.tests.test_local_runtime_source_contract qlever.tests.test_local_runtime_build_contract qlever.tests.test_sqlite_backend_source_contract qlever.tests.test_qlever_runtime_sdk_contract qlever.tests.test_resolve_runtime_sdk_build
bun test qlever/tests/QleverLocalRuntimeImage.test.ts tests/install/local-runtime-delivery.test.ts tests/storage/rdf/LocalQleverNativeSparqlClient.test.ts tests/storage/rdf/QleverSparqlEngine.test.ts --run
bun run check:rdf-protocol-abi
XPOD_QLEVER_PUBLIC_SDK_ROOT=/Users/ganlu/develop/xpod-jobs/qlever bun test /Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverPgBackendProvider.test.ts /Users/ganlu/develop/xpod-rdf-components/.worktrees/qlever-atomic-backend/qlever/tests/QleverPgExtension.test.ts
```

- [ ] **Step 5: Run the final installed-image gate once**

```bash
cd /Users/ganlu/develop/xpod-jobs
docker build --build-arg XPOD_QLEVER_LOCAL_RUNTIME_IMAGE=xpod-qlever-local-runtime:dev -t xpod-qlever-conformance:local .
XPOD_INSTALLED_IMAGE_REF=registry.example/xpod@sha256:<digest> XPOD_PG17_QLEVER_IMAGE_REF=registry.example/xpod-rdf-postgres@sha256:<digest> XPOD_QLEVER_SEMANTIC_FIXTURE_PATH=<fixture.cjs> bun scripts/check-qlever-installed-image-conformance.ts
bun run test:integration
```

Expected: Local and Cloud installed paths pass the same corpus; Local FTS works
without embedding; late embedding fills existing keys; no test is skipped; full
integration exits 0.

- [ ] **Step 6: Update docs and commit**

Document the common QLever product seam, SQLite/PG physical ownership, Local
runtime process, optional candidate capabilities, FTS-first behavior, artifact
pinning, focused verification order, and the narrow non-product status of any
remaining RDF3X benchmark code.

```bash
git add src/storage/rdf/ShadowRdfQuintStore.ts src/storage/rdf/SolidRdfEngine.ts src/storage/rdf/index.ts src/index.ts tests/storage/rdf/ShadowRdfQuintStore.test.ts tests/storage/rdf/DefaultRdfImport.test.ts scripts/check-qlever-installed-image-conformance.ts package.json docs/COMPONENTS.md docs/rdf-engine-spec.md
git diff --cached --check
git commit -m "✅ Enforce QLever parity at the shipped product boundary" -m "Remove obsolete Pod RDF routing and make installed Local/Cloud semantic plus search conformance the release gate." -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: native contract, product focused tests, build, typecheck, installed image, and full integration"
```

## Execution order and stop conditions

1. Do not start SQLite implementation until the live PG artifact in Task 2 is green.
2. Do not run a real QLever link until provider/protocol tests are green.
3. Do not build the Xpod image until native differential and product focused tests are green.
4. Missing DSN/runtime/provider/image is a failed required gate, never a skip.
5. Registry/OCI publication requires release authority; no temporary file dependency, mutable tag, or compatibility path may bypass it.
