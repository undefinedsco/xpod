# QLever-compatible RDF Physical Backend Protocol Design

> Parent: [`RDF Engine Spec`](../../rdf-engine-spec.md).  
> Related: [`Full-text Index V2 P3 Fusion Planner`](2026-06-23-full-text-index-v2-p3-fusion-planner-design.md), [`Full-text Index V2 P4 Native FTS`](2026-06-28-full-text-index-v2-p4-native-fts-design.md), [`Progressive Semantic Index`](../../progressive-semantic-index.md).

## Goal

Define the data access protocol that would let Xpod run a QLever-style planner/executor over the existing Xpod RDF facts, RDF-3X stats, text index, vector index, path scope, and ACL/ACR scope.

The protocol answers one question before any C++/PostgreSQL extension work:

> Can Xpod's PG/SQLite RDF engine provide the physical data capabilities that a QLever-style executor needs, without creating a second RDF fact store?

This spec is the contract. It is not an implementation plan for embedding QLever, and it does not make QLever a product dependency.

## Working assumptions

- This is a native-first physical protocol for a PostgreSQL extension / QLever-compatible executor path. TypeScript snippets in this document are IDL-style notation only for tests, benchmark tooling, and non-native fallbacks; they are not the product execution protocol. The primary implementation contract is a C ABI with an internal C++ facade where QLever code is involved.
- RDF facts remain authoritative in Xpod's existing facts layer: `rdf_terms`, `rdf_quads`, facts covering indexes, and SolidFS/Pod authority files.
- RDF-3X stats, materialized views, result cache, text index, vector index, path closure, and profile output are derived and rebuildable.
- The protocol is internal to `SolidRdfEngine` / `PostgresRdfEngine`. It is not a public SPARQL dialect, not a public QLever backend selector, and not a durable Pod model.
- Low-level names such as `termId` are runtime/index keys. They are not Solid resource `id` fields and must not leak into shared Pod schemas as `xxxId` relations.
- Solid ACL/ACR access scope is part of query semantics. A backend that cannot enforce a scope safely must fail closed or fall back to a safe executor.

## Upstream QLever boundary

QLever has useful planner/executor/profile concepts, but its current data boundary is not a narrow storage interface.

Observed upstream shape:

- `libqlever/Qlever.h` exposes an embedded database API and notes that QLever JSON contains detailed query execution timings.
- `QueryExecutionContext` owns an `Index` and exposes it through `getIndex()`.
- `Operation` owns a `RuntimeInformation` tree, computes estimates before execution, updates actual rows/time/cache status after execution, and can stream runtime updates.
- `IndexScan` is tied to `PermutationPtr`, `LocatedTriplesState`, block metadata, and QLever's own `IndexImpl` / permutation files.
- Text scan operations call QLever `Index` text-posting methods directly.

Implication:

- Reusing QLever's observability model is straightforward conceptually.
- Reusing QLever's full executor over PG facts requires a broad backend compatibility layer, not a small `scan()` replacement.
- The top-level embedded API (`qlever::Qlever`) is not the integration point for Xpod's PG-backed facts. It constructs and loads QLever's own on-disk `Index` from `EngineConfig.baseName_`, which would create the second RDF fact store that this design explicitly avoids.
- Whole-QLever-as-PG-extension is not the first step. First define and test the physical backend protocol, then adapt the lower-level planner/executor dependencies (`QueryExecutionContext`, `QueryPlanner`, `Index`/permutation access, runtime profile) to that protocol.

## Architecture

```text
SPARQL / RdfQuery / product search request
  -> logical planner
      - RdfBgpSource
      - TextMatchSource
      - VectorMatchSource
      - PathScopeSource
      - AclScopeSource
      - MaterializedResultSource
  -> QLever-compatible physical protocol
      - TermDictionary
      - PermutationAccess
      - CardinalityStats
      - TextCandidateSource
      - VectorCandidateSource
      - PathScopeSource
      - AccessScopeEvaluator
      - ExecutionProfileSink
  -> physical backend
      local:  SQLite/PGlite facts + FTS/vector artifacts
      cloud:  PostgreSQL facts + GIN/vector/native extension when available
```

Planner and executor code inside the native path should depend on this protocol, not directly on product model repositories or ad-hoc PG SQL assembled in TypeScript. The TypeScript engine may still call the native executor, collect reports, and run fallback paths, but it is not the protocol owner for the QLever-compatible path.

The protocol has three layers:

1. **Semantic contract**: operations, invariants, snapshot/version rules, scope rules, and profile fields. This document owns this layer.
2. **Native binding**: the primary execution contract, exposed as a stable C ABI for PostgreSQL extension integration. QLever-specific C++ types stay behind an internal C++ facade.
3. **TypeScript test/admin binding**: optional generated or hand-written binding used for conformance tests, benchmark artifact normalization, local fallback validation, and API/dashboard reporting. It must follow the native contract, not define a separate product protocol.

## Binding strategy

The product execution path is native-first. TypeScript is not the protocol boundary for the QLever-compatible PG extension path.

Recommended order:

| Binding | Purpose | Timing |
| --- | --- | --- |
| Semantic spec | Stable contract for correctness, scope, estimates, and profile | Now |
| C ABI | Safe boundary for PostgreSQL extension and external native executor | First implementation target |
| C++ facade | Adapter layer for QLever planner/executor internals | With QLever spike |
| TypeScript test/admin binding | Conformance tests, benchmark report normalization, slow-query dashboard, fallback comparison | Derived after C ABI shape is fixed |

Reasoning:

- If planner/executor runs inside PostgreSQL, the hot path cannot depend on a TypeScript protocol. The protocol must be usable from a PG extension without crossing the JS runtime.
- QLever is C++, but PostgreSQL extension boundaries should not expose unstable C++ ABI. A narrow C ABI is the stable contract; C++ implements it internally.
- TypeScript remains useful for tests, current fallback engine, and observability ingestion, but it must be a client/binding of the native protocol, not the source of truth.

## Implementation artifacts

The first native-first protocol artifacts are:

