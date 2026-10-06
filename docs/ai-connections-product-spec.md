# AI Connections Product Spec

> Status: Canonical product specification
>
> Date: 2026-08-24; design alignment: 2026-10-02, retaining R6 handoff and domain boundaries
>
> Scope: Xpod AI Connections product behavior, data ownership, package
> boundaries, and acceptance order.
>
> Login and Pod creation follow
> [Login And Host Design](superpowers/specs/2026-09-19-xpod-login-and-host-design.md).
> Non-login authentication authority remains defined by
> [Xpod Auth Authority Boundaries](superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md):
> AI Connections is a static WebID/Pod capability consumer and must not import
> or present CSS Account authentication.
>
> Cross-module experience requirements follow the
> [Product And Experience Spec](superpowers/specs/2026-09-27-xpod-product-experience-spec.md).
> This revision aligns design documents only; it does not verify a release or
> claim that the target behavior is implemented.
> R2 changes the AI workspace's task flow and model-selection behavior as product
> targets. Runtime compliance has not been inspected; the responsible domain
> owners must implement and verify those changes separately from UI copy.

**Current desktop overrides:** [October 1 shell/applets](superpowers/specs/2026-10-01-xpod-desktop-shell-and-applets-design.md) §4 and §9 govern this iteration’s AI applet: provider directory stays visible, client configuration belongs to key records rather than a separate client list, and processing settings live under Pod. Xpod keys use the Solid client-credential contract in §4.2; legacy Gateway-key/hash-only rules below apply only to that legacy resource type. They do not redefine Solid credentials or authorize exposing secrets. Shared Tasks may be edited in both hosts under §9; the old R2 four-entry arrangement is historical. See the [design entry](../DESIGN.md) for geometry, WebID admission and pending capabilities.

This document is the authority for AI Connections within its product scope, subject to those explicit overrides.
It does not override the login, authorization, Pod lifecycle, or shared security
contracts above. Implementation plans, audits, and acceptance matrices describe
their dated scope; they are not proof of current release behavior.

The AI workspace brings provider connections, client setup, and Xpod processing
uses into one navigation area. AI Connections owns connections, allowed models,
and Xpod API Keys; AI Config owns per-use model assignments. Xpod Gateway remains
the data plane exposed to clients. Shared navigation does not merge domain owners,
credentials, permissions, or persistence contracts.

The [R6 joint experience](../../homepage/docs/specs/personal-ai-product-experience-r6.md)
owns cross-product handoff. LinX provides daily work, knowledge and My AI;
Foundry owns training and release governance. This AI area connects published
models to purposes/clients and exposes serving evidence. It does not duplicate
knowledge editing, chat or training submission. The historical R2 controller entries
do not constrain the October 1 applet navigation or the complete product boundary.

## Product Principles

- AI Connections uses the host's WebID login entry. Account management keeps
  its separate authority; AI Connections must not introduce another login form.
- Users should not need to understand WebID, Pod routing, Offering, Gateway, or
  service tokens to complete routine work.
- Provider setup and client setup are one product area, not two disconnected
  pages.
- AI Config is a responsibility within the same top-level AI workspace, not a
  second top-level destination. It assigns models to actual Xpod consumers and
  preserves their separate configuration and runtime authority.
- Web validation comes before desktop validation. Desktop shell behavior must
  not hide bugs in WebID login, Pod binding, provider persistence, or Gateway
  chat.
- Real Xpod validation is mandatory before claiming completion. Hermetic tests
  are useful, but they cannot replace the real running Xpod Gateway.

## User Jobs

AI Connections must optimize these tasks:

| Job | User-facing outcome |
| --- | --- |
| Connect a provider | Save provider credentials in the user's Pod and verify the connection. |
| See available models | Distinguish discovered models, the user's allowed models, and the model actually assigned to each use. |
| Use an AI client | Select the client/model, explicitly reuse or create a key, preview the target configuration, then apply or copy it. |
| Use a published personal model | Preserve the release and purpose, check supported runtime/client compatibility, and distinguish selection from serving and actual Run use. |
| Choose AI for personal materials | Select models for supported uses such as text recognition, document understanding, and semantic search, with consequences shown in the same flow. |
| Track usage | See usage grouped by Xpod API Key, with provider/model detail when available. |
| Disable access | Temporarily stop an API Key or provider credential without deleting history. |
| Delete stale records | Remove deleted API Keys from the visible list after successful deletion. |
| Recover from stale auth | Return to a useful login or reconnect state, never a raw callback or blank page. |
| Repair a work dependency | Return to the same knowledge resource, model release or Run with permissions and material scope revalidated; do not silently resubmit work or training. |

## Information Architecture

The following R2 organization is retained as design history where it conflicts
with the current desktop overrides above; it is not a second implementation target.

R2 replaces the separate AI Connections and AI Config top-level entries with one
`AI` workspace in the local controller. It keeps provider management, API Key management, and per-use
configuration as distinct responsibilities inside that workspace.

```text
Rail
  AI
    First-use tasks
      Connect a client
      Choose AI for materials
    Daily summary
      Connected services
      Known client status
      Processing-use summary
    Task detail
      Connection / client / processing use
    Add a connection
      Supported provider catalog
    Advanced management
      API Keys
```

This is a task map, not a requirement to render all sections as a permanent list
or add another navigation rail. First use presents `连接客户端` and
`为资料处理选择 AI`. Daily use prioritizes existing connections, known client
status, and configured uses. The complete provider catalog appears only when
adding a connection; it is not an always-visible directory of unconfigured
services. API Keys remain directly manageable through a stable professional
entry but are not the new user's first required selection.

