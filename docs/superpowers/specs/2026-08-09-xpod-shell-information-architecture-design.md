# Xpod Shell Information Architecture Design

**Date:** 2026-08-09

**Current desktop precedence:** [October 1 desktop shell/applets](2026-10-01-xpod-desktop-shell-and-applets-design.md), especially §9, supersedes this document’s R2 four-entry navigation, geometry and LinX-only task editing. See the [design entry](../../../DESIGN.md) for the integration contract. Tasks, AI Connections and Pod share applet bodies across hosts and require WebID; local Device/settings remain available under host authority without login. R6 object handoff, permission revalidation, model-version evidence and domain ownership remain binding where not explicitly superseded. Undefined long-term Grant, import/export/migration and simultaneous-tunnel capabilities remain pending; this document proves no current runtime acceptance.

**Status:** Historical R2 local-controller information architecture; revised 2026-09-28 for R6 object and task handoff. This is a target design, not a statement that every item is implemented or verified in the current release.

**Historical status:** This document previously carried “Implemented and verified”. That label is retained here as a historical claim, not transferred to later authentication, host-lifecycle, or visual changes. Release verification requires versioned evidence.

**Current application:** Read this baseline with the [product-design charter](../../product-design-charter.md) and [2026-09-27 product-experience spec](2026-09-27-xpod-product-experience-spec.md). The latter records the R2 interaction, density, theme and acceptance baseline; current desktop overrides are listed above. [2026-09-19 login and host canonical](2026-09-19-xpod-login-and-host-design.md) owns login and Pod/host lifecycle; [2026-08-30 authority boundaries](2026-08-30-xpod-auth-authority-boundaries.md) owns non-login authority. R2 replaces the old five-workspace, icon-rail and mandatory list-pane design with four task entries and conditional object navigation. This is the current review’s design judgment, not a claim that the user previously fixed these choices. Domain authority, data and lifecycle contracts remain in force.

**Scope:** Xpod local-controller navigation, 概览, 存储空间, AI, 服务与访问, account card and macOS menu-bar tray. The four-entry rule is not a cap on the full Xpod product. The [R6 joint experience](../../../../homepage/docs/specs/personal-ai-product-experience-r6.md) owns cross-product tasks: LinX provides daily work, knowledge and My AI; Xpod provides asset/access/coverage/runtime recovery; Foundry retains training and release governance. This shell does not duplicate chat, knowledge editing or training submission forms.

**Out of scope:** Replacing authentication, provider connectors, model semantics, storage authority or runtime lifecycle protocols. Navigation changes reuse these domain owners.

## 1. Problem and R2 decision

The earlier design reduced duplicate Dashboard/Settings navigation, but kept the product arranged around implementation modules. Five top-level workspaces, a permanent secondary list and a long Status tree made routine tasks compete with service internals. AI setup crossed two peer workspaces; storage management remained a settings subsection; index state, policy and rebuild were separated across pages.

R2 groups navigation by what a person is trying to understand or change:

| Top-level entry | User task | Reused domain responsibilities |
| --- | --- | --- |
| 概览 | Understand what is usable, from where, and what needs attention | Runtime, access-path and space summaries; default landing |
| 存储空间 | Manage space assets, location, access, usage, coverage and portability | Account Pod management, Pod authorization, storage and indexing owners |
| AI | Connect a provider/client, assign a published model to a purpose, inspect its running version | AI Connections, AI Config, Foundry release and runtime facts keep their respective owners |
| 服务与访问 | Run the service, make it reachable, diagnose and repair a Run dependency | Network, runtime, service health and logs; task continuation remains with the Task owner |

Old route families and technical details remain addressable. They do not dictate primary navigation. R2 does not turn Xpod into a file browser or LinX workspace.

## 2. Design principles

1. Use the four labeled entries for this local controller, not as a complete-product capability ceiling. Keep asset/runtime details reachable from their original objects. Do not add a second Dashboard/Settings rail.
2. Default to navigation plus content. Add an object pane only for a real collection of selectable objects; a table of page headings is not an object collection.
3. Overview starts with usability and impact. Healthy service internals take one summary line; actionable failures move ahead of routine facts.
4. Keep user tasks together while preserving business owners. AI connection and assignment share navigation; search state, policy and rebuild share the selected space’s task context.
5. Observed state, desired configuration and operation results remain visibly distinct even when combined in one task surface.
6. AI Connections owns provider/client credentials and connection tasks; AI Config owns model assignments and relevant policies. Navigation consolidation never merges these permissions or stores.
7. Persist user AI and indexing policy in the user’s Pod. Runtime services report capabilities and operational observations.
8. Rebuildable indexes may be rebuilt or discarded; authority data and durable model artifacts must not be affected by index lifecycle actions. A published adapter/checkpoint is not disposable cache merely because it is derived.
9. Use a shared system-following theme across documents, authentication, workspaces and native window chrome.
10. Apply the authority needed for the requested task. Never compose Account + WebID + Pod into a global admission requirement.

