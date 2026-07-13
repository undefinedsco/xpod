# Full-text Index V2 Design Overview

> Status: split design index. This file is the entry point only. Phase-specific requirements live in the linked specs below so each phase can be reviewed, implemented, and verified independently.

## Working assumptions

- Authority data stays in Pod/SolidFS/RDF storage. Search, vector, ranking, and planner tables are derived indexes.
- Raw Turtle/JSON-LD/N-Triples/RDF/XML serialization is not the primary searchable body for RDF data.
- Current Xpod implementations are the starting point: `RdfTextIndex`, `PostgresRdfTextIndex`, `RdfQuery.textSearch[]`, `vectorSearch[]`, `applyRdfAccessScope(...)`, `MixDataAccessor.textSearchIndexingEnabled`, and `RdfIndexSolidFsSyncer`.
- New storage should evolve existing tables first. New physical tables are allowed only when existing tables cannot express the phase requirement cleanly.
- Names such as `pointId`, `sourceNodeId`, `subjectId`, `predicateId`, and `graphId` are internal physical index keys in this spec. They must not become durable Pod/RDF relation names. Shared Solid models should use URI relation fields with semantic names.
- Planner integration is expressed through public, vendor-neutral source and operator contracts; P0 does not require an external service or vendor-specific protocol.
- P0-P4 define physical-source preparation, compatibility scaffolding, diagnostics, and benchmark baselines without binding to a specific planner implementation or vendor.

## Goal

Build a production-safe retrieval layer that can search RDF entities, document files, path/folder metadata, and eventually embeddings through planner-visible candidate sources while preserving ACL/ACR correctness.

The end-state system supports:

- RDF entity text search over eligible textual literal fields.
- Document text search over Markdown/plain-text/reader output chunks.
- Entity projections/cards for display, FTS, embedding, and Agent context.
- Planner-visible candidate sources for text, vector, RDF, path, and authorization constraints.
- Hard authorization filtering before final ranking/top-k.
- Stable source and retrieval-point identity across file moves where content is unchanged.
- Versioned rebuild/migration tooling.

## Non-goals

- Do not index raw RDF serialization text as the canonical RDF full-text body.
- Do not reduce RDF FTS to only `name` and `description` fields.
- Do not turn RDF textual properties into generic `meta` blobs that lose predicate/datatype/language/provenance.
- Do not rely on application-layer TypeScript full materialization for text candidate filtering, entity join, ranking, or pagination.
- Do not use current file path/URL as stable source identity.
- Do not silently truncate text for embedding, summarization, or indexing.
- Do not expose implementation-specific SPARQL extension syntax as a product API.

## Planner integration boundary

The public design separates stable Xpod semantics from replaceable planner integrations:

```text
SolidRdfEngine
  owns public SPARQL semantics, authority boundaries, source/path/ACL scope,
  snapshots, mutation invalidation, and fallback behavior.

Vendor-neutral native SPARQL ABI
  exposes capability discovery and bounded physical operators for authority facts,
  term dictionaries, permutation scans, and text/vector candidate sources.
```

P0-P4 remain useful as physical-source contracts, report gates, compatibility scaffolding, and benchmark baselines. Planner implementations may consume those contracts without changing `SolidRdfEngine` semantics or exposing vendor-specific details.

Hard rule:

> Planner integrations must preserve `SolidRdfEngine` semantics and use public, vendor-neutral contracts. Vendor-specific implementation and deployment details are outside this design.

## Spec map

Current completion audit: [`2026-06-28-full-text-index-v2-completion-audit`](./2026-06-28-full-text-index-v2-completion-audit.md).

| Phase | Spec | Plan | Report | Purpose |
| --- | --- | --- | --- | --- |
| P0 | [`p0-safe-foundation-design`](2026-06-23-full-text-index-v2-p0-safe-foundation-design.md) | [`p0-safe-foundation-plan`](../plans/2026-06-23-full-text-index-v2-p0-safe-foundation.md) | [`p0-report`](2026-06-23-full-text-index-v2-p0-implementation-report.md) | Safe, bounded, authorization-aware FTS foundation. |
| P1 | [`p1-source-retrieval-points-design`](2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md) | [`p1-source-retrieval-points-plan`](../plans/2026-06-23-full-text-index-v2-p1-source-retrieval-points.md) | [`p1-report`](2026-06-23-full-text-index-v2-p1-implementation-report.md) | Stable source/retrieval identity and projection hygiene. |
| P2 | [`p2-embedding-semantic-design`](2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md) | [`p2-embedding-semantic-plan`](../plans/2026-06-23-full-text-index-v2-p2-embedding-semantic.md) | [`p2-report`](2026-06-23-full-text-index-v2-p2-implementation-report.md) | Embedding and semantic retrieval on shared retrieval points. |
| P3 | [`p3-fusion-planner-design`](2026-06-23-full-text-index-v2-p3-fusion-planner-design.md) | [`p3-fusion-planner-plan`](../plans/2026-06-23-full-text-index-v2-p3-fusion-planner.md) | [`p3-report`](2026-06-23-full-text-index-v2-p3-implementation-report.md) | Product-grade fusion planner built from planner-visible operators. |
| P4 | [`p4-native-fts-design`](2026-06-28-full-text-index-v2-p4-native-fts-design.md) | — | — | Native PostgreSQL/SQLite FTS physical backends behind `TextMatchSource`. |

