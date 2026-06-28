# Full-text Index V2 P0 Design — Safe Retrieval Foundation

> Parent: [`Full-text Index V2 Design Overview`](2026-06-23-full-text-index-v2-design.md).  
> Implementation plan: [`P0 Safe Retrieval Foundation`](../plans/2026-06-23-full-text-index-v2-p0-safe-foundation.md).
> Implementation report: [`P0 Implementation Report`](./2026-06-23-full-text-index-v2-p0-implementation-report.md).

## Goal

Make text search useful, bounded, and authorization-safe without adding embeddings, LEANN, public QLever syntax, or a universal cost planner.

P0 is the only phase allowed to change the existing text-index behavior by default.

## Scope

P0 includes:

- centralized `TextIndexPolicy`.
- RDF entity projection for searchable textual literals.
- document FTS for allowed Markdown/plain text/log/reader output.
- physical query pushdown for text candidate generation.
- authorization fail-closed behavior.
- P0 schema/version creation and rebuild tooling.

P0 excludes:

- persisted embeddings and ANN/LEANN graph.
- LLM-generated folder summaries.
- public QLever/SPARQL+Text syntax.
- cost-based reordering across all source types.
- complex per-principal materialized Entity Cards.
- P1 source/retrieval-point identity migration.

## TextIndexPolicy

A RDF object is eligible for entity text projection when:

1. It is a string-like literal: plain literal, `xsd:string`, or `rdf:langString`.
2. Its predicate and source class are allowed by `TextIndexPolicy`.
3. Its graph/source is allowed by the query authorization scope at retrieval time.
4. It satisfies size and field budget constraints.

Policy categories:

- `searchableText`: participates in FTS and may contribute to embedding/context projection in later phases.
- `displayOnlyText`: can appear in display/context projection when authorized, but is excluded from default FTS and embedding.
- `sensitiveText`: never enters FTS, embedding, or card body.
- `structured`: RDF/typed index only.
- `relation`: RDF edge; optional authorized label projection in later phases.
- `system`: provenance, ACL/ACR/meta/system state; not default FTS body.

P0 policy decision:

- Known credential/provider/token/ACL/ACR/system namespaces are denied by default.
- Known shared-model textual predicates receive explicit roles.
- Unknown predicates default to `displayOnlyText` unless the source class or app policy explicitly opts into broad text indexing.

This keeps P0 fail-safe while still allowing model-owned resources to expose more than `name` and `description`.

## RDF entity FTS

RDF FTS indexes normalized searchable RDF facts, not serialization text.

Rules:

- Index rows preserve subject, graph/source, predicate, literal, datatype, language, source, policy role, and authorization/materialization version where available.
- Numeric/date/boolean literals remain structured RDF facts. They may be displayed or used as filters/ranking signals, but must not be blindly tokenized as body text unless policy marks the predicate as searchable text.
- IRI and blank-node objects remain RDF relations. A renderer may include an authorized target label/title later, but P0 must not put raw IRI strings into body text as a search shortcut.
- For the same subject, same normalized searchable RDF facts, same source scope, and same `TextIndexPolicy`, the FTS projection hash must be identical regardless of Turtle, JSON-LD, N-Triples, TriG, or RDF/XML syntax.

Syntax differences such as prefix spelling, triple order, JSON-LD key order, or RDF/XML layout must not affect generated projections.

Explicit exceptions:

- Base IRI and relative IRI resolution can change facts.
- Blank nodes need scoped deterministic handling; blank-node labels are not stable cross-serialization identities.
- Datatype and language tag are part of canonical literal identity.
- Predicate policy changes projected fields.

Example source facts:

```turtle
<#task>
  schema:name "修复全文索引" ;
  schema:description "完成查询下推" ;
  ex:acceptance "所有集成测试通过" ;
  ex:note "需要支持中文检索" ;
  ex:priority 3 .
```

If policy allows the four textual literals, they can enter FTS with predicate weights. `schema:name` can become the display heading. `ex:priority` remains structured metadata and should not enter FTS body by default.

## Document FTS

Document FTS handles non-RDF body text and line-access files as documents. RDF facts should prefer Entity FTS.

Document sources:

- Markdown and Markdown-like text.
- Plain text and logs when allowed by policy.
- Reader/OCR outputs when the reader pipeline exists.
- Line-access files as textual documents only when policy explicitly allows body indexing for that source class.

Document FTS returns file/folder-like results, not RDF subject candidates by default. P1 will align those results with durable retrieval-point semantics.

## Query planner requirements

P0 requires FTS to be a planner-visible bounded candidate source.

Required logical sources:

- `TextMatchSource` or current `TextSearch` with equivalent detail.
- `PathScopeSource` when workspace/path/source scope is applied.
- `AclScopeSource` when authorization scope is applied.
- entity field/source filters.

Required P0 pushdowns where backend supports them:

- source/workspace/path filtering.
- ACL/ACR allowed/denied graph/source filtering.
- entity filters.
- candidate scoring.
- field weights.
- `ORDER BY`.
- `LIMIT/OFFSET`.
- per-source and per-entity caps where supported.
- snippet selection where supported.

PostgreSQL should use a physical text operator appropriate to the backend. SQLite should use an actual FTS/token/posting strategy with bounded query plans. A custom term posting table is allowed, but prefix/substring behavior must not degrade into full scans for ordinary queries.

Plan/metrics markers must make behavior visible:

- `TextMatchSource(...)` or current `TextSearch(...)` with equivalent details.
- `AclScopeSource(...)`.
- `PathScopeSource(...)`.
- `TopKPushdown(...)`.
- `PerSourceCap(...)` when source-local cap is enforced.
- no broad TypeScript materialization marker for normal top-k text queries.
- no N+1 entity fetch in normal result hydration.

## Authorization boundary

ACL, ACR, and meta resources are authorization/provenance inputs, not default standalone FTS documents.

Rules:

- ACL/ACR/meta facts remain structured RDF facts.
- They can affect source visibility, graph visibility, inheritance, and cache invalidation.
- They do not enter card body or default FTS text.
- They can be inspected via admin/debug surfaces only with explicit system authorization.

Product-level search must be fail-closed:

- Normal user search requires an authorization scope.
- Missing principal/base path/permission version must reject, not silently search all data.
- System/admin bypass must be explicit in API and plan output.
- ACL filtering must happen before final score/top-k.

## Tokenization and ranking

Whitespace split is insufficient.

P0 tokenizer must cover:

- CJK n-grams or equivalent segmenter.
- Unicode normalization.
- full-width/half-width normalization where appropriate.
- punctuation handling.
- very long tokens without exceeding backend term limits.

P0 ranking must be better than raw `occurrenceCount(normalizedText, query)`:

- BM25 or equivalent TF/IDF scoring where backend supports it.
- field/predicate weights.
- title/name/label boost.
- source/card/field kind weights.
- stable tie-breakers.

## Storage and rebuild boundary

P0 may adapt existing text source/chunk/term/entity tables before adding new ones.

P0 requires:

- text index schema version.
- migration/advisory lock for multi-process startup where backend needs it.
- idempotent table/index creation.
- idempotent backfill.
- full rebuild command.
- incremental rebuild command when practical.
- resumable cursor when practical.
- source hash comparison.
- skipped/error state table or equivalent status rows.
- rebuild metrics and dry-run.

Existing old data behavior:

- Authority data remains unchanged.
- Existing text chunk tables may be migrated or superseded, but raw RDF body chunks must stop being the default RDF FTS surface.
- P0 must not require P2/P3 schema.

## Acceptance gate

P0 is complete only when all of these are true:

- RDF raw serialization boilerplate does not appear as default searchable body text.
- String-like RDF literals beyond `name`/`description` are searchable when policy allows them.
- Credential/provider/token/ACL/ACR/system fields are not in FTS text.
- User search without authorization scope fails closed.
- ACL/ACR filtering happens before final top-k.
- Text search with `limit` does not materialize all matching rows into TypeScript before ranking.
- Entity filters and path/workspace filters are pushed into text candidate generation where supported.
- Chinese long text without spaces is searchable by short Chinese keyword.
- Fresh start and upgrade create P0 schema idempotently.
- Rebuild can scan existing Pod data and regenerate P0 text indexes without changing authority data.
