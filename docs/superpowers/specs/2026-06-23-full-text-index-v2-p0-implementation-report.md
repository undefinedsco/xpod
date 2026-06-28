# Full-text Index V2 P0 Implementation Report

> Related spec: [`2026-06-23-full-text-index-v2-p0-safe-foundation-design.md`](./2026-06-23-full-text-index-v2-p0-safe-foundation-design.md)
> Related plan: [`../plans/2026-06-23-full-text-index-v2-p0-safe-foundation.md`](../plans/2026-06-23-full-text-index-v2-p0-safe-foundation.md)

## Status

P0 acceptance-gate behavior is implemented and covered by focused tests plus the current full integration run. This report records backend-specific limits explicitly; it is not a claim that later backend upgrades such as BM25 or PostgreSQL `tsvector` have been implemented.

Current text-index schema version is `2` because P1 retrieval identity added derived `source_key` and `retrieval_kind` columns on top of the P0 text index foundation.

## Implemented P0 behavior

- RDF entity text projection indexes normalized RDF facts instead of raw RDF serialization text.
- `TextIndexPolicy` denies ACL/ACR/Solid system predicates and Xpod credential/provider namespaces from default FTS.
- Unknown RDF predicates default to `displayOnlyText`.
- Policy-allowed string-like literals beyond `name` and `description` (for example `schema:comment`) are searchable while structured, display-only, and sensitive fields stay out of default FTS.
- RDF entity projection preserves subject, predicate, literal value, datatype, language, and policy role in derived entity mentions.
- `schema:name`, `schema:title`, and label-like predicates become entity headings and participate in heading boost.
- Turtle, N-Triples, TriG, JSON-LD, and RDF/XML projection tests verify equivalent facts produce equivalent entity FTS projection.
- SQLite and PostgreSQL text indexes support source/workspace/path allow/deny filters, entity filters, ordering, limit/offset, and per-source caps.
- Query plans expose `TextSearch(...)`, `PathScopeSource(...)`, `AclScopeSource(...)`, `TopKPushdown(...)`, `PerSourceCap(...)`, and `NoTsFullMaterialize(TextSearch)` where applicable.
- Remote Pod Run context retrieval fails closed when access scope is missing or lacks principal / permission version.
- `applyRdfAccessScope(...)` now applies `basePath` even when no explicit allowed/denied graph list exists, so RDF graph patterns plus text/vector candidates stay inside the authorized Pod subtree.
- Base-path-only authorization is visible in search plans as `AclScopeSource(base-path:...)` instead of being hidden as a generic path prefix.
- Text-index schema creation is idempotent, and SQLite legacy entity tables are upgraded with provenance columns on open.
- Rebuild paths can regenerate derived text indexes from SolidFS without mutating authority data.

## Backend limitations

### SQLite text index

- Uses custom normalized term postings and chunk rows, not SQLite FTS5.
- Scoring is lightweight occurrence count plus heading boost. It is not true BM25.
- CJK search uses generated short CJK terms; it is not language-aware segmentation.
- Prefix/substring semantics are limited to the current token/posting strategy and ordinary query terms.
- Per-source cap is implemented. Per-entity cap is not implemented in P0 because retrieval-point/entity ownership is not yet stable enough before P1.

### PostgreSQL text index

- Uses PostgreSQL tables and SQL filters over normalized text/postings. It does not yet use `tsvector` / GIN as the default physical operator.
- Scoring mirrors SQLite lightweight occurrence count plus heading boost. It is not PostgreSQL `ts_rank` / BM25-equivalent ranking.
- CJK behavior follows the same token/posting strategy as SQLite.
- Per-source cap is implemented with SQL windowing. Per-entity cap is not implemented in P0 for the same P1 ownership reason.

### Shared query planner boundary

- P0 exposes bounded candidate-source evidence in the plan, but it is not a full cost-based fusion planner.
- Text-search source-local `limit` is intentionally distinct from query-level `limit`; only source-local windows emit `TopKPushdown`.
- ACL/ACR constraints are pushed into source filters for text/vector candidate generation when provided. Full Solid authorization materialization remains outside the text index and is supplied through `RdfAccessScope`.
- QLever-style source reordering and text/vector/RDF fusion remain P3 work.

## Acceptance gate audit

| Gate | Current evidence | Status |
| --- | --- | --- |
| RDF raw serialization boilerplate does not appear as default searchable body text. | Entity projection indexes RDF literals from parsed quads; tests confirm raw namespace/prefix strings such as `schema.org` are not searchable from raw RDF text. | Covered by focused tests. |
| String-like RDF literals beyond `name`/`description` are searchable when policy allows them. | `TextIndexPolicy` classifies allowed local names such as `comment` as `searchableText`; SQLite/PostgreSQL tests verify `schema:comment` is searchable while structured/display-only/sensitive literals are not. | Covered by focused tests. |
| Credential/provider/token/ACL/ACR/system fields are not in FTS text. | Policy denies ACL/ACR/Solid system predicates, Xpod credential/provider namespaces, and sensitive local-name parts; focused tests verify credential/provider labels and token-like fields are not searchable. | Covered by focused tests. |
| User search without authorization scope fails closed. | Remote Pod Run context retrieval rejects missing access scope or missing principal/permission version. | Covered by focused service tests. |
| ACL/ACR filtering happens before final top-k. | Fusion/search query tests verify unauthorized candidates are filtered before final ranking and expose `FusionHardFiltersBeforeRank(...)` evidence. | Covered by focused query tests. |
| Text search with `limit` does not materialize all matching rows into TypeScript before ranking. | Text-search plans expose `TopKPushdown(...)`, `PerSourceCap(...)`, and `NoTsFullMaterialize(TextSearch)` where applicable. | Covered by focused query/text tests. |
| Entity filters and path/workspace filters are pushed into text candidate generation where supported. | SQLite/PostgreSQL search SQL applies entity, workspace, source, and local path filters before result materialization; query plans expose candidate-source filters. | Covered by focused storage/query tests. |
| Chinese long text without spaces is searchable by short Chinese keyword. | SQLite/PostgreSQL text-index tests verify CJK generated terms match short Chinese keyword queries. | Covered by focused tests. |
| Fresh start and upgrade create P0 schema idempotently. | Schema-version tests reopen fresh indexes; SQLite legacy table upgrade tests verify provenance columns are added idempotently. | Covered by focused tests. |
| Rebuild can scan existing Pod data and regenerate P0 text indexes without changing authority data. | Rebuild/SolidFS sync paths regenerate derived text indexes and record rebuild status; authority-data mutation is outside the text-index write path. | Covered by focused storage/solidfs tests and integration verification. |

## Integration verification

- `bun run test:integration:lite` passed with 17 test files / 87 tests, with 1 file / 1 test skipped by the suite.
- `bun run test:integration:full` passed with 4 test files / 40 tests.

## Required follow-up before declaring P0 complete

- Decide whether the product needs true BM25 / PostgreSQL `tsvector` as a later backend upgrade; current P0 accepts the bounded normalized posting strategy.
- Keep per-entity caps deferred unless P1 retrieval-point/entity ownership is pulled forward.
