# AI Model Defaults and Discovery

This document defines how Xpod manages default AI models when providers keep
adding, renaming, deprecating, or upgrading models. It covers chat, embedding,
reader/OCR, and agent-runtime models.

## Core Principle

Provider model catalogs are recommendations, not user settings.

```text
Provider Catalog / Discovery
  -> Secretary recommendation
  -> user approval or user policy
  -> User Pod Settings
  -> Runtime resolves one concrete model per run/cache/index
```

The runtime must not silently use a newly discovered provider model unless that
model has been written into the user's Pod settings or the user has explicitly
enabled an auto-follow policy.

## Responsibilities

| Layer | Responsibility | Authority |
| --- | --- | --- |
| Provider Catalog | Built-in or remotely synced knowledge of known providers, models, aliases, default base URLs, capabilities, and recommended defaults. | System recommendation only |
| Discovery | Finds current provider state: available models, deprecated models, compatibility, pricing/quotas, and upgrade relationships. | Derived fact source, not settings |
| Secretary | Explains detected changes and recommends actions to the user in product language. | Recommendation workflow |
| User Pod Settings | Stores enabled providers, configured models, credentials, and selected defaults. | User authority |
| Runtime | Resolves the concrete model for a run, reader cache, embedding index, or tool execution. | Execution fact |

## Model Default Semantics

A provider can have a recommended default in the catalog, but the Pod stores the
actual user default.

```text
catalog.paddleocr.defaultModels = ["PP-OCRv6"]

/settings/providers/paddleocr.ttl
  ai:defaultModel </settings/providers/paddleocr.ttl#PP-OCRv6> .
```

The catalog default is used for bootstrap and recommendations. The Pod default
is what runtime uses.

## Default Policies

Each provider or model selection should have a default policy.

```ts
type DefaultModelPolicy =
  | 'pinned'        // User explicitly fixed this model. Do not auto-upgrade.
  | 'recommended'   // Follow catalog recommendation automatically.
  | 'compatible';   // Allow safe upgrades within the same family/capability.
```

Recommended defaults:

| Model class | Default policy | Reason |
| --- | --- | --- |
| reader/OCR | Recommend upgrade, require user confirmation | Reader cache can be rebuilt and behavior drift is acceptable when visible. |
| chat | Recommend upgrade, require user confirmation | Behavior drift affects answers and agent tone. |
| embedding | Recommend upgrade, require user confirmation and migration plan | Changing model changes vector space, so switching must trigger re-indexing or a parallel index profile. |
| runtime/coding agent | Pinned | Execution behavior and tool-use semantics can drift. |
| custom provider | Pinned | Discovery cannot safely infer provider semantics. |

A model chosen manually by the user becomes `pinned` unless the user explicitly
turns on auto-follow.

## Discovery-to-Secretary Flow

When discovery detects a better or newer model, it creates a candidate. It does
not mutate Pod settings directly.

```text
Discovery detects PP-OCRv7
  -> writes candidate fact / discovery result
  -> compares with user's Pod default PP-OCRv6
  -> Secretary explains the change and recommends an action
  -> user accepts
  -> Xpod writes PP-OCRv7 into User Pod Settings
  -> new runtime executions resolve PP-OCRv7
  -> historical runs and caches still reference PP-OCRv6
```

Example Secretary message:

```text
PaddleOCR has a newer reader model: PP-OCRv7.
Your current default is PP-OCRv6.
Switching may improve OCR quality, but existing reader cache entries will remain
on PP-OCRv6 until rebuilt. Use PP-OCRv7 for new reads?
```

## Allowed Automatic Updates

Automatic updates are allowed only in two cases:

1. **Bootstrap**
   - The user has configured a provider credential, but no model/default exists
     in the Pod yet.
   - Xpod may create the catalog's current recommended model and set it as the
     provider default.

2. **Explicit auto-follow policy**
   - The user enabled `recommended` or `compatible` policy.
   - Xpod may update the default, but it must write an audit trail explaining
     why the change happened.

Audit record requirements:

```ts
interface ModelDefaultChangeAudit {
  provider: string;
  previousModel?: string;
  nextModel: string;
  policy: 'bootstrap' | 'recommended' | 'compatible' | 'manual';
  reason: string;
  approvedBy: 'user' | 'user-policy' | 'system-bootstrap';
  discoveredAt?: string;
  appliedAt: string;
}
```