Summary statuses must state their evidence: a saved configuration, a Gateway
check, and a verified client run are different facts. Missing client observation
is `not checked` or `unknown`, not `disconnected`. Routes may deep-link to the
existing domain detail without requiring the user to visit four separate pages
to finish one task.

Provider detail contains:

- current connection cards;
- provider-specific credential entry;
- OAuth/browser import only when the provider supports it;
- API key entry when the provider supports it;
- quota and usage only when supported or already observed;
- discovered models, the allowed-model list, and links to affected processing
  uses, without treating discovery or list order as a runtime default.

### Processing Uses In The AI Workspace

Organize user-facing choices as `识别文字`, `理解文档`, and `按意思搜索` where a
real consumer exists. These labels map to the existing OCR, reader/indexer, and
embedding responsibilities; they do not create a new configuration schema or
invent a consumer. Show additional uses only when the product actually has them.

Within a use's task detail, show the current effective model, any saved-but-not-
effective choice, its provider connection, and the action needed next. Adding or
repairing that connection returns to the same use with its pending choice intact;
the user need not reconstruct the task from a provider directory.

Before changing a model, show the consequences in that same context:

- which material will be sent to which provider/endpoint, within the existing
  deployment policy; do not equate saved-in-Pod with local inference;
- known charging information, or explicitly `cost unknown` when unavailable;
- affected uses and the known source/index scope that needs rebuilding; do not
  claim a complete count when the system cannot determine it;
- what continues before rebuilding, what changes after it, and the available
  start/defer choices. For a changed embedding scope without reusable vectors,
  delaying the rebuild leaves text/FTS retrieval only for that scope; do not show
  semantic search as ready or silently search vectors from another model.

Saving the model assignment, activating it, and starting/finishing an index rebuild
are separate outcomes. Queue a rebuild only after the user's explicit choice;
do not present a configuration save or a connection check as a completed rebuild.

### Published Personal Model Handoff

Model discovery/allowance/assignment remain the rules above. Personal-model use
adds the following evidence, not a replacement model schema or a new release owner:

| Fact | Authority and UI contract |
| --- | --- |
| Desired published release | Foundry release governance and evidence; a training candidate is not automatically published or enabled. |
| Actually serviceable version | Runtime observation, with scope/time. Desired configuration does not prove this version is loaded or reachable. |
| Client/purpose selection | The existing assignment or client configuration owner. Apply/copy success does not prove a request used it. |
| Version actually used by a Run | Task/Run execution evidence. A later rollback does not rewrite historical use. |

An incoming release/purpose/client task preserves those validated references and
its legal return target. Show compatible choices and execution/data destination,
known cost or an explicit unknown, then use the existing authorized apply flow.
Enablement/rollback follow the release and assignment owners; do not bypass Cloud
catalog/endpoint restrictions, allowed models or capability eligibility because
the model is personal. If the runtime cannot report the version, say unverified
rather than copying the desired release into an observed field.

Connection repair returns to the original LinX knowledge/model/Run task, not a
generic AI home. Revalidate identity, target authority, material version/scope,
execution destination, cost and enablement scope before resuming consequential
choices. Read access is not training-use consent. Repair does not submit training,
expand grants, silently replace a model or recreate a key/Pod. No secret or lost
permission content is retained in a URL or restored after an identity change.

Foundry, runtime, client and Task owners must supply the version associations and
safe continuation contract. Missing evidence is a scoped dependency; do not invent
fields/APIs or claim the handoff is implemented. Training cancellation, retry and
revocation effects require their domain contract; a Run cancellation API does not
define them, and revocation does not prove that existing weights have forgotten.

## Concept Boundaries

| Concept | Meaning | User-visible? | Durable owner |
| --- | --- | --- | --- |
| Provider | A company or compatible service family, such as OpenAI or Anthropic. | Yes | Shared catalog plus Pod records for user state. |
| Offering | A concrete way to access a Provider, such as API Platform, subscription, token plan, local daemon, or custom compatible endpoint. | Mostly hidden. Use plain labels when needed. | AI Connections package / Xpod. |
| Credential | A provider login, OAuth token, API Key, or local endpoint configuration. | Yes, as connection cards. | User Pod. |
| Model | A provider model resource. `ChatModel`, `EmbeddingModel`, and similar classes inherit from `AIModel`. | Yes | `@undefineds.co/models` for shared model semantics. |
| Capability | What a model can do, such as vision, OCR, tools, or structured output. | Only as eligibility/filtering hints. | `@undefineds.co/models`. |
| Product role | How Xpod uses a model, such as OCR, embedding, reader, indexer, or default chat. | Yes, as supported processing uses in the AI workspace; owned by AI Config. | Xpod-owned config schema. |
| Xpod API Key | A key accepted by Xpod Gateway for local clients. It is not a provider key. | Yes | Xpod-owned Pod resource. |
| Client target | A local client config target, such as Codex, Claude Code, Pi, or CodeBuddy. | Yes | Local host adapter plus Xpod API Key metadata. |

Capabilities do not create new model subclasses. A vision-capable Qwen model is
still a chat model with a vision capability. OCR reader and indexer are product
roles, not reasons to call everything a chat model.

### Embedding Model Authority

Embedding models are managed by the Xpod Gateway provider catalog
(`src/api/ai-gateway/providers/ProviderRegistry.ts`). BYOK contributes an API key
only: neither the model list nor the endpoint is user-supplied in Cloud.