## 3. Global application frame

Before any React entry renders, the document applies the resolved system theme to the root element so navigation and authentication redirects do not flash the opposite color scheme. Components use semantic theme tokens instead of fixed light or dark palette classes. A manual theme selector is not part of this design.

### 3.1 Route-scoped authentication and restoration

A route uses only the authority required for its task. Mounting the shared shell or a projection provider does not justify restoring WebID, waiting for a Pod, or requiring a cloud Account everywhere.

| Route responsibility | Required authority | Isolation requirement |
| --- | --- | --- |
| Account controls, Account-scoped Status data, and `/settings/pod` management | CSS Account | A valid Account with no Pod can enter Pod management. Do not trigger WebID login or create a Pod as a side effect. |
| Local Network and local runtime settings/control | Authorized local-host transport | Do not add Account/WebID requirements merely because the page is in the shell; local transport still enforces its own authorization. |
| Pod-backed configuration, Solid resources and WebID access grants | Inrupt WebID and the target Pod authorization required by the operation | Restore/select only at the relevant boundary. A Pod read failure does not log the Account or WebID out. |

This table assigns UI responsibilities; it does not grant access or replace the domain authority matrices. Mixed pages must isolate their sections by the authority each operation needs. In particular, an unavailable Pod must not globally lock otherwise authorized local or Account-only tasks.

For a route that requires a missing session, confirmed anonymous state uses the authentication presentation for that explicit scene on a themed document. Follow the [2026-09-06 frontend contract](2026-09-06-auth-frontend-redesign.md): shared WebID short flows may be compact; Xpod Account Web documents use their own layout and must not be forced into a compact card. Xpod owns Account forms and business steps while reusing shared primitives. Protected content is not mounted behind it: no protected rail/list/content, avatar credentials popover, or hidden modal layer. A local task that requires no user session is not redirected to this scene merely because Account or WebID is anonymous.

Restoring, anonymous and error are distinct. Restoration may suppress a credentials-card flash, but it must not leave the page blank indefinitely. Show the current phase and delayed-recovery actions using the timing and feedback contract in the [product-experience spec](2026-09-27-xpod-product-experience-spec.md). A UI waiting threshold is not an authentication timeout and must not change authority state, start a second login transaction, or infer anonymous. Retry and cancel use the existing authority operation; cancellation of UI waiting does not claim to undo a submitted operation.

Electron focus and app-activation events must not reveal protected content or restore focus into an obsolete modal. Once the route's own authority permits access, show its content without waiting on unrelated identity or Pod work.

### 3.2 Desktop layout

Default at widths of 768 px and above:

```text
┌──── navigation 184 px ────┬──────────── content ─────────────┐
│ Xpod                     │ Task heading / current target   │
│ 概览                     │                                 │
│ 存储空间                 │ Facts, choices and actions       │
│ AI                       │                                 │
│ 服务与访问               │                                 │
│                          │                                 │
│ Account, when available  │                                 │
└──────────────────────────┴─────────────────────────────────┘
```

Navigation entries always carry text; icons supplement labels. 概览 is the default landing. Account, Help and About are utility actions, not additional top-level workspaces. There is no permanent Settings destination or Inbox entry.

At widths of 1100 px and above, a genuine object collection may add a 224 px object pane between navigation and content. Spaces or provider connections can qualify; Overview, a single settings form or a list of diagnostic headings does not. The pane contains selectable objects, not dashboard cards. Empty and single-object tasks must not reserve an empty third column merely to satisfy a shell template.

### 3.3 Responsive behavior and density

- At least 1100 px: 184 px labeled navigation plus content; add the 224 px object pane only when the task has a real object collection.
- From 768 px to below 1100 px: keep the labeled navigation; show the object list or the selected detail, not both. Detail has a named back action and restores list selection/focus.
- Below 768 px: use a 48 px top task bar and a drawer with labeled navigation. The bar identifies the task and exposes menu/back as appropriate; opening the drawer does not discard the task. Do not recreate five bottom tabs.
- Workspace, selected object and relevant detail remain addressable by URL. Resize preserves the target, safe unsaved input and navigation history.
- Fine-pointer desktop: ordinary actionable rows/controls start at 36 px; read-only diagnostic rows may use 28–32 px; two-line object rows start at 56 px.
- Coarse-pointer input: actionable targets are at least 44 px and two-line rows at least 60 px. Authentication primary actions remain at least 44 px on all devices.
- These are minimums, not clipping heights. Do not shrink font size to meet density; long content and text enlargement may expand rows. Read-only diagnostic density cannot be reused for undersized action targets.

The [product-experience spec](2026-09-27-xpod-product-experience-spec.md) owns this R2 contract; shared layout and controls implement it once rather than letting modules invent variants.

## 4. User main card

The Account utility sits in the labeled navigation, or is reachable from the narrow navigation drawer. Selecting it opens a compact account popover anchored inward from the navigation. The card represents a person and their account; it is not an operations panel or SaaS administration summary.

