# Full-text Index V2 P2 Design — Embedding and Semantic Retrieval

> Parent: [`Full-text Index V2 Design Overview`](2026-06-23-full-text-index-v2-design.md).
> Implementation plan: [`P2 Embedding and Semantic Retrieval`](../plans/2026-06-23-full-text-index-v2-p2-embedding-semantic.md).
> Implementation report: [`P2 Implementation Report`](./2026-06-23-full-text-index-v2-p2-implementation-report.md).

## Goal

Add vector/embedding search on top of P1 retrieval points while keeping authority text, FTS text, summary text, and embedding input clearly separated. P2 prepares the Xpod vector candidate source for the native-compatible backend; it is not a request to grow a TypeScript/PostgreSQL upper planner.

## Scope

P2 includes:

- vector points keyed by retrieval-point identity.
- model/provider/version-specific embedding indexes.
- embedding input policy for locator and semantic roles.
- summary lifecycle as derived model input only.
- invalidation/rebuild when embedding model, projection policy, or input hash changes.

P2 excludes:

- full fusion planner.
- LEANN-like storage optimization.
- public semantic-search protocol.
- upstream-external native planner-native vector syntax; vector is an Xpod physical-source extension.
- product benchmark automation beyond focused correctness/performance checks.

## Vector point identity

Vector records are derived from retrieval points.

A vector point is keyed by:

- retrieval point key.
- model/provider.
- projection role/input kind.
- input hash.
- projection policy version.
- model version/dimension.

Rules:

- FTS and vector results join through the same retrieval-point identity.
- Changing embedding model, dimension, provider, projection version, or input hash invalidates affected vector points.
- Embedding model upgrades are not silent; migrate or build parallel indexes.
- Authority data is never modified by vector rebuild.

## Embedding input policy

Use two default embedding roles:

- `locator`: path terms, folder title/description, heading/title.
- `semantic`: what the point is about, using summary, first paragraph, docstring, or bounded content according to policy.

Rules:

- Path remains structural for filtering; path text may contribute weak semantic signal.
- Body content is not blindly mixed into locator embedding.
- Summary does not replace authority text used by FTS.
- Raw content mainly belongs to FTS/BM25 and exact source reads; semantic embedding may use bounded content or derived summary according to policy.

This avoids three default embeddings. Summary and raw content are projection choices for the same `semantic` role, not separate vector roles.

## Summary lifecycle

Summary is derived model input only when needed.

Record summary metadata:

- summary model/provider.
- prompt/version.
- source hash.
- original token count.
- summary token count.
- summary rounds.
- failure/skipped reason.

Rules:

- No silent truncation.
- If summary fails, either skip embedding or fall back through an explicit policy.
- Summary is rebuildable and disposable.
- Summary must not replace authority text used by FTS or source reads.

## Storage model boundary

Names below are illustrative and physical.

```text
rdf_vector_points
  point_key
  model
  provider
  dimension
  input_kind
  input_hash
  projection_policy_version
  embedding
  summary_metadata
  status
  updated_at
```

Vector storage must be backend-specific but visible through one logical retrieval interface. Local and cloud backends can differ physically as long as they preserve the same point/model/input identity semantics.

## Acceptance gate

P2 is complete only when all of these are true:

- FTS and vector results join through the same retrieval-point identity.
- Changing embedding model or projection version invalidates affected vector points without modifying authority data.
- Long input over model budget uses bounded summary or skips embedding with an explicit reason.
- Search results can expose score components and provenance for FTS/vector fusion.
- Missing or expired provider credentials fail with a clear reason.
