# Full-text Index V2 P1 Implementation Report

> Related spec: [`2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md`](./2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md)
> Related plan: [`../plans/2026-06-23-full-text-index-v2-p1-source-retrieval-points.md`](../plans/2026-06-23-full-text-index-v2-p1-source-retrieval-points.md)

## Status

P1 acceptance-gate behavior is implemented for the current chunk-backed retrieval-point model. This report records deferred backend limits explicitly, especially the absence of a standalone physical retrieval-point table.

## Implemented P1 behavior

- Text sources now carry derived internal `source_key` identity in SQLite and PostgreSQL text indexes.
- Text chunks now carry `retrieval_kind` with supported values such as `entity-card`, `field-chunk`, and `file-chunk`.
- `RdfTextSearchResult` exposes `sourceKey`, `retrievalPointKey`, and `retrievalKind` so FTS results can join with future vector/context projections.
- `moveSource(...)` updates a source locator while preserving source identity and existing retrieval-point keys.
- Oversized source text records `skipped` with reason `maxSourceBytes` instead of silently truncating.
- Excess chunk count records `capped` with reason `maxChunksPerSource`.
- Long RDF textual fields can be projected as bounded `field-chunk` retrieval points instead of inflating entity-card bodies.
- `RdfQuery.textSearch` can bind source/retrieval-point/provenance fields for Agent context projection:
  - `sourceKey`
  - `retrievalPoint`
  - `retrievalKind`
  - `entityProvenance`
- `RdfRunContextRetriever` marks retrieved context as untrusted and carries source key, retrieval-point key, retrieval kind, and parsed RDF entity provenance in item metadata.
- `PiAgentRuntimeDriver` projects that metadata into the Agent prompt with `UNTRUSTED_CONTEXT` plus bounded provenance tags.
- `RdfSearchScope.localPathPrefix` filters text-search candidates through the source metadata table, not through FTS terms.
- SQLite and PostgreSQL text indexes maintain structural `local_path` and `(workspace, local_path)` source indexes for prefix/subtree filtering.
- SQLite and PostgreSQL text indexes preserve source identity across `moveSource(...)` while subtree search follows the updated indexed `local_path`.
- Path-only source moves preserve content-backed chunk row identity and term posting rows; weak path changes do not rewrite content chunks.
- Folder metadata sources (`inode/directory` or trailing slash paths) now project to a single `folder-card` retrieval point in both SQLite and PostgreSQL text indexes.
- SQLite and PostgreSQL text search hydrate entity mentions for normal result sets through one batch `entitiesForChunks(...)` call instead of per-result `entitiesForChunk(...)` lookups.

## Backend limitations

- Retrieval points are currently represented through existing text chunk rows, not a separate physical `rdf_retrieval_points` table.
- `source_key` is derived index identity only; it is not a durable Pod/RDF relation.
- Path/source tree indexing currently supports indexed current-path subtree filtering through `localPathPrefix`; it is not yet a full parent/child/depth materialized tree.
- Folder-card projection currently covers explicit folder metadata text only. Automatic folder summaries or child-derived folder cards are not implemented.
- Agent context provenance is bounded in the prompt projection and currently includes entity and predicate tags, not a full rendered RDF card.
- Vector indexes now expose `retrievalPointKey` for current chunk-backed retrieval points; model/provider/version identity is tracked in the P2 report.

## Acceptance gate audit

| Gate | Current evidence | Status |
| --- | --- | --- |
| Same subject + same searchable facts + same policy produce identical field/card/search projections across RDF serialization syntaxes. | `createRdfEntityTextChunksFromText(...)` tests cover Turtle, N-Triples, TriG, JSON-LD, and RDF/XML into the same projected chunk shape. | Covered by focused tests. |
| Long textual RDF fields create bounded `field-chunk` retrieval points and remain exact-searchable in FTS. | Long-field projection creates separate `field-chunk` rows and search returns the long literal with RDF provenance. | Covered by focused tests. |
| Moving a file without content change preserves source identity and content-backed point identity. | `moveSource(...)` tests preserve `sourceKey`, chunk key, and retrieval-point key across moves. | Covered by focused tests. |
| Prefix/subtree path search uses structural path/source index, not FTS. | `localPathPrefix` is pushed to source metadata filters; SQLite/PostgreSQL now create `local_path` and `(workspace, local_path)` source indexes; subtree search follows moved paths. | Covered by focused tests. |
| Weak path text changes do not force content re-indexing beyond path/folder projection fields. | Path-only moves keep the same content chunk row and term posting row identities. | Covered by focused tests. |
| Entity result hydration has no N+1 fetch pattern for normal result sets. | SQLite/PostgreSQL text search call `entitiesForChunks(...)` once for the result set and do not call per-result `entitiesForChunk(...)`. | Covered by focused tests. |
| Agent context projection includes an explicit untrusted-context marker plus source/retrieval-point identity and RDF entity provenance when available. | `RdfRunContextRetriever` metadata and `PiAgentRuntimeDriver` prompt projection include `UNTRUSTED_CONTEXT`, source key, retrieval point, retrieval kind, and bounded RDF entity provenance. | Covered by focused service tests. |

## Integration verification

- `bun run test:integration:lite` passed with 17 test files / 87 tests, with 1 file / 1 test skipped by the suite.
- `bun run test:integration:full` passed with 4 test files / 40 tests.

## Required follow-up before declaring P1 complete

- Add full parent/child/depth materialization only if product queries need direct tree navigation beyond prefix/subtree filtering.
- Connect folder metadata producers to the existing `folder-card` projection when folder description/summary data is available.
- Requirement-by-requirement audit is recorded in [`Full-text Index V2 Current Completion Audit`](./2026-06-28-full-text-index-v2-completion-audit.md). Re-run it before merging if P1 code changes again.
