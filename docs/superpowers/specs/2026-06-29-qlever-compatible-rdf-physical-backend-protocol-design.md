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
- QLever adapter upstream include bridge: [`native/postgres/qlever_adapter/src/XpodQleverBridge.cpp`](../../../native/postgres/qlever_adapter/src/XpodQleverBridge.cpp)
- QLever ValueId bridge: [`native/postgres/qlever_adapter/src/XpodQleverValueIdBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverValueIdBridge.hpp)
- QLever IdTable bridge: [`native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverIdTableBridge.hpp)
- QLever Result bridge: [`native/postgres/qlever_adapter/src/XpodQleverResultBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverResultBridge.hpp)
- Native candidate source bridge: [`native/postgres/qlever_adapter/src/XpodCandidateBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodCandidateBridge.hpp)
- Xpod-backed IndexScan adapter shell: [`native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp`](../../../native/postgres/qlever_adapter/src/XpodBackedIndexScan.hpp)
- QLever adapter internal executor seam: [`native/postgres/qlever_adapter/src/XpodQleverExecutor.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverExecutor.hpp)
- QLever permutation mapping shim: [`native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPermutationMap.hpp)
- QLever scan request bridge: [`native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverScanBridge.hpp)
- QLever parsed plan bridge: [`native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverPlanBridge.hpp)
- QLever scan row materializer: [`native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp`](../../../native/postgres/qlever_adapter/src/XpodQleverScanMaterializer.hpp)
- QLever adapter C++ implementation shell: [`native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp`](../../../native/postgres/qlever_adapter/src/xpod_qlever_adapter.cpp)
- QLever adapter CMake target: [`native/postgres/qlever_adapter/CMakeLists.txt`](../../../native/postgres/qlever_adapter/CMakeLists.txt)
- ABI validator: [`scripts/check-rdf-physical-protocol-abi.cjs`](../../../scripts/check-rdf-physical-protocol-abi.cjs)
- Focused tests: [`tests/native/RdfPhysicalBackendProtocolHeader.test.ts`](../../../tests/native/RdfPhysicalBackendProtocolHeader.test.ts), [`tests/native/QleverAdapterFacade.test.ts`](../../../tests/native/QleverAdapterFacade.test.ts), [`tests/native/QleverPhysicalBackendFacade.test.ts`](../../../tests/native/QleverPhysicalBackendFacade.test.ts), [`tests/native/QleverExecutorFactory.test.ts`](../../../tests/native/QleverExecutorFactory.test.ts), [`tests/native/QleverPermutationMap.test.ts`](../../../tests/native/QleverPermutationMap.test.ts), [`tests/native/QleverScanBridge.test.ts`](../../../tests/native/QleverScanBridge.test.ts), [`tests/native/QleverScanMaterializer.test.ts`](../../../tests/native/QleverScanMaterializer.test.ts), [`tests/native/QleverIdCodec.test.ts`](../../../tests/native/QleverIdCodec.test.ts), [`tests/native/QleverValueIdBridge.test.ts`](../../../tests/native/QleverValueIdBridge.test.ts), [`tests/native/QleverIdTableBridge.test.ts`](../../../tests/native/QleverIdTableBridge.test.ts), [`tests/native/QleverBackedIndexScan.test.ts`](../../../tests/native/QleverBackedIndexScan.test.ts), [`tests/native/QleverResultBridge.test.ts`](../../../tests/native/QleverResultBridge.test.ts), [`tests/native/RdfCandidateBridge.test.ts`](../../../tests/native/RdfCandidateBridge.test.ts)

The physical backend header is the data execution-boundary artifact. The adapter facade is the C ABI entry point that will hide QLever-specific C++ types behind a stable native boundary. Query execution uses `xpod_qlever_query_request` so snapshot and access scope enter the native scan path with the SPARQL bytes instead of being inferred in TypeScript. TypeScript only validates, normalizes, and reports this contract; it is not the hot-path protocol for the PostgreSQL extension path.

The C ABI includes batch term lookup/resolve callbacks. The C++ facade gates every callback field through `struct_size`, so older or partially initialized callback tables fail closed with `UNSUPPORTED` instead of reading past the struct. Broad QLever-style planning must use this batch seam rather than row-by-row dictionary calls.

