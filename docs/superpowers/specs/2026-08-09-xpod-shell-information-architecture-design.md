# Xpod Shell Information Architecture Design

**Date:** 2026-08-09

**Status:** Implemented and verified

**Scope:** Xpod desktop/web shell navigation, Status, Network, AI Config, Settings, user card, and macOS menu bar tray

**Out of scope:** AI Connections provider-management flow

## 1. Problem

The current shell separates Dashboard and Settings into two products and gives each product its own rail. This duplicates domains such as Network and Services, while the list pane changes meaning between pages: it is sometimes a selectable object list and sometimes a stack of summary cards. Content panes then mix observed state, diagnostics, durable settings, and lifecycle actions.

The new shell must make the three layout layers predictable:

- **Rail:** stable, first-level workspaces.
- **List:** selectable sections or objects within the active workspace.
- **Content:** details and actions for the selected list item.

The shell also needs a global user card and a macOS menu-bar tray that reflects the three Xpod runtime services.

## 2. Design principles

1. Use one global rail. Do not switch between separate Dashboard and Settings rails.
2. Keep the rail small and stable. Low-frequency subdomains belong in the list pane.
3. Every list row is selectable. Summary cards do not belong in the list pane.
4. A content pane answers one subject. It may show summaries, forms, evidence, and contextual actions, but it does not introduce another navigation level.
5. Observed state and desired configuration may coexist in a domain such as Network, but their controls must be visibly separated and must not duplicate one another.
6. AI Connections and AI Config are separate first-level workspaces. AI Connections reuses the existing provider-management implementation and is not redesigned here.
7. Persist user-level AI and indexing policy in the user's Pod. Runtime services report capabilities and operational state.
8. Derived indexes may be rebuilt or discarded; authority data in the Pod must never be affected by index lifecycle actions.

## 3. Global application frame

### 3.1 Desktop layout

```text
┌──── rail ────┬──────── list ─────────┬──────────── content ────────────┐
│ Xpod         │ Active workspace      │ Selected item                  │
│              │                       │                                │
│ Status       │ Selectable rows       │ State, configuration,          │
│ Network      │ grouped when useful   │ evidence, and actions           │
│ AI Connect.  │                       │                                │
│ AI Config    │                       │                                │
│              │                       │                                │
│ Settings     │                       │                                │
│ [Avatar]     │                       │                                │
└──────────────┴───────────────────────┴────────────────────────────────┘
```

The rail is icon-first and uses tooltips and accessible labels. Its order and grouping are fixed:

```text
TOP
  Xpod identity / home mark

PRIMARY WORKSPACES
  Status
  Network
  AI Connections
  AI Config

BOTTOM
  Settings
  Current-user avatar
```

There is no first-level Dashboard item. Status is the default operational landing page. There is no Inbox workspace in this design.

### 3.2 Responsive behavior

- Wide desktop: rail, list, and content remain visible.
- Medium width: rail remains visible; list and content use the existing two-pane navigation behavior.
- Narrow/mobile: the rail becomes a compact bottom or overlay navigation surface; list selection opens content and provides an explicit back action.
- The active workspace and active list item must remain addressable by URL.

## 4. User main card

The avatar is pinned to the bottom of the rail. Selecting it opens a compact popover inward from the rail.

```text
┌─────────────────────────────────┐
│ [Avatar]  Alice                 │
│           alice.example         │
│                                 │
│ Pod                             │
│ https://alice.example/          │
│ ● Connected                     │
│                                 │
│ [Open Pod]   [Copy WebID]       │
│ ─────────────────────────────── │
│ Account                         │
│ Switch Pod                      │
│ Sign out                        │
└─────────────────────────────────┘
```

The card contains only global identity and session information:

- Avatar and display name.
- Short WebID identity.
- Current Pod URL and connection state.
- Open Pod and copy WebID.
- Account, switch Pod, and sign out.

It does not contain storage usage, network diagnostics, service state, AI models, or system settings. Those belong to the corresponding workspace.

## 5. Status workspace

