# Full-text Index V2 P2 Implementation Report

> Related spec: [`2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md`](./2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md)
> Related plan: [`../plans/2026-06-23-full-text-index-v2-p2-embedding-semantic.md`](../plans/2026-06-23-full-text-index-v2-p2-embedding-semantic.md)

## Status

P2 acceptance-gate behavior is implemented for the current vector-row-backed summary lifecycle. This report records implemented vector identity, model isolation, embedding-input policy, service-level summary fallback plumbing, and deferred limits such as the absence of a dedicated summary authority table or automated model migration workflow.

## Implemented P2 behavior

- SQLite and PostgreSQL vector sources now carry derived internal `source_key` identity.
- SQLite and PostgreSQL vector chunks now persist embedding identity metadata:
  - `provider`
  - `model`
  - `modelVersion`
  - `inputKind`
  - `inputHash`
  - `projectionPolicyVersion`
- `RdfVectorSearchResult` exposes:
  - `sourceKey`
  - `retrievalPointKey`
  - embedding identity metadata listed above.
- For the current physical model, `retrievalPointKey` equals `chunkKey`, so callers can align FTS and vector rows when both indexes use the same chunk/retrieval-point key.
- The same retrieval point can keep parallel provider/model-specific vectors in fresh SQLite and PostgreSQL vector indexes.
- Re-indexing a source replaces only the matching provider/model/version/input-kind/projection-policy variant, preserving other model-specific vectors for the same source.
- SQLite and PostgreSQL vector indexes explicitly preserve unaffected vector identities while replacing stale chunks for the affected provider/model/modelVersion/inputKind/projectionPolicyVersion identity. This covers projection-version/model-version invalidation without mutating authority data.
- `RdfQuery.vectorSearch` can bind vector identity fields:
  - `sourceKey`
  - `retrievalPoint`
  - `provider`
  - `model`
  - `modelVersion`
  - `inputKind`
  - `inputHash`
  - `projectionPolicyVersion`
  - `scoreComponents`
- `RdfQuery.textSearch` can also bind `scoreComponents`, so FTS and vector candidates expose comparable fusion/debug payloads at the query layer.
- `RdfQuery.vectorSearch` can filter vector candidates by:
  - `vectorProvider`
  - `vectorModel`
  - `vectorModelVersion`
  - `vectorInputKind`
  - `vectorInputHash`
  - `vectorProjectionPolicyVersion`
- Existing vector schemas are upgraded in place by adding `source_key` and backfilling it from `source` when missing.
- Existing vector schemas are also upgraded in place by adding vector identity metadata columns and backfilling them to empty-string defaults.
- Pre-P2 SQLite and PostgreSQL vector tables with old `UNIQUE(source_id, chunk_key)` constraints are upgraded so the same retrieval point can store parallel provider/model-specific vectors.
- `RdfSearchScope.localPathPrefix` also applies to vector candidate source filtering through source metadata.
- `RdfSearchIndexingService` now applies an explicit embedding-input policy:
  - `semantic` input uses bounded chunk body text.
  - `locator` input uses path plus heading/title breadcrumbs and does not mix body text into locator vectors.
  - default indexing remains `semantic` only unless the service is configured with additional input kinds.
  - each generated vector chunk records `inputKind`, `inputHash`, `provider`, `model`, optional `modelVersion`, and `projectionPolicyVersion`.
- `RdfSearchIndexingService` propagates `embeddingModelVersion` from AI config into vector identity, so model-version upgrades can invalidate/rebuild affected vectors without touching authority data.
- `RdfSearchIndexingService` can enforce `maxEmbeddingInputChars`; over-budget inputs are skipped with visible `input_too_large` metadata instead of being silently truncated.
- When configured with a `summaryService`, `RdfSearchIndexingService` summarizes over-budget embedding inputs and embeds the bounded summary instead of silently truncating the original text.
- Summary failures and summary outputs that still exceed the embedding budget are skipped with explicit reasons (`summary_failed` or `summary_too_large`) instead of crashing the whole index update or silently falling back to truncated input.
- Summary-derived vector chunks persist summary metadata in SQLite and PostgreSQL vector indexes:
  - summary provider/model.
  - prompt version.
  - source hash when available.
  - original and summary character counts.
  - summary rounds.