- A model is embeddable only when the catalog provides it
  (`capabilities.embedding` on the provider descriptor).
- A Cloud deployment may use only those models, even when the caller brings their
  own provider credential: discovery, custom-model declarations, Pod AI Config and
  stored credentials cannot add an embedding model to Cloud.
- A Cloud deployment also owns the endpoint. The user cannot provide a base URL
  (and a Pod-provided proxy is ignored): the provider and its endpoint come from
  the catalog, so a BYOK key can never redirect Cloud egress. Providers the
  deployment does not offer in Cloud — the self-hosted `custom` provider and
  local-daemon products such as Ollama — are not available at all: Cloud settings
  list only the providers the deployment provides, credentials are rejected for
  any other provider, a supplied endpoint must equal the provided one, and the
  inference runtime resolves `custom` against the catalog instead of a Pod URL.
- A Local deployment keeps arbitrary BYOK embedding models, endpoints and proxies,
  including custom providers and private endpoints.
- The rule lives in one policy (`src/ai/service/EmbeddingModelPolicy.ts`) and is
  applied at every entry: custom-model registration, model selection, the AI
  Config embedding assignment, and the runtime embedding call itself (the hard
  boundary, because Pod data is user-writable).

### Embedding Credential Against LatticeDB

LatticeDB is this product's name for the derived index layer and its unified query
layer: graph facts, the FTS index and the VEC index plus the planner that fuses
them (`docs/rdf-engine-spec.md`: `RdfTextIndex`, `RdfVectorIndex`,
`RdfQueryExecutor`). The definition is the repo's own; the name only fixes what
"compare against LatticeDB" means below.

Entering an embedding API key is not enough to make embedding usable. Stored
vectors belong to a provider, a model, a model version and a projection policy, so
the account's key has to be compared with what LatticeDB already holds before any
of it is used:

- **When.** After an embedding credential is entered or updated, after the AI
  Config embedding model (or its provider) changes, and before the first embedding
  call that would write or read vectors.
- **What is compared.** For the credential's provider + model (and model version
  when the provider reports one): whether the VEC index already holds chunks in
  that scope, the dimension they were written with, the projection policy version
  they were built under, and whether the unified query layer reaches them for the
  current account and workspace scope.
- **What the comparison decides.** Whether embedding can start as-is, whether the
  key opens a scope the index has never seen (nothing to reuse), or whether the
  scope differs from what is stored (dimension or projection policy changed).
- **Never mix by accident.** Vectors are scoped to
  `provider + model + modelVersion + projectionPolicyVersion`, so a new key or
  model never silently reads another model's vectors; a scope with no vectors
  yields text/FTS hits only.
- **What the user sees.** A differing scope is reported as "index rebuild
  required", and the rebuild is queued only after the user confirms. Until the
  rebuild finishes the embedding role must not present itself as fully indexed.
- **Performance.** The comparison must be a scoped lookup, not a scan: it asks the
  VEC index what one `provider + model (+ version) + projection policy` scope holds
  (chunk count, dimension) and stays bounded by the account and workspace scope.
  Measured on the SQLite index (`.test-data/embedding-byok-acceptance/vector-compare-perf.ts`):
  a scope-filtered count is 0.09 ms at 2k chunks and 1.73 ms at 40k chunks, while
  `RdfVectorIndex.modelDistribution()` - the same question answered for *every*
  scope at once - costs 0.54 ms and 16.5 ms, and `stats()` 19.2 ms at 40k. The
  index columns for the scoped query already exist
  (`rdf_vector_chunks_model_dimensions`); a whole-table aggregate is therefore an
  implementation gap, not a licence to scan. Rebuilding is incremental - only
  sources whose vectors are missing or stale in the new scope are re-embedded, in
  batches bounded by the model's `maxBatchSize` - and neither the comparison nor a
  queued rebuild blocks authority writes. Retrieval, not the comparison, is the
  cost centre: the same probe measures a scoped vector search at 8.9 ms for 2k
  chunks and 468 ms for 40k, because scoring walks every component row, so larger
  Pods need an ANN/quantized backend rather than a faster comparison.

### Credential Source

Embedding and chat read the same AI Connections credentials. A credential is
stored as an `encryptedSecret` envelope (plaintext envelope locally, wrapped
secret cell in Cloud), so every consumer must decode it rather than looking for a
bare `apiKey` property:

- `src/ai/service/AiCredentialSecret.ts` owns the plaintext shapes and the
  decoder port; `createAiCredentialSecretDecoder` adds the credential vault for
  wrapped Cloud secrets.
- `PodChatKitStore.getAiConfig` (embedding, indexing, reconciliation) and
  `CredentialReaderImpl` (extension runtime) both decode before selecting, so a
  key entered once in AI Connections works on both surfaces.
- Selection also honours AI Connections management state: a disabled credential is
  skipped, and a Pod holding credentials for several deployments prefers the
  running deployment's own.

### Discovered, Allowed, And Effective Models

R2 replaces the earlier rule that silently made the first selected embedding
model the default. This is a product behavior target, not a claim about the current
resolver. AI Config and the runtime model-selection owner must implement it; a
frontend label alone cannot establish compliance.

| Fact | Meaning | Must not imply |
| --- | --- | --- |
| Discovered model | The provider/catalog reports this model under the current deployment's rules. | The user has allowed it or selected it for a use. |
| Allowed model | The user permits this model within the applicable provider/deployment policy. | Its position or selection time makes it the embedding default. |
| Effective assignment | A specific use resolves to an explicit Pod assignment or a valid, trusted deployment default. | Merely saving a list has changed the running model or rebuilt its index. |

