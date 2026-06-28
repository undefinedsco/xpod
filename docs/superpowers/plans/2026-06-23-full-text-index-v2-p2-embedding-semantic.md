# Full-text Index V2 P2 Plan — Embedding and Semantic Retrieval

> Parent spec: [`../specs/2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md`](../specs/2026-06-23-full-text-index-v2-p2-embedding-semantic-design.md)  
> Overview: [`../specs/2026-06-23-full-text-index-v2-design.md`](../specs/2026-06-23-full-text-index-v2-design.md)

## Goal

Add vector/embedding retrieval on top of P1 retrieval points while keeping authority text, FTS text, summary text, and embedding input clearly separated.

## Assumptions

- P1 retrieval points are stable enough to key vector points.
- Provider/model/credential configuration is stored in the user's Pod settings, not server environment variables.
- Embedding indexes are derived and rebuildable.

## Deliverables

### 1. Vector points keyed by retrieval points

Add vector records keyed by:

- retrieval point key.
- model/provider.
- projection role/input kind.
- input hash.
- projection policy version.
- model version/dimension.

Rules:

- FTS and vector results join through retrieval-point identity.
- Changing model or projection version invalidates affected vector points.
- Embedding model upgrades are not silent; migrate or build parallel indexes.

Verify:

- Same point can have multiple model-specific embeddings.
- Model switch does not reuse incompatible vectors.
- Missing/expired credential fails with a clear reason.

### 2. Embedding input policy

Support at least two semantic roles:

- `locator`: path terms, folder title/description, heading/title.
- `semantic`: what the point is about, using summary, first paragraph, docstring, or bounded content according to policy.

Rules:

- Path remains structural for filtering; path text may contribute weak semantic signal.
- Body content is not blindly mixed into locator embedding.
- Summary does not replace authority text used by FTS.

Verify:

- Path/title query can retrieve folder/file points without requiring body text match.
- Semantic query can retrieve body/content points.
- Score report distinguishes locator vs semantic vector contribution.

### 3. Summary lifecycle

Add summary only as a derived model input when needed.

Required metadata:

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

Verify:

- Over-budget input records `summarized`, `skipped`, or `error`.
- Source hash change invalidates affected summary/vector rows.

## Out of scope

- Full fusion planner.
- LEANN-like storage optimization.
- Public semantic-search protocol.
- Product benchmark automation beyond focused correctness/performance checks.

## Completion gate

P2 is complete only when:

1. FTS and vector results join through the same retrieval-point keys.
2. Model/provider/version invalidation tests pass.
3. Summary/over-budget behavior is visible and deterministic.
4. P0/P1 search and authorization tests still pass.