## Runtime Resolution

Every execution must record the concrete model that was actually used.
Model resolution returns provider/model/policy metadata and, when needed, a
`credentialId`; it does not return raw secrets. Reader and embedding execution
must resolve the raw secret only at invocation time through the host
`CredentialResolver` defined in
[Extension Runtime and Credential Resolution](extension-runtime-and-credential-resolution.md).

```ts
interface ResolvedModelUse {
  provider: string;
  model: string;
  modelType: 'chat' | 'embedding' | 'reader' | 'runtime';
  resolvedFrom:
    | 'explicit-request'
    | 'pod-provider-default'
    | 'pod-ai-config'
    | 'catalog-bootstrap'
    | 'user-policy';
}
```

Runtime records must be immutable enough that historical behavior remains
explainable after catalog changes.

Examples:

- `Run` records chat/runtime model used for an agent step.
- `Reader cache` key includes provider, model, reader version, options hash, and
  source content hash.
- `Embedding index` records provider, model, dimension, tokenizer/profile, and
  index version.

## Embedding-Specific Rule

Embedding upgrades are not ordinary default changes. A new embedding model means
a different vector space.

Allowed strategies:

1. Keep old index and use old model until explicit migration.
2. Build a new index profile in parallel, then atomically switch the active
   profile.
3. Use both profiles temporarily during migration, but report mixed coverage.

Secretary may recommend embedding upgrades the same way it recommends reader/chat
upgrades, but the recommendation must include the index impact and migration
choice. Do not silently change `embeddingModel` for an existing workspace or
Pod. User approval should update the selected embedding model and create or
schedule the required migration/parallel-index work.

## Suggested Model Metadata

Shared model rows should support enough metadata to reason about upgrades.

```ts
interface ModelMetadata {
  modelType: 'chat' | 'embedding' | 'reader' | 'runtime';
  status?: 'active' | 'deprecated' | 'retired';
  family?: string;          // e.g. pp-ocr, qwen-embedding, gpt
  version?: string;         // e.g. v6, v4, 2026-06
  capabilities?: string[];  // e.g. ocr, document-read, embedding, vision
  dimension?: number;       // required for embedding models
  contextWindow?: number;
  supersededBy?: string;    // model IRI or provider-scoped id
  source?: 'catalog' | 'discovery' | 'user-custom';
}
```

Minimum useful fields for upgrade decisions:

- `status`
- `family`
- `version`
- `capabilities`
- `dimension` for embeddings
- `supersededBy` when provider gives a clear replacement

## Product UX Contract

Secretary owns the user-facing recommendation, not the discovery module.

Secretary should explain:

- what changed;
- what the user currently uses;
- whether the change affects chat behavior, reader cache, runtime behavior, or
  embedding indexes;
- whether rebuild/migration is needed;
- what happens to historical runs and existing cache/index data;
- how to roll back.

Discovery should expose structured facts only. It should not generate product
copy or mutate settings directly.

## Storage Boundary

The user's Pod stores:

- enabled providers;
- configured models;
- provider default model;
- credentials;
- default policy and audit records if needed.

Pod settings are the authority for Provider / Model / Credential resources, but
runtime records, reader cache keys, discovery results, and embedding index
profiles should store only provider/model ids and `credentialId`, never the raw
`apiKey` / token value.

The catalog/discovery layer stores or derives:

- known provider aliases;
- recommended default models;
- currently available provider models;
- deprecation/replacement hints;
- pricing/quota/capability metadata;
- confidence and source timestamps.

Catalog/discovery data is rebuildable. Pod settings are user authority.

## Acceptance Criteria

1. Updating `@undefineds.co/models` catalog does not silently overwrite existing
   user Pod model defaults.
2. Bootstrap can create a model/default when the user has a provider credential
   but no model settings.
3. Secretary can present model upgrade recommendations from discovery results.
4. User approval writes the selected model/default into the Pod.
5. Runtime records the concrete model used for every run, reader cache, and
   embedding index.
6. Embedding model changes can be recommended to users, but applying them
   requires explicit migration or a parallel index profile.
7. Historical runs and cache/index entries remain explainable after provider
   catalog changes.