```text
┌─────────────────────────────────┐
│ [Avatar]  Alice                 │
│           Account: alice   [⧉]  │
│           WebID available       │
│ ─────────────────────────────── │
│ Personal Pod                    │
│ alice.example               [✓] │
│ ─────────────────────────────── │
│ Switch account                  │
│ Sign out                        │
└─────────────────────────────────┘
```

The sketch illustrates content, not a new composite identity contract. Labels identify Account, WebID and Pod separately. The card contains only relevant identity and session information:

- Avatar, display name and Account identity; show WebID separately only when supplied by its authority.
- Copy actions name the object and copy its full value; a shortened display must not normalize or rewrite the identity.
- Optional note and region when profile data exists.
- A subdued current personal-Pod row when useful, never a service-status block.
- Product-level Switch account follows September 19 X-1: isolate and clear the old WebID/Pod context before presenting a new identity. It must not retain old bindings by applying a single-authority sign-out rule.
- Product-level Sign out uses the canonical logout coordinator and reports each authority's result. If a single-authority action is offered instead, name it explicitly as “退出管理账号” or “断开 WebID 会话”; it only calls that authority. A generic Sign out label must not silently mean Account-only. D-14/D-18 unresolved concurrency/cancellation remains a dependency, not a Shell invention.

It does not contain storage usage, network diagnostics, service state, AI models, or system settings. Those belong to the corresponding workspace.

The account avatar is shown only when backed by the relevant Account state. It does not render an embedded credentials card or create a second login implementation. On an authorized local-only route without an Account, omit personal identity claims while keeping permitted local tasks available. Anonymous, restoring and failure presentations belong to the route boundary in section 3.1; a Pod failure alone does not replace the whole shell with a login scene. The card distinguishes Account identity, WebID and selected Pod rather than presenting “Pod connected” as proof of a composed session.

## 5. 概览

Overview answers: **What can I use now, from where, and what needs my attention?** It is the default content page, with no persistent secondary list.

### 5.1 Normal content order

1. A concise availability conclusion naming the current machine/service instance and usable scope: this machine, LAN or verified external access. Keep machine online, service health, reachability and Pod access as separate facts.
2. The recommended usable address, with its scope, copy/open actions and last check when relevant. Configuration alone does not prove reachability.
3. Space summary: selected/available space, storage location and access state; a contextual link opens 存储空间. No Pod gives the authorized management path, not a false login failure.
4. One compact service summary line linking to 服务与访问. Healthy Gateway/Solid Server/API Server do not occupy three permanent cards or list entries on Overview.
5. Optional AI setup or connection summary only when it helps the current user task. An unconfigured optional AI capability is not a degraded-service alarm.

Version, uptime and detailed endpoints remain reachable in service or developer details. Tunnel, DDNS, access paths and Cloud coordination are not additional runtime services.

### 5.2 Failure and partial availability

A failure with user impact appears before normal summaries. State the affected capability and scope, keep unaffected capabilities usable, and offer the next useful action. For example, external access failure must not be described as all local data unavailable. A missing optional configuration is a neutral setup state; unknown or stale observations cannot be rendered healthy or zero.

An alert links to the relevant task and preserves the target. Overview does not introduce a generic “Needs attention” workspace or recreate the old multi-level Status tree.

Service health does not prove knowledge coverage, a trained model, an enabled release or a completed Run. Keep knowledge accumulation, runtime adaptation and actual training distinct. Optional untrained AI is neutral; an unavailable dependency required by the current task is an actionable, scoped problem.

### 5.3 Technical detail destinations

| Detail | Task destination | Navigation treatment |
| --- | --- | --- |
| Gateway, Solid Server, API Server health and lifecycle | 服务与访问 | Service detail links; stable deep links remain |
| Logs, health checks, network probes | 服务与访问 → 诊断 | Select source/filter in content; stable deep links remain |
| Storage/bandwidth consumption and limits | 存储空间, explicitly scoped to Account/Pod | Task summary with usage detail links |
| AI consumption | AI, scoped to provider/model/capability | Connection/use detail when observed |
| Search coverage, queue, failure and rebuild | Selected 存储空间 → 搜索与索引 | State, policy and actions in one task context |
| RDF, FTS, Vector, retrieval points, cache, slow queries and benchmark | Search/index professional details | Advanced entry and stable deep links; no permanent top-level or Overview list |

The old permanent Status list is removed. This changes discovery and hierarchy, not the availability of supported diagnostics.

## 6. 服务与访问

This entry combines local runtime management and network tasks. It does not add Account/WebID requirements to authorized local control. The landing content names the current service instance, states observed health and provides supported start/stop/restart actions with explicit scope. Startup policy, restart policy, data-directory facts and configuration provenance appear beside the relevant service settings, rather than in a separate Settings workspace.

### 6.1 Network task groups

The old eight-page Network list is replaced by three task groups within this entry. They are content sections or contextual detail destinations, not a mandatory object pane.

