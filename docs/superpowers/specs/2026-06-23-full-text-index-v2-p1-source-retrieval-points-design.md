# Full-text Index V2 P1 Design — Source and Retrieval Point Hygiene

> Parent: [`Full-text Index V2 Design Overview`](2026-06-23-full-text-index-v2-design.md).
> Implementation plan: [`P1 Source and Retrieval Point Hygiene`](../plans/2026-06-23-full-text-index-v2-p1-source-retrieval-points.md).
> Implementation report: [`P1 Implementation Report`](./2026-06-23-full-text-index-v2-p1-implementation-report.md).

## Goal

Make text search, snippets, cards, paths, and future embeddings share stable internal retrieval identity without duplicating authority data or exposing physical `xxxId` fields as Solid model semantics.

## Scope

P1 includes:

- internal `SourceNode` semantics for file/resource/folder-like sources.
- internal `RetrievalPoint` semantics for entity-card, field-chunk, file-chunk, and folder-card results.
- projection role split: display, FTS, embedding, Agent context.
- hard chunk budgets and skipped/error states.
- path and move handling.

P1 excludes:

- vector/embedding indexes.
- LLM-generated summaries as default behavior.
- cost-based fusion planner.
- public query syntax changes.

## SourceNode semantics

Paths are mutable locators and structural constraints, not stable identity.

A source node tracks:

- stable source key.
- workspace.
- current URI.
- current path.
- parent/source tree relation.
- content type.
- content hash.
- path version.
- authorization/materialization version.

Maintain a separate source/path structure for:

- exact path.
- prefix/subtree.
- parent-child.
- depth.
- workspace.
- extension/content type.
- folder descendants.
- ACL/ACR inheritance materialization.

Do not use FTS or embedding to prove structural path membership.

## RetrievalPoint semantics

Retrieval points are internal physical join targets. They are not durable Pod/RDF relation names.

Point kinds:

- `entity-card`: compact searchable/displayable entity projection.
- `field-chunk`: bounded long RDF literal field.
- `file-chunk`: bounded document body section.
- `folder-card`: folder/title/summary projection when folder projection exists.

Each point preserves:

- source key.
- optional RDF subject/graph/predicate/literal provenance.
- authority reference.
- span/range or heading path.
- kind.
- ordinal.
- projection hash.
- token/byte counts.

FTS, snippets, card hydration, and P2 vectors should all join through this layer.

## Projection roles

Entity Cards are derived views. They do not replace RDF facts.

Use separate projection roles instead of one Markdown blob for everything:

- display projection: user-facing card, may include structured metadata such as priority.
- FTS projection: tokenized text fields with predicate/field weights; excludes display-only structured values unless policy allows.
- embedding projection: bounded model input; may use summary in P2.
- Agent context projection: bounded, provenance-rich, and marked as untrusted context.

Role rules:

- Same subject + same searchable facts + same policy produce identical field/card/search projections across RDF serialization syntaxes.
- Display-only structured metadata must not leak into default FTS.
- Agent context must include provenance and an untrusted-context marker.
- Summary may be an embedding input later; it is not authority text.

## Chunking and budgets

FTS and embedding should share retrieval-point identity, but P1 only needs enough identity to make FTS results, snippets, provenance, and future vector joins stable.

Rules:

- Short RDF textual fields aggregate into an entity-card/text projection point.
- Long RDF textual fields become one or more field-chunk points.
- Markdown/file body text becomes file-chunk points.
- Folder titles/summaries become folder-card points only when folder projection exists.

Preferred chunk boundary order:

1. Explicit heading/section structure.
2. Paragraph boundary.
3. Sentence boundary if available.
4. Hard token window with overlap only after structural boundaries fail.

P1 budgets:

- `maxSourceBytes`.
- `maxFieldBytes`.
- `maxChunkTokens`.
- `maxChunkBytes`.
- `maxChunksPerSource`.
- `maxTermsPerChunk`.
- `maxQueryChars`.
- `maxQueryTerms`.
- `maxEntityFilters`.
- `maxLimit`.
- `maxOffset`.

No silent truncation. If a source/field exceeds policy, the indexer records `skipped`, `capped`, or `error` with reason and hashes.

## Path and move handling

Move handling is split into correctness and derived catch-up.

Correctness path:

- update source locator/path relation.
- update path version.
- update structural path index transactionally enough to avoid wrong query answers.
- preserve source identity when content is unchanged.

Derived catch-up:

- refresh weak path FTS.
- refresh folder-card projection.
- refresh ACL inheritance materialization and stats.
- use journal/rebuild mechanisms for asynchronous catch-up.

RDF relative IRI path:

- if moving changes RDF relative IRI resolution, run RDF move projection separately and rebuild affected entity cards/facts.

Weak path text can include basename, folder title, folder summary, and path segments. It is a low-weight retrieval signal, not authority for path membership. Moving a folder must not force content re-embedding just because path text changed.

## Storage model boundary

Names below are illustrative and physical. Shared Solid models should use semantic URI relation names if any concept becomes durable Pod data.

```text
rdf_text_sources / source_nodes
  source_node_key
  workspace
  current_uri
  current_path
  parent_source_node_key
  content_type
  content_hash
  path_version
  auth_version

rdf_entity_text_fields
  field_key
  subject_term_key
  graph_term_key
  predicate_term_key
  literal_term_key
  datatype_term_key
  language
  source_node_key
  policy_role
  field_weight
  field_hash

rdf_retrieval_points
  point_key
  source_node_key
  subject_term_key
  graph_term_key
  predicate_term_key
  kind
  authority_ref
  text_projection_ref
  span_start
  span_end
  heading_path
  ordinal
  text_hash
  projection_hash
  token_count
  byte_count
```

## Acceptance gate

P1 is complete only when all of these are true:

- Same subject + same searchable facts + same policy produce identical field/card/search projections across RDF serialization syntaxes.
- Long textual RDF fields create bounded `field-chunk` retrieval points and remain exact-searchable in FTS.
- Moving a file without content change preserves source identity and content-backed point identity.
- Prefix/subtree path search uses structural path/source index, not FTS.
- Weak path text changes do not force content re-indexing beyond path/folder projection fields.
- Entity result hydration has no N+1 fetch pattern for normal result sets.
- Agent context projection includes an explicit untrusted-context marker plus source/retrieval-point identity and RDF entity provenance when available.