Discovery keeps permitted embedding models selectable. An active embedding
allowlist continues to constrain embedding: a Pod assignment outside that list
must not execute. Cloud catalog, provider, endpoint, and allowlist restrictions
above remain mandatory; the workspace cannot offer a way around them.

An existing explicit Pod assignment or trusted deployment default may continue
when it remains valid under these rules. A Pod that selected only chat models
does not lose a valid embedding assignment merely because it has no new embedding
selection. Neither selecting the first model, deselecting a model, sorting a list,
nor refreshing discovery chooses a replacement execution model. When the current
assignment becomes invalid, explain the affected use and require a valid choice;
do not fall back silently. If no lawful, deterministic default exists, the user
must choose a model in that use before it can run. Display the effective model
and its source so the user can distinguish a personal assignment from a deployment
default.

## Login And Session Model

AI Connections has one login entry: the host-owned WebID login through the
current Xpod. This does not replace the Account-only entry for account, machine,
and Pod management.

Internally, Xpod may use two independent sessions:

| Session | Purpose | Owner |
| --- | --- | --- |
| AccountSession | CSS account and account-page authority. | Xpod/CSS account layer. |
| WebIDSession | Solid authenticated Pod reads and writes. | Inrupt/Solid runtime. |

The Xpod host coordinates them. A page must not create its own second login
entry, password form, provider picker, arbitrary issuer input, or external Pod
picker.

AI Connections, AI Config, and other Pod-backed settings share the same
WebIDSession provider in the Xpod host. Dashboard/account pages may use
AccountSession where account authority is actually needed. Shared UI components
receive session facts through props and must not own Xpod login policy.

Interactive AI Connections requests keep that same WebIDSession authority:

- Provider management, credential import, quota, model discovery, model
  selection, and interactive `/v1/models` reads use the host-owned Solid
  authenticated fetch directly.
- They must not first exchange the browser session for an applet service-access
  or runtime invocation token. A failed management request belongs to the
  current WebID session and must not surface as a second login flow.
- The native client-configuration bridge is a separate, narrowly scoped
  capability. It may use a short-lived `client-config:read` /
  `client-config:write` invocation because it crosses from the Web UI into the
  local filesystem authority.
- Codex, Claude Code, Pi, CodeBuddy, and other non-interactive clients call
  `/v1/*` with their Xpod API Key or owner-bound client credential. They do not
  reuse the browser session.

`AccountLoginView` is not part of shared-ui for Xpod. Xpod owns its account
pages and its WebID login surface.

## Exact Local Pod Binding

Local Xpod is the service provider for its own product login. From a local Xpod
login:

1. The login starts from the current Xpod origin.
2. CSS may ask the user to create or verify an account.
3. Registration creates only the Account. When the authoritative inventory
   confirms there is no bound Pod, the host offers `Go to Pod management` and
   cancellation. An inventory read failure or an inaccessible existing Pod is a
   recovery state, not permission to create. Login, registration,
   authorization, page entry, and refresh must not prepare or create a Pod.
4. In Pod management, the user explicitly selects an available Cloud or machine
   target they can manage and confirms creation. For a Local Pod, provisioning persists
   the exact WebID-to-storage binding to that selected Local service provider.
   It must not silently substitute an arbitrary Cloud Pod.
5. After creation, the host re-reads authoritative bindings and service health,
   resumes the still-valid authorization transaction, and returns to the original
   AI Connections task. AI Connections consumes the resulting WebID/Pod
   capability; it does not perform Account management or grant itself access.

Managed machine registration and explicit per-account Pod creation are distinct.
Neither machine registration nor service startup grants Pod ownership or triggers
creation; Standalone must not require Cloud registration. The resulting binding
is durable. An expired provisioning handoff is not an expired login session and
must not invalidate an already-established binding.

If explicit creation reports success without saving this binding, that is a
provisioning bug. The UI may offer repair as an exceptional recovery action,
but ordinary login, refresh, and navigation must not create another Pod or make
manual repair a required step.

Pod management owns the creation form, target selection, and explicit submit.
The login and authorization surfaces must not embed a second creation form or
auto-submit one. Preserve a bounded continuation tied to the current Account and
interaction, not provider secrets. Account switching or interaction expiry starts
a new authorization; cancelling authorization does not revoke a submitted
creation task. A timeout must recover the original task and authoritative Pod
inventory before any new creation attempt. Missing task-recovery support must be
reported as unavailable, not replaced by automatic resubmission.

The generated WebID and storage URL shown during local login should not surprise
the user with `localhost` when Cloud has assigned a service provider domain. The
SDK should resolve the optimal reachable path and still preserve the exact Pod
identity.

### Cloud-managed Local provision contract

The following transport and binding invariants apply to an explicitly requested
Managed Local creation or an existing binding's recovery. They do not authorize
automatic creation during login. The login/host canonical governs entry points,
machine choice, and task orchestration.

A Cloud-managed Local Xpod is valid only when all of these facts are true:

- `/provision/status` on the Local Gateway reports `managed: true`,
  `registered: true`, the Cloud `oidcIssuer`, and the canonical managed `publicUrl`.
  A fresh `provisionCode` is required for explicit first creation, not for restoring an
  already-bound identity.
- For explicit first creation, the `provisionCode` includes the short-lived SP callback credential
  (`serviceAccessToken` plus `serviceAccessTokenExp`) and, when the canonical
  managed URL is not directly reachable from Cloud, managed-route credentials
  (`signalApiUrl`, `routeAccessToken`, `routeAccessTokenExp`, and `nodeId`).