Status answers: **Can Xpod be used now, how can it be reached, and where is a failure occurring?**

### 5.1 List

```text
Status
├─ OVERVIEW
│  └─ Overview
├─ SERVICES
│  ├─ Gateway
│  ├─ Solid Server
│  └─ API Server
├─ DIAGNOSTICS
│  └─ Logs
├─ INDEX
│  ├─ Index Overview
│  ├─ RDF
│  ├─ FTS
│  ├─ Vector
│  ├─ Retrieval Points
│  ├─ Cache
│  ├─ Slow Queries
│  └─ Benchmark
└─ USAGE
   ├─ Usage Overview
   ├─ Storage
   ├─ Bandwidth
   ├─ AI Usage
   └─ Index Storage
```

There is no generic “Needs attention” list item. Contextual failures appear at the top of the relevant content page with evidence and direct actions.

### 5.2 Overview content

- Overall availability and degraded state.
- Gateway, Solid Server, and API Server summaries.
- Recommended access URL.
- Runtime uptime and version.
- Contextual failures, hidden when there are none.
- Access-path summary: local, LAN, public, and tunnel.
- Cloud coordination summary when Cloud coordination is enabled; otherwise hidden.

Overview is the default Status content. It is not a separate rail item and is not positioned relative to an Inbox.

### 5.3 Service content

Gateway, Solid Server, and API Server are direct Status list items rather than a nested Runtime navigation layer. Each service detail shows state, PID where available, uptime, restart count, internal endpoint, health checks, dependencies, recent errors, related logs, and an explicitly scoped restart action. Aggregate service health remains in Overview.

### 5.4 Logs content

Log sources:

```text
All
Xpod Runtime
Gateway
Solid Server
API Server
Errors
```

The content provides level, time-range, and text filters; live refresh; known-error hints; and sanitized diagnostics export.

### 5.5 Index content

Index replaces the narrower RDF label.

Index Overview, RDF, FTS, Vector, Retrieval Points, Cache, Slow Queries, and Benchmark are direct grouped Status list items. Their content pages show current backend, enabled/supported state, coverage, queue backlog, last successful run, failures, storage use, cache evidence, planner evidence, and benchmark reports. They do not change the durable indexing policy; that belongs in AI Config.

### 5.6 Usage content

Usage Overview, Storage, Bandwidth, AI Usage, and Index Storage are direct grouped Status list items. They show measured consumption and limits. Storage and bandwidth remain scoped to the current account/Pod usage model. AI Usage groups requests and consumption by capability, provider, and model when evidence is available. Index Storage separates authority data from rebuildable derived data.

## 6. Network workspace

Network is a first-level workspace because users need both frequent operational visibility and durable connectivity configuration. It is not duplicated between Dashboard and Settings.

### 6.1 List

```text
Network
├─ Overview
├─ Endpoints
├─ Addresses
├─ Domain & DNS
├─ HTTPS
├─ Tunnel Profiles
├─ P2P
└─ Diagnostics
```

### 6.2 Content responsibilities

**Overview**

- Recommended access path.
- Local, LAN, public, and tunnel status.
- DNS and TLS summary.
- Contextual failures and suggested next actions.

**Endpoints**

- Canonical URL, API endpoint, Solid endpoint, and identity issuer.
- Currently effective route.
- Copy and open actions.

**Addresses**

- Local, LAN, and public address groups.
- Interface, IP version, port, reachability, latency, and last checked time.

**Domain & DNS**

- Observed DNS records and expected values.
- Domain and DDNS configuration.
- DNS provider, record TTL, and write-only credential state.
- Recheck after saving.

**HTTPS**

- Observed certificate domains, issuer, validity, expiry, and renewal status.
- HTTPS enablement, ACME email/domains, certificate paths, and renewal policy.
- Manual renewal as an operational action.

**Tunnel Profiles**

- Profile rows such as ngrok, Cloudflare, and frp.
- Provider, label, public endpoint, credential state, provider-specific parameters, and activation state.
- Exactly one profile may be active. Provider-specific advanced fields remain folded.

