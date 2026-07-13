# Full-text Index V2 P4 Design — Native FTS Physical Backend

> Parent: [`Full-text Index V2 Design Overview`](2026-06-23-full-text-index-v2-design.md).
> Depends on: [`P0 Safe Retrieval Foundation`](2026-06-23-full-text-index-v2-p0-safe-foundation-design.md), [`P1 Source/Retrieval Points`](2026-06-23-full-text-index-v2-p1-source-retrieval-points-design.md), [`P2 Embedding/Semantic`](2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md), and [`P3 Fusion Planner`](2026-06-23-full-text-index-v2-p3-fusion-planner-design.md).
> Current evidence boundary: [`2026-06-28-full-text-index-v2-completion-audit`](./2026-06-28-full-text-index-v2-completion-audit.md).

## Working assumptions

- P0-P3 semantics are already the product boundary: `TextMatchSource` is planner-visible, ACL/ACR and path filters are hard filters, and authority data remains in Pod/SolidFS/RDF storage.
- Current text search uses normalized chunk/term postings. That implementation is correct enough as the fallback and baseline.
- P4 is a physical backend upgrade. It must not introduce public external native planner syntax, public PostgreSQL FTS syntax, or new durable Solid model semantics.
- PostgreSQL native full-text search is the first target because cloud workloads are the pressure point. SQLite FTS5 is a later parity target.
- Native FTS may change ranking order. It must not change authorization, path scope, source identity, or result provenance semantics.

## Goal

Add a native full-text physical backend behind the existing text-search abstraction:

```text
RdfQuery.textSearch[]
  -> TextMatchSource
  -> RdfTextIndexLike.search(...)
  -> physical backend selected inside the text index
      - current normalized postings backend
      - PostgreSQL native FTS backend (P4a)
      - SQLite FTS5 backend (P4b)
  -> same RdfTextSearchResult shape
  -> RDF/path/ACL/vector/fusion planner
```

P4 should improve broad text candidate generation and text-heavy fusion queries while preserving the same caller-facing API and planner contracts.

## Non-goals

- Do not replace RDF3X or the RDF fact indexes.
- Do not expose `tsquery`, `MATCH`, external native planner TextSearch syntax, or backend-specific operators as product APIs.
- Do not index raw Turtle/JSON-LD/N-Triples/RDF/XML serialization as the canonical RDF text body.
- Do not add `xxxId`-style durable fields or new shared Solid resources for physical FTS rows.
- Do not make path text the only path mechanism. Path remains structural scope first, weak text signal second.
- Do not remove the current postings backend. It remains the compatibility fallback and benchmark baseline.
- Do not require a C extension or PostgreSQL custom index for P4a. Built-in PostgreSQL FTS is enough for the first native backend.

## Phase split

| Phase | Scope | Default behavior |
| --- | --- | --- |
| P4a | PostgreSQL `tsvector` + GIN backend behind `PostgresRdfTextIndex` | Opt-in until benchmark gate passes. |
| P4b | SQLite FTS5 backend behind `RdfTextIndex` | Opt-in/local parity after P4a. |
| P4c | Tokenizer/ranking tuning and product-quality gates | Promote `auto` only when measured. |

P4a is the only implementation target for the next plan. P4b/P4c are recorded so the P4a design does not paint the system into a corner.

## Architecture boundary

Keep the existing logical layer stable:

- `RdfTextIndexLike.indexText(...)` remains the write entry.
- `RdfTextIndexLike.search(...)` remains the read entry.
- `RdfTextSearchOptions` remains the caller contract for query, workspace, source/path filters, allowed/denied sources, entity filters, limits, and ordering.
- `RdfTextSearchResult` remains the candidate/result contract: source, source key, chunk key, retrieval point key, retrieval kind, heading/path, content offsets, entities, score, and score components.

Add only a small internal physical-backend selector inside the text-index implementation. Avoid a public plugin-style abstraction until there are at least two native backends that need the same interface.

Recommended internal shape:

```text
PostgresRdfTextIndex
  -> PostingTextSearchBackend        # current behavior
  -> PostgresNativeFtsSearchBackend  # P4a, PG-only
  -> select backend per query using capability + policy + fallback reason
```

The selector is not a product API. It exists to make benchmark A/B, fallback, and plan evidence explicit.

## PostgreSQL native FTS storage

P4a adds a derived PG-only table. It should not duplicate path/workspace/source metadata that already lives in `rdf_text_sources`.

Recommended table:

```sql
CREATE TABLE IF NOT EXISTS rdf_text_fts_pg (
  chunk_id BIGINT PRIMARY KEY REFERENCES rdf_text_chunks(id) ON DELETE CASCADE,
  backend_version INTEGER NOT NULL,
  config REGCONFIG NOT NULL,
  projection_hash TEXT NOT NULL,
  fts_vector TSVECTOR NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rdf_text_fts_pg_vector_gin
  ON rdf_text_fts_pg USING GIN (fts_vector);

CREATE INDEX IF NOT EXISTS rdf_text_fts_pg_config
  ON rdf_text_fts_pg (backend_version, config);
```