- Managed route is the zero-configuration fallback for a Cloud-managed Local
  Xpod. Cloud must not make first-run Pod binding depend on creating a
  third-party tunnel. A Cloudflare or other tunnel is optional and is used only
  when the Local host explicitly supplies that tunnel capability, or when no
  managed-route broker is available.
- Cloud runtime must derive its own identity and signal origins from the
  canonical deployment URL: `CSS_BASE_URL=https://id.undefineds.co/` is enough
  to resolve `oidcIssuer=https://id.undefineds.co/`,
  `publicUrl=https://id.undefineds.co/`, and
  `cloudApiEndpoint=https://api.undefineds.co`. Do not require a duplicate
  product-facing env var just so provision codes can contain `signalApiUrl`.
- Pod management uses the verified provision scope for the explicitly selected
  machine when creating or looking up storage. It must not fall back to a generic
  localhost Pod or silently replace the user's selected storage target.
- The OIDC authorization parser must retain `provisionCode`, and the Account
  continuation must retain the current interaction's verified scope through
  Account registration and Pod management. Retaining scope does not trigger
  preparation. A direct API test that supplies the code itself does not cover
  this Web handoff; registration with zero Pods and subsequent explicit creation
  must also be tested end to end.
- The resulting WebID is Cloud-issued, while its `solid:storage` points at the
  complete canonical Local Xpod Pod URL (including its Pod path), not just the
  SP origin. The SDK may rewrite network traffic to the
  best reachable local path, but the RDF identity remains canonical.

Binding is persistent: the WebID profile's `solid:storage` and the SP's ownership
record must agree. Returning sign-in and session restoration read that binding;
they must not repeat Pod creation or require the original short-lived provision
code. A failed profile read, unreachable route, or failed authentication is not
evidence of a missing binding. Keep those errors distinct. Only a confirmed
missing or inconsistent ownership relation may offer the explicit repair flow.

Local routing also keeps two URLs distinct: the canonical resource identity
verified by the Solid server and the local network transport URL. For browser
DPoP, Inrupt signs the canonical target first; the SDK's resource transport then
maps it to the same resource on the local SP. Do not wrap `Session.fetch` with a
URL rewrite that changes what Inrupt signs. The response URL exposed to the
caller stays canonical as well: the transport alias is not an HTTP redirect.

The SDK supplies canonical mapping headers; reverse proxies supply the actual
ingress host/protocol. The SDK must not put the canonical host into standard
`X-Forwarded-*` headers, and a Docker bridge address must not gain loopback-admin
authority. Dev-proxy failures must be tested with a real browser; direct
Gateway API success does not cover that extra hop. The pinned Inrupt transport
hook is tracked in
[`issues/2026-08-28-inrupt-browser-resource-transport.md`](issues/2026-08-28-inrupt-browser-resource-transport.md).

If Cloud cannot call the Local SP because the managed URL is unreachable and the
provision code has no managed-route credentials, the product is not ready for
AI Connections acceptance. The user-facing recovery state should say that this
Xpod has not finished connecting to Cloud, not show raw errors such as
`fetch failed`.

## API Keys And Client Configuration

Apply the current Solid client-credential and key-based client-configuration
overrides above. The older separate client/key organization below must not restore
a second client list or treat Solid credentials as legacy Gateway keys.

Xpod API Keys are created for Xpod Gateway. They are reusable across clients
unless the user chooses to label or apply them to a specific client.

### Client Setup Task

1. Select the client and a permitted model. Keep the selected client, model,
   connection, and return target throughout the task.
2. Explicitly choose an existing Xpod API Key or create a key for this client.
   For a new key, require a name with a sensible editable default. A client label
   does not itself enforce client-exclusive use or introduce new permissions.
3. Preview the exact client configuration target, endpoint/model, chosen key
   identity with a redacted value, and any known overwrite or replacement. Show
   what the host can inspect and what remains unknown; missing read capability
   must not be presented as proof that no configuration exists.
4. Ask for the explicit apply action after that preview. Apply writes the selected
   client's configuration only through the authorized native capability. If the
   environment cannot write it, explain that before key creation and offer the
   client-specific copy path. A successful native apply does not also require
   manual pasting.
5. Show the completed stage and the next supported verification action. Return to
   the originating task when valid, otherwise the client summary, without losing
   partial results. A published-model task retains its release/purpose/client and
   separate serving-version evidence as specified above.

Reusing a key must identify known assigned clients and explain that disabling or
deleting that key can affect them together. Assignment metadata and observed use
are not an inventory of every copied key: if other clients or devices may use it,
state that the complete impact is unknown. Creating a dedicated key can separate
management, but a label alone must not promise an enforced security boundary.

Key creation and writing a client file are separate operations. If creation
succeeds and the file write fails, retain the created key's identity and the
configuration plan. `Retry apply` retries only the write using that same key; it
must not create another key. Reopen/retry resolves the existing operation result
and key before proceeding. If recoverable key material is unavailable, explain
the missing material and offer an explicit alternative rather than silently
creating a replacement. Cancelling file setup does not delete an already-created
key; show its retained state and a separate management action.

| Result | What it proves | What it does not prove |
| --- | --- | --- |
| Configuration copied or written | The intended configuration was copied, or the host confirmed the target write. | The client has loaded it or can complete a request. |
| Gateway check passed | The stated Gateway endpoint/key/model check succeeded at the recorded time and scope. | The actual client is configured correctly or running. |
| Client verified | A supported verification completed through the selected client, with its scope and time shown. | Every later request or every client feature will succeed. |
| Client verification unsupported / not run | No client-level evidence is available. | The client is ready or disconnected. |