**P2P**

- Capability and current state.
- Enablement, signal service, and fallback policy.

**Diagnostics**

- DNS resolution, TCP connection, HTTP reachability, TLS handshake, canonical URL, and Cloud connectivity.
- Run, copy, and export actions.

Observed state and configuration must be visually distinct within the same content page. Saving configuration must not present an unverified value as current operational truth.

## 7. AI Config workspace

AI Config is an independent first-level workspace. It configures how Xpod capabilities consume models and derived-index backends. It does not manage provider connections, API keys, Base URLs, provider quotas, provider model catalogues, Gateway Keys, or external client connection flows.

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

### 7.2 List

```text
AI Config
├─ Model Assignments
├─ Document Processing
├─ Search & Indexing
└─ Index Lifecycle
```

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

Each assignment shows provider, model, availability, credential readiness, configuration source (system default or Pod override), restore-default action, and a bounded test action. It references provider configuration but does not edit credentials.

### 7.4 Document Processing content

- OCR enabled state.
- Automatic or on-demand triggering.
- Image, PDF, and table recognition policy.
- OCR fallback order.
- Document structure reader policy.
- Reader priority, file/page limits, and failure fallback.

Model selection remains in Model Assignments and is not duplicated here.

### 7.5 Search & Indexing content

Default controls:

- Full-text indexing enabled.
- Vector indexing enabled.
- Progressive indexing enabled.
- Text backend set to Auto by default.
- Vector backend set to Auto by default.

Manual backend choices are shown only after the user opts out of Auto:

- Text: FTS5 or PostgreSQL FTS, subject to runtime capability.
- Vector: VEC or pgvector, subject to runtime capability.

Advanced controls include FTS/vector/entity coverage and other bounded policy values only when they have an implemented consumer. Embedding dimension is derived from the selected model and is read-only.

### 7.6 Index Lifecycle content

- Automatically index new resources.
- Refresh derived indexes after source updates.
- Remove derived entries after source deletion.
- Current index configuration version.
- Pending queue and recent completion/failure evidence.
- Rebuild FTS, Vector, or all derived indexes.

Changing a model or backend never silently destroys or immediately replaces an existing index. The save flow offers explicit choices:

```text
[Save configuration]
[Save and schedule rebuild]
```

## 8. Settings workspace

Settings is pinned near the bottom of the rail and contains low-frequency configuration not owned by Network or AI Config.

### 8.1 List

```text
Settings
├─ Pod
├─ Identity & Access
├─ Storage
├─ Runtime
├─ Cloud
└─ Advanced
```

### 8.2 Content responsibilities

**Pod**

- Pod name and URL.
- Current storage provider.
- Creation and basic metadata.
- Open Pod.

**Identity & Access**

- WebID, OIDC issuer, current account, and session state.
- Agent/app access grants, AI Gateway service access, revoke action, and ACP/ACR capability state.

**Storage**

- File/MinIO and SQLite/PostgreSQL/Redis/Quadstore backend configuration where supported.
- Authority-data location and storage health.
- Credentials display only configured/not configured state.
- Migration entry only when the runtime reports the capability.

**Runtime**

- Edition, Base URL, data directory, and configuration source.
- Service startup and automatic restart policy.
- Save-and-restart behavior.
- Full service health does not appear here; it belongs in Status.

**Cloud**

- Cloud endpoint, node registration, heartbeat, and cluster coordination configuration.
- Hidden when the deployment cannot use Cloud coordination.

**Advanced**

- Logging level and retention.
- Supported advanced runtime parameters.
- Restart requirements and configuration provenance.
- Never expose an unfiltered environment-variable editor.

Measured storage and bandwidth usage belongs in Status / Usage, not Settings.

## 9. macOS menu-bar tray

The tray is a native macOS menu-bar integration at the top-right of the screen. It is not part of the in-app rail.

The existing lightweight desktop shell is the host for this integration. This design does not replace or scaffold another desktop shell; it adds the tray, routes, and workspace integration to the existing shell.

