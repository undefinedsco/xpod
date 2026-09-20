# Pod-native Data Capability Platform TODO

**Status:** Deferred design topic; no implementation is authorized by this file
**Parent architecture:**
[Pod-native Applet Platform Architecture](../specs/2026-08-12-pod-native-applet-platform-architecture.md)

## Why this TODO exists

The Data Capability Platform is a platform mainline alongside the Applet/Agent
Plane. It includes both semantic data-contract modeling and construction of a
user's Personal AI Model, as well as what is commonly described as a data middle
platform. These are separate lifecycles and must be designed for Solid rather
than copied from a centralized enterprise warehouse or an opaque model-training
service.

This file preserves the scope and invariants without prematurely choosing
schemas, APIs, storage topology, vendors, or monetization rules while the
current discussion remains focused on Applets, SDKs, modeling, and Discovery.

## Working definition

The future Data Capability Platform should support two related flows over
authorized Pod data and external sources.

The first makes heterogeneous data reusable and interoperable:

```text
User intent + source / Pod resource + discovered vocabularies
  -> infer structure and ask competency questions
  -> map to an existing profile or create a versioned private proposal
  -> validate and generate executable access contracts
  -> ingest or project without replacing source authority
  -> Collection and quality controls
  -> pipeline / worker / enrichment
  -> search, graph, vector, or materialized projection
  -> governed Data API / Agent tool / Data Product
  -> Applet, Agent, or external authorized consumer
```

The second makes a user's AI capability improve from their own authorized data,
preferences, feedback, and task history:

```text
Authorized Pod sources + feedback + explicit purpose
  -> dataset manifest, filtering/redaction, and reproducible snapshot
  -> define a base-model plus retrieval/memory comparison baseline
  -> train by adapter tuning, preference tuning, fine-tuning, or distillation
  -> personal-task, privacy, and permission evaluation
  -> versioned Personal AI Model artifact and deployment profile
  -> governed inference for Applets and Agents
  -> observe, improve, roll back, retire, or rebuild
```

Candidate scope:

- an AI-assisted semantic data-modeling workbench for competency questions,
  vocabulary and application-profile discovery, schema inference, mapping,
  shapes, validation, compatibility evidence, versioning, migration planning,
  and promotion;
- a Personal Model Foundry lifecycle for data selection and consent, dataset
  curation, retrieval and memory, training/fine-tuning/adapters, preference
  learning, distillation, evaluation, model-artifact management, desired
  deployment, rollback, and retirement;
- connectors, import, export, and incremental synchronization;
- semantic mappings and projections over heterogeneous existing data;
- Collections, hydration, datasets, and entity resolution;
- validation, deduplication, quality rules, and schema evolution;
- full-text, graph, vector, hybrid search, and query planning;
- transformation, aggregation, AI enrichment, and background pipelines;
- realtime subscriptions, change propagation, and cache invalidation;
- lineage, provenance, audit, versions, retention, and deletion propagation;
- permission-aware Data APIs and Agent tools;
- Data Product packaging, entitlement, metering, pricing, and developer revenue.

## Two meanings of modeling

This architecture must not use one unqualified `modeling` term for two different
jobs:

1. **Semantic data modeling** makes heterogeneous data understandable and
   interoperable across Applets.
2. **Personal AI Model construction** makes an executable model behave better
   for one person's data, preferences, tasks, and policies.

Semantic data modeling is not a passive schema registry and not a prerequisite
that users must complete manually before using their own data. It is the
semantic compiler between intent, heterogeneous data, and reusable
capabilities.

The semantic path supports three levels without treating them as the same kind
of authority:

| Level | Modeling behavior | Intended use |
| --- | --- | --- |
| Personal / on-read | AI infers structure, discovers vocabularies, and records a private, reversible mapping with confidence and evidence | Make existing authorized data useful immediately |
| Shareable | A versioned mapping or application-profile candidate declares inputs, outputs, identity, constraints, permissions, and compatibility | Let another Applet or Agent reproduce the behavior |
| Trusted / promoted | Reviewed terms, profile constraints, migrations, fixtures, and round-trip tests are published through the normal `@undefineds.co/models` process | Stable cross-product writes and ecosystem contracts |

Expected modeling artifacts include competency questions, source-shape
observations, vocabulary/profile references, mapping rules, confidence and
provenance, validation shapes and reports, identity rules, compatibility and
migration plans, and generated drizzle-solid resources, types, query/API/tool
schemas, forms, fixtures, and tests. These are executable artifacts rather than
an ontology document that every Applet must interpret independently.