Rationale:

- Authority text remains in `rdf_text_chunks.content` and RDF/SolidFS. `rdf_text_fts_pg` stores only the derived search vector.
- `workspace`, `local_path`, `source`, `source_key`, and `source_hash` stay in `rdf_text_sources`; query-time joins apply those filters.
- File or folder move updates `rdf_text_sources.local_path`. It should not rewrite content vectors unless the path/folder projection itself is re-indexed as a separate retrieval point.
- A separate table avoids adding PG-specific `tsvector` columns to the cross-backend chunk schema.

Vector construction should use weighted parts derived from existing chunk fields:

```text
A: heading/title/name/label
B: path/folder-card weak text when present
C: body/content field text
D: low-weight auxiliary text when policy allows it
```

Path is not blindly embedded into body text. It enters native FTS only through explicit weak projection fields such as folder cards, headings, or path projection chunks.

## Path handling

Path has two roles and they must stay separate:

1. **Structural scope**: workspace, source, source prefix, local path prefix, allowed/denied source sets. These are filters and must be applied before final ranking/top-k.
2. **Weak lexical signal**: folder names, headings, titles, and folder-card text can contribute to ranking when they are indexed as retrieval text.

For P4a:

- Structural path filters stay in `rdf_text_sources` and use btree-compatible predicates already supported by `RdfSearchSourceFilter`.
- Native FTS queries join `rdf_text_fts_pg -> rdf_text_chunks -> rdf_text_sources` and push structural filters into that SQL before `ORDER BY rank LIMIT ...`.
- Moving a subtree should update source path rows, not rewrite all child FTS vectors. Only retrieval points whose own projection text changes need vector refresh.
- Optional future path acceleration can add `ltree`, `pg_trgm`, or prefix materialization, but that is not part of P4a.

This keeps path usable by FTS queries without turning path into duplicated authority text.

## Query behavior

Default P4a query flow:

```sql
WITH q AS (
  SELECT websearch_to_tsquery($config, $query) AS tsq
), candidates AS (
  SELECT
    chunk.id AS chunk_id,
    ts_rank_cd(fts.fts_vector, q.tsq) AS native_rank
  FROM q
  JOIN rdf_text_fts_pg fts ON fts.fts_vector @@ q.tsq
  JOIN rdf_text_chunks chunk ON chunk.id = fts.chunk_id
  JOIN rdf_text_sources source ON source.id = chunk.source_id
  /* workspace/source/path/allowed/denied/entity filters are pushed here */
  ORDER BY native_rank DESC, chunk.id ASC
  LIMIT $source_window
)
SELECT ...
FROM candidates
JOIN rdf_text_chunks chunk ON chunk.id = candidates.chunk_id
JOIN rdf_text_sources source ON source.id = chunk.source_id
LEFT JOIN rdf_text_entities entity ON entity.chunk_id = chunk.id
ORDER BY candidates.native_rank DESC, chunk.id ASC;
```

Rules:

- Use `websearch_to_tsquery` for ordinary user search when available; fallback to `plainto_tsquery` only for unsupported syntax paths.
- Use `ts_rank_cd` as the first native ranker unless benchmark evidence favors `ts_rank`.
- Push workspace/source/path/allowed/denied/entity filters into the candidate SQL before source-window `LIMIT`.
- Return the same hydrated result shape as the postings backend.
- Keep score explanations explicit. Add a new score algorithm such as `pg-ts-rank-cd` instead of pretending it is `occurrence-heading-boost`.
- Keep deterministic tie breakers.

## Authorization behavior

Native FTS is not allowed to rank unauthorized data and then filter it later.

Required behavior:

- `allowedSources`, `deniedSources`, and `deniedSourcePrefixes` are pushed into the native candidate SQL when provided.
- `workspace`, `sourcePrefix`, and `localPathPrefix` are pushed into the native candidate SQL when provided.
- If the current authorization scope cannot be represented safely in SQL, the query must use the postings fallback or fail closed. It must not run native FTS over all rows and post-filter in TypeScript.
- Query plan evidence must show authorization/path hard filters before rank, reusing P3 markers such as `AclScopeSource(...)`, `PathScopeSource(...)`, and `FusionHardFiltersBeforeRank(...)` when applicable.

## Backend selection and fallback

Add an internal mode with these values:

| Mode | Meaning |
| --- | --- |
| `posting` | Force current normalized postings backend. |
| `pg-native-fts` | Force PostgreSQL native FTS when available; fail or fallback with visible reason. |
| `auto` | Prefer native FTS only for supported query/filter shapes after capability probe and benchmark gate. |

Initial default remains `posting`. `pg-native-fts` is opt-in for P4a testing.

Fallback reasons must be visible in plan/metrics, for example:

- `driver-not-pg`
- `native-schema-missing`
- `native-index-stale`
- `unsupported-query-language`
- `unsupported-tokenizer`
- `unsafe-auth-filter`
- `benchmark-gate-disabled`

Plan markers should include:

- `TextMatchSource(...)`
- `PostgresNativeFts(...)`
- `PostgresNativeFtsGin(...)`
- `PostgresNativeFtsRank(ts_rank_cd)`
- `TopKPushdown(PostgresNativeFts ... )`
- `PostingsFallback(reason:...)` when native is not used
- `NoTsFullMaterialize(TextSearch)` when the native plan preserves bounded pushdown

## Tokenization boundary

PostgreSQL built-in FTS is strong for many whitespace/European-language cases but not a complete answer for all languages.

P4a policy:

- Keep current postings behavior as fallback for CJK/no-space cases unless the native backend proves equivalent recall.
- Store the `config` used for each `fts_vector` so a future rebuild can migrate dictionaries/configs deterministically.
- Do not silently change tokenizer behavior for existing indexes. A tokenizer/config change is a derived-index version change and requires rebuild or side-by-side validation.
- Do not add `zhparser`, `pg_jieba`, or ICU-based extensions in P4a unless a separate dependency decision approves them.

## Rebuild and lifecycle

Native FTS rows are derived. Rebuilds must not mutate authority data.

Required lifecycle:

- `open()`/schema initialization creates native FTS tables only when the mode or capability probe needs them.
- `indexText(...)` writes the existing chunk/posting rows first, then upserts native FTS rows for the affected chunks when native mode is enabled.
- `deleteSource(...)` relies on cascading chunk deletion or explicitly removes native rows.
- `moveSource(...)` updates source metadata only; it does not rewrite native vectors unless projection text changed.
- `refreshDerivedIndexes()` or equivalent rebuild command can populate `rdf_text_fts_pg` from existing `rdf_text_chunks`.
- Stale/missing native rows are detected by `backend_version` and `projection_hash`.
- Side-by-side postings + native is supported during rollout.

Storage stats and benchmark reports must show native FTS bytes separately from postings bytes.

## Benchmark and acceptance gates

P4a needs benchmarks against the current postings backend, not against hand-written expectations.

Required benchmark groups:

1. **Focused text search**
   - common terms with many hits.
   - rare terms with few hits.
   - title/heading boosted terms.
   - entity-filtered text search.
2. **Broad fusion**
   - broad text candidate set + RDF/path/ACL filters + top-k.
   - text + vector fusion with text source windowing.
3. **Path scoped search**
   - same broad query with and without `localPathPrefix`.
   - move-source smoke: path change does not rebuild content vectors.
4. **Tokenizer fallback**
   - Chinese/no-space query either matches native equivalently or emits visible postings fallback.

Acceptance gate:

- `pg-native-fts` can be enabled opt-in on PostgreSQL.
- Native query plans show `PostgresNativeFts(...)` and `TopKPushdown(...)` for supported shapes.
- Unsupported shapes show `PostingsFallback(reason:...)`.
- ACL/ACR and path filters are applied before candidate limit/final rank.
- Result recall matches postings for supported query shapes, allowing documented ranking-order differences.
- Product-scale broad text/fusion cases improve p95 or scanned-row cost against postings baseline, or native remains non-default.
- Serving-query benchmark does not regress beyond the existing strict/product P3 gate.
- Existing P0-P3 tests still pass.
- Storage overhead and index-build duration are reported.

## Expected performance profile

Native PG FTS should help most when:

- the query term hits many chunks and ranking/top-k matters.
- FTS candidates must join with RDF/path/ACL filters.
- current postings scans or app-side scoring dominate latency.

Native PG FTS may not help when:

- the query is already a rare exact token.
- RDF/path filters are more selective than text.
- tokenizer fallback routes to postings.
- the benchmark is dominated by non-text serving queries.

P4 should therefore be promoted by workload-specific gates, not by a blanket assumption that native FTS is always faster.

## Risks

| Risk | Mitigation |
| --- | --- |
| Ranking changes surprise product behavior. | Keep postings baseline, explicit score algorithm, deterministic tie-breakers, and result-diff tests. |
| CJK/no-space recall regresses. | Fallback to postings until native tokenizer support is proven. |
| Storage overhead grows. | Store only `tsvector` derived rows and report native bytes separately. |
| Path moves rewrite too much. | Keep path metadata in `rdf_text_sources`; update vectors only when projection text changes. |
| Authorization is applied too late. | Require SQL pushdown or fail/fallback before native search. |
| PG/PGlite capability mismatch. | Probe capabilities; PGlite can stay on postings until FTS support is validated. |
| Backend-specific logic leaks upward. | Keep the product contract at `TextMatchSource` / `RdfTextIndexLike`. |

## Implementation order for the next plan

1. Add tests that define backend selection, plan markers, fallback reasons, and ACL/path-before-top-k behavior.
2. Add PG native FTS schema creation and rebuild from existing `rdf_text_chunks`.
3. Wire `indexText`, `deleteSource`, and `moveSource` lifecycle to native rows.
4. Implement native candidate SQL and result hydration through existing result shape.
5. Add benchmark mode comparing postings vs PG native FTS for focused text and product fusion cases.
6. Keep default as postings until acceptance gates prove native should become `auto` or default for supported PG workloads.