The setup completion view must preserve these distinctions. Do not replace an
unsupported client test with a green `client ready` label after a Gateway check.

### Professional Key Management

The API Keys entry remains available for creating, listing, copying, enabling,
disabling, and deleting keys independently of a client setup task. Its creation
form requires a name and may accept an optional client target; choosing a target
enters the preview/apply flow above, not an immediate unreviewed configuration
write. Without a target, copy uses the explicitly selected generic Gateway format.

Copy behavior must be client-specific. Codex, Claude Code, Pi, and CodeBuddy do
not share one universal environment variable block. The copy action should use
the selected client format or a clear generic Gateway format when no client is
selected.

An ordinary API Key row contains its name, one primary description, a meaningful
status, and at most one direct action. Use the description for the most useful
identifying fact, such as a redacted suffix or intended purpose; do not pack usage
statistics, client icons, and multiple action icons into the same row. Detailed
usage and known client associations belong in the key's detail view.

Use a clearly named `Key actions` menu for additional actions, with a key-specific
accessible name. Menu items use accurate text, not ambiguous Stop/Play symbols:

| State | Visible status | Named action and scope |
| --- | --- | --- |
| Active | Active | `Disable key` stops access through this key for all its users, including other clients/devices. It does not stop only the currently displayed client or its process. |
| Disabled | Disabled | `Enable key` restores the key's eligibility for access; it does not prove any client has reconnected or passed verification. |
| Active or disabled | Current state remains visible until deletion succeeds | `Delete key` removes this key and affects all clients using it; state that impact before submission. |
| Deleted | Removed after confirmed deletion | No row remains after refresh. |

Disable and enable are a pair. Delete is separate and removes the row after the
server confirms deletion. State meaning must remain readable without colored
backgrounds, and an action menu must not replace visible status text.

Before disabling or deleting a key or provider connection, show known affected
clients and processing uses in the same action context. Name the source/limits of
that knowledge; no recorded assignment does not prove there are no consumers.
If relationships cannot be enumerated, say so without inventing a complete impact
list. After success, the affected summaries must distinguish unavailable or
unverified uses from unrelated healthy connections; do not silently move them to
another key, provider, or model.

## Secret Handling

Provider credentials and Xpod API Key material belong in the user's Pod when
they are durable product data.

The product may retain recoverable plaintext for Xpod API Keys when the explicit
goal is cross-device copy or client reconfiguration. If plaintext is not
available, the UI must say exactly what is missing and why. A vague message like
`this device cannot copy` is not enough when the source of truth is the Pod.

Provider API Keys must never be written into Codex, Claude Code, Pi, or
CodeBuddy. Local clients receive only Xpod Gateway endpoint plus Xpod API Key.

An Xpod key is an Account client credential, not a Pod record: Xpod stores no
plaintext, no recoverable companion resource and no second key index. The
legacy shared `gatewayAccessKeyResource` belongs to the retired Gateway key
design; Xpod keys no longer read or write it, and nothing may derive a reveal
capability from its `secretHash`. Provider credential records are separate and
must never be reused as client keys.

These rules are object-specific:

| Object | Display and recovery boundary |
| --- | --- |
| Xpod API Key | An Account client credential the account manages; Xpod only wraps it once as `sk-base64(client_id:client_secret)` for the client. The wrapper is visible in the session that created it and nowhere else: there is no reveal, and the list shows metadata only. |
| Shared `gatewayAccessKeyResource` | Legacy shared model resource that Xpod keys no longer use. Never add plaintext to it or derive a reveal capability from `secretHash`. |
| Provider Credential | Separate credential storage and protection contract. Wrapping an Account credential does not authorize provider-secret reveal, copying provider secrets into clients, or weakening encryption. |
| Runtime configuration secret | Keeps its own write-only or redacted configuration contract. Account-credential handling does not create a runtime-secret reveal operation. |

### Web Management Contract

The Account owns Xpod keys; Xpod has no key backend of its own. The Web UI
drives the CSS Account client-credentials control with the current
authenticated session. It never asks the user for a CSS Client ID or Client
Secret, and the page issues, lists and revokes through the capability boundary
(`ui/src/auth/account-client-credentials.ts`) rather than a Pod route:

| Method | Path | Meaning |
| --- | --- | --- |
| `POST` | `controls.account.clientCredentials` | Issue one named credential for the current WebID and return `{id, secret, resource}` once. |
| `GET` | `controls.account.clientCredentials` | List the account's remaining credentials as label → resource; metadata only. |
| `DELETE` | the credential `resource` | Revoke that exact credential after re-reading it and matching `id` and `webId`. |

The wrapper `sk-base64(client_id:client_secret)` exists only in the session
that issued it; Xpod stores no plaintext and no Pod-side companion record, so a
reload cannot show the value again and the row says so. There is no reveal
route and no enable/disable update: the Account offers neither, so the surface
does not pretend otherwise. A Bearer key accepted by `/v1/models` and
`/v1/chat/completions` is exactly this wrapper over an Account-issued
credential.

#### Owned rows and honest restore status

Two rules keep the list from over-claiming what the Account actually returns:

- **Ownership.** A row is shown only for a credential the Account confirms for
  the **currently authenticated WebID**. The list endpoint returns every
  credential the account owns, and one Account can hold several Cloud WebIDs and
  Local bindings, so a row whose `webId` is missing — or is not the selected
  identity — is never relabelled as "this identity's key". Revocation re-reads
  the credential and matches its exact `id`, `resource` and `webId` before
  `DELETE`, so a foreign credential is refused rather than silently deleted.