| Group | Primary content | Progressive detail |
| --- | --- | --- |
| 访问与连接 | Recommended address; where it works; copy/open; local/LAN/external observations and check time | Developer connection information: canonical URL, API/Solid endpoints, issuer, interfaces, ports and effective route |
| 对外访问设置 | Supported ways to make this instance reachable; current configuration and effects | Domain/DNS, HTTPS, tunnel and P2P controls only for capabilities the runtime actually supports |
| 诊断 | User-impacting problem, relevant checks, service health and logs, retry/check/export | DNS/TCP/HTTP/TLS checks, Cloud coordination evidence, process IDs, internal endpoints and sanitized technical reports |

Do not turn provider names or unsupported transport plans into empty product pages. The chosen access method reveals only applicable settings; alternative supported methods remain discoverable without requiring users to configure all of them.

### 6.2 Access configuration details

- Domain/DNS: expected and observed records, domain/DDNS configuration, TTL, credential configured state and recheck action.
- HTTPS: certificate domains, issuer, validity and renewal evidence; supported enablement/ACME/path settings. Save and renewal are different operations.
- Tunnels: show the runtime-declared supported profiles, label, endpoint, credential state and activation. Do not promise ngrok, Cloudflare or frp because the old document listed their names; provider-specific fields appear only for the selected supported method. Activation follows the runtime’s actual mutual-exclusion contract.
- P2P: capability, observed state and supported enablement/signal/fallback policy. It is not an always-present page.
- Cloud coordination: include applicable endpoint, registration, heartbeat and coordination settings without claiming that a planned independent host agent is installed.

Observed state and desired configuration stay visually separate. Saving must not replace observations with unverified intended values. Developer connection information preserves canonical identities even when the effective network path is local or tunneled.

### 6.3 Service and log details

The service detail retains health, PID where available, uptime, restart count, internal endpoint, checks, dependencies, recent errors, related logs and supported scoped actions. A running PID is not proof of service health. Runtime startup and automatic-restart policy, save/restart requirements and supported advanced parameters remain available here. Never expose an unfiltered environment-variable editor.

A failed Run may open its known instance/dependency/log scope here and return to that same Run. Repair fixes the dependency; it does not resubmit training or claim the Run completed. A waiting_input continuation retains the Run under the Task contract. Unknown operation results must be queried before retrying; requested cancellation is not stopped execution. Foundry must define training cancellation/retry before those controls are executable; an existing Run cancel capability does not supply that missing protocol.

Logs allow source (`All`, `Xpod Runtime`, `Gateway`, `Solid Server`, `API Server`), level, time range and text filters. Source and error level remain independent so a user can ask which service failed. Live refresh, known-error hints and sanitized export remain supported design requirements. Diagnostic deep links open the right source/subject under 服务与访问 without restoring the old Status navigation.

## 7. AI

AI is one navigation entry covering provider connection, usable models, assignment to a purpose and external client connection. It presents a continuous task while preserving two business owners:

- AI Connections owns provider credentials, Base URLs, provider quotas/catalogues, Xpod client API Keys and external client connection flows.
- AI Config owns model assignments and durable use policies. It references connections and does not edit their credentials.

Combining navigation does not merge stores, permission boundaries or authentication state. Search/index policy and rebuild are presented in the selected space’s search task; the existing AI Config, runtime and index owners still implement their respective responsibilities.

### 7.1 Shared model semantics

AI model records use three independent semantic dimensions. Product adapters must not collapse them into one string field:

```text
Class       what the model is       RDF class inheritance
Capability  what the model can do   URI relation
Role        how a product uses it    AI Config relation
```

`AIModel` is the shared parent class. Stable API-contract classes extend it through drizzle-solid `SolidSchema.extend()`:

```text
AIModel
├─ ChatModel
├─ EmbeddingModel
├─ DocumentModel
├─ RerankingModel
├─ ImageGenerationModel
├─ SpeechRecognitionModel
├─ SpeechSynthesisModel
└─ VideoGenerationModel
```

Capabilities such as reasoning, tool use, web access, vision, OCR, document understanding, structured output, and indexing are URI resources linked from a model. They are not model subclasses. A Qwen-VL record remains a `ChatModel` and may additionally link to OCR and document-understanding capabilities.

AI Config fields are workload roles. Each role links to the shared `AIModel` parent and validates the capability required by that role:

```text
chatModel      requires Chat
ocrModel       requires OCR
readerModel    requires DocumentUnderstanding
embeddingModel requires Embedding
indexerModel   requires Indexing
rerankerModel  requires Reranking
```

This allows a role to select any compatible subclass without encoding the current adapter or API route into the ontology. Model assignments always store AI model resource URIs rather than provider/model names.

Only cross-product model semantics and user intent belong in `@undefineds.co/models`. Xpod-specific FTS/vector enablement, backend selection, and index lifecycle controls remain product-owned Pod configuration rather than predicates on the shared `AIConfig` class.

### 7.2 Task composition