The ownership boundary is deliberate:

- Discovery finds community vocabularies, profiles, mappings, and evidence.
- Data Capability creates and runs the modeling workflow, including private and
  provisional mappings.
- Original publishers own the meaning of community terms.
- `@undefineds.co/models` owns approved UDFS terms and curated reusable
  application profiles.
- Applets consume declared model/data capabilities; they do not each build a
  private generic modeling engine.

### Personal Model Foundry

A Personal AI Model is an actual executable user-specific model artifact: an
adapter, fine-tuned checkpoint, distilled model, or eventually an independently
trained model. RAG, memory, tools, and policy belong to the broader Personal AI
Runtime; they are not relabeled as a trained model.

The Foundry produces and governs a Personal Model Release:

```text
base model reference
  + authorized data/purpose manifest
  + training/adaptation recipe
  + adapter, checkpoint, distilled-model, or trained-model artifact
  + evaluation suite and reports
  + runtime comparison baseline and deployment profile
  + provenance, rollback, retention, and revocation rules
```

The platform should prepare trustworthy data and evaluation before spending on
training, and promote a trained artifact only when it beats the cheaper runtime
baseline:

1. Curate explicit preferences, feedback pairs, task traces, and authorized
   training/evaluation snapshots.
2. Measure the current base model with permission-aware Pod retrieval and
   memory as the comparison baseline.
3. Train parameter-efficient adapters such as LoRA, or use preference tuning,
   and promote them only on a material held-out gain.
4. Fine-tune or distill personal/on-device models where capability, latency,
   privacy, or cost justifies the additional lifecycle burden.
5. Use continual learning only after contamination, forgetting, deletion, and
   rollback are demonstrably controlled.

This sequence makes a trained adapter, checkpoint, distilled model, or future
personal foundation model the first-class outcome, while requiring it to remain
tied to its recipe and evidence.

### Asset and authority classification

| Asset | Authority/lifecycle role |
| --- | --- |
| Pod source resources and explicit feedback | User-authoritative facts; never replaced by embeddings or weights |
| Personal model profile, purpose/consent and dataset manifest | User-authoritative control records in the Pod |
| Training/evaluation snapshot | Reproducible, purpose-scoped materialization linked to exact source versions; not a new source of truth |
| Retrieval index, embedding, cache, or memory projection | Derived artifact; invalidate or rebuild under source and policy changes |
| Adapter, checkpoint, or distilled model | Durable, user-owned derived model asset with base-model, code, parameters, dataset, and evaluation lineage; exportable/versioned rather than treated as a disposable cache |
| Evaluation suite and report | Versioned deployment evidence; evaluation examples remain separated from training inputs |
| Deployment profile and active version | User-authoritative choice of model/artifact, tools, scopes, policy, and rollback target |
| Worker lease, retry, GPU allocation, and serving replica | Infrastructure execution state |

Artifact bytes need not all be RDF or fit inside the Pod's RDF graph. Large
snapshots and weights may use Solid file resources or a bound artifact store,
while their manifests, identities, grants, provenance, and lifecycle decisions
remain discoverable from the Pod.

The Foundry owns the Personal Model Release and desired deployment state. Xpod
Agent Runtime/Gateway owns actual training jobs, serving processes, routing,
GPU/CPU allocation, health, and retries. The broader Personal AI Runtime owns
composition with retrieval, memory, tools, and policy. These boundaries may
share SDK contracts, but they are not one lifecycle or one authority.

## Non-negotiable invariants

These constraints already follow from the Pod-native architecture and should
survive the future design:

1. Pod resources and files remain the user-authoritative source of truth.
2. Search indexes, vectors, caches, projections, and materialized views are
   derived data: attributable, invalidatable, and rebuildable.
3. The platform must not create a second hidden user-data authority in its
   infrastructure database.
4. Canonical community terms remain owned by their publishers;
   `@undefineds.co/models` owns UDFS terms and the tested application profiles
   that adopt community terms. Xpod owns adapters, services, execution, and
   product-specific operational schemas.
5. Applets consume declared data capabilities rather than implementing private
   copies of indexing, synchronization, permission, or enrichment pipelines.
6. Capability execution is authorized for a concrete caller, target Pod, data
   scope, and purpose. Runtime location or `local/cloud` is not the product
   authorization model.
7. Every derived result must be traceable to source, capability/provider,
   version, policy, and execution time at a granularity chosen by the future
   provenance design.
8. Revocation, deletion, and source changes must have a defined effect on
   downstream derived data.