- **Unknown restored observations.** `clientId` is the Account credential id and
  is the row's identity. The fingerprint that the bridge reports is the digest of
  the wrapper **only while the wrapper is known** — that is, inside the session
  that issued it. A restored row carries metadata only, so the UI states that the
  key cannot be verified or re-shown instead of inventing a digest or a
  "changed" verdict. Applying a key and testing it is a single-session
  observation, and a refresh must not erase the ability to test the key that was
  just applied in that session.

#### Revocation Is Revalidated On Admission

An Xpod key is only as valid as the Account credential behind it. Deleting that
credential must stop the wrapper it backs even while an access token minted
before the deletion is still inside its own lifetime:

- Every **new** inbound `sk-base64(client_id:client_secret)` request to
  `/v1/models` and the inference routes revalidates the presented credential with
  the issuer before the request is admitted. A cached access token proves an
  earlier exchange; it is not proof that the credential still exists.
- The session cache serves only the **same** request's outbound Pod access: one
  exchange is reused for that request's own reads and writes. It never admits a
  later inbound request, and a pending pre-revocation exchange is not reused to
  admit a request that began after the revocation completed.
- A definitive issuer refusal (400/401/403) drops the cached session and fails
  the request with 401. An issuer that cannot be reached (5xx or network) leaves
  the cache untouched and answers 503 - a cached success is never substituted for
  an answer the issuer did not give.
- A request already in flight when the revocation lands is not torn down; only
  admissions that start afterwards must fail.
- The rule holds in Cloud, managed Local and Standalone and across separate CSS
  and API processes: it lives in the shared authentication/session boundary, not
  in a UI revoke hook, a RAM event notification, a TTL, a clock advance or a
  provider branch.
- Typed errors and secret redaction are unchanged: a refusal never echoes the
  presented secret, and an accepted request keeps exactly the WebID association
  and authorized Pod binding its exchange proved.

## Provider Detail UX

Provider setup must reflect real capability:

- `Import local OpenAI login` is only shown when the desktop/local environment
  can actually read and import an existing OpenAI login.
- Browser authorization opens the provider or account flow only when that flow
  is real.
- API Key setup stays available for providers that support API keys.
- Unsupported quota, OAuth, or subscription import must be explicit and quiet,
  not a broken button.
- The full catalog is an add-connection chooser; ordinary navigation shows the
  user's connected services. Editing a connection exposes known affected uses
  and client relationships with the same uncertainty rules as key management.

OpenAI subscription, OpenAI API Platform, provider API Keys, and Xpod API Keys
are different things. Labels must make that clear.

## Error And Loading UX

Errors should be written for users, with technical detail one click away.

Rules:

- Required-session routes show the appropriate authentication scene, without
  protected content behind it. They do not gate unrelated authorized local or
  Account tasks or create a second Account form inside AI Connections.
- Scene and sizing follow the September 6 Account/WebID contract and R2 spec
  section 5: compact applies only to short authentication; Account documents
  retain their full layout. Business bodies do not choose window geometry.
- Never leave callbacks or Account pages blank after failure. Use the shared
  phase feedback; 300ms/10s presentation thresholds are not authentication
  timeouts and cannot reset authority or start another transaction.
- Retry/reconnect follows the current canonical failure classification. An
  error is not anonymous; remembered identity is only a display hint. Do not
  clear/re-register OIDC metadata or exchange an old code in a module-local
  recovery path; protocol recovery belongs to the existing authority owner.
- Provider/API Key read failures stay scoped, retain safe inputs/known progress,
  and do not block unrelated providers. A completed key creation is never
  repeated just because client configuration failed.
- Main feedback names the failed step and its task impact; technical details
  are available on demand, never raw stack traces in the object list.
- Distinguish dependency repair, continuation of the same waiting_input Run and
  retry of a training job. Query the original operation when its result is unknown;
  preserve completed side effects. A cancellation request or closing the waiting
  UI is not confirmed stopped execution. Missing training retry/cancel semantics
  remain with Foundry, not a module-local retry button.
- Healthy service/connection checks do not mean knowledge coverage, training or
  a Run is complete. Optional untrained AI is neutral, while a missing dependency
  required by the current task receives a scoped repair action.
- Usage/estimates identify object, period, unit, source and time. Provider quota,
  key consumption, space capacity and training estimates are separate; unknown
  is not zero. Do not infer training feasibility or local execution from them.

## Package Responsibilities

| Package / layer | Owns | Must not own |
| --- | --- | --- |
| `@undefineds.co/models` | Shared AI model classes, capability terms, reusable model semantics. | Xpod-only toggles, index schedules, UI state, provider-specific product policy. |
| `drizzle-solid` | ORM/resource machinery and exact Pod IRI resolution. | Product workarounds for missing repository helpers. |
| `@undefineds.co/solid-sdk` | Session provider primitives, optimal path resolution, authenticated Pod access helpers. | Xpod product IA, login copy, desktop tray policy. |
| `@undefineds.co/shared-ui` | Headless or lightly styled reusable controls that accept props. | Xpod AccountLoginView, Xpod-only issuer rules, persistence location. |
| `@undefineds.co/extension-sdk` | Client/app integration contracts and capability description. | Provider credential storage or Xpod login state. |
| `@undefineds.co/ai-connections` | Provider catalog, offering metadata, client config templates, protocol DTOs. | Xpod shell routing, desktop lifecycle, global auth gate. |
| Xpod UI | IA, screens, user-facing copy, WebID login surface, exact local binding UX. | Shared model vocabulary and generic SDK semantics. |
| Xpod server | Gateway API, provider adapters, credential persistence, API Key issuance, usage collection, local provisioning. | UI-specific layout state or client presentation preferences. |
| Desktop shell | Tray, background service lifetime, native client config apply, reopen behavior. | Provider semantics or Pod data modeling. |