### 9.1 Icon

Replace the current colored square asset with monochrome macOS template images:

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

The tooltip includes the aggregate state, for example `Xpod · 3/3 services running`.

### 9.2 Runtime services

The tray reports exactly three services:

1. Gateway.
2. Solid Server (internal service name `css`).
3. API Server (internal service name `api`).

### 9.3 Native menu

```text
● Xpod healthy                         disabled
  3/3 services running                disabled
──────────────────────────────────
● Gateway                     Running
● Solid Server                Running
● API Server                  Running
──────────────────────────────────
Open Xpod
Open Pod                           ↗
──────────────────────────────────
Status
Network
AI Config
Settings
──────────────────────────────────
Check Status Again
Restart Xpod…
──────────────────────────────────
Signed in as Alice                  disabled
Switch Account…
──────────────────────────────────
Launch at Login                       ✓
About Xpod
Quit Xpod
```

Each service row opens the corresponding direct Status service detail. When a service fails, the menu surfaces a contextual `Open <service> Logs` action.

The first implementation exposes whole-runtime start/restart controls, not individual service restart controls. Service dependencies and restart effects require the richer Status service detail page.

### 9.4 Interaction behavior

- Single click opens the native menu.
- No separate right-click or double-click behavior.
- Open Xpod shows or focuses the main window.
- Route menu items show/focus the main window and navigate within that window.
- Closing the window on macOS hides it while Xpod and the tray continue running.
- Quit Xpod quits the desktop shell. Whether it also stops the runtime must be an explicit implementation decision and must be communicated in the confirmation copy.

## 10. State, loading, and errors

- List rows may show compact textual state but never become summary cards.
- Initial content loading uses shape-matched skeletons.
- Refresh retains the previous successful snapshot and marks it stale until replacement data arrives.
- Errors stay contextual to the selected subject and include evidence or a next action.
- Settings show saved, dirty, saving, applied, restart-required, and rebuild-required states distinctly.
- Capability-disabled controls explain whether the limitation comes from the runtime, deployment mode, or missing user configuration.
- Status colors always include text or an icon label and are not used decoratively.

## 11. URL and migration direction

The target route families are:

```text
/status/*
/network/*
/ai-config/*
/settings/*
```

Existing `/dashboard/*` and old `/settings/models|pod|network|services` paths require explicit redirects. Exact route names and backward-compatibility duration belong in the implementation plan.

The migration must preserve existing user work in the dirty tree and must not absorb the independent AI Connections changes into this scope.

## 12. Accessibility

- Every rail icon has an accessible name and visible tooltip.
- Active rail and list items are communicated independently of color.
- List selection supports keyboard navigation.
- Content headings identify both workspace and selected item.
- Status refreshes use polite live regions; lifecycle failures use assertive announcements only when necessary.
- Destructive or disruptive actions state their scope and require confirmation.
- The native tray uses meaningful labels rather than relying on dot color.

## 13. Verification requirements

Implementation verification must cover:

1. Rail order, bottom-pinned Settings/avatar, and active-state routing.
2. Every declared list row selecting the correct content route.
3. Responsive rail/list/content transitions.
4. User-card authenticated, unauthenticated, switching, and unavailable-Pod states.
5. Status snapshots for three healthy, starting, degraded, failed, and stopped services.
6. Network observed/configured state separation.
7. Pod-level persistence for AI Config and runtime capability gating.
8. Save-only versus save-and-rebuild index flows.
9. macOS template icon appearance in light and dark menu bars.
10. Tray menu contents and navigation for healthy, degraded, and stopped runtime states.
11. Legacy route redirects.
12. Full TypeScript build and repository integration suite.

## 14. Deferred decisions

The implementation plan must resolve these without expanding product scope:

- Whether Quit Xpod also stops the managed runtime or leaves it running.
- Exact mobile replacement for the icon rail.
- Which current backend controls are genuinely supported and may be exposed rather than shown as future capability.
- Route naming details and legacy redirect duration.

These decisions do not alter the approved information architecture.