- Physical backend C ABI header: [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h)
- QLever adapter C ABI facade and query request context: [`native/postgres/qlever_adapter/include/xpod_qlever_adapter.h`](../../../native/postgres/qlever_adapter/include/xpod_qlever_adapter.h)
- QLever adapter internal C++ backend facade: [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp)
- QLever id codec ABI: [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h)
- Batch TermDictionary lookup/resolve ABI: [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h)
- TermDictionary prefix range ABI: `xpod_rdf_prefix_range_request` / `xpod_rdf_prefix_range_fn` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), surfaced through [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp)
- QLever adapter upstream include bridge: [`native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`](../../../native/postgres/qlever_adapter/src/XpodQleverBridge.cpp)
- QLever ValueId bridge: [`native/postgres/qlever_adapter/src/XpodQleverValueIdBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverValueIdBridge.hpp)
- QLever term-order contract: `xpod_rdf_qlever_term_ordering` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), consumed by [`native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp)
- QLever id comparator: `xpod_rdf_compare_qlever_ids_fn` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), surfaced through [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp) and used by native `OrderBy` / internal sort modifiers.
- Path/source scope resolution ABI: `xpod_rdf_resolved_source_scope` / `xpod_rdf_resolve_source_scope_fn` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), surfaced through [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp)
- Distinct cardinality estimate ABI: `xpod_rdf_estimate_distinct_fn` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), surfaced through [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp)
- Backend capability negotiation ABI: `xpod_rdf_backend_capabilities` / `xpod_rdf_backend_capabilities_fn` in [`native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h`](../../../native/postgres/rdf_protocol/include/xpod_rdf_physical_backend.h), surfaced through [`native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp`](../../../native/postgres/qlever_adapter/src/XpodPhysicalBackend.hpp). This tells the native QLever adapter which permutations, scope pushdowns, slot ranges, and candidate sources are available without guessing from TypeScript config.
- QLever IdTable bridge: [`native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp)
- QLever Result bridge: [`native/postgres/qlever_adapter/src/XpodQleverResultBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverResultBridge.hpp)
- Native candidate source bridge: [`native/postgres/qlever_adapter/src/XpodCandidateBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodCandidateBridge.hpp)
- Xpod-backed IndexScan adapter shell: [`native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp)
- Xpod-backed candidate operation result shared structs: [`native/postgres/qlever_adapter/src/XpodBackedCandidateOperation.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedCandidateOperation.hpp)
- Xpod-backed text candidate operation shell: [`native/postgres/qlever_adapter/src/XpodBackedTextSearch.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedTextSearch.hpp)
- Xpod-backed vector candidate operation shell: [`native/postgres/qlever_adapter/src/XpodBackedVectorSearch.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedVectorSearch.hpp)
- QLever adapter internal executor seam: [`native/postgres/qlever_adapter/src/XpodQleverExecutor.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverExecutor.hpp)
- QLever native planner request context: [`native/postgres/qlever_adapter/src/XpodQleverPlannerRequestContext.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPlannerRequestContext.hpp)
- QLever planner-context scan input helper: [`native/postgres/qlever_adapter/src/XpodQleverPlannerScanInput.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPlannerScanInput.hpp)
- QLever internal planner context provider seam: [`native/postgres/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPlannerContextProvider.hpp)
- QLever permutation mapping shim: [`native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp)
- QLever scan request bridge with slot term-range constraints: [`native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp)
- QLever parsed plan bridge: [`native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp)
- QLever operation plan bridge: [`native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverOperationBridge.hpp)
- QLever operation tree introspection bridge: [`native/postgres/qlever_adapter/src/XpodQleverOperationIntrospection.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverOperationIntrospection.hpp)
- QLever operation-to-plan bridge: [`native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverOperationPlanBridge.hpp)
- QLever native physical operation executor: [`native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverOperationExecutor.hpp)
- QLever candidate physical operation executor test: [`tests/native/QleverCandidateOperationBridge.test.ts`](../../../tests/native/QleverCandidateOperationBridge.test.ts)
- QLever scan row materializer: [`native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp)
- QLever adapter C++ implementation shell: [`native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp`](../../../native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp)
- QLever adapter CMake target: [`native/postgres/qlever_adapter/CMakeLists.txt`](../../../native/postgres/qlever_adapter/CMakeLists.txt)
- ABI validator: [`scripts/check-rdf-physical-protocol-abi.cjs`](../../../scripts/check-rdf-physical-protocol-abi.cjs)
- Focused tests: [`tests/native/RdfPhysicalBackendProtocolHeader.test.ts`](../../../tests/native/RdfPhysicalBackendProtocolHeader.test.ts), [`tests/native/QleverAdapterFacade.test.ts`](../../../tests/native/QleverAdapterFacade.test.ts), [`tests/native/QleverPhysicalBackendFacade.test.ts`](../../../tests/native/QleverPhysicalBackendFacade.test.ts), [`tests/native/QleverExecutorFactory.test.ts`](../../../tests/native/QleverExecutorFactory.test.ts), [`tests/native/QleverPermutationMap.test.ts`](../../../tests/native/QleverPermutationMap.test.ts), [`tests/native/QleverScanBridge.test.ts`](../../../tests/native/QleverScanBridge.test.ts), [`tests/native/QleverScanMaterializer.test.ts`](../../../tests/native/QleverScanMaterializer.test.ts), [`tests/native/QleverIdCodec.test.ts`](../../../tests/native/QleverIdCodec.test.ts), [`tests/native/QleverValueIdBridge.test.ts`](../../../tests/native/QleverValueIdBridge.test.ts), [`tests/native/QleverIdTableBridge.test.ts`](../../../tests/native/QleverIdTableBridge.test.ts), [`tests/native/QleverBackedIndexScan.test.ts`](../../../tests/native/QleverBackedIndexScan.test.ts), [`tests/native/QleverBackedTextSearch.test.ts`](../../../tests/native/QleverBackedTextSearch.test.ts), [`tests/native/QleverBackedVectorSearch.test.ts`](../../../tests/native/QleverBackedVectorSearch.test.ts), [`tests/native/QleverCandidateOperationBridge.test.ts`](../../../tests/native/QleverCandidateOperationBridge.test.ts), [`tests/native/QleverOperationBridge.test.ts`](../../../tests/native/QleverOperationBridge.test.ts), [`tests/native/QleverOperationIntrospection.test.ts`](../../../tests/native/QleverOperationIntrospection.test.ts), [`tests/native/QleverOperationPlanBridge.test.ts`](../../../tests/native/QleverOperationPlanBridge.test.ts), [`tests/native/QleverResultBridge.test.ts`](../../../tests/native/QleverResultBridge.test.ts), [`tests/native/RdfCandidateBridge.test.ts`](../../../tests/native/RdfCandidateBridge.test.ts)

The physical backend header is the data execution-boundary artifact. The adapter facade is the C ABI entry point that will hide QLever-specific C++ types behind a stable native boundary. Query execution uses `xpod_qlever_query_request` so snapshot, cancellation, graph scope, source/path scope, and access scope enter the native scan path with the SPARQL bytes instead of being inferred in TypeScript. TypeScript only validates, normalizes, and reports this contract; it is not the hot-path protocol for the PostgreSQL extension path.

The C ABI includes batch term lookup/resolve callbacks. The C++ facade gates every callback field through `struct_size`, so older or partially initialized callback tables fail closed with `UNSUPPORTED` instead of reading past the struct. Broad QLever-style planning must use this batch seam rather than row-by-row dictionary calls.
Path/source scope now has native resolve and estimate callbacks as well as request propagation. Resolve returns backend-owned source-node and graph-scope constraints that a QLever-compatible planner can treat as hard execution boundaries; estimate gives the planner a CBO-visible subtree cardinality signal before it chooses between RDF scans, text/vector candidate sources, and joins.
Join fanout estimates also carry graph and source scope, so QLever cost estimates do not accidentally use global fanout statistics for a scoped Solid request.
Distinct estimates are exposed separately from distinct execution so CBO can price `DISTINCT`, no-aggregate `GROUP BY`, and duplicate-eliminating join shapes without executing the distinct scan first.
Backend capabilities are exposed as a native callback, so QLever-facing code can negotiate data-source capabilities before planning instead of assuming every PG/local backend supports every permutation, hard scope, and candidate source.

The scan materializer has two explicit result shapes: a raw `TermKey` row buffer for protocol tests, and a QLever-id-bits row buffer that must go through `PhysicalBackend::encodeQleverId`.
The IdTable bridge then converts the QLever-id-bits row buffer into upstream `IdTable`, giving the future `IndexScan` replacement a single `PhysicalBackend scan -> IdTable` seam.
Planner-produced `IndexScan` plans set `needed_slots` from the scan variables, and the materializer emits only those slots in QLever permutation order. Scan requests can also carry flat `slot_ranges` constraints so TermDictionary prefix ranges can be pushed into permutation scans without inventing a separate operation bridge. `xpod_qlever_query_request` carries request-level graph scope into `PlannerRequestContext`, and `ScanRequestInput` forwards the native `graph_scope` field to the C ABI scan request. Exact/set/prefix graph scopes can therefore enter the low-level permutation scan instead of being reconstructed by graph-specific operator glue above the scan. The TypeScript/Postgres fallback path mirrors this through `RdfQuadScanOptions.slotTermRanges`, compiling ranges into `rdf_quads` term-id predicates and applying the same predicate in post-filter scans. Constant subject/predicate/object columns are therefore used for native scan filtering but are not returned as IdTable columns. The bridge carries output variable names in the same materialized column order, so SPARQL JSON `head.vars` and row bindings follow planner output instead of assuming fixed `s,p,o` columns. A zero-variable scan is represented as a zero-width IdTable with row count preserved separately from the encoded id buffer.
Parsed BGP constants are bound through the native batch term dictionary before scan execution; prefix constraints are bound through `PhysicalBackend::prefixRange(...)` and injected into scan `slot_ranges`. The scan request receives term keys/ranges and still carries snapshot/access-scope context from `xpod_qlever_query_request`. Parsed-BGP fallback scans also emit only variable slots, so constants remain filters rather than fixed `s,p,o` output columns. The bridge also has a first two-triple BGP seam: a primary scan plus subject filter scan represented by an explicit operation root and materialized as a HashJoin-shaped result without using a second RDF fact store.
The backed IndexScan adapter shell can expose the same scan as upstream `Result`, making the next step a replacement of QLever `IndexScan::computeResult()` rather than another data-shape bridge.
The operation tree introspection bridge can read descriptor, result width, sorted columns, and immediate child metadata from QLever `Operation` / `QueryExecutionTree` objects without executing them. This is the first non-parser seam for real `QueryPlanner` output: planner-produced operation trees can be inspected and mapped into `BridgePhysicalPlan` incrementally, while execution remains owned by the native physical protocol.
The operation-to-plan bridge now handles the first real upstream operation shapes: `IndexScan` is detected through the `Operation` base or a `QueryExecutionTree` root, and there is a native seam that calls `QueryPlanner::createExecutionTree(...)` before mapping the tree root to `BridgeQueryPlan`. The bridge supports both default-constructible test planners and the upstream-shaped `QueryPlanner(QueryExecutionContext*, SharedCancellationHandle)` construction path. The `IndexScan` subject/predicate/object components and `Permutation` are converted to the same native plan, and constants still bind through the native batch dictionary before execution. A constrained `Join` tree is flattened into the existing native `HashJoin` plan when every leaf is an `IndexScan` and at least one common variable appears in every leaf; the plan records legacy per-scan `join_slots` for the first key and `join_key_slots` for the full tuple, so common variables may sit in different RDF slots such as left object to right subject. Planner-generated RDF/RDF joins also record explicit `scan_project_slots`, so right-side non-duplicate variables become real output columns instead of being reduced to a semi-join filter. RDF/RDF `IndexScan` joins may use multiple shared variables through `join_key_slots`, inferred in canonical RDF slot order `S/P/O`; non-`IndexScan` RDF joins and joins that need expression/filter evaluation still fail closed. This starts replacing parser-only planning with planner-output planning while preserving the same Xpod physical scan executor.
The facade query path now prefers this planner-output seam when a QLever planner can be constructed in the embedded build, and falls back to the parsed-BGP bridge only while the real Xpod-backed `QueryExecutionContext` / `Index` layer is not available. The executor owns an internal planner context provider and keeps a native `PlannerRequestContext` handle for every request, including the request cancellation token. Planner selection is native-first: if an embedded or patched `QueryPlanner` can be constructed from `const PlannerRequestContext*` plus a cancellation handle, that path is used; the bridge creates the QLever `SharedCancellationHandle` at this native seam and pre-cancels it when the Xpod request cancellation callback is already set. Otherwise the bridge falls back to the upstream `QueryExecutionContext*` constructor when it is safely bound, then to parsed-BGP fallback. If the upstream context type cannot receive the Xpod request context, the provider exposes no `QueryExecutionContext*` rather than pretending the upstream context is Xpod-backed. The public C ABI still exposes only `xpod_qlever_query_request` and the native physical backend. This keeps `PhysicalBackend`, snapshot, and access-scope context in the native request boundary while moving the hot path toward upstream planner trees without exposing QLever C++ objects through the public C ABI.
The native physical operation executor now owns the first executable operation tree boundary: `PermutationScan` and single-key multi-scan `HashJoin` execute from `BridgePhysicalPlan` in C++ over `PhysicalBackend`. `HashJoin` uses per-scan join slots when `join_slots` is present and falls back to the legacy single `join_slot` for older hand-built plans. When `scan_project_slots` is present, `HashJoin` groups right scan rows by join key and appends the cartesian combination of right-side projections to the primary scan projection, matching join-output semantics while preserving the older semi-join path for legacy hand-built plans. `HashJoin` also emits native profile events as an `XPOD_RDF_PROFILE_RDF_JOIN` root, while child scan adapters emit `XPOD_RDF_PROFILE_PERMUTATION_SCAN` events under that parent. `XpodQleverBridge.cpp` is intentionally reduced to parse, bind, delegate to `executeBridgeOperationPlan(...)`, resolve terms, and serialize. It must not grow ad-hoc physical execution logic again; future QLever `QueryPlanner` / `Operation` integration should produce or adapt to the same native physical plan shape.
The adapter query request already carries snapshot, cancellation, graph scope, source/path scope, and access-scope context into every generated RDF scan request, including fallback parsed plans and planner-context-derived scans, so future QLever-backed execution does not bypass Solid snapshot, cancellation, graph, path/subtree, or ACL/ACR semantics.
The bridge request-context application carries request graph scope into primary, filter, and child RDF scan plans, and the text/vector candidate-source request structs expose the same `graph_scope` field. This keeps FTS/vector candidate generation inside the same Solid graph boundary before QLever planner/executor performs fusion joins.
The physical scan primitive can now carry exact graph term-key constraints and can materialize `XPOD_RDF_SLOT_GRAPH` as an optional projected slot. QLever triple permutations are treated as Xpod quad permutations with graph appended at the physical boundary, so triple-shaped scans keep their existing S/P/O result while graph-aware paths do not need separate operator glue.
The parsed-query fallback now maps fixed-IRI `GRAPH` group patterns into the same graph scan primitive by binding the graph IRI through the native term dictionary as `XPOD_RDF_SLOT_GRAPH`. Variable graph scopes still fail closed until the upstream planner path can expose graph-variable projection without losing Solid graph-scope semantics.
The parsed-query fallback can also project a `GRAPH ?g` scope for a single BGP scan by adding `XPOD_RDF_SLOT_GRAPH` to the scan projection and appending the graph variable after S/P/O in materializer order. Fixed-IRI GRAPH groups remain exact graph scan constraints.
Two-triple parsed fallback groups under `GRAPH ?g` now reuse the native projected hash join with composite `{subject, graph}` join keys. The filter scan also projects graph so subject matches cannot cross graph boundaries; the left scan remains the only projected output (`S/P/O/G`) while the second scan acts as a graph-safe semi-join filter.
The planner-context scan input helper converts native planner request context into `ScanRequestInput` without forcing the lower-level scan bridge to include the adapter facade. This keeps the scan bridge usable as a pure physical scan primitive while giving future Xpod-backed QLever operations a single request-aware constructor path.
The same shell now exposes operation-shaped metadata (`descriptor`, result width, sorted columns) and a `computeResult(false)` seam. It deliberately does not inherit upstream `Operation` yet, because upstream `Operation` brings the whole `QueryExecutionContext`/cache/runtime tree; the next patch can move this seam either into an upstream `IndexScan::computeResult()` patch or into a planner-generated Xpod-backed operation.
The shell also asks the native backend for scan estimates, giving the future operation boundary size, cost, and known-empty decisions without consulting QLever permutation files.
When `computeResult(false)` runs, the shell emits native profile events for the permutation scan boundary. This is the first executable bridge toward QLever-style `RuntimeInformation` without yet importing the full upstream operation tree.
Text and vector candidate callbacks are materialized by a separate native C++ bridge into stable candidate rows. This keeps FTS/VEC candidate sources as protocol inputs to the future planner rather than TypeScript post-filters. Text and vector candidate sources also have QLever-style operation shells with estimate, execute, and profile behavior over `PhysicalBackend`, matching the `IndexScan` shell boundary without making candidates RDF triples. `BridgePhysicalPlan` can now carry text/vector candidate roots and execute them through a typed native result dispatcher that returns either RDF rows or candidate rows. Mixed text/RDF joins have a first native seam: a variable-entity `TextIndexScanForEntity` can feed candidate `ResourceTerm` keys into one RDF `IndexScan`, producing an RDF scan projection filtered by the candidate set and a profile tree with `HashJoin -> TextSearch + PermutationScan`. This is deliberately not yet a full QLever join projection that appends text columns. The legacy SPARQL `QleverResultWithStatus` path rejects candidate roots before execution instead of coercing candidates into an RDF IdTable.

The adapter target is intentionally source-provider based:

- `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=OFF` is the default and builds the stub facade without requiring upstream QLever sources.
- `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON` requires `XPOD_QLEVER_SOURCE_DIR` and validates the embedded API, parser/AST, lower-level planner, and index headers before configuration succeeds.
- The source-tree gate includes `engine/Operation.h`, `engine/QueryExecutionTree.h`, and `engine/Join.h`, because the intended boundary is QueryPlanner/Operation output, not parser-only scan shims.
- The source-tree gate also requires `util/CancellationHandle.h`, because real `QueryPlanner` construction needs a cancellation handle together with `QueryExecutionContext`.
- Xpod must not vendor a second RDF fact store behind this target. The next integration steps wire QLever planner/executor code to the Xpod physical backend ABI.

## Core concepts

### Terms

```ts
// IDL notation. Native binding uses fixed-width integer handles.
type TermKey = bigint;

type RdfTerm =
  | { kind: 'iri'; value: string }
  | { kind: 'blank'; value: string }
  | { kind: 'literal'; value: string; datatype?: string; language?: string };
```

Rules:

- `TermKey` is a backend-local stable dictionary key for the current facts snapshot.
- `TermKey` is not a Pod resource id, not a fragment id, and not an application-facing identifier.
- QLever `ValueId` bits are not implicitly identical to `TermKey`. The native backend must either expose encode/decode callbacks for QLever id bits or explicitly declare `XPOD_RDF_TERM_KEY_ENCODING_QLEVER_VALUE_ID_BITS`.
- QLever sortedness is a separate contract from id encoding. A backend may expose `XPOD_RDF_QLEVER_TERM_ORDER_PRESERVED` only when native permutation order remains sorted after converting term keys to QLever id bits; otherwise the adapter must clear QLever `sorted_by` metadata instead of letting upper operators rely on false sortedness.
- QLever id comparison is also a backend contract. If QLever id bits are opaque or do not preserve RDF term order, `OrderBy` and internal sort modifiers must call `compare_qlever_ids` to compare semantic term order. Missing comparators fall back to the old numeric bits order only as a compatibility path, not as proof of SPARQL value-order correctness.
- Literal identity includes lexical value, datatype, and language.
- Numeric literal metadata may be exposed for filters and estimates, but it must not collapse distinct RDF lexical terms.
- Long literals may use digest/text split internally; exact equality must still preserve RDF term identity.

### Quads and snapshots

```ts
type QuadKey = {
  subject: TermKey;
  predicate: TermKey;
  object: TermKey;
  graph: TermKey;
};

type FactsSnapshot = {
  factsVersion: string;
  statsVersion?: string;
  snapshotToken?: string;
};
```

Rules:

- Every read runs against one facts snapshot.
- Derived stats may lag facts. The backend must expose freshness and confidence rather than silently treating stale stats as exact.
- Query profiles must record the facts and stats versions used by each source.

### Source and retrieval keys

```ts
type SourceNodeKey = string;
type RetrievalPointKey = string;
type CancellationToken = {
  isCancelled(): boolean;
};
```

Rules:

- These are index/runtime keys for source files, folders, chunks, headings, messages, or generated retrieval points.
- They can be joined to RDF terms when a resource IRI exists, but they are not required to be RDF terms.
- File moves should update path/source projections without rewriting content-derived text/vector postings when the stable source node is unchanged.

## Protocol surfaces

### 1. TermDictionary

```ts
interface TermDictionary {
  lookupTerm(term: RdfTerm, snapshot: FactsSnapshot): Promise<TermKey | null>;
  lookupTerms(terms: RdfTerm[], snapshot: FactsSnapshot): Promise<(TermKey | null)[]>;
  resolveTerm(key: TermKey, snapshot: FactsSnapshot): Promise<RdfTerm | null>;
  resolveTerms(keys: TermKey[], snapshot: FactsSnapshot): Promise<(RdfTerm | null)[]>;
  prefixRange(prefix: string, kind?: RdfTerm['kind'], snapshot?: FactsSnapshot): Promise<TermRange[]>;
}
```

Required behavior:

- Batch lookup/resolve is mandatory. Per-row dictionary calls are not acceptable for broad joins.
- `prefixRange` is for vocabulary/IRI/literal lexical range planning. It is not a substitute for structural path scope.
- The native ABI returns zero or more `TermRange` batches and a collation marker. Multiple ranges are allowed because long-literal/digest storage, kind partitions, or database-specific dictionaries may not make every prefix a single contiguous term-key interval.
- Native `prefixRange` requests carry the same optional cancellation token as scan/candidate requests so long prefix expansion can stop without waiting for the next upper operator.
- The backend must expose whether term collation is bytewise, locale-aware, or database-default. Graph-prefix and path-prefix filters must not depend on unsafe collation.

### 2. PermutationAccess

```ts
type Permutation =
  | 'SPOG'
  | 'SOPG'
  | 'PSOG'
  | 'POSG'
  | 'OSPG'
  | 'OPSG'
  | 'GSPO'
  | 'GPOS';

type QuadPattern = {
  subject?: TermKey;
  predicate?: TermKey;
  object?: TermKey;
  graph?: TermKey;
};

type GraphScope =
  | { kind: 'all' }
  | { kind: 'exact'; graph: TermKey }
  | { kind: 'prefix'; iriPrefix: string }
  | { kind: 'set'; graphs: TermKey[] };

type SlotTermRange = {
  slot: 'subject' | 'predicate' | 'object' | 'graph';
  range: TermRange;
  collation: 'unknown' | 'bytewise' | 'database' | 'locale';
};

type ScanRequest = {
  snapshot: FactsSnapshot;
  cancellation?: CancellationToken;
  permutation: Permutation;
  pattern: QuadPattern;
  slotRanges?: SlotTermRange[];
  graphScope?: GraphScope;
  accessScope?: AccessScope;
  order?: ScanOrder;
  limit?: number;
  offset?: number;
  batchSize?: number;
  neededSlots?: Array<'subject' | 'predicate' | 'object' | 'graph'>;
};

interface PermutationAccess {
  capabilities(): BackendCapabilities;
  scan(request: ScanRequest): AsyncIterable<RowBatch<QuadKey>>;
  count(request: ScanRequest): Promise<CountResult>;
  distinct(request: DistinctRequest): AsyncIterable<RowBatch<TermKey[]>>;
}
```

`BackendCapabilities` is a native feature declaration: supported permutations, hard scope pushdowns, slot-range support, scan limit/offset support, candidate-source availability, and an optional backend name/version for profile reporting. It is not a planner policy object and must not contain QLever C++ types.

Required behavior:

- `scan` returns dictionary keys, not strings.
- The backend must state the output sort order of each batch. That order is planner-visible only when the backend also declares that QLever term order is preserved.
- `limit` is valid only when the backend can apply it before any non-pushed filter that might change correctness.
- Slot term ranges are dictionary-key constraints for subject/predicate/object/graph slots. They are how `prefixRange` output enters `PermutationAccess`; they are not path, graph-prefix, or ACL scope. Bridge prefix bindings must call `prefixRange` and inject the returned ranges before execution; native and TypeScript fallback implementations must both apply them before exposing rows to upper operators.
- Graph-prefix scan must use actual graph terms or a collation-safe prefix method; it must not accidentally include subject/object IRIs with the same prefix.
- Access scope must be applied before rows are exposed to the executor when the scope can deny rows.
- Batch iteration must support cancellation and must report partial runtime profile data.
- Capability negotiation must happen before planning or fallback selection. Missing capability data is not proof of support; the adapter must either use a safe fallback or fail closed.

### 3. CardinalityStats

```ts
type Estimate = {
  rows: number;
  distinct?: Partial<Record<'subject' | 'predicate' | 'object' | 'graph', number>>;
  selectivity?: number;
  cost?: {
    cpu: number;
    io: number;
    memory?: number;
    startup?: number;
  };
  confidence: 'exact' | 'fresh-estimate' | 'stale-estimate' | 'fallback-heuristic';
  statsVersion?: string;
  reason?: string;
};

type HistogramRequest = {
  snapshot: FactsSnapshot;
  cancellation?: CancellationToken;
  pattern: QuadPattern;
  graphScope?: GraphScope;
  sourceScope?: SourceScope;
  accessScope?: AccessScope;
  slots: Array<'subject' | 'predicate' | 'object' | 'graph'>;
  maxBuckets?: number;
};

type HistogramHint = {
  slots: Array<'subject' | 'predicate' | 'object' | 'graph'>;
  range?: TermRange;
  rows: number;
  distinctTerms?: number;
  selectivity?: number;
  confidence: Estimate['confidence'];
  statsVersion?: string;
  reason?: string;
};

interface CardinalityStats {
  estimateScan(request: ScanRequest): Promise<Estimate>;
  estimateDistinct(request: DistinctRequest): Promise<Estimate>;
  estimateJoinFanout(request: JoinFanoutRequest): Promise<Estimate>;
  histogramHints(request: HistogramRequest): Promise<HistogramHint[]>;
}
```

Minimum stats needed for CBO:

- exact graph count and graph-prefix count;
- predicate count and predicate-object count;
- subject-predicate count for star joins;
- distinct slot and distinct tuple estimates;
- text term document frequency;
- vector model/dimension distribution;
- path/source subtree cardinality;
- ACL/ACR scope selectivity when available.

Stats must include confidence. A stale or heuristic estimate is allowed only if the planner can choose a safe fallback or mark the profile accordingly.

### 4. TextCandidateSource

```ts
type TextSearchRequest = {
  snapshot: FactsSnapshot;
  cancellation?: CancellationToken;
  query: string;
  graphScope?: GraphScope;
  workspace?: string;
  sourceScope?: SourceScope;
  accessScope?: AccessScope;
  fields?: TextFieldWeights;
  limit: number;
  offset?: number;
  requireEntityTerms?: TermKey[];
};

type Candidate = {
  sourceNode?: SourceNodeKey;
  retrievalPoint?: RetrievalPointKey;
  resourceTerm?: TermKey;
  score: number;
  rankDetails?: Record<string, unknown>;
  range?: SourceRange;
};

interface TextCandidateSource {
  search(request: TextSearchRequest): AsyncIterable<RowBatch<Candidate>>;
  estimate(request: TextSearchRequest): Promise<Estimate>;
}
```

Required behavior:

- Text candidates are candidate sources, not RDF triples.
- Candidate rows must carry a stable join key: `retrievalPoint`, `sourceNode`, or RDF `resourceTerm`.
- Path/source/access filters must be pushed into the candidate query when they affect authorization or hard scope.
- If a backend cannot push an authorization scope safely, it must fail closed or use a safe fallback. It must not rank all rows and post-filter unauthorized rows.
- Score details should identify the physical scorer, for example `pg-ts-rank-cd`, `sqlite-fts5-bm25`, or `posting-bm25`.

### 5. VectorCandidateSource

```ts
type VectorSearchRequest = {
  snapshot: FactsSnapshot;
  cancellation?: CancellationToken;
  vector: number[];
  model: string;
  dimensions: number;
  metric: 'cosine' | 'dot' | 'euclidean';
  graphScope?: GraphScope;
  workspace?: string;
  sourceScope?: SourceScope;
  accessScope?: AccessScope;
  limit: number;
  threshold?: number;
};

interface VectorCandidateSource {
  search(request: VectorSearchRequest): AsyncIterable<RowBatch<Candidate>>;
  estimate(request: VectorSearchRequest): Promise<Estimate>;
}
```

Required behavior:

- Model and dimensions are part of the candidate source identity.
- The backend must expose whether the result is exact or approximate.
- Approximate vector search must be visible in profile details, including candidate window and recall-relevant parameters when known.
- Path/access scope must be pushed before final top-k when possible. If not possible, the profile must mark the fallback and the executor must preserve correctness.

### 6. PathScopeSource

```ts
type SourceScope = {
  workspace?: string;
  sourceNode?: SourceNodeKey;
  sourceUri?: string;
  sourceUriPrefix?: string;
  localPath?: string;
  localPathPrefix?: string;
  includeFolders?: boolean;
  includeFiles?: boolean;
};

interface PathScopeSource {
  resolveScope(scope: SourceScope, snapshot: FactsSnapshot): Promise<ResolvedSourceScope>;
  estimate(scope: SourceScope, snapshot: FactsSnapshot): Promise<Estimate>;
}
```

Required behavior:

- Path scope is structural. FTS/path tokens and folder embeddings are weak ranking signals only.
- Native `resolveScope` returns non-owning backend views of source-node and graph constraints. Callers must not retain returned pointers beyond the backend-defined request lifetime.
- Folder retrieval points may participate in text/vector search, but raw full path embedding cannot replace structural prefix/subtree checks.
- Moving a folder should primarily update source/path projection rows and graph-prefix projection, not rewrite content vectors or text postings for unchanged content.

### 7. AccessScopeEvaluator

```ts
type AccessScope = {
  principal?: string;
  mode: 'read' | 'write' | 'append' | 'control';
  authorizationModel: 'wac' | 'acp' | 'mixed';
  allowedGraphs?: TermKey[];
  deniedGraphs?: TermKey[];
  allowedGraphPrefixes?: string[];
  deniedGraphPrefixes?: string[];
  allowedSources?: SourceNodeKey[];
  deniedSources?: SourceNodeKey[];
  permissionVersion?: string;
};

interface AccessScopeEvaluator {
  resolve(principal: string | undefined, mode: AccessScope['mode'], snapshot: FactsSnapshot): Promise<AccessScope>;
  estimate(scope: AccessScope, sourceScope?: SourceScope): Promise<Estimate>;
}
```

Required behavior:

- ACL/ACR scope is a hard semantic constraint.
- Scope must be part of cache keys and materialized-result identities.
- Permission version must be exposed so result cache invalidation can distinguish facts changes from authorization changes.
- A query profile must show where access scope was applied: scan, text candidate source, vector candidate source, path source, or defensive post-filter.

### 8. ExecutionProfileSink

QLever's `RuntimeInformation` is the reference shape: estimates are created before execution; actual rows, runtime, cache status, and children are updated as operations run.

```ts
type ExecutionProfileNode = {
  id: string;
  descriptor: string;
  kind:
    | 'TermLookup'
    | 'PermutationScan'
    | 'RdfJoin'
    | 'TextSearch'
    | 'VectorSearch'
    | 'PathScope'
    | 'AccessScope'
    | 'FusionRank'
    | 'Sort'
    | 'TopK'
    | 'MaterializedResult'
    | 'Cache';
  status: 'not-started' | 'running' | 'completed' | 'optimized-out' | 'failed' | 'cancelled';
  estimate?: Estimate;
  actual?: {
    inputRows?: number;
    outputRows?: number;
    scannedRows?: number;
    returnedRows?: number;
    batches?: number;
    durationMs: number;
    operationMs?: number;
  };
  backend?: 'sqlite' | 'pglite' | 'postgres' | 'pg-extension' | 'qlever-adapter';
  indexUsed?: string[];
  cache?: {
    status: 'disabled' | 'miss' | 'hit' | 'store' | 'bypass';
    key?: string;
  };
  details?: Record<string, unknown>;
  children: ExecutionProfileNode[];
};

interface ExecutionProfileSink {
  start(node: ExecutionProfileNode): void;
  update(id: string, patch: Partial<ExecutionProfileNode>): void;
  finish(id: string, patch: Partial<ExecutionProfileNode>): void;
  snapshot(): ExecutionProfileNode;
}
```

Required behavior:

- Every planner-visible source must produce a profile node.
- Estimate and actual values must be comparable in the same units where possible.
- The profile must include enough detail to answer whether broad fusion time is spent in text search, vector search, RDF membership, path/ACL filtering, score fusion, or sorting.
- Slow-query records and benchmark artifacts should store the profile tree, not only string plan markers.

## QLever mapping table

| QLever concept | Protocol capability | Notes |
| --- | --- | --- |
| `Index::indexToString` / vocabulary access | `TermDictionary.resolveTerm(s)` | Batch required for Xpod. |
| `Vocabulary::getId` / prefix ranges | `TermDictionary.lookupTerm` / `prefixRange` | Prefix range cannot replace path scope. |
| QLever `ValueId` comparison | `compare_qlever_ids` | Required when encoded id bits are opaque or non-order-preserving. |
| `Permutation` / `IndexScan` | `PermutationAccess.scan/count/distinct` | PG uses facts covering indexes; no QLever permutation files. |
| scan block metadata / located triples | `ScanRequest` + `FactsSnapshot` + `ExecutionProfileNode` | Snapshot/version must align with PG facts. |
| multiplicities / size estimates | `CardinalityStats` | Stats can be exact, fresh, stale, or heuristic. |
| `TextIndexScanForWord/Entity` | `TextCandidateSource` | Candidate source, not RDF triple scan. |
| `Operation` tree | logical/physical operator tree | Xpod can reuse the model without inheriting storage. |
| `RuntimeInformation` | `ExecutionProfileNode` | Highest-value direct idea to absorb first. |
| QLever query cache | Xpod result/materialized cache | Scope/facts/permission version must be part of identity. |

## Backend mappings

### PostgreSQL

| Protocol surface | Existing / intended PG source |
| --- | --- |
| Term dictionary | `rdf_terms` with kind, value, datatype/lang/numeric/digest metadata |
| Permutation scan | `rdf_quads` plus facts covering indexes such as SPOG/POSG variants |
| Graph prefix | graph term projection + collation-safe `starts_with` or graph id set |
| RDF-3X stats | `rdf3x_*` projection/graph/pair stats and PG `ANALYZE` hints |
| Text candidate source | `rdf_text_*`, PG FTS derived table, or future native text operator |
| Vector candidate source | `rdf_vector_*` or future vector backend |
| Path scope | source node / local path / URI projection tables plus native source-scope estimate callback |
| Access scope | WAC/ACP derived overrides, allowed/denied graph/source scope |
| Profile | `RdfQueryResult.metrics.explain` and slow-query/benchmark profile tree |

### SQLite / local

| Protocol surface | Existing / intended local source |
| --- | --- |
| Term dictionary | embedded RDF index term dictionary |
| Permutation scan | local facts covering indexes / RDF-3X primary |
| Text candidate source | current postings backend, later FTS5 |
| Vector candidate source | local vector component table/artifact |
| Path scope | SolidFS/source-node projection |
| Access scope | same resolved scope contract, enforced before final result |
| Profile | same `ExecutionProfileNode` tree |

## Compliance tests

A backend implements this protocol only when it passes these tests:

1. **Term identity**: IRI, blank node, plain literal, language literal, datatype literal, numeric literal, and long literal round-trip through lookup/resolve without identity collapse.
2. **Permutation equivalence**: each supported permutation returns the same quads as the canonical facts scan for exact, prefix, and unbound patterns.
3. **Graph scope**: exact graph, graph prefix, and graph set filters include only named graphs that match the graph condition.
4. **Access scope**: denied graph/source rows never appear in text, vector, or RDF candidate output.
5. **Snapshot stability**: a query sees one facts version; stats freshness is reported when stats lag facts.
6. **Batch behavior**: broad scans return the same rows across different batch sizes and can be cancelled.
7. **Estimate/profile presence**: every source has estimate rows, actual rows, scanned rows when applicable, duration, backend, and index details.
8. **Fusion attribution**: a text+vector+RDF fusion query profile separates text time, vector time, RDF membership time, path/ACL time, rank time, and sort/top-k time.
9. **Fallback correctness**: unsupported pushdown either falls back to a safe executor or fails closed with an explicit reason.
10. **Cache identity**: facts version and permission version are part of cache/materialized result identity for scoped queries.

## Phase plan

### P0 — Native ABI shape and current-backend compliance

- Keep this spec language-neutral and native-first.
- Define the C ABI header shape for term lookup, permutation scan, stats, text/vector candidate source, access scope, and execution profile callbacks.
- Add TypeScript test/admin binding only as a conformance harness over the current PG/local RDF engines.
- No query behavior change.
- No QLever C++ dependency yet.

### P1 — Execution profile tree

- Emit `ExecutionProfileNode` from the native protocol boundary, with TypeScript normalization for benchmark artifacts and slow-query snapshots.
- Store profile in benchmark artifacts and slow-query snapshots.
- Use it to diagnose broad fusion before changing the planner.

### P2 — QLever compatibility spike

Current state: `xpod_qlever_adapter` exists as a C ABI / C++ facade shell. In QLever-enabled builds, `xpod_qlever_adapter_query_request(...)` can execute the minimal physical scan query shape `SELECT * WHERE { ?s ?p ?o }` and simple IRI/literal-constant BGP variants and a two-triple subject-filter BGP through the Xpod-backed scan/join seam and return SPARQL-style JSON bindings. The bridge decodes QLever result ids through the native id codec and batch-resolves RDF terms through the native dictionary seam before serializing. It also returns a minimal scan profile JSON with operation kind, descriptor, and output rows so the result boundary already carries QLever-style observability data. The bridge now calls QLever `SparqlParser::parseQuery` and prefers planner-output planning when a `QueryPlanner` is constructible in the embedded build. Planner construction is native-first: a `QueryPlanner(const PlannerRequestContext*, SharedCancellationHandle)` shape can consume the Xpod physical backend request directly; the real upstream-shaped `QueryPlanner(QueryExecutionContext*, SharedCancellationHandle)` remains supported as a secondary path only when a bound context is available. `BridgedQleverExecutor` asks an internal planner context provider for the current request's `PlannerContextHandle`, without changing the public C ABI. If the upstream context cannot accept that Xpod request context, the provider keeps the native request handle but exposes no `QueryExecutionContext*`, so the bridge uses the native planner constructor if present or parsed-BGP fallback otherwise. The fallback derives a scan plan from the parsed `BasicGraphPattern`, applies the query snapshot/source/access context to scan and candidate sources, batches IRI and literal constant term lookup through the native dictionary, and returns a `BridgePhysicalPlan`. The native operation executor executes `PermutationScan` and multi-scan `HashJoin` over the Xpod physical backend, including joins where shared variables occupy different RDF slots in different scans through per-scan `join_slots` / `join_key_slots`; planner-generated RDF/RDF joins now carry `scan_project_slots`, so right-side non-duplicate variables are appended to result rows instead of being discarded by the old semi-join filter path. `HashJoin` emits native `RDF_JOIN` profile events and generated physical plans attach scan profile nodes as children of the join root. The operation-plan seam can also preserve QLever result modifiers above supported RDF roots without adding new public C ABI operations, and can represent `NeutralElementOperation` as a zero-width one-row native root. It now has a first tree-shaped operation boundary: `BridgeQueryPlan.child_plans` keeps child plans before term binding, `toBridgePhysicalPlan` flattens child scans/candidates with adjusted indexes, and constrained `Union` operations over supported child roots execute natively by appending left rows then right rows according to public `getOriginalColumn(...)` mappings. Union missing-column / UNDEF padding is now represented with the native `BRIDGE_NO_COLUMN` sentinel and materialized as QLever `UNDEF` ids when appending child rows. `CartesianProductJoin` now reuses the same child-plan boundary for supported child roots and materializes products by concatenating child rows in child order. `Minus` also uses that child-plan boundary for supported roots: the bridge derives matched columns from shared output variable names, preserves the left-side projection, and executes an exact-id anti-join without reading QLever private `_matchedColumns` state. `OptionalJoin` follows the same public-metadata rule: it derives matched columns and right-side projection columns from child output variables, preserves the left projection, and pads unmatched optional right values with QLever `UNDEF` ids. `MultiColumnJoin` is also represented as a tree root over supported children: it derives all shared-variable column pairs from child output variables, appends only right-side non-duplicate variables, and executes an exact-id inner join. No-aggregate `GroupBy` is supported as a native tree root: it rejects alias/aggregate shapes, projects public group-key variables from the child result, and deduplicates exact id tuples. `LimitOffset` appends an ordered modifier that slices the produced `IdTable`; upstream-shaped `Distinct` appends an ordered modifier from `getDistinctColumns()` and removes duplicate key tuples while keeping the first row; upstream-shaped `Sort` appends an `InternalSort` modifier from public `resultSortedOn()`, sorts RDF rows through the backend QLever-id comparator, and preserves internal `sorted_by`; upstream-shaped `OrderBy` appends an ordered modifier from public `getSortedVariables()`, resolves variables to output columns, clears internal sortedness, and stably sorts RDF rows by the configured key directions through the same comparator. The comparator is supplied by `xpod_rdf_compare_qlever_ids_fn` when ids are opaque; missing comparators retain numeric bits ordering only as a compatibility fallback. The older root-level `has_limit`/`has_distinct` fields remain internal compatibility shims for hand-built plans, while planner-generated operations use the ordered modifier list so modifier composition can move toward QLever tree semantics. Result modifiers remain bridge metadata for compatibility only; new work must not grow another QLever-like planner/operator layer in Xpod. Timing/row attribution for true QLever execution should come from QLever RuntimeInformation once the lower data protocol is wired. It can also dispatch `TextSearch` / `VectorSearch` roots through a typed candidate-row result boundary. Mixed candidate/RDF joins are no longer text-only at the native executor layer: `BridgeOperationPlan::candidate_source` selects text or vector candidates, then the same candidate-key path joins candidate `ResourceTerm` / `RetrievalPoint` keys to the configured RDF scan slot. Candidate rows are retained by join key, so the executor can prepend explicit `candidate_project_columns` before RDF scan columns and shift sorted scan columns accordingly. The first QLever-planner mixed join remains `Join(TextIndexScanForEntity(variable), IndexScan(... ?entity ...))`: the planner maps candidate `ResourceTerm` to the RDF scan slot, deduplicates the shared `entity` variable, projects the candidate-side `text` column before RDF variables, and records the text source and RDF scan under one `RDF_JOIN` root. Candidate projection values are encoded through the backend `encode_qlever_id`; projected candidate keys must therefore be RDF-compatible keys for SPARQL serialization. Rank/score projection is still outside RDF bindings and remains future work. The SPARQL facade detects candidate roots and fails closed with an explicit candidate-row error instead of executing a candidate search and then failing the RDF serialization path. Separately, the operation introspection seam can inspect QLever `Operation` / `QueryExecutionTree` metadata without executing the tree, and the operation-to-plan seam can convert an upstream `IndexScan` operation, `TextIndexScanForWord` candidate root, `QueryExecutionTree` root, `QueryPlanner::createExecutionTree(...)` result, or constrained nested `Join` tree into `BridgeQueryPlan`. `TextIndexScanForWord` is represented as a native text candidate source with owned query bytes and an explicit candidate output column for the text record / retrieval point. `TextLimit` above a native text candidate root is pushed into the text candidate request limit; shapes that need per-entity combination limiting still fail closed. Fixed-entity `TextIndexScanForEntity` is represented as the same text candidate source plus dictionary-bound `required_entities`; variable-entity `TextIndexScanForEntity` is represented as the same native source with candidate output columns for both the text record / retrieval point and the entity / resource term. Candidate execution validates declared output columns and fails closed if the backend returns rows that do not contain the required retrieval-point or resource-term channel. A QLever `Join(TextIndexScanForWord, fixed TextIndexScanForEntity)` on the same text record variable is folded into one native text candidate source with the fixed entity filter. The physical plan remains valid after the QLever operation object goes out of scope, and text candidates are not coerced into RDF scan results. Syntax failures are reported as parse failures, while parsed-but-unsupported shapes still fail closed with `XPOD_RDF_STATUS_UNSUPPORTED` until the real Xpod-backed planner/index layer is wired behind the facade.

`PlannerRequestContext` also snapshots the native backend capability callback result for each query. A patched or embedded QLever planner can therefore inspect supported permutations, hard scope pushdowns, slot ranges, and candidate-source features at construction/planning time without probing callback pointers or consulting TypeScript configuration. Missing capability callbacks remain explicit `UNSUPPORTED` snapshots, not assumed support.

The Xpod-backed scan adapter uses the same capability contract as a lower-protocol guard: when a backend explicitly returns capabilities, unsupported permutations fail closed before estimate or scan callbacks are invoked. Backends without the optional capability callback keep the older callback-driven behavior for compatibility.

Text and vector candidate operation shells use the same rule for feature bits: an OK capability response without `TEXT_SEARCH` or `VECTOR_SEARCH` fails closed before estimate/search callbacks. This keeps FTS/vector availability in the native data contract that QLever-facing code can plan against.

`XpodQleverPhysicalIndex` is the first native QLever-shaped lower access surface over this protocol. It exposes the query capability snapshot, single and batch dictionary lookup/resolution, QLever id encoding/decoding/comparison, term prefix ranges, text/vector candidate-source factories, QLever `ScanSpecification`-style col0/col1/col2 mapping into RDF slot patterns, and `permutation(...).estimate(...)` / `permutation(...).scan(...)` / `permutation(...).count(...)` / `permutation(...).distinct(...)` / `permutation(...).estimateDistinct(...)` using `PlannerRequestContext`; scan/count/distinct/estimateDistinct, scan-spec, and candidate-source calls preserve the request snapshot, graph scope, source scope, access scope, cancellation, and backend capability guards. Scan-spec graph filters that cannot yet be represented as Xpod graph scope fail closed instead of broadening results. This is the seam that a patched or embedded QLever `Index`/`Permutation` / text-index path should call. It must not grow SPARQL planning, join planning, modifiers, ranking, or fusion policy.

- Build a read-only spike that maps a small QLever-like operator subset to this protocol:
  - term lookup;
  - single permutation scan;
  - 2-3 pattern BGP join;
  - text candidate source;
  - vector candidate source;
  - profile tree.
- This should validate the C ABI shape first. A TypeScript fallback harness can mirror the same calls for comparison, but it is not the primary executor path.

### P3 — Optional native / extension path

Only after P0-P2 show value:

- define the native binding as a C ABI first, with a C++ facade behind it when QLever code is involved;
- evaluate a C++/PG extension component that implements selected hot operators;
- keep PG facts as authority;
- keep native operators shape/cost gated;
- do not create a second SPO store.

The native binding should not expose C++ ABI directly across PostgreSQL or process boundaries. PostgreSQL extensions and external runtimes should see a stable C ABI or generated FFI layer; QLever-specific C++ types stay behind the adapter.

## Non-goals

- Do not expose a user-visible `qlever` backend selector.
- Do not maintain QLever's on-disk RDF index beside PG/SQLite facts.
- Do not implement SPARQL UPDATE through this protocol in the first version.
- Do not support SERVICE federation through this protocol; cross-provider federation remains outside the hot server path.
- Do not make text/vector/path retrieval authoritative over RDF facts or SolidFS files.
- Do not add durable shared Pod model fields for physical term/source/cache keys.

## Acceptance criteria

The protocol design is accepted when:

- existing RDF engine docs link to this spec as the QLever-compatible data boundary;
- the protocol identifies all physical surfaces needed by BGP, text, vector, path, ACL/ACR, CBO, and execution profile;
- each surface states correctness constraints and fallback behavior;
- there are explicit compliance tests for future implementation;
- no section requires a second RDF fact store or query-time dynamic index creation.
