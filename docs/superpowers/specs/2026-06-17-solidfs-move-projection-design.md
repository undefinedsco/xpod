# SolidFS Move Projection Design

Date: 2026-06-17
Status: Draft for review
Scope: SolidFS folder/file move semantics, cloud materialized workspace, `.meta` notes, and RDF/GSPO projection refresh.

## Summary

Xpod should not implement folder move by making all GSPO terms relative and resolving full IRIs at query time. That path reduces some write amplification but introduces a broad resolver dependency into SPARQL planning, ACL/meta handling, prefix/glob matching, result projection, and debugging.

Instead, Xpod will keep standard RDF/URI semantics in the GSPO projection while adding stable file identity below it. Move operations update file locators and then refresh URI projection through the existing SolidFS sync journal. Since current RDF storage already dictionary-encodes graph, subject, predicate, and object terms, most URI projection refreshes should be implemented as controlled term dictionary rewrite/remap operations rather than rewriting the `rdf_quads` fact table.

## Goals

- Preserve Solid and RDF intuition: externally visible resources remain URI-addressed.
- Keep Agent workspaces usable with ordinary tools such as `ls`, `find`, `rg`, `grep`, `cat`, editors, parsers, and code agents.
- Make folder/file move recoverable through the existing SolidFS journal.
- Avoid re-parsing and re-embedding unchanged content after move.
- Reduce GSPO move write amplification by rewriting distinct URI terms where safe.
- Keep `.meta` visible and useful for AI decisions, while keeping index artifacts internal.

## Non-goals

- Do not make all GSPO subject/object/source terms relative.
- Do not introduce a mandatory full-IRI runtime resolver into every RDF query path.
- Do not make FTS/vector/ANN/planner index artifacts visible in the workspace.
- Do not add a second MoveJournal or ProjectionJournal.
- Do not automatically rewrite user-authored absolute IRIs inside RDF content.
- Do not implement FUSE-level transparent hydration in P0.

## Architecture

```text
File Identity Layer
  fileId / blobId / contentHash / path / uri / materializationState

GSPO Projection Layer
  standard RDF terms and URI semantics
  graph/subject/predicate/object are stored as term ids through rdf_terms

Derived Semantic Layer
  reader tree / retrieval points / text index / vector index
  anchored by fileId + contentHash
```

The file layer owns stable identity and content reuse. The GSPO layer is a URI projection used by SPARQL, drizzle-solid, ACL/meta, and app queries. The derived semantic layer is rebuildable and should not be treated as content authority.

## Current RDF storage fact

Both SQLite/file-backed and PostgreSQL RDF engines store quads as term ids:

```text
rdf_quads:
  graph_id
  subject_id
  predicate_id
  object_id

rdf_terms:
  id
  kind
  value
  hash
  value_head
  normalized_text
```

Writes call the RDF term dictionary for graph, subject, predicate, and object. This means move projection refresh should usually target distinct URI terms first, not the entire quad fact table.

## Move model

### P0: expanded moved entries

A directory move is represented as multiple file-level moved entries sharing one transaction id.

```text
tx_id = solidfs_tx_...

moved /a/docs/x.md      -> /b/docs/x.md
moved /a/docs/sub/y.ttl -> /b/docs/sub/y.ttl
```

This is simple, replayable, and compatible with the existing journal shape.

### P1: moved_prefix compression

For very large directory moves, add a compressed journal operation:

```text
moved_prefix:
  oldPrefix = /a/docs/
  newPrefix = /b/docs/
```

It means every resource under `oldPrefix` moves to `newPrefix` with the suffix preserved. Replay expands it from FileRecord/checkpoint state in batches. P0 should not depend on this optimization.

## SolidFS SyncJournal reuse

Do not create a second journal. Extend the existing SolidFS SyncJournal as the single recovery/outbox mechanism for move and projection work.

Existing journal principles remain:

- one logical journal per Pod;
- entry granularity is a resource change or projection action;
- multi-file or directory-level operations use `tx_id`;
- journal stores metadata and recovery state, never file bodies;
- replay stages must be idempotent;
- compaction absorbs completed history into checkpoints.

Recommended `SolidFsChange` extension:

```ts
type SolidFsChangeType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'moved'
  | 'moved_prefix';

interface SolidFsMoveChange {
  type: 'moved';
  previousPath: string;
  path: string;
  previousResource?: string;
  resource?: string;
  sourcePath?: string;
  sourceVersion?: string;
  contentHash?: string;
  projectionHints?: Record<string, unknown>;
}
```