## Phase boundaries

### P0 — Safe full-text retrieval foundation

P0 changes current text-index behavior by default. It makes search useful, bounded, and authorization-safe without requiring vector search, LEANN, or a universal cost planner.

P0 owns:

- centralized `TextIndexPolicy`.
- RDF entity text projection.
- document FTS for allowed plain/Markdown/reader text.
- physical text-query pushdown evidence.
- fail-closed authorization behavior.
- versioned text-index schema and rebuild tooling.

### P1 — Shared source/retrieval-point identity

P1 makes text, snippets, cards, paths, and future embeddings share stable internal retrieval identity without duplicating authority text.

P1 owns:

- internal `SourceNode` semantics.
- internal `RetrievalPoint` semantics.
- projection-role split: display, FTS, embedding, Agent context.
- path/move correctness.
- chunk budgets and visible skipped/error states.

### P2 — Embedding and semantic retrieval

P2 adds vector/embedding retrieval on top of P1 retrieval points.

P2 owns:

- vector points keyed by retrieval-point identity.
- provider/model/version-specific embedding indexes.
- embedding input policy for locator and semantic roles.
- summary lifecycle as derived model input only.
- invalidation/rebuild when model, policy, or input hash changes.

### P3 — Product-grade fusion planner

P3 adds planner integration only after P0/P1/P2 have reliable physical sources.

P3 owns:

- planner-visible text/vector/RDF/path/ACL sources.
- selectivity/cost/top-k estimates.
- source reordering where safe.
- explicit ranking/fusion components.
- benchmark gates for fusion workloads and serving-query regressions.

### P4 — Native FTS physical backend

P4 keeps the P0-P3 logical contract and swaps the text candidate physical operator when a backend can do better than normalized postings.

P4 owns:

- PostgreSQL `tsvector` / GIN candidate generation behind `TextMatchSource`.
- optional later SQLite FTS5 parity.
- native FTS plan markers, benchmark gates, and visible postings fallback reasons.
- path/ACL/source filters pushed before native rank/top-k.
- native-index rebuild and storage-overhead reporting.

## Shared conceptual model

```text
RDF facts
  -> RDF term dictionary / fact indexes
  -> entity field projection by subject
      -> searchable textual fields
      -> display / FTS / embedding / context projections
      -> entity-card or field-chunk retrieval points

Documents
  -> source nodes
  -> heading/paragraph/token-budget chunks
  -> file-chunk retrieval points

Folders / paths
  -> structural source/path index
  -> optional folder-card retrieval points
  -> weak path text fields

Retrieval points
  -> FTS physical operator / postings
  -> vector points / embeddings
  -> planner-visible candidate sources
```

Core invariant: **unify joinable internal keys, not all dictionaries**. RDF term dictionary, text token dictionary, source identity, and retrieval-point identity may be distinct. They must be linked through stable internal keys that the planner can join.

## Current implementation facts to preserve

Existing useful pieces:

- `RdfTextIndex` and `PostgresRdfTextIndex` maintain text source/chunk/term/entity tables.
- `RdfQuery.textSearch[]` and `vectorSearch[]` can already participate in local and PostgreSQL query execution.
- `applyRdfAccessScope(...)` can project allowed/denied source constraints into search source filters.
- `MixDataAccessor.textSearchIndexingEnabled` can trigger text indexing on CSS-side RDF authority writes.
- `RdfIndexSolidFsSyncer` can sync structured RDF plus optional text/vector indexes from SolidFS direct workspace commits.

Known mismatches to fix in the phase specs:

- The `256` constant is a posting term max length, not a chunk size. Chunk sizing needs explicit token/byte budgets.
- Current indexing is path/content-type driven and can index raw line-addressable RDF text. P0 must prefer entity projection for RDF facts.
- Current search can still materialize broad candidate arrays and rank/slice in TypeScript. P0 requires pushdown evidence.
- Current entity bridge exists only when caller passes `entities[]`. P0/P1 require entity projection as a first-class pipeline.

## Shared API and product boundary

Any product retrieval API must require:

- principal or explicit system bypass.
- workspace/base path or equivalent authorization scope.
- authorization model and permission version, or a way to derive them.
- allowed/denied graph/source constraints, or a way to derive them.
- query budget parameters.

Agent context retrieval must mark retrieved text as untrusted context and preserve provenance:

- source/current path.
- subject.
- predicate or field role.
- graph/source.
- snippet/card section.
- score components where useful.

## Split rationale

The original single spec mixed product intent, backend mechanics, phase planning, and open questions. The split keeps the total design coherent while allowing each phase to meet the AGENTS.md rules:

- assumptions are explicit.
- each phase has a minimal scope.
- unrelated future flexibility is kept out of P0.
- every acceptance gate is verifiable.