The AI landing shows existing connections and their actual readiness, then offers two tasks with only their necessary dependencies:

- **Connect an AI client:** establish the required provider/model availability and client credential/configuration, then verify the relevant client path. Assigning a model to a document or search purpose is not a prerequisite.
- **Use AI with saved material:** choose the required document/search purpose and a compatible model; add or repair a provider connection only when that purpose needs it. Preserve the selected space and return target.

Neither task is a mandatory wizard through every AI feature. A genuine collection of connections may use the optional object pane; empty setup or a single form does not require one.

Model assignments and document-processing policies are contextual destinations inside AI, not a peer “AI Config” workspace. AI Connections’ product spec defines credential, connection and client behavior. The space search task reuses the same AI Config editor and task feedback in place; opening full AI detail is optional and preserves the target and return path. Do not create a second assignment owner or require cross-page travel for routine search configuration.

### 7.3 Model Assignments content

Task-to-model assignments include only capabilities with real consumers:

```text
General / Chat
OCR
Document Reader
Embedding
Indexer / Summarizer
Reranker
```

Each assignment summary shows only the purpose, selected model and availability. Editing expands the necessary provider/credential-readiness evidence, configuration source (system default or Pod override), restore-default action and bounded test. It references provider configuration but does not edit credentials; failures link to their owning connection task.

For personal models, detail distinguishes the Foundry release target, runtime-observed serving version, client-selected version and Run-observed version with source/time. A candidate is not automatically enabled; saving a selection does not prove live serving or actual use. Rollback does not rewrite past Runs. Reuse the existing model/assignment owners, Cloud catalog and endpoint limits; a personal-model label grants no exception.

### 7.4 Document Processing content

- OCR enabled state.
- Automatic or on-demand triggering.
- Image, PDF, and table recognition policy.
- OCR fallback order.
- Document structure reader policy.
- Reader priority, file/page limits, and failure fallback.

Model selection retains the Model Assignments business owner and can reuse its editor inside the processing task. Do not require a separate page visit or duplicate its state and persistence logic.

## 8. 存储空间

This entry reuses `/settings/pod` for Account inventory and explicit creation. Account is required for those management regions, not for the whole combined space surface. A valid WebID and authorized target Pod can enter search, purpose and grant regions without an Account session. Users can identify a space, understand where it is kept and who can use it, manage supported lifecycle actions, inspect usage and configure search without first visiting a generic Settings tree; this is not a file feed.

### 8.1 Space selection and management

- With zero Pods, authorized Account management stays accessible and offers explicit supported creation/binding. A failed inventory read is an error, not an empty collection.
- With multiple spaces, show a real selectable collection; preserve the selected target in the route. Do not silently select the first candidate where domain rules require explicit choice.
- Show the space name, URL, location/provider, creation/basic metadata and a supported open action. Keep machine, service and Pod state separate.
- Creation, binding, migration and host lifecycle follow the 2026-09-19 canonical. Registration, opening a route and authorizing an app do not create a Pod.
- Account inventory and explicit creation require Account authority. Search, purpose and grant regions require their own valid WebID/target-Pod authority and can remain accessible without Account. Missing Account blocks only Account management regions; a failed Pod resource blocks only its dependent operation. A combined page must not add an Account + WebID + Pod admission gate or block unrelated local service actions.

### 8.2 Location, access and usage

Location and health use actual evidence. Supported File/MinIO and SQLite/PostgreSQL/Redis/Quadstore settings remain in appropriately scoped storage detail; backend names do not become mandatory navigation entries. Configuration credentials show configured/not-configured state only. Migration appears only when supported, with source, target, impact and recovery described by its lifecycle contract.

Show data location, inference/training execution location, artifact storage and device reachability separately. Local access does not imply local inference. Original knowledge/model resources have stable detail and return locations; editing and feedback stay in LinX, release governance stays in Foundry. Read permission does not grant training use; revocation does not prove trained weights have forgotten the material.

Access details identify Account, WebID, issuer, application grants and their target scope. Revocation, AI Gateway service access and ACP/ACR capability remain distinct operations; provider credentials and Xpod client API Keys stay with AI Connections.

Usage shows measured consumption, limit and scope. Storage/bandwidth retain their Account/Pod usage model; a space view must not relabel Account totals as the selected Pod’s usage. Index storage distinguishes original authority data from rebuildable derivatives. A failed or absent measurement is not zero; detailed reports retain stable links.

Task estimates, actual consumption, provider quota, key usage and space capacity identify their object, period, unit, source and observation time. Do not infer training feasibility from API balance or move execution/switch models without the required choice. Account totals still require Account authority.

Export, backup and migration each disclose their own asset scope: data, knowledge/task records, model bytes and manifests, provenance/authorization records, rebuildable indexes and credentials. Mark included/excluded/unknown; separately identify external artifact stores and whether their bytes are copied. A reference alone is not a complete model backup. Report manifest creation, copy/check and restore verification separately; unverified restore is not “fully recoverable”. Preserve identity and canonical addresses per the host contract; secret transfer follows its original security owner. Undefined portability capability is a dependency, not a success promise.

