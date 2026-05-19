---
name: solid-modeling
description: Use when designing or reviewing Solid Pod, RDF, Linked Data, drizzle-solid, or LinX shared model schemas; especially for deciding URI vs id fields, inverse links, chat/thread/message modeling, Pod persistence boundaries, and cross-app data semantics.
metadata:
  short-description: Solid Pod/RDF modeling guidance
---

# Solid Modeling

Use this skill when changing or reviewing Solid Pod data models, RDF vocab mappings, drizzle-solid schemas, repositories, or tests that assert cross-app data semantics.

## Core stance

Model the Pod as a Linked Data graph, not as a relational database with foreign keys.

- Use RDF/Pod relation fields for URI references.
- Use local ids only for subject-template variables, UI labels, runtime keys, or
  repository/API ergonomics.
- Treat durable `id` values as base-relative resource ids when the storage path
  is part of identity; do not collapse them to fragment/local ids.
- Do not let a field named `xxxId` secretly behave like an RDF link.
- Prefer explicit semantic field names: `chat`, `thread`, `message`, `maker`, `replyTo`, `workspace`.
- UI-only state stays outside Pod. Durable shared state belongs in Pod.

## Shared model ownership

When a project has a shared model/ORM package, that package owns durable Pod
storage semantics.

- If a resource/schema/repository already exists in the shared model package,
  app shells should use it directly.
- Do not copy shared predicates, subject templates, Turtle serializers, URI
  builders, or resource state machines into CLI, web, mobile, or plugin shells.
- If the shell needs a missing query or mutation, add the repository/helper and
  contract tests to the shared model package first, then call it from the shell.
- Shell-specific code may keep only interaction and protocol adaptation: CLI/TUI
  rendering, GUI state, command flags, local cache plumbing, and mapping native
  runtime events into shared insert/update DTOs.

## ORM-first Pod access

Do not hand-parse shared business TTL when an ORM schema/resource exists.

- Default runtime stores should receive a `SolidDatabase`/ORM client, not only a
  raw `fetch`. A fetch-only boundary often forces callers into listing Pod
  containers, reading `.ttl` documents, and parsing triples manually.
- Use `db.select().from(resource).where(...)` for list/subset reads.
- Use `db.findById`, `db.updateById`, and `db.deleteById` when callers hold a
  canonical base-relative resource id.
- Use `db.findByIri`, `db.updateByIri`, and `db.deleteByIri` when the concrete
  resource IRI is known.
- Use `db.findByResource`, `db.updateByResource`, and `db.deleteByResource`
  only at adapter boundaries that intentionally accept mixed exact targets such
  as a full IRI, base-relative resource id, or row.
- Do not expose locator-shaped inputs in business APIs. `findByLocator`,
  `updateByLocator`, and `deleteByLocator` are legacy compatibility surfaces;
  new model, repository, and app code should use ById, ByIri, or a repository
  helper with domain-shaped parameters.
- For compound or date-bucketed templates such as
  `{yyyy}/{MM}/{dd}.ttl#{id}`, a fragment/local id is not a complete resource
  id. Resolve it through a repository/index first, or pass the canonical
  base-relative resource id that includes every storage slot.
- If a shell cannot express a needed query/mutation without parsing TTL, add the
  missing resource/repository API to the shared model package instead of moving
  a Turtle parser into the model package.
- Raw Solid client or `fetch` access is acceptable only for protocol-level
  adapters where no shared business resource exists yet, and that boundary
  should be isolated and marked as compatibility/protocol code.

## URI fields vs short-id query ergonomics

Schema/repository storage semantics and app ergonomics are different layers.

## Document resources, base paths, and subjects

Model a Pod document path as the resource identity when the document is the
thing being described.

For RDF documents such as `.ttl`, the file can describe itself. In that case:

- `base` is the container/base IRI prefix where resources live.
- `subjectTemplate` should produce the document-relative resource IRI.
- The RDF subject is usually the document URI itself, not a synthetic fragment.
- Do not store `path`, `filePath`, `wikiPath`, or similar fields when the URI
  already encodes identity and location.
- Use `.meta` only when the primary resource cannot describe itself, for example
  binary files, non-RDF files, or external metadata about a separate resource.

Preferred one-resource-per-file pattern:

```ts
base: '/settings/autonomy/grants/'
subjectTemplate: '{id}.ttl'
```

This models:

```ttl
</settings/autonomy/grants/grant-1.ttl>
  dcterms:title "Allow safe file search" ;
  dcterms:conformsTo </settings/autonomy/schema/grant.ttl#GrantWikiPage> .
```

Avoid adding a separate metadata subject for the same TTL page:

```ttl
</settings/autonomy/grants/grant-1.ttl#meta> ...
```

Use a fragment subject only when the document contains multiple first-class
resources, for example:

```ts
base: '/chat/{chatId}/2026/05/'
subjectTemplate: '07.ttl#{id}'
```

For append-heavy event logs, date-bucketed fragment resources are often better
than one file per event. For durable page-like resources that users or agents
read as a document, one TTL document per page is usually clearer.

## LLM Wiki page mapping

When mapping an LLM Wiki-style page model to Solid:

- The wiki page is a Pod resource URI, normally a TTL document URI.
- Page attributes such as title, summary, body, tags, source, provenance, and
  compiled timestamps are predicates on that page URI.