`TermDictionaryRewrite` is a projection sync action triggered by journal replay. It is not a separate journal.

## TermDictionaryRewrite

Move projection refresh must be implemented through an engine API, not ad hoc SQL updates.

```ts
rewriteTerms({
  oldPrefix,
  newPrefix,
  scope,
  mode,
}): Promise<TermRewriteResult>
```

The API must handle:

- recomputing `hash`, `value_head`, `normalized_text`, and related identity fields;
- invalidating term caches such as `termCache` and `idCache`;
- bumping RDF facts data version;
- marking RDF-3X/search/vector derived states stale where needed;
- handling target term collisions;
- remapping quad slots when the new URI term already exists;
- preserving correctness when a term has mixed system/content usage.

### Default rewrite scope

Safe by default:

- graph/source URI terms;
- Xpod system-generated URI terms;
- `.meta` / `.acl` projection URI terms;
- reader/retrieval exposed URI terms.

Not rewritten by default:

- user-authored absolute IRIs in RDF content;
- imported external entity IRIs;
- `owl:sameAs` or semantic identity links;
- mixed-use terms where changing the dictionary would alter user-authored content unexpectedly.

If a target URI term already exists, rewrite becomes remap/merge rather than direct dictionary update. Conflicts must be explicit and recoverable.

## Local and cloud workspace semantics

### Local

```text
authority = user's real local filesystem
workspace = same real directory
cache = metadata/reader/index artifacts only, not file bodies
```

Local mode should not reshape the user directory with symlinks. `fileId` exists for indexing, journal, reader cache, embedding reuse, and projection state.

### Cloud

```text
authority = R2/COS object store + metadata DB
workspace = local materialized working cache on the runtime node
```

Cloud materialization rules:

- directory tree is complete, so `ls` and `find` do not miss resources;
- by-line/text files are fully local, so `rg`, `grep`, `cat`, parsers, and code tools work normally;
- large media/binary/remote objects appear as local placeholders with `.meta` descriptions;
- full hydration of large objects is an explicit AI/tool decision, not an automatic hidden download;
- dirty hydrated files are protected by journal and cannot be evicted until commit or rollback.

## Hydration behavior

Runtime tools should surface placeholder state rather than silently downloading large files.

A read/stat/open attempt on a placeholder should return enough information for AI to decide:

```json
{
  "kind": "remote-placeholder",
  "path": "video.mp4",
  "mediaType": "video/mp4",
  "byteSize": 1234567890,
  "contentHash": "sha256:...",
  "hydrateAvailable": true,
  "actions": ["metadata", "thumbnail", "range", "full"],
  "estimatedCost": {
    "downloadBytes": 1234567890
  }
}
```

Preferred order is metadata, thumbnail, preview, or range-read before full hydration.

## `.meta` note convention

`.meta` is visible resource description. It may contain note-like resources that describe the original file and derived reader/index coverage. It must not contain secrets, signed URLs, local cache paths, journal cursors, locks, or raw index artifacts.

Use the note vocabulary style and existing Solid/PDS conventions where appropriate. PDS Notepad fields are useful for titles, content, timestamps, and authorship, but the notepad `pim:next` line linked-list structure is not suitable for metadata state.

Recommended fields to reuse:

- `dct:title`
- `dct:description` for human/AI-readable note content
- `dct:created`
- `dct:modified`
- `dct:creator`
- optional `flow:participation` / `flow:participant`

Xpod-specific structured state stays under `udfs:*`.

Example:

```ttl
@prefix dct: <http://purl.org/dc/terms/> .
@prefix sioc: <http://rdfs.org/sioc/ns#> .
@prefix udfs: <https://vocab.undefineds.co/udfs#> .

<#file> a udfs:Note ;
  sioc:about <./report.pdf> ;
  dct:title "File metadata" ;
  dct:description "Remote PDF object, hydrate before reading full bytes." ;
  udfs:noteKind "file-metadata" ;
  udfs:mediaType "application/pdf" ;
  udfs:byteSize 123456789 ;
  udfs:contentHash "sha256:..." ;
  udfs:materializationClass "placeholder-r2" .

<#reader-pdf-v1> a udfs:Note ;
  sioc:about <./report.pdf> ;
  dct:title "PDF reader coverage" ;
  dct:description "Parsed pages 1-12 of 240." ;
  udfs:noteKind "reader-coverage" ;
  udfs:readerKind "pdf" ;
  udfs:readerVersion "pdf-v1" ;
  udfs:coverageUnit "page" ;
  udfs:coveredRange "1-12" ;
  udfs:readUnits 12 ;
  udfs:totalUnits 240 ;
  udfs:status "partial" .
```

