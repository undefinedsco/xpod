# Pod-native Applet Platform Architecture

**Status:** Discussion baseline
**Scope:** Applet ecosystem, SDK boundaries, shared semantic modeling, Personal AI Model boundary, Discovery, and AI-friendly verification
**Deferred:** The detailed Data Capability Platform design is tracked in
[Pod-native Data Capability Platform TODO](../plans/2026-08-12-data-capability-platform-todo.md).

## 1. Purpose

This document records the architectural decisions reached while turning AI
Connection into the first independently testable Xpod/Linx Applet. It is the
shared baseline for the remaining discussion; it is not an implementation plan
and does not imply that every open platform capability should be built now.

Decision language used below:

- **Decided**: a boundary that current implementation must preserve.
- **Direction**: the preferred design, still subject to validation by another
  reference Applet.
- **Open**: a question that remains intentionally unresolved.
- **Deferred**: an important platform area recorded for a later design part.

## 2. Product position

No existing company is a complete analogue. The closest commercial strategy is
Shopify, while different technical surfaces have different reference points:

| Concern | Reference | What to learn | What remains different |
| --- | --- | --- | --- |
| Ecosystem strategy | [Shopify App Extensions](https://shopify.dev/docs/apps/build/app-extensions) | Installable capabilities, stable host surfaces, CLI, review, distribution, and versioned releases | The durable subject is the user's or organization's Pod, not a merchant database owned by the platform |
| Extension contract | [VS Code Extension API](https://code.visualstudio.com/api) | Manifests, contribution points, capability boundaries, host-owned lifecycle, testing, and marketplace compatibility | Xpod/Linx hosts data applications and agents rather than editor features |
| Runtime composition | [Cordis](https://github.com/cordiverse/cordis), [Pi](https://github.com/earendil-works/pi), and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Reversible lifecycle and scoped capabilities; a minimal user-programmable harness with transparent sessions; a complete agent product assembled from replaceable plugins | All remain internal references or adapter candidates rather than the Applet ABI; Pi and DSH are Agent Harnesses, not the Applet platform |
| Server runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) | Isolated functions, capability bindings, deployment, observability, quotas, and background execution | Xpod must preserve Solid identity, Pod authority, and Linked Data semantics |
| AI creation loop | [Replit Agent](https://docs.replit.com/features/agent/overview) | Generate, run, inspect, test, repair, preview, and roll back in one loop | Generated applications must reuse durable shared data instead of creating another project-local silo |

The concise positioning is:

> Xpod is a Pod-native Data and Agent Runtime. Linx is the user-facing host for
> Applets and data capabilities. AI is the intent-to-capability compiler and
> executor: users state what they want, while AI discovers, composes, creates,
> verifies, and operates the required capabilities. It is not a privileged
> bypass around SDK, identity, permission, or modeling contracts.

The intended ecosystem advantage is that an Applet can be replaced without
requiring the user to migrate the durable data it operates on.

### 2.1 North-star experience: intent becomes capability

The product does not require every user to learn software development, RDF, or
platform packaging. Its north star is **言出法随**: a user expresses an intent
in their own terms and the system turns that intent into a safe, working,
evolvable capability.

```text
User intent
  -> understand personal context and policy
  -> discover existing data, semantic profiles, AI models/artifacts, Applets,
     tools, mappings, and services
  -> compose what already exists
  -> create only the missing view, command, mapping, worker, or Applet
  -> preview, test, explain permissions, and execute
  -> observe outcomes and retain approved preference/feedback
  -> improve the person's future capability graph
```

The user-facing unit is therefore not always “an Applet.” Depending on the
intent, the smallest missing contribution may be a command, view, Agent tool,
semantic mapping, connector, automation, worker, recipe, or full Applet. The
Extension Package and trust model for these contribution types remain **Open**,
but the architecture must not force every intent into a new standalone app.

A person's Jarvis is not one ever-growing application or one model. It is the
continuously evolving composition of their authorized data, preferences,
memory, Applets, tools, mappings, automations, models, policies, and grants.

A Personal AI Model is an actual user-specific executable model artifact: for
example an adapter, fine-tuned checkpoint, distilled model, or eventually an
independently trained model. It runs inside a broader Personal AI Runtime that
also supplies retrieval, memory, tools, policy, and context. The model is real;
the surrounding manifests and evidence make it governable and reproducible.

“Continually improves” means that approved durable artifacts and evidence
accumulate—preferences, mappings, recipes, tests, successful compositions, and
explicit feedback. It does not authorize an AI to silently rewrite canonical
facts, enlarge permissions, or treat opaque model weights as the only record of
what was learned.

## 3. Architecture planes

The system is not a single linear SDK stack. It has two product-facing planes,
one authority/runtime foundation, and two cross-cutting planes.

```text
          Discovery: describe, index, match, and compose
  ┌──────────────────────────────────────────────────────┐
  │ Applet / Agent Plane   │ Data Capability Plane      │
  │ UI, commands, tools,   │ organize, retrieve, learn, │
  │ domain workflows       │ evaluate, derive, serve    │
  │                        │                 [DEFERRED]  │
  ├──────────────────────────────────────────────────────┤
  │ Pod / Identity / Runtime Plane                       │
  │ WebID, Solid OIDC, Pod, permissions, API, worker,   │
  │ protocol adapters, Gateway, execution               │
  └──────────────────────────────────────────────────────┘
          Governance: trust, provenance, audit, policy
```

### 3.1 Applet / Agent Plane

**Decided:** Applets own domain interaction and business behavior. They may
provide list/detail content, commands, tools, loading states, and recoverable
errors. They do not own the product rail, global account session, Solid OIDC
implementation, global settings, or canonical pane geometry.

The current first-class contribution is an Applet. A future extension package
may contribute smaller views, commands, API handlers, workers, or Agent tools,
but their lifecycle and trust model remain **Open**. The current Applet contract
must not pretend those decisions have already been made.

### 3.2 Pod / Identity / Runtime Plane

**Decided:** This plane owns WebID, Solid OIDC, target Pod selection, access
control, runtime execution, protocol adapters, API/Gateway projection, and
infrastructure execution state.

- One host window owns one shared Solid session boundary.
- Account login and WebID login are distinct product transactions even when
  they reuse presentation primitives.
- An Applet does not branch on `local` or `cloud`; data and capability
  descriptors express what is available.
- User-authoritative data belongs in the Pod. Leases, retry counters,
  heartbeats, and other executor internals may remain infrastructure state.

### 3.3 Data Capability Plane

**Core boundary decided; detailed design deferred:** This is the Pod-native
data-platform/data-middle-platform concern, not merely CRUD, ETL, or a future
marketplace. It covers three related but distinct capability families:

- **semantic data-contract capability:** vocabulary/profile discovery, schema
  inference, mapping, shapes, validation, compatibility, versioning, migration,
  and generated data-access artifacts;
- **data operations capability:** ingest, Collections, quality, search,
  graph/vector indexes, pipelines, derived views, realtime, provenance, audit,
  data APIs, Data Products, metering, and developer monetization;
- **Personal Model Foundry capability:** purpose-scoped dataset construction,
  retrieval and memory, preference learning, training or parameter-efficient
  adaptation, evaluation, artifact/version management, release and rollback,
  and deletion/revocation handling.

The third family is the intended meaning of “personal modeling” in this
architecture. Its target output is a real user-specific model artifact. Prompt,
retrieval, and memory form the comparison baseline and may remain part of the
runtime, but they are not renamed as model training.

```text
Authorized Pod data + feedback + explicit purpose
  -> dataset manifest and reproducible snapshot
  -> define a base-model plus retrieval/memory comparison baseline
  -> train, adapt, or distill a user-specific model
  -> personal evaluation and privacy/safety gates
  -> versioned Personal AI Model artifact
  -> deploy, observe, improve, roll back, or retire
```

Responsibility then crosses an explicit boundary:

```text
Data Capability / Personal Model Foundry
  -> produces an evaluated Personal Model Release
Xpod Agent Runtime / Gateway
  -> deploys, serves, routes, and observes that release
Personal AI Runtime
  -> composes the served model with retrieval, memory, tools, and policy
```

The Foundry owns desired model-release state and its evidence; runtime owns live
execution state. A serving replica, GPU allocation, lease, or retry counter does
not become part of the Personal Model Release.

Personalization does not change data authority. Source facts, consent, purpose,
the model recipe, artifact manifest, evaluation evidence, and lifecycle choices
are user-authoritative records. Training snapshots, embeddings, adapters,
checkpoints, and serving replicas are derived or executable artifacts with
lineage. A promoted adapter, checkpoint, or distilled model is nevertheless a
durable, user-owned model asset—not a disposable cache. Its bytes may live in
Pod/file storage or an explicitly bound artifact store, but an opaque training
machine or provider must not become the only copy or authority.

Semantic data modeling remains separate. Community publishers retain authority
for their terms, while approved UDFS terms and curated application profiles are
promoted into `@undefineds.co/models`; inferred mappings do not become shared
semantics merely because a Personal AI Model used them.

The detailed architecture is deliberately not decided in this part. The
non-negotiable boundary is:

> Pod resources remain the authority. Indexes, caches, vectors, projections,
> and materialized views are derived, attributable, and rebuildable.

See the linked TODO for the questions that must be answered before implementation.

### 3.4 Discovery Plane

**Decided:** Discovery is an orthogonal, cross-cutting plane. It is not only an
App Store screen and it is not a new owner of every kind of platform data.

Discovery indexes and projects facts whose authority remains with their owning
domain. It supports four distinct kinds of discovery:

| Kind | Question answered |
| --- | --- |
| Semantic discovery | Which semantic models/profiles, vocabularies, shapes, capabilities, versions, and migrations already exist? |
| Data discovery | Which Pods, storages, Collections, resources, indexes, and eventually Data Products are available? |
| AI model discovery | Which base models, personal artifacts, recipes, evaluations, deployment targets, and compatibility constraints exist? |
| Runtime discovery | Which host APIs, workers, protocol handlers, endpoints, and native capabilities are available here? |
| Ecosystem discovery | Which Applets, Agents, adapters, providers, MCP servers, and installable capabilities exist and are compatible? |

Discovery may validate, cache, rank, recommend, and publish descriptions. It
must preserve the source, version, confidence, and freshness of derived facts.
An AI inference by Discovery is a candidate fact, never an untraceable mutation
of a user's Pod or a shared vocabulary.

### 3.5 Governance Plane

Trust, permission, provenance, audit, policy, version compatibility, and future
metering cut across Applets, data capabilities, and runtime execution. They
must not be reimplemented as unrelated product-specific flags.

## 4. Ownership map

| Owner | Owns | Does not own |
| --- | --- | --- |
| Community vocabulary publishers and standards bodies | Canonical external classes, predicates, ontology terms, versions, and their published meaning | Xpod application profiles, product storage layout, or runtime behavior |
| `@undefineds.co/models` | UDFS-owned vocabulary; curated application profiles over community and UDFS terms; durable resource identities, URI helpers, reusable repositories, and migrations | Ownership of community vocabularies, product UI, runtime placement, or provider network execution |
| `drizzle-solid` | Generic ORM/resource machinery for Pod CRUD and queries | Shared business semantics or Applet UI |
| `@undefineds.co/solid-sdk` | Browser/session contract, WebID and Pod runtime, storage selection, authenticated Pod access | Product shell or Applet business state |
| `@undefineds.co/extension-sdk` | Manifest, contribution/lifecycle contract, host capabilities, layout descriptors, framework bindings | Product routes, credentials, provider business rules |
| `@undefineds.co/shared-ui` | Visual tokens and reusable presentation primitives | Session ownership, permission decisions, data access |
| Xpod runtime | Solid/API/Gateway execution, model training/serving backends, protocol adapters, workers, service adapters, derived infrastructure state | Authority over Personal Model Releases, a second copy of shared semantic models, or Applet-specific UI |
| Linx/Xpod host | Module registry, route selection, account surface, shell composition, host capability implementations | Applet domain behavior or shared RDF semantics |
| Applet | Domain UI, commands, workflows, and use of declared capabilities | OIDC mechanics, host geometry, undeclared runtime access |
| Discovery | Indexes, projections, compatibility matching, provenance-aware recommendations | Durable shared schema, user settings, or business authority |
| Data Capability Platform | Semantic data-contract workflow; data ingest, derivation and serving; Personal Model Foundry dataset, training/adaptation, evaluation, artifact release and desired-deployment lifecycle | Canonical external vocabulary meanings, live executor state, unilateral approval of shared UDFS contracts, or opaque ownership of a user's source data and model assets |

Existing lower-level contracts remain authoritative for their subjects:

- [Applet Runtime Reference and Adoption Decision](2026-08-14-applet-runtime-reference-design.md)
- [Shared Linx Applet Shell Design](2026-08-01-shared-linx-applet-shell-design.md)
- [Applet Service Access and Host SDK Design](2026-07-27-applet-service-access-design.md)
- [Extension Runtime and Credential Resolution](../../extension-runtime-and-credential-resolution.md)
- [AI Provider Offering and Capability Design](2026-08-10-ai-provider-offering-capability-design.md)

## 5. Semantic data modeling governance

Modeling is a platform constraint, not an incidental coding step. Code can
compile while two Applets assign incompatible meanings to the same user data.

The Data Capability Plane operationalizes the semantic process in this section.
It can discover, infer, propose, map, validate, generate, and collect evidence;
`@undefineds.co/models` records the reusable contract only after promotion.
This section governs RDF/Linked Data semantics, not training a Personal AI
Model.

**Decided:** AI is normally a model consumer and composer. It becomes a model
proposer only when semantic Discovery and the adopted application profiles
cannot answer the required competency questions.

The decision order is:

1. Search semantic Discovery for established community vocabularies,
   ontologies, shapes, and application profiles that answer the competency
   questions.
2. Reuse the applicable community terms through an explicit application
   profile in `@undefineds.co/models`, including constraints that the upstream
   vocabulary does not prescribe.
3. Reuse an existing UDFS resource, relation, or capability when no adopted
   community term fits.
4. Extend an existing semantic resource when every child instance remains a
   valid instance of its parent and the distinction is reusable across products.
5. Create a new product-owned schema for behavior that is genuinely local to
   one product.
6. Propose a new UDFS/shared model only when the previous options cannot express the
   durable cross-product semantics.

Community reuse is not blind vocabulary mixing. The application profile is the
executable contract that selects terms, adds cardinality/range and resource
identity constraints, records supported versions, and maps them to
drizzle-solid resources and repositories. The external publisher remains the
authority for each borrowed term; `@undefineds.co/models` owns only the curated
profile and Xpod-specific additions.

A shared `Semantic Model Proposal` must state at least:

- the competency questions the model must answer;
- whether each resource is file-primary or control-primary;
- canonical identity and base-relative resource-id rules;
- which fields are literals and which are URI relations;
- class versus capability versus product-role decisions;
- relation to existing vocabulary and why reuse is insufficient;
- community vocabulary source, license, version/status, and adopted application
  profile when external terms are reused;
- storage, permission, versioning, and migration implications;
- representative RDF and round-trip tests.

Protocol-native opaque fields belong under namespaced protocol metadata unless
they need stable cross-product query, deduplication, audit, or recovery.
Product shells must not copy shared predicates, URI builders, serializers, or
resource lifecycle rules.

## 6. Discovery responsibilities by layer

| Layer | Discoverable projection | Authority remains with |
| --- | --- | --- |
| Community vocabularies | Canonical namespaces, classes, predicates, ontology metadata, published shapes/profiles, versions, licenses, deprecations, mappings, and dependencies | Original publishers and standards bodies |
| Models/application profiles | Adopted community terms, UDFS terms, Xpod constraints, resource identities, migrations, and executable examples | `@undefineds.co/models` |
| drizzle-solid | Supported resource/query operations and known limitations | `drizzle-solid` |
| Solid SDK | WebID, Pod/storage binding, session and authenticated access capabilities | Solid server and SDK contract |
| Extension SDK | Manifests, contribution points, requested/provided capabilities, host compatibility | Extension and host contracts |
| Xpod runtime | API, Gateway, worker, protocol-handler and index capabilities | Xpod runtime registries |
| Host | Installed/enabled Applets, routes, native capabilities | Linx/Xpod host |
| Applet | Consumed/provided data types, commands, permissions, tools | Applet manifest |
| Data Capability Platform | Semantic mappings/profiles; datasets, memory/retrieval policies, Personal AI Model artifacts/evaluations; Collections, indexes, pipelines, provenance, and Data Products | Pod source resources, community publishers, and—after semantic promotion—`@undefineds.co/models` |

The minimum Discovery milestone is machine-readable rather than marketplace-
complete:

- a versioned manifest index;
- community vocabulary ingestion plus model/application-profile and capability
  indexes generated from their owners;
- host capability and extension-point descriptions;
- provenance and compatibility validation;
- a query surface usable by both humans and Agents;
- generated documentation from the same source.

Marketplace ranking, billing, revenue share, review operations, and personalized
recommendations are not required for this milestone.

## 7. What “AI-friendly” must mean

Having an SDK, MCP server, template, compatible API, or detailed README is not
proof. The claim must be falsifiable:

> With the same model, prompt, context, time, token, tool, and repair budgets,
> an unfamiliar Agent using the public Xpod SDK should complete real Solid App
> tasks more reliably, safely, and cheaply than the declared baseline.

Four evaluation families are required.

### 7.1 AppletBench

Representative tasks include:

- use the shared account/WebID login boundaries rather than creating a second
  session;
- implement real Pod CRUD with models and drizzle-solid;
- run the same Applet standalone and embedded without a deployment branch;
- request minimum permissions and prove two-user isolation;
- use canonical shell/layout components and recover from network/OIDC failures;
- add an API/worker capability without leaking credentials or host internals.

### 7.2 SemanticModelingBench

Representative assertions include:

- suitable community vocabularies and adopted internal semantics are discovered
  and reused instead of creating near-synonym classes;
- external terms are only used through a declared application profile with
  source, version, license, constraints, and compatibility evidence;
- URI relations and literal external identifiers are not confused;
- class, capability, Offering, and product role remain distinct;
- RDF round trips preserve exact resource identity;
- Applet B can read and update data written by Applet A using only the public
  model and SDK, without seeing Applet A's source.

### 7.3 PersonalModelBench

Representative assertions include:

- every training or evaluation snapshot resolves to authorized source versions,
  explicit purpose, retention policy, and a reproducible recipe;
- retrieval/memory and the current base model establish the measured baseline
  before an adapter, fine-tune, preference tune, or distilled model is promoted;
- evaluation data is isolated from training inputs and includes personal-task,
  permission-negative, privacy-leakage, and regression cases;
- each adapter/checkpoint/distilled model records its base model, training code,
  parameters, dataset, evaluation, storage, deployment, and rollback lineage;
- correcting/deleting source data or revoking consent produces an explicit
  rebuild, quarantine, or retirement decision for every affected artifact;
- an older trusted version can be restored without losing the Pod records that
  explain the user's preferences, data grants, and approved behavior.

### 7.4 DataCapabilityBench

**Deferred:** This will validate two different paths after the Data Capability
Platform contract is designed:

- unfamiliar data through semantic discovery, mapping/profile selection,
  validation, generated access, ingest, indexing, pipeline execution,
  provenance, permissions, and Data Product behavior;
- authorized personal data and feedback through dataset construction,
  retrieval/memory baselines, optional training/adaptation, personal-task
  evaluation, artifact provenance, deployment, rollback, and revocation or
  deletion handling.

### 7.5 Proposed evidence and gates

All tasks need machine-verifiable hidden oracles: build/type checks, browser
flows, real OIDC/Pod integration, RDF graph assertions, permission-negative
tests, credential-leak checks, worker recovery, and visual/accessibility checks.

Initial benchmark targets are a proposal, not yet a release policy:

- at least 80% hidden-task success on the first result;
- at least 95% success within three bounded repair rounds;
- at least +20 percentage points success or 25% lower token/repair cost than a
  raw Solid SDK baseline;
- zero cross-Pod access, credential leakage, or unauthorized permission growth;
- zero blocking visual failures;
- 100% standalone/embedded parity for applicable cases.

Every reported result must include SDK commit/version, model/version, prompts,
budgets, generated diff, logs, browser traces, final RDF assertions, time, and
token cost. Public examples must be separated from rotating hidden tasks to
avoid benchmark memorization.

The product-level north-star metrics are broader than code-generation success:

- time from expressed intent to a verified usable capability;
- percentage of intents fulfilled by composing existing capabilities before
  generating new code;
- percentage of existing authorized data usable without migration;
- permission escalations, irreversible actions, and data pollution caused by
  generated capabilities (target: zero);
- whether approved mappings, preferences, recipes, and tests reduce the cost of
  satisfying later intents for the same person;
- whether a new Personal AI Model version measurably improves held-out personal
  tasks over the declared base-model plus retrieval/memory baseline without
  increasing privacy, permission, or regression failures;
- promotion rate from a useful personal capability to a portable ecosystem
  contribution without requiring the user to write code or RDF manually.

## 8. Development strategy

**Direction:** Build through vertical reference-Applet slices and continuously
extract stable horizontal capabilities. Do not finish packages layer by layer
in isolation, and do not let every Applet implement its own platform.

```text
Reference Applet need
  -> identify irreversible contracts
  -> implement a minimal real vertical slice
  -> move stable behavior to its rightful owner
  -> publish Discovery metadata from that owner
  -> validate with a second independent consumer
  -> pass benchmark and compatibility gates
```

### 8.1 Contract-first concerns

These must not wait for accidental duplication:

- WebID/OIDC/session/permission boundaries;
- Applet identity, manifest, lifecycle, and capability contracts;
- durable model semantics, URI relations, and resource identity;
- standalone/embedded lifecycle;
- test seeds, security oracles, and package-consumer verification.

### 8.2 Product-pulled concerns

These should normally be proven in a real Applet before becoming public API:

- domain-specific interaction patterns;
- provider detail and settings experiences;
- dashboards and cards;
- particular forms and table conventions;
- one-off worker or pipeline UX.

### 8.3 Promotion rule

- Keep one-Applet interaction detail local unless it crosses a security or
  durable-data boundary.
- Promote behavior with a second independent consumer into the appropriate
  shared package.
- Treat a new shared model, capability kind, contribution point, or Data Product
  contract as a compatibility commitment; require proposal, independent
  consumption, and eval evidence.

The first reference set should cover different architectural pressure:

1. **AI Connections:** Provider/Offering/Credential/model discovery, Gateway,
   quota, and coding-client projection.
2. **Files:** file-primary resources, RDF metadata, preview, permissions, and
   search.
3. **Notes or Tasks:** ordinary CRUD, Collections/hydration, semantic reuse,
   and cross-Applet collaboration.
4. **A Worker Applet:** background execution, delegation, eventing,
   idempotency, recovery, and write-back.

Every slice should deliver a real product path, extracted shared capability,
Discovery metadata, and automated acceptance evidence.

### 8.4 Progressive capability promotion

The platform should not impose marketplace-grade authoring requirements on a
personal intent. AI performs the promotion work as the blast radius grows:

| Stage | User experience | Allowed flexibility | Required guardrail |
| --- | --- | --- | --- |
| Personal | Say the intent and use the result | AI-assisted reads, temporary mappings, personal preferences, private/reversible outputs | Interactive authorization, sandbox/preview, rollback, no silent long-term delegation |
| Shareable | Choose to share a proven personal capability | Read through declared compatible mappings; personalize through Pod settings | AI removes personal identifiers/secrets, declares consumes/produces/capabilities/permissions, and generates clean-user tests |
| Trusted | Install from trusted discovery, run unattended, recommend, or charge | Only declared extension points and compatible versions | Deterministic shared writes, profile/migration tests, two-user isolation, provenance, revocation, audit, signing/review policy |

Users are not expected to learn this promotion process. The Agent produces the
manifest, application-profile references, mappings, permission explanation,
tests, and packaging evidence; the user supplies intent, feedback, and explicit
authorization for expanded effects.

## 9. Terminology guardrails

- **Discovery is not Registry.** A registry accepts declarations; Discovery
  additionally resolves, indexes, validates, matches, and may recommend.
- **Discovery is not Marketplace.** Marketplace is one user-facing ecosystem
  and transaction experience built on Discovery.
- **Semantic data model is not AI model.** `@undefineds.co/models` defines
  durable data semantics; a base/provider AI model is an executable offering;
  a Personal AI Model is a governed user-specific capability and artifact
  lineage built around one or more base models.
- **Personal AI Model is not RAG.** It is an executable user-specific model
  artifact. Retrieval and memory belong to the broader Personal AI Runtime and
  provide the baseline that model training must beat.
- **Training material is not Pod source truth.** Dataset snapshots, embeddings,
  adapter/checkpoint weights, and serving replicas are derived artifacts. They
  need lineage, retention, rollback, and revocation semantics.
- **Model adapter is not protocol adapter.** The former changes an AI model's
  behavior; the latter translates an external interface.
- **Evaluation set is not production memory.** Personal eval cases must be
  versioned and protected from training contamination.
- **Vocabulary catalog is not application profile.** Discovery catalogs broad
  community semantics; `@undefineds.co/models` records the smaller, tested set
  adopted by our applications and adds only the constraints or terms we own.
- **Capability is not Offering.** Capability describes what can be done;
  Offering describes how a user receives and is charged for a provider product.
- **Pod data is not infrastructure state.** User-authoritative, exportable, and
  auditable assets belong in the Pod; retry/lease/heartbeat state normally does
  not.
- **Applet is not Host.** Applet supplies domain behavior; Host supplies global
  shell, session, routing, and native capability implementations.

## 10. Open questions for the next discussion

The following remain deliberately unresolved:

1. Which extension contribution types beyond a full Applet become first-class:
   view, command, API handler, worker, Agent tool, or protocol adapter?
2. How are trusted Applets reviewed, signed, installed, upgraded, revoked, and
   sandboxed, especially when most code is AI-generated?
3. How do `appId`, OIDC `client_id`, developer identity, package identity, and
   signing identity relate without being collapsed into one identifier?
4. Which host capabilities are stable public APIs, and which stay experimental?
5. How is a shared semantic-model proposal reviewed and versioned without
   slowing down ordinary Applet development?
6. What is the minimum machine-readable Discovery protocol before a marketplace
   UI exists?
7. How much UI belongs in headless behavior, React bindings, and styled shared
   components?
8. What is the packaging and repository boundary as Applets become independently
   released?
9. Which AppletBench, SemanticModelingBench, and PersonalModelBench tasks become
   release-blocking first?
10. What is the minimum Personal AI Model lifecycle across data consent,
    dataset/snapshot construction, retrieval and memory, adaptation or training,
    evaluation, artifact storage, serving, rollback, and deletion propagation?

## 11. Non-goals for this part

- Designing or implementing the complete Data Capability Platform.
- Designing or implementing the complete fine-tuning, adapter-training,
  distillation, or continual-learning platform.
- Implementing marketplace billing, revenue sharing, ranking, or review
  operations.
- Moving UDFS or adopted application-profile ownership from
  `@undefineds.co/models` into Xpod or Discovery, or claiming ownership of terms
  published by external communities.
- Giving Applets direct access to host session internals or raw provider
  credentials.
- Forking external schedulers, queues, execution engines, or established
  protocol implementations when an adapter is sufficient.
- Treating all runtime state as Pod data or treating a centralized index as the
  authority over the Pod.
- Treating training snapshots, embeddings, adapters, checkpoints, or serving
  replicas as the original Pod facts, or allowing opaque weights to become the
  only durable record of user preferences and feedback.
- Claiming AI-friendliness from a demo, documentation volume, or SDK existence
  without reproducible evaluation evidence.