### 8.3 Search & indexing task

For the selected space, present coverage and queue/failure evidence, the durable search/index policy, and supported rebuild actions in the same task context. This removes the old split between Status observations, AI Config policy and a separate lifecycle page. Each section retains its existing business owner, permissions and state source.

Supported policy controls include full-text, vector and progressive indexing, automatic indexing of new resources and refresh after source changes. Cleanup of derived content after source deletion or loss of access is mandatory; it is not a user-disableable policy. Report cleanup delay or failure and its recovery path without treating deleted or unauthorized material as an accessible search result.

Auto remains the default backend selection. Runtime support alone does not authorize an editable backend dropdown: manual text/vector switching is exposed only after the owning domain defines and supports safe switching/migration, including existing-index compatibility and failure recovery. Otherwise show the effective backend read-only, with applicable capability information; do not imply that selecting FTS5/PostgreSQL FTS or VEC/pgvector performs a safe migration.

Model assignment changes use the same AI Config editor and task feedback within the space search task. Full-detail navigation is optional, retains the selected space/task and returns to it; it is not required for a routine assignment. Reuse the business owner rather than copying provider credentials or assignment logic. Embedding dimension is derived from the selected model and read-only. Additional coverage and policy controls require a real implemented consumer.

The task shows current configuration version, pending queue and recent completion/failure evidence. Saving policy and rebuilding remain distinct:

```text
[Save configuration]
[Save and schedule rebuild]
```

A model/backend change never silently destroys or replaces an existing index. Rebuild FTS, Vector or all derived indexes states the target space and effects; source data is preserved. Original data deletion is a separate operation.

### 8.4 Professional details

RDF, FTS, Vector, retrieval points, cache, slow queries, planner evidence and benchmark reports remain behind a stable advanced-detail entry and existing deep links. They are not permanent first-level or Overview list items. Coverage, backlog and failures needed for the current search task remain visible without opening professional diagnostics.

## 9. macOS menu-bar tray

The tray is a native macOS menu-bar integration at the top-right of the screen. It is separate from the in-app labeled navigation.

The existing lightweight desktop shell is the host for this integration. This design does not replace or scaffold another desktop shell; it adds the tray, routes, and workspace integration to the existing shell.

### 9.1 Icon

Use a dedicated monochrome macOS template adaptation of the selected Xpod 留缝折角 mark. The application icon uses the selected ink-purple tile; that tile is not the menu-bar icon. Preserve old assets for reference rather than overwriting them. Asset mapping and acceptance are owned by the shared brand work in the [product-experience spec](2026-09-27-xpod-product-experience-spec.md), not by individual workspaces.

The template asset requirements are:

- `trayTemplate.png`: 16×16.
- `trayTemplate@2x.png`: 32×32.
- Black plus alpha, no colored background, gradient, or enclosing tile.
- Approximately 2 px visual inset.
- Mark the Electron `NativeImage` as a template image so macOS supplies light/dark/high-contrast rendering.

The icon represents aggregate runtime state:

- All three services running: normal.
- Any service starting: starting.
- Any service crashed/failed: error.
- All stopped: stopped.
- Mixed running/stopped: degraded.

The tooltip includes the aggregate service state, for example `Xpod · 3/3 services healthy`, only when health observations support it. Process existence does not prove health, external reachability or Pod access. Icon/attention-marker mapping follows product-experience spec section 9.

### 9.2 Runtime services

Aggregate service health is based on exactly three services; normal operation does not render all three as separate menu rows:

1. Gateway.
2. Solid Server (internal service name `css`).
3. API Server (internal service name `api`).

### 9.3 Native menu

The tray is a short status/control surface, not a copy of the application navigation. In normal operation it contains:

- A concise current-instance summary based on observed state.
- Open Xpod, which shows or focuses the main window.
- The control applicable to the current service state and actual ownership/capability, with an explicit target and effect.
- A service detail/diagnostic entry for further inspection.
- An accurately named exit action following section 9.4 and the installed lifecycle capability.

Do not duplicate the four task entries, three healthy-service rows, Account switching or startup settings in the tray. Those tasks remain in the application. On failure, foreground the affected service and impact, with a direct diagnostic or recovery entry instead of adding the full healthy-service inventory.

If an external opening action is offered, name its actual capability and target: for example, opening the space management page is not “Open Pod”. Offer a Pod URL/browser action only when that capability and authorized target are actually available.

Service dependencies, per-service restart effects, Account controls and startup policy belong in their full task surfaces. The tray must not imply independent service control when the runtime only supports whole-runtime control.

### 9.4 Interaction behavior