- `RdfVectorSearchResult.summaryMetadata` exposes that persisted derived-input metadata for downstream fusion/debug surfaces.
- `RdfVectorIndex.summaryLifecycle()` and `PostgresRdfVectorIndex.summaryLifecycle()` expose a derived lifecycle view over summary-backed vector chunks, including source identity, retrieval-point identity, vector model identity, summary metadata, and update time.
- `RdfVectorSearchResult.scoreComponents` now exposes vector fusion/debug inputs such as metric, dimensions, score, distance, dot product, query magnitude, candidate magnitude, and squared distance when available.
- `RdfTextSearchResult.scoreComponents` exposes current FTS scoring inputs: normalized query, occurrence score, heading boost, final score, and the scoring algorithm identifier.
- If the embedding provider rejects the configured credential or call, `RdfSearchIndexingService` returns `embedding_provider_failed` with the provider error message instead of throwing an unclassified error or writing stale partial vectors.

## Backend limitations

- There is no standalone summary lifecycle authority table yet. Current lifecycle queries are derived from vector rows with `summary_metadata`.
- Summary fallback is currently implemented at the indexing-service boundary. The summary text itself is not stored as authority text and has no separate lifecycle authority table yet.
- If no summary service is configured, over-budget embedding inputs still use explicit skip behavior with `input_too_large`.
- There is no background embedding-index migration workflow for model/provider/version upgrades; current support is explicit identity-scoped reindexing.
- Locator embedding is available through the indexing service policy, but broader product rollout still needs caller configuration and query defaults.
- `retrievalPointKey = chunkKey` is sufficient for current shared text/vector chunk callers, but a separate physical retrieval-point table is still deferred.
- Missing model/key configuration and provider-call failures are reported at the indexing-service boundary. Credential refresh itself remains the responsibility of the higher-level extension/provider layer, not the vector index.

## Acceptance gate audit

| Gate | Current evidence | Status |
| --- | --- | --- |
| FTS and vector results join through the same retrieval-point identity. | Text and vector search results both expose `sourceKey` and `retrievalPointKey`; `RdfQuery.textSearch`/`vectorSearch` can bind those fields for query-layer joins. | Covered by focused storage/query tests. |
| Changing embedding model or projection version invalidates affected vector points without modifying authority data. | SQLite and PostgreSQL vector indexes replace only chunks matching provider/model/modelVersion/inputKind/projectionPolicyVersion; unaffected identities remain. `RdfSearchIndexingService` propagates optional `embeddingModelVersion`. | Covered by focused vector/service tests. |
| Long input over model budget uses bounded summary or skips embedding with an explicit reason. | `RdfSearchIndexingService` records `input_too_large`, `summary_failed`, or `summary_too_large`; configured summary service produces bounded summary vector inputs with summary metadata. | Covered by service tests. |
| Search results can expose score components and provenance for FTS/vector fusion. | `RdfVectorSearchResult.scoreComponents`, `RdfTextSearchResult.scoreComponents`, and query bindings expose scoring/provenance payloads. | Covered by focused storage/query tests. |
| Missing or expired provider credentials fail with a clear reason. | Missing key/model returns `ai_config_unavailable` or `embedding_model_unavailable`; provider rejection returns `embedding_provider_failed` with message. | Covered by service tests. |

## Integration verification

- `bun run test:integration:lite` passed with 17 test files / 87 tests, with 1 file / 1 test skipped by the suite.
- `bun run test:integration:full` passed with 4 test files / 40 tests.

## Required follow-up before declaring P2 complete

- Add a dedicated summary lifecycle table only if product usage needs summary reuse, retention, or migration independent of vector rows.
- Requirement-by-requirement audit is recorded in [`Full-text Index V2 Current Completion Audit`](./2026-06-28-full-text-index-v2-completion-audit.md). Re-run it before merging if P2 code changes again.