9. Developer revenue comes from providing useful capabilities, connectors,
   semantic profiles, Personal AI Model recipes/artifacts, pipelines,
   governance, or Applets—not from taking ownership of user data.
10. AI-assisted schema-on-read may be probabilistic, but its mapping, evidence,
    confidence, and source version must be inspectable and replaceable.
11. Shared writes and durable automated pipelines must not depend on an opaque
    inference alone; they bind to a declared versioned mapping or application
    profile and produce validation/provenance evidence.
12. A base model, a provider model offering, and a user's Personal AI Model
    artifact are different objects with independent versions and ownership.
13. Personal training/evaluation materializations bind to authorized source
    versions, explicit purpose, retention policy, and a reproducible recipe.
14. Evaluation inputs remain versioned and separated from training data so a
    reported improvement cannot be explained by benchmark contamination.
15. Embeddings, memory projections, adapters, checkpoints, and distilled models
    define invalidation or retirement behavior when source data, consent,
    policy, code, or the base model changes.
16. Deletion and revocation must specify rebuild, quarantine, or artifact
    retirement; the platform must not promise magical selective unlearning from
    opaque weights.

## Interfaces to reserve conceptually

The parent architecture may refer to these concepts, but this TODO does **not**
approve them as RDF fields or TypeScript interfaces:

- `consumes` and `produces` data/semantic-profile descriptions;
- competency questions, source-shape observations, and vocabulary/profile
  references;
- versioned mappings, validation shapes/reports, confidence, and promotion
  state;
- `baseModelRef`, Personal AI Model identity, and artifact version;
- purpose/consent, dataset-manifest, and training/evaluation-snapshot references;
- retrieval, memory, preference, tool, and deployment profiles;
- adapter/checkpoint/distilled-model artifact references, recipe, provenance,
  evaluation report, active version, and rollback target;
- permission and purpose requirements;
- Collection or dataset identity;
- source and provenance records;
- pipeline and index-profile identity;
- quality and freshness state;
- entitlement and metering records;
- Data Product reference and service-level description.

Before any becomes shared durable semantics, it must follow the normal
`@undefineds.co/models` proposal and competency-question process.

## Existing foundations to reconcile

The later design should reuse or explicitly supersede, not duplicate, these
existing Xpod foundations:

- [Full-text Index V2 Design](../specs/2026-06-23-full-text-index-v2-design.md)
- [Derived Index Multi-consumer Checkpoints](../specs/2026-08-05-derived-index-multi-consumer-checkpoints-design.md)
- [Progressive Semantic Index](../../progressive-semantic-index.md)
- [Vector Sidecar](../../vector-sidecar.md)
- [SolidFS Specification](../../solidfs-spec.md)
- [Protocol Integration Architecture](../../protocol-integration-architecture.md)
- [Notification Subscription](../../notification-subscription.md)
- [Usage and Quota](../../usage-and-quota.md)

## Questions for the dedicated design part

### Authority and topology

1. What remains exclusively in the Pod, and which derived representations may
   exist in Xpod infrastructure?
2. Is the logical platform federated per Pod, per user, per organization, or a
   combination? How are cross-Pod queries explicitly authorized?
3. How are data location, residency, portability, backup, and deletion proven?

### Semantic catalog, data contracts, and quality

4. How does Data Catalog/Discovery describe physical resources, logical
   Collections, semantic models/profiles, community vocabularies, quality, freshness, and
   compatibility without becoming their authority?
5. How are external schemas mapped first into discoverable community
   vocabularies and then into a curated application profile, and when may a
   mapping propose a new UDFS/shared term?
6. Which validation system expresses shape conformance and data-quality rules?
7. How are semantic-profile and pipeline migrations rolled out without breaking Applets?
8. Which parts of schema inference may remain probabilistic, and what
   evidence is required before an inferred mapping becomes shareable or trusted?
9. Which executable artifacts are generated from a profile, and how do they
   stay consistent across drizzle-solid, APIs, Agent tools, forms, and tests?

### Personal AI Model lifecycle

10. Which Pod resources, feedback, and task traces may be used for which model
    purpose, and how is consent narrowed, inspected, changed, and revoked?
11. What are the canonical manifests for a dataset, reproducible snapshot,
    training/adaptation recipe, model artifact, evaluation suite/report, and
    deployment profile?
12. Which personalization method should be selected for a task—prompt/profile,
    retrieval, memory, adapter/LoRA, preference tuning, full fine-tuning, or
    distillation—and against which baseline?
13. Where are large snapshots, adapters, checkpoints, and distilled weights
    stored, encrypted, moved, exported, and deleted while their control records
    remain Pod-authoritative?