- Single click opens the native menu.
- No separate right-click or double-click behavior.
- Open Xpod shows or focuses the main window.
- Route menu items show/focus the main window and navigate within that window.
- Closing the window on macOS hides it while Xpod and the tray continue running.
- Target lifecycle: quitting the UI does not implicitly stop the independent host agent or Xpod service. Stopping Xpod and exiting the agent are separate, explicitly scoped operations under the 2026-09-19 canonical.
- These are target semantics, not a claim that the independent agent has shipped. In a transitional deployment, labels and confirmation must describe the actual lifecycle owner and effect according to the product-experience spec. Do not offer a background-service promise when the installed capability cannot keep running.
- Account sign-out is separate from window, UI, service and host-agent exit. Switching identities must prevent stale results from appearing under the new identity.
- Before stop/restart/upgrade/exit, explain known effects on local Runs, remote training, future scheduling and observation-only UI; disclose unknown dependencies. UI exit does not pause Tasks, revoke access or cancel remote jobs. Only offer supported controls; after maintenance recheck the original Run and serving version without assuming automatic recovery or repeating unknown-result work.

## 10. State, loading, and errors

- Object rows may show compact textual state; do not add a permanent object pane for summaries or section headings.
- Initial content loading uses shape-matched skeletons; identity restoration uses the phase feedback in section 3.1 rather than a blank workspace or an invented authentication state.
- Refresh retains the previous successful snapshot and marks it stale until replacement data arrives.
- Errors stay contextual to the selected subject and include evidence or a next action.
- Configuration surfaces show saved, dirty, saving, applied, restart-required and rebuild-required states distinctly.
- Capability-disabled controls explain whether the limitation comes from the runtime, deployment mode, or missing user configuration.
- Status colors always include text or an icon label and are not used decoratively.

## 11. URL and migration direction

Navigation names do not require new identity or resource URLs. Preserve and map existing route families into the four task entries according to product-experience spec section 3:

| Existing entry/detail | R2 visible destination |
| --- | --- |
| `/status/*` overview | 概览 |
| `/status/*` service/log diagnostic details | 服务与访问, corresponding detail |
| `/status/*` usage/index details | Corresponding space or AI task, with authority/scope preserved |
| `/network/*` | 服务与访问, relevant access group |
| AI Connections routes | AI, connection/client business owner retained |
| `/ai-config/model-assignments`, `/ai-config/document-processing` | AI, model/purpose business owner and WebID/Pod authority retained |
| `/ai-config/search-indexing`, `/ai-config/index-lifecycle` | Selected 存储空间 → 搜索与索引; original editor, feedback and WebID/Pod authority retained |
| `/settings/pod` Account inventory/create regions | 存储空间, Account admission retained only for these management regions |
| Selected-space search/purpose/grant regions | 存储空间, valid WebID/target-Pod admission; no additional Account requirement |
| Old runtime/cloud/advanced settings | 服务与访问, supported runtime/access detail |
| Old identity/storage settings | Relevant 存储空间 detail or Account utility, scoped to the actual target |

The table maps route responsibilities, not literal wildcard redirects. Exact paths, safe default targets, legacy aliases and minimum compatibility duration are fixed by the product-experience spec; the implementation plan records any additional observed aliases. Preserve validated continuation, object identifiers and the destination authority. Never make an Account inventory/create link require an already-ready Pod. Conversely, do not add Account admission to a valid WebID/target-Pod search, purpose or grant deep link merely because its content appears in the combined space surface. Keep legitimate object identifiers and task return targets, and never redirect a technical deep link to an unrelated generic landing.

Migration preserves existing user work and data. It changes navigation/combination, not provider protocols, model assignments or authentication ownership.

### 11.1 R6 object handoff inside the four entries

| Original task | Controller destination | Return contract |
| --- | --- | --- |
| LinX knowledge/source access or coverage | Authorized selected-space access/search region under `/settings/pod` | Same resource/version, with permission and scope revalidated |
| Published personal model use | AI client/purpose, then service runtime detail only if required | Same release, purpose and client; separate publication, serving and verification facts |
| Failed Run dependency | 服务与访问 with known instance, dependency and diagnostic scope | Same Run; human steering/continuation remains in LinX |
| Carry space/model assets elsewhere | Supported space export/backup/migration and scope manifest | Original space/model detail; bytes and restore evidence, not only pointers |

Use validated object/version, purpose, client and return context; do not create new APIs or store secrets in URLs. After repair revalidate identity, authority, material scope/version, execution/cost and enablement scope before resuming a consequential choice. Do not automatically submit training, broaden grants, switch models or recreate keys/Pods. Missing mappings are assigned to the existing route/resource owner. Full detail remains reachable without new parallel knowledge/training/task top-level pages.

## 12. Accessibility

- Every primary navigation entry has visible text and an accessible name. Icons are supplementary; drawer and utility actions are named.
- Active navigation and object selection are communicated independently of color.
- Object selection supports keyboard navigation; opening detail and returning restore meaningful focus. The narrow drawer manages focus and returns it to its opener.
- Content headings identify both workspace and selected item.
- Status refreshes use polite live regions; lifecycle failures use assertive announcements only when necessary.
- Destructive or disruptive actions state their scope and require confirmation.
- The native tray uses meaningful labels rather than relying on dot color.