## Data Storage

Durable user AI data is stored in the user's Pod:

- provider credentials;
- allowed models and separately owned per-use model assignments;
- Xpod API Keys;
- API Key client assignments;
- usage summaries when persisted;
- provider quota cache when available.

Local-only data is limited to:

- desktop window and tray state;
- client config write capability;
- local remembered identity presentation hints;
- transient OIDC transaction state.

## Acceptance Order

Web acceptance is first:

1. Fresh profile shows one WebID login path.
2. Account registration/verification completes with zero Pods and no preparation
   or creation side effect. A Pod-dependent task offers Pod management and cancel.
3. Pod management creates only after explicit confirmation, persists the exact
   chosen binding, and safely resumes the original task. Refresh, timeout, failed
   inventory reads, account switching, and expired continuations do not create
   duplicates or resume under the wrong identity.
4. Cloud-managed Local uses a provision code with route credentials when direct
   public access is unavailable; no `localhost` WebID/storage fallback appears.
5. AI Connections loads from the optimal reachable Pod path while preserving the
   canonical Cloud WebID and Local SP storage identity.
6. Provider API Key can be saved to the Pod and reloaded.
7. Discovery, allowed models, and effective use assignments remain distinct.
   Reordering or changing the list does not silently select an embedding default;
   invalid or missing assignments require an explicit valid choice. Cloud policy
   restrictions still apply at the runtime boundary.
8. Xpod API Key management remains available. Client setup supports explicit
   reuse/new-key choice and a configuration preview before applying or copying.
   A failed write after key creation retries with the same key. Configuration,
   Gateway checks, and actual client verification have separate results, including
   unsupported verification.
9. `/v1/models` returns the selected model projection through Xpod Gateway.
10. `/v1/chat/completions` returns a real chat response through Xpod Gateway.
11. The first-use AI workspace offers the two task entries; daily use shows
    connected services, known client states, and actual processing uses. A use's
    model change presents data destination, known/unknown cost, affected scope,
    and rebuild/defer consequences without a forced tour of separate pages.
12. Disabling/deleting a connection or key presents known dependencies and
    unknown impact boundaries; it does not silently substitute another model or
    credential.
13. Published-model tasks distinguish release target, observed serving version,
    client selection and actual Run use. Candidate enablement is explicit under
    the domain owner; rollback preserves historical evidence. Missing version
    observation is unverified, and Cloud/capability restrictions remain intact.
14. Repair returns to the same validated resource/release/Run, rechecking authority,
    version, scope and consequences. A lost response does not repeat completed
    key/application side effects or resubmit training. Cancel requested is not
    cancel confirmed; undefined training controls are not executable substitutes.
15. Saved data, inference/training execution and artifact location remain distinct;
    usage and estimates expose their source and scope. A working connection alone
    does not claim a trained model, completed Run or fully local processing.

Desktop acceptance follows after the Web chain passes:

1. Red close hides the window and keeps tray plus owned services alive.
2. Reopen does not flash a login card while sessions are still valid.
3. Quit is explicit and does not masquerade as sign-out.
4. Tray identity follows the selected Xpod folded-corner brand assets and the
   shared platform-specific tray specification. Preserve legibility and semantic
   state indicators; do not retain the old shield as a new design requirement or
   invent page-specific tray variants.
5. Native client apply works for supported clients and clearly falls back to
   copy for unsupported environments.

## Priority

P0:

- one WebID login path;
- exact local Pod binding after explicit creation, plus safe task continuation;
- AI Connections reads and writes Pod data;
- provider credential save and reload;
- Xpod API Key CRUD;
- continuous client setup, explicit key reuse, preview, and partial-failure recovery;
- discovered/allowed/effective model separation without order-based defaults;
- processing-use configuration with data/cost/rebuild consequences;
- `/v1/models` and real chat through Gateway.

P1:

- provider quota and usage summaries;
- OAuth/subscription import for providers that truly support it;
- richer model metadata and stale-model repair;
- desktop tray state overlays and reopen polish.

P2:

- cost dashboards;
- failover and policy routing UI;
- import from existing client configs;
- encrypted secret envelope migration.

## Documentation Authority

Resolve conflicts by responsibility, as defined in the
[Product Design Charter](product-design-charter.md):

1. Login, identity, Pod creation, and host lifecycle follow the September 19
   canonical; non-login authentication follows the August 30 authority boundaries.
2. This file governs AI Connections behavior, provider/client responsibilities,
   and Xpod API Key product semantics within those boundaries.
3. Cross-module interaction and selected branding follow the product experience
   spec and its cited Shell/brand authorities; cross-product object/task handoff
   follows R6 except for the explicit October 1 §9 overrides. R2 navigation is historical.
4. Package contracts remain authoritative for their shared models and APIs;
   product convenience cannot weaken the hash-only key contract.
5. Implementation, acceptance reports, and screenshots are dated evidence of
   observed behavior. A mismatch is a deviation to resolve, not a new design rule.

Implementation acceptance above requires runtime evidence. A document-only design
alignment does not run that acceptance or claim implementation completion.
