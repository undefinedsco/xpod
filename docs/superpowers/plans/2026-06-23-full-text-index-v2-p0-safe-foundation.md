# Full-text Index V2 P0 Plan — Safe Retrieval Foundation

> Parent spec: [`../specs/2026-06-23-full-text-index-v2-p0-safe-foundation-design.md`](../specs/2026-06-23-full-text-index-v2-p0-safe-foundation-design.md)  
> Overview: [`../specs/2026-06-23-full-text-index-v2-design.md`](../specs/2026-06-23-full-text-index-v2-design.md)

## Goal

Make text search useful, bounded, and authorization-safe without adding embeddings, LEANN, public QLever syntax, or a universal cost planner.

P0 is the only phase allowed to change the existing text-index behavior by default.

## Assumptions

- Authority data remains in Pod/SolidFS/RDF storage.
- Text index rows are derived and rebuildable.
- RDF data must not be searched through raw Turtle/JSON-LD/RDF/XML serialization text.
- QLever is only an algorithmic reference in P0.
- Existing engines are the implementation surface: `RdfTextIndex`, `PostgresRdfTextIndex`, `RdfQuery.textSearch[]`, `MixDataAccessor`, and `RdfIndexSolidFsSyncer`.

## Deliverables

### 1. TextIndexPolicy

Add one central policy path that classifies RDF predicates and source classes as:

- `searchableText`
- `displayOnlyText`
- `sensitiveText`
- `structured`
- `relation`
- `system`

Rules:

- Known credential/provider/token/private-key/proxy/auth fields are denied.
- ACL/ACR/meta/system fields are denied from default FTS/card/vector body.
- Known model-owned textual predicates may be searchable beyond `name` and `description`.
- Unknown predicates default to `displayOnlyText`.

Verify:

- Sensitive fields cannot be found through text search.
- Unknown textual predicates are not indexed unless policy opts in.
- Allowed textual predicates beyond `name`/`description` are searchable.

### 2. RDF entity projection for FTS

Replace raw RDF-body indexing for structured RDF writes with entity-field projection.

Rules:

- Searchable input is normalized RDF facts, not serialization syntax.
- Preserve provenance: subject, graph/source, predicate, literal, datatype, language, policy role.
- Numeric/date/boolean literals stay structured; do not tokenize by default.
- IRI/blank-node objects stay relations; do not index raw IRI text as body.

Verify:

- Turtle prefixes, RDF/XML tags, JSON-LD keys, and raw IRI syntax are not searchable body text.
- Same facts across supported RDF syntaxes produce equivalent FTS projection.
- Chinese text literals are searchable by short Chinese keyword.

### 3. Physical query pushdown

Make text search a bounded candidate source instead of a broad TypeScript materialization path.

Required pushdowns where backend supports them:

- source/workspace/path filter.
- entity filter.
- ACL/ACR allowed/denied source or graph filter.
- scoring.
- field weighting.
- `ORDER BY`.
- `LIMIT/OFFSET`.

Plan/metrics must expose evidence:

- `TextMatchSource(...)` or existing `TextSearch(...)` with equivalent detail.
- `PathScopeSource(...)` when path/workspace scope is applied.
- `AclScopeSource(...)` when authorization scope is applied.
- `TopKPushdown(...)` when source-local limit/order is pushed down.
- no broad TypeScript materialization marker for normal top-k text queries.
- no N+1 entity fetch in normal result hydration.

Verify:

- A text search with source-local `limit` does not load all matching chunks into TypeScript before slicing.
- Query-level `limit` is not falsely reported as source-local `TopKPushdown`.
- Entity hydration uses batch lookup for the returned window.

### 4. Authorization fail-closed behavior

Product retrieval must require authorization context unless an explicit system/admin bypass is used.

Rules:

- User search without access scope rejects.
- ACL/ACR filtering happens before final ranking/top-k.
- Bypass is explicit in API and plan output.

Verify:

- Remote Pod search without access scope fails closed.
- Local file/workspace internal tests can still run when explicitly not remote.
- Allowed and denied source filters affect candidate generation before final ranking.

### 5. Schema, rebuild, and upgrade

Add P0 text-index schema/version handling without requiring P1/P2/P3 tables.

Required:

- Idempotent schema creation.
- Rebuild/backfill command or service path.
- Source hash comparison.
- Skipped/error state.
- Rebuild metrics and dry-run.

Ops entry:

- `xpod rdf text-rebuild <workspace> --text-index <sqlite-path> [--source-path <dir>] [--reset] [--dry-run] [--json]`.
- `<workspace>` is the authority URI/path recorded on indexed sources.
- `--source-path` is only for cases where the authority workspace is remote but the ops process has a local materialized directory to scan.
- The command regenerates derived text-index rows only; it must not mutate authority Pod/SolidFS data.

Verify:

- Fresh start creates all P0 structures.
- Re-running setup/migration is idempotent.
- Rebuild regenerates derived text indexes without mutating authority data.

## Out of scope

- Persisted embeddings.
- Summary generation.
- Folder cards.
- SourceNode/RetrievalPoint identity migration.
- Cost-based source reordering.
- Public QLever/SPARQL+Text syntax.

## Completion gate

P0 is complete only when:

1. Unit tests cover policy, RDF projection, CJK query, pushdown evidence, and auth fail-closed behavior.
2. SQLite/local and PostgreSQL/cloud text-index paths both pass focused tests.
3. `bun run build:ts` passes.
4. The implementation report names any backend limitation explicitly instead of hiding it behind generic FTS wording.