- The wiki schema/shape is a URI relation, not a filesystem path string.
- Map `schema` to `dcterms:conformsTo <shape-or-schema-uri>`.
- Do not introduce `.meta` for TTL wiki pages unless describing a different
  non-RDF payload.

Example:

```ttl
</settings/autonomy/grants/grant-1.ttl>
  a <https://undefineds.co/ns#GrantWikiPage> ;
  dcterms:title "Allow safe repository inspection" ;
  dcterms:abstract "Permit bounded read-only commands in trusted workspaces." ;
  dcterms:conformsTo </settings/autonomy/schema/grant.ttl#GrantWikiPage> .
```

Index fields may exist for filtering, but they are not a substitute for
semantic evaluation. For example, approval grants can expose action/risk/target
metadata for lookup while the AI Secretary still reads the page body, summary,
tags, provenance, and context to decide whether a concrete request is covered.

### Pod schema layer

Use full URI relation fields:

```ts
message.chat   // full Chat IRI
message.thread // full Thread IRI
message.replyTo // full Message IRI, if present
thread.chat    // full Chat IRI
```

Avoid relation fields like:

```ts
message.chatId
message.threadId
thread.chatId
```

unless they are intentionally opaque local strings and are not RDF links.

### Repository/API layer

It is fine, and usually preferable, to expose short-id helpers:

```ts
messageRepository.listByThreadId(db, { chatId, threadId })
threadRepository.listByChatId(db, { chatId })
```

These helpers should convert short ids to canonical Pod IRIs or canonical
base-relative resource ids internally before querying URI fields.

Do not force UI/CLI callers to manually construct Pod IRIs in every `where` clause.

## Avoid single-field links to compound subject templates

Do not model a relation as `threadId.link(threadResource)` when the target
resource subject template needs more than `id`, for example:

```ts
thread.subjectTemplate = '{chatId}/index.ttl#{id}'
```

A single `threadId` cannot safely resolve that IRI because `chatId` is also required. This can produce template residue such as:

```text
/.data/chat/{chatId}/index.ttl#thread-1
```

Preferred fixes:

1. Store a full URI relation field, e.g. `message.thread`.
2. Use a repository helper that accepts `{ chatId, threadId }` and derives the full URI.
3. If the RDF relation direction should be inverse, use an inverse column or explicit relation writer rather than pretending the child owns the forward predicate.

## Solid Chat relationship guidance

For Solid Chat-like models, align with graph semantics:

| Concept | Preferred RDF direction | Typical predicate |
|---|---|---|
| chat contains message | `chat -> message` | `meeting:message` / `wf:message` as project vocabulary dictates |
| thread contains message | `thread -> message` | `sioc:has_member` |
| reply points to original | `replyMessage -> originalMessage` | `sioc:has_reply` or project reply predicate |
| author/maker | `message -> maker` | `foaf:maker` |

Therefore, a message can be connected to both chat and thread. In a row shape this may surface as `message.chat` and `message.thread`, but the RDF triples may be inverse links:

```ttl
<chat>   meeting:message     <message> .
<thread> sioc:has_member     <message> .
<reply>  sioc:has_reply      <original> .
<message> foaf:maker         <maker> .
```

When the ORM supports inverse predicates, use them for read/write symmetry. If inverse predicates are not robust enough for the operation, write relation triples explicitly in repository code and cover with integration tests.

## Naming rules

- `id`: the resource id relative to the model base. For one-resource-per-file
  templates this may look local, but for compound/date-bucketed templates it
  must include the path and fragment needed to identify the resource, such as
  `chat/default/2026/05/18/runs.ttl#run_x`.
- `id.default((key) => ...)`: the preferred field-level default generator for
  compound/date-bucketed resource ids. `key` is the ORM-generated local random
  key; it is not a schema field or business concept. If callers provide `id`
  explicitly, they must provide the same complete base-relative resource id
  shape that the default would have produced.
- `subjectTemplate`: keep it, but narrow it to expanding the complete `id` into
  the subject. The preferred final shape is `subjectTemplate: '{id}'` or an ORM
  default equivalent. Do not put `{key}` in `subjectTemplate`; `key` only belongs
  to the `id.default((key) => ...)` generator.
- local/template id: the value inserted into a `subjectTemplate` variable such
  as `{id}`; do not return it as the durable `id` when the resource lives in a
  compound path.
- `chat`, `thread`, `message`, `replyTo`, `maker`: URI-valued graph relations.
- `chatId`, `threadId`, `messageId`: acceptable as function parameters, UI selection state, runtime protocol fields, or derived aliases; avoid as persisted RDF link fields.
- `Uri` suffix may be used for compatibility adapters, but prefer semantic names in new Pod schemas.

## Testing expectations

For schema changes, verify both ergonomics and graph semantics:

1. Unit tests for URI builders and short-id repository helpers.
2. Local xpod integration tests for write/readback.
3. Strict seed/readback tests when changing relation semantics:
   - chat
   - thread
   - message
   - session
   - approval/consent/grant/audit where relevant
4. Assert no unresolved template placeholders remain in produced IRIs.

Do not preserve obsolete tests that encode abandoned storage paths. Retire or rewrite them around the current Pod/xpod product path.

## Product semantics boundary

Product-specific domain rules do not belong in this skill file.

- Put product data semantics in the owning package schemas, repositories, and shared docs.
- Keep this skill limited to reusable Solid/RDF modeling guidance.
- If a product defines terms such as `chat`, `thread`, `message`, or `session`, the
  package that owns those schemas should be the single source of truth.
