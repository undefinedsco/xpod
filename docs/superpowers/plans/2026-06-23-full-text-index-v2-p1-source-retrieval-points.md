# Full-text Index V2 P1 Plan — Source and Retrieval Point Hygiene

> Parent spec: [`../specs/2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md`](../specs/2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md)  
> Overview: [`../specs/2026-06-23-full-text-index-v2-design.md`](../specs/2026-06-23-full-text-index-v2-design.md)

## Goal

Make text search, snippets, cards, paths, and future embeddings share stable internal retrieval identity without duplicating authority data or exposing physical `xxxId` fields as Solid model semantics.

## Assumptions

- P0 text projection and authorization behavior already works.
- Source and retrieval-point keys are internal physical index keys.
- Durable Pod/RDF models should keep semantic URI relation names, not internal key names.

## Deliverables

### 1. SourceNode semantics

Introduce or align an internal source abstraction for file/resource/folder-like objects.

It must track:

- stable source key.
- current URI/path.
- workspace.
- parent/source tree relation.
- content type.
- content hash.
- path version.
- authorization/materialization version.

Rules:

- Path is a mutable locator and structural constraint, not stable identity.
- Moving a file without content change must preserve source identity.
- Prefix/subtree path queries use the structural path/source index, not FTS.

Verify:

- File move updates locator/path relations without creating a new content identity.
- Subtree search remains correct after move.
- Weak path text changes do not force content re-indexing.

### 2. RetrievalPoint semantics

Introduce internal retrieval points for:

- entity-card.
- field-chunk.
- file-chunk.
- folder-card.

Each point must preserve:

- source key.
- optional RDF subject/graph/predicate/literal provenance.
- span/range or heading path.
- kind.
- projection hash.
- token/byte counts.
- ordinal.

Verify:

- Entity result hydration is batchable by point/source keys.
- Long RDF fields become bounded `field-chunk` points.
- Document chunks and RDF entity chunks can join through the same retrieval-point layer.

### 3. Projection role split

Separate derived projections:

- display projection.
- FTS projection.
- embedding projection.
- Agent context projection.

Rules:

- Do not use one Markdown blob for all roles.
- Context projection must be bounded, provenance-rich, and marked untrusted.
- Summary may be an embedding input later, but it is not authority text.

Verify:

- Same subject + same searchable facts + same policy produce identical search projection across RDF syntaxes.
- Display-only structured metadata does not leak into default FTS.
- Agent context includes provenance and untrusted-context marker.

### 4. Chunk budgets and skipped states

Add explicit budgets:

- `maxSourceBytes`
- `maxFieldBytes`
- `maxChunkTokens`
- `maxChunkBytes`
- `maxChunksPerSource`
- `maxTermsPerChunk`

Rules:

- No silent truncation.
- Oversized input records `skipped`, `capped`, or `error` with reason and hashes.

Verify:

- Long fields are exact-searchable in bounded chunks.
- Oversized unsupported input produces a visible skipped/error record.

## Out of scope

- Vector/embedding indexes.
- LLM summaries.
- Cost-based fusion planner.
- Public query syntax changes.

## Completion gate

P1 is complete only when:

1. Source move and retrieval-point identity tests pass.
2. Projection role tests prove display/FTS/context separation.
3. Long-field chunking is bounded and observable.
4. Existing P0 authorization and text-search tests still pass.