The scan materializer has two explicit result shapes: a raw `TermKey` row buffer for protocol tests, and a QLever-id-bits row buffer that must go through `PhysicalBackend::encodeQleverId`.
The IdTable bridge then converts the QLever-id-bits row buffer into upstream `IdTable`, giving the future `IndexScan` replacement a single `PhysicalBackend scan -> IdTable` seam.
Parsed BGP constants are bound through the native batch term dictionary before scan execution; the scan request receives term keys and still carries snapshot/access-scope context from `xpod_qlever_query_request`. The bridge also has a first two-triple BGP seam: a primary scan plus subject filter scan that materializes a HashJoin-shaped result without using a second RDF fact store.
The backed IndexScan adapter shell can expose the same scan as upstream `Result`, making the next step a replacement of QLever `IndexScan::computeResult()` rather than another data-shape bridge.
The adapter query request already carries snapshot and access-scope context into the generated scan request, so future QLever-backed execution does not bypass Solid snapshot or ACL/ACR semantics.
The same shell now exposes operation-shaped metadata (`descriptor`, result width, sorted columns) and a `computeResult(false)` seam. It deliberately does not inherit upstream `Operation` yet, because upstream `Operation` brings the whole `QueryExecutionContext`/cache/runtime tree; the next patch can move this seam either into an upstream `IndexScan::computeResult()` patch or into a planner-generated Xpod-backed operation.
The shell also asks the native backend for scan estimates, giving the future operation boundary size, cost, and known-empty decisions without consulting QLever permutation files.
When `computeResult(false)` runs, the shell emits native profile events for the permutation scan boundary. This is the first executable bridge toward QLever-style `RuntimeInformation` without yet importing the full upstream operation tree.
Text and vector candidate callbacks are materialized by a separate native C++ bridge into stable candidate rows. This keeps FTS/VEC candidate sources as protocol inputs to the future planner rather than TypeScript post-filters.

The adapter target is intentionally source-provider based:

- `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=OFF` is the default and builds the stub facade without requiring upstream QLever sources.
- `XPOD_QLEVER_ADAPTER_ENABLE_QLEVER=ON` requires `XPOD_QLEVER_SOURCE_DIR` and validates the embedded API, parser/AST, lower-level planner, and index headers before configuration succeeds.
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

type ScanRequest = {
  snapshot: FactsSnapshot;
  permutation: Permutation;
  pattern: QuadPattern;
  graphScope?: GraphScope;
  accessScope?: AccessScope;
  order?: ScanOrder;
  limit?: number;
  offset?: number;
  batchSize?: number;
  neededSlots?: Array<'subject' | 'predicate' | 'object' | 'graph'>;
};

interface PermutationAccess {
  scan(request: ScanRequest): AsyncIterable<RowBatch<QuadKey>>;
  count(request: ScanRequest): Promise<CountResult>;
  distinct(request: DistinctRequest): AsyncIterable<RowBatch<TermKey[]>>;
}
```

Required behavior:

- `scan` returns dictionary keys, not strings.
- The backend must state the output sort order of each batch.
- `limit` is valid only when the backend can apply it before any non-pushed filter that might change correctness.
- Graph-prefix scan must use actual graph terms or a collation-safe prefix method; it must not accidentally include subject/object IRIs with the same prefix.
- Access scope must be applied before rows are exposed to the executor when the scope can deny rows.
- Batch iteration must support cancellation and must report partial runtime profile data.

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
  query: string;
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
  vector: number[];
  model: string;
  dimensions: number;
  metric: 'cosine' | 'dot' | 'euclidean';
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
| Path scope | source node / local path / URI projection tables |
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

Current state: `xpod_qlever_adapter` exists as a C ABI / C++ facade shell. In QLever-enabled builds, `xpod_qlever_adapter_query_request(...)` can execute the minimal physical scan query shape `SELECT * WHERE { ?s ?p ?o }` and simple IRI/literal-constant BGP variants and a two-triple subject-filter BGP through the Xpod-backed scan/join seam and return SPARQL-style JSON bindings. The bridge decodes QLever result ids through the native id codec and batch-resolves RDF terms through the native dictionary seam before serializing. It also returns a minimal scan profile JSON with operation kind, descriptor, and output rows so the result boundary already carries QLever-style observability data. The bridge now calls QLever `SparqlParser::parseQuery` and delegates its currently supported minimal scan shape to `XpodQleverPlanBridge`, which derives a scan plan from the parsed `BasicGraphPattern`, batches IRI and literal constant term lookup through the native dictionary, and returns the executable `ScanRequestInput` plus operation metadata; two-triple subject filters execute as a second native scan and a small subject-key hash join before serialization. Syntax failures are reported as parse failures, while parsed-but-unsupported shapes still fail closed with `XPOD_RDF_STATUS_UNSUPPORTED` until the real QLever planner/executor is wired behind the facade.

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