14. How are training/evaluation split, contamination, memorization/privacy
    leakage, regressions, and catastrophic forgetting measured?
15. What happens to every Personal AI Model artifact when source data is
    corrected/deleted, consent is revoked, a base model disappears, or a
    provider can no longer serve it?
16. Which evaluations gate deployment, automatic promotion, rollback, or
    retirement, and which actions require fresh interactive or long-term
    delegation?

### Processing and serving

17. What is the standard pipeline lifecycle: trigger, input snapshot,
   checkpoint, retry, idempotency, output commit, and rollback?
18. Which query/search/data APIs are platform contracts versus protocol
   adapters?
19. How do realtime notification, hydration, index refresh, and cache
    invalidation compose?
20. How are large binary/file-primary resources processed without duplicating
    their bodies into RDF or leaking them outside the authorized boundary?

### Trust and governance

21. What delegation is required for interactive, background, and long-running
    processing?
22. What provenance granularity is useful without making every transformation
    prohibitively expensive?
23. How do permission revocation and right-to-delete propagate into indexes,
    vectors, backups, and third-party processors?
24. How are tenant isolation, resource quotas, cost attribution, and abusive
    pipelines controlled?

### Products and developer value

25. What exactly is a Data Product in a Pod-native system: a dataset, a query,
    a maintained projection, a capability, or a bundle?
26. Which participant is paid for a connector, semantic profile, Personal AI
    Model recipe/artifact, pipeline, enrichment, governance rule, or Applet, and
    what is the metering subject?
27. How are entitlement, pricing, settlement, refunds, version compatibility,
    and service quality represented without coupling user data to one market?
28. Can a user replace a paid provider while preserving the resulting durable
    data and provenance?

## Candidate end-to-end reference flows

The dedicated design should select one semantic/data-operations flow and one
Personal AI Model flow. A strong data-operations candidate is:

```text
Files imports a document
  -> shared Document/File metadata is written to the Pod
  -> Discovery identifies source vocabulary/profile candidates
  -> Data Capability validates an existing profile or records a mapping
  -> generated drizzle-solid access reads the mapped resource
  -> Collection discovers and hydrates it
  -> Xpod builds permission-aware full-text and vector indexes
  -> a Worker generates summary and entity links
  -> Notes/Tasks reuse the generated facts
  -> an Agent queries through a governed tool
  -> the user inspects provenance and revokes access
  -> derived data is invalidated or removed according to policy
```

This flow exercises file-primary resources, RDF semantics, Collections,
search/vector, worker execution, AI enrichment, provenance, permissions,
cross-Applet reuse, Agent consumption, and revocation.

A strong Personal AI Model candidate is:

```text
The user authorizes selected documents, messages, preferences, and feedback
  -> Data Capability writes a purpose-scoped dataset manifest and snapshot
  -> the current base model plus Pod retrieval/memory establishes a baseline
  -> a versioned adapter is trained against the approved training split
  -> held-out personal tasks and permission/privacy negatives are evaluated
  -> the user promotes the passing adapter as their active model version
  -> Applets and Agents invoke it through a governed deployment profile
  -> new feedback is recorded without silently entering training data
  -> source deletion or consent revocation produces an impact report
  -> the affected model is retained, quarantined, retrained, or retired by policy
```

This flow exercises consent, dataset lineage, a true model-training artifact,
comparison against a retrieval baseline, evaluation isolation, user-owned model
storage, deployment, feedback, rollback, and revocation semantics.

## Promotion criteria

Promote this TODO into an approved design only after:

1. the authority and derived-data boundary is agreed;
2. one semantic/data-operations flow and one Personal AI Model flow, including
   their security/permission cases, are selected;
3. existing index, vector, SolidFS, notification, and quota designs are audited
   for reusable contracts and conflicting ownership;
4. the minimum semantic modeling lifecycle—from private inference through shareable
   mapping to promoted profile—is agreed, with model proposals and competency
   questions written for the reference flow;
5. the Personal AI Model lifecycle boundary is agreed across purpose/consent,
   dataset authority, retrieval/memory, training or adaptation, artifact
   storage, evaluation, deployment, rollback, and deletion/revocation;
6. the runtime/delegation model for interactive and background work is agreed;
7. DataCapabilityBench acceptance oracles are specified;
8. monetization decisions are separated from the minimum technical contract so
   they cannot block a useful open capability layer.

Until those criteria are met, new Applets should use existing semantic models,
drizzle-solid, Pod permissions, and published Xpod services. They must not create
private “mini data platforms” or introduce speculative shared Data Product
schemas.