## 13. Verification requirements

The following R2 verification list is historical for navigation and geometry. Apply the October 1 overrides before using its remaining authority, safety and evidence checks:

1. Exactly four labeled primary entries in this local controller: 概览、存储空间、AI、服务与访问; 概览 is the default. This does not cap full-product assets or tasks. Section 11.1 details remain reachable; no restored five-icon rail, permanent Settings entry or duplicate LinX/Foundry editor.
2. Normal Overview content prioritizes usability, scope/address and space; healthy services occupy one summary line. An unconfigured optional AI connection does not create a failure alarm.
3. Impacting failures precede normal summaries, identify affected scope and link to the right task while unaffected tasks remain available.
4. At 1100 px and above, only actual object collections add a 224 px object pane beside the 184 px navigation. Forms and Overview remain navigation + content; zero objects do not leave an empty reserved pane.
5. At 768–1099 px, list/detail transitions preserve selection and back/focus behavior. Below 768 px, a 48 px task bar and labeled drawer replace desktop navigation; no five-tab bottom bar.
6. Fine-pointer 36 px actions, 28–32 px read-only diagnostics and 56 px two-line rows; coarse-pointer 44 px actions/60 px two-line rows; authentication primary actions at least 44 px. Text enlargement/long errors expand without clipping or reduced font size.
7. Client connection and saved-material purposes are separate AI tasks with only necessary dependencies; client setup does not require document/search assignment. Assignment summaries show purpose/model/availability and expand advanced editing details. Business owners, credentials and authority remain separate; failed setup returns to its owning step.
8. `/settings/pod` Account inventory/create regions admit a valid Account with zero Pods. Valid WebID/target-Pod search, purpose and grant regions also work without Account; a missing authority blocks only its dependent region. Search reuses the same AI Config editor/feedback in place, with optional full-detail navigation and preserved object/task return.
9. Access groups cover 访问与连接、对外访问设置、诊断; only supported methods expose controls. Developer endpoints and advanced diagnostics remain reachable without permanent navigation clutter.
10. Original-data/index separation and save-only versus save-and-rebuild remain intact. Derived cleanup after source deletion/loss of access cannot be disabled; editable backend changes require a defined safe switch/migration contract. Exact AI Config paths, service, usage, index and diagnostic deep links resolve to the correct R2 task, authority and target.
11. Account-card product switching follows X-1; product logout and explicitly named single-authority actions remain different. Anonymous/unavailable-Pod states use route authority while unrelated authorized local/Account tasks remain available. Unresolved D-14/D-18 actions are not invented.
12. Delayed restoration shows phase feedback and permitted recovery; presentation timers do not mutate identity or start duplicate restoration. Errors are not anonymous.
13. Service healthy/starting/degraded/failed/stopped evidence, observed/configured separation, stale-state labeling and capability gating.
14. Shared light/dark theme, first paint, authentication layouts, focus, selected states, native window background and menu-bar template assets.
15. Tray remains a short instance summary/open/current-control/detail/exit surface, without four-entry navigation, healthy-service inventory or Account/startup settings. Failures foreground the affected service; opening actions name the real capability. Close window, quit UI, Account sign-out, service stop and agent exit remain separately scoped against the installed lifecycle capability.
16. Implementation delivery runs the repository’s required type/build/integration checks and records versioned evidence. This document-only revision does not claim those runtime checks have passed.
17. The four section 11.1 paths retain the original object/version and revalidate before returning. Repair is not automatic task/training submission; unknown results do not repeat side effects. Apply product-experience AC-15/17.
18. Release, serving, client and Run versions remain distinct; health does not imply model growth or task completion. Candidate enablement and rollback preserve domain ownership and past Run evidence. Apply AC-16.
19. Lifecycle impact distinguishes known local/remote tasks and future scheduling; assets distinguish rebuildable indexes from durable models. Portability reports bytes, external stores, scope and restore evidence separately. Apply AC-18/19.
20. Data/execution/artifact location, reachability and scoped usage are separate; reading/comparison detail does not inherit compact-auth or diagnostic-row constraints. Apply AC-20.

## 14. Implementation handoff and historical decisions

The [product-experience spec](2026-09-27-xpod-product-experience-spec.md) supplies the current interaction and visual contract, including restoration feedback timing, narrow-window navigation and shared-theme mapping. Implementations must not each choose different values or create page-local substitutes.

The old open decision “whether Quit Xpod stops the runtime” is superseded by the 2026-09-19 host lifecycle target, with truthful transition behavior required by section 9.4. The implementation plan records supported backend controls and capability gaps, and implements the route mappings and compatibility duration fixed by product-experience spec section 3. Capability gaps affect dependent controls, not the four-entry task architecture. R2 replaces the older navigation lock; the old five-workspace design is historical context, not a user-imposed invariant.

For each delivered slice, record the implementation version, covered scenarios and evidence separately. Neither this baseline nor an earlier passing test report certifies a later release.