## Reader and index visibility

Visibility levels:

```text
Visible in workspace:
  content files, .meta, .acl

Visible through tools/API:
  reader tree, outline, retrieval points, reader coverage

Not visible:
  FTS postings, vector files, ANN graph, planner stats, term dictionary internals
```

Reader tree is content structure and can be shown to AI through tools such as `inspect_structure`, `expand_file`, and `read_section`. Index artifacts are implementation details and should only be accessed through search/query APIs.

## Agent workspace prompt

Agent Runtime should inject workspace semantics into context:

```md
You are operating inside an Xpod SolidFS materialized workspace.

- Directory entries are complete: `ls` and `find` show the workspace tree.
- Text/by-line files are materialized locally and can be read with normal tools.
- Large binary/media/remote-object files may appear as placeholders.
- Placeholder metadata is available through `.meta` and workspace tools.
- Do not assume placeholder bytes are the real content.
- Hydration has cost; inspect metadata before choosing metadata, thumbnail, range-read, or full hydration.
- Writes are tracked by the SolidFS journal and must be committed or rolled back by runtime.
- Search/vector/index artifacts are internal; use search/reader tools rather than looking for index files.
```

A dynamic workspace summary should also be provided, including root, authority type, materialization counts, free local cache, hydration limits, and available tools.

## Conflict rules

Path conflicts are filesystem conflicts and should be resolved synchronously before move is accepted.

Recommended defaults:

- file target conflict: fail;
- directory target conflict: fail in P0;
- content hash duplicate: dedupe blob/cache only, do not merge file identity;
- identity/sameAs candidates: record candidates only, do not auto-merge;
- RDF subject conflict: allow with named graph/provenance;
- historical alias: not active in default query.

Term rewrite conflicts must be explicit:

- direct dictionary update only when no target term exists and usage is safe;
- remap when target term exists;
- skip or mark reconcile-required on unsafe mixed usage.

## Implementation phases

### P0

- Add or align FileRecord/materialization state.
- Implement cloud materialized working cache semantics.
- Define `.meta` note convention for file metadata, hydration hints, and reader coverage.
- Extend SolidFS journal change payload for `moved` entries.
- Implement TermDictionaryRewrite for safe graph/source/system terms.
- Add AI workspace prompt and hydrate tool contract.

### P1

- Add `moved_prefix` journal compression for large directory moves.
- Add finer term usage/provenance tracking.
- Improve collision/remap performance.
- Expose reader tree as virtual resource/API.
- Add thumbnail/range-read pipelines for large remote objects.

## Testing strategy

- Move a single text file and verify FileRecord, `.meta`, GSPO graph/source projection, and reader cache reuse.
- Move a directory with multiple files and verify one `tx_id` groups the move entries.
- Simulate crash after local move but before projection rewrite; verify journal replay completes.
- Simulate term collision and verify remap or reconcile behavior.
- Verify user-authored absolute IRIs are not rewritten by default.
- Verify cloud placeholder appears in `ls/find`, text files work with `rg`, and large object read returns hydration decision metadata.
- Verify dirty hydrated files are not pruned.
- Verify `.meta` reader coverage reports partial/complete/stale states.

## Decisions fixed for P0

- Use `udfs:noteKind`, `udfs:materializationClass`, `udfs:hydrationState`, `udfs:readerKind`, `udfs:readerVersion`, `udfs:coverageUnit`, `udfs:coveredRange`, `udfs:readUnits`, `udfs:totalUnits`, `udfs:contentHash`, `udfs:byteSize`, and `udfs:mediaType` as the first vocabulary surface. These terms may later move into `@undefineds.co/models` vocab exports, but the semantic names are fixed here.
- Use `sioc:about` as the canonical note target predicate in `.meta` for this feature. If shared models later standardize another predicate, readers may accept it as compatibility, but writers should emit `sioc:about`.
- P0 directory target conflicts fail by default. `merge-dir` is not a default behavior and must be an explicit future option.
- P0 term rewrite safety is inferred conservatively from quad slot and source/projection scope: graph/source and Xpod-generated projection terms can rewrite; subject/object content terms are skipped unless they are known Xpod projection terms. A dedicated usage/provenance table is P1.
