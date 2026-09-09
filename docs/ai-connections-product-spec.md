# AI Connections Product Spec

> Status: Canonical product specification
>
> Date: 2026-08-24
>
> Scope: Xpod AI Connections product behavior, data ownership, package
> boundaries, and acceptance order.
>
> Authentication authority is defined by
> [Xpod Auth Authority Boundaries](superpowers/specs/2026-08-30-xpod-auth-authority-boundaries.md):
> AI Connections is a static WebID/Pod capability consumer and must not import
> or present CSS Account authentication.

This document is the current authority for AI Connections. Older specs,
implementation plans, audits, and acceptance matrices are evidence only. When
they conflict with this file, this file wins.

AI Connections is the user-facing control panel for connecting AI providers,
selecting usable models, issuing Xpod API Keys, and configuring local AI
clients. Xpod Gateway is the data plane exposed to clients.

## Product Principles

- One visible Xpod login path. Xpod uses WebID login as the product entry.
- Users should not need to understand WebID, Pod routing, Offering, Gateway, or
  service tokens to complete routine work.
- Provider setup and client setup are one product area, not two disconnected
  pages.
- AI Config is a separate top-level entry. It chooses which connected model is
  used by Xpod workloads such as chat, OCR, embedding, reader, and indexer.
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
| See available models | Refresh models from the connected provider and select models exposed through Xpod. |
| Use an AI client | Create an Xpod API Key and either apply a native client config or copy the correct config for that client. |
| Track usage | See usage grouped by Xpod API Key, with provider/model detail when available. |
| Disable access | Temporarily stop an API Key or provider credential without deleting history. |
| Delete stale records | Remove deleted API Keys from the visible list after successful deletion. |
| Recover from stale auth | Return to a useful login or reconnect state, never a raw callback or blank page. |

## Information Architecture

AI Connections is a top-level product entry. It is separate from AI Config,
Status, Network, and Settings.

```text
Rail
  AI Connections
    List
      API Keys
      Provider
        OpenAI
        Anthropic
        Kimi
        Bailian
        DeepSeek
        Zhipu AI
        Ollama
        Custom
    Content
      API Keys
      Provider detail
```

The list must not include a vague `All` item. The content title for the API Key
page is `API Keys`; the list row can also be `API Keys`.

Provider detail contains:

- current connection cards;
- provider-specific credential entry;
- OAuth/browser import only when the provider supports it;
- API key entry when the provider supports it;
- quota and usage only when supported or already observed;
- available models and selected models.

## Concept Boundaries

| Concept | Meaning | User-visible? | Durable owner |
| --- | --- | --- | --- |
| Provider | A company or compatible service family, such as OpenAI or Anthropic. | Yes | Shared catalog plus Pod records for user state. |
| Offering | A concrete way to access a Provider, such as API Platform, subscription, token plan, local daemon, or custom compatible endpoint. | Mostly hidden. Use plain labels when needed. | AI Connections package / Xpod. |
| Credential | A provider login, OAuth token, API Key, or local endpoint configuration. | Yes, as connection cards. | User Pod. |
| Model | A provider model resource. `ChatModel`, `EmbeddingModel`, and similar classes inherit from `AIModel`. | Yes | `@undefineds.co/models` for shared model semantics. |
| Capability | What a model can do, such as vision, OCR, tools, or structured output. | Only as eligibility/filtering hints. | `@undefineds.co/models`. |
| Product role | How Xpod uses a model, such as OCR, embedding, reader, indexer, or default chat. | Yes in AI Config, not AI Connections. | Xpod-owned config schema. |
| Xpod API Key | A key accepted by Xpod Gateway for local clients. It is not a provider key. | Yes | Xpod-owned Pod resource. |
| Client target | A local client config target, such as Codex, Claude Code, Pi, or CodeBuddy. | Yes | Local host adapter plus Xpod API Key metadata. |

Capabilities do not create new model subclasses. A vision-capable Qwen model is
still a chat model with a vision capability. OCR reader and indexer are product
roles, not reasons to call everything a chat model.

## Login And Session Model

The product has one visible login path: WebID login through the current Xpod.

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
3. On first activation, provisioning creates the account's Local Pod and saves
   its WebID-to-storage binding. Later logins only read the saved binding.
4. The final WebID and storage URL must bind to the local Xpod service
   provider, not to an arbitrary Cloud Pod.

Node registration at Xpod startup and per-account Pod activation are distinct:
startup registers the Local SP with Cloud; it cannot bind an account before a
WebID is known. The creation/binding operation is one-time, but the resulting
binding is durable. An expired provisioning handoff is not an expired login
session and must not invalidate an already-established binding.

If first activation reports success without saving this binding, that is a
provisioning bug. The UI may offer repair as an exceptional recovery action,
but ordinary login, refresh, and navigation must not create another Pod or make
manual repair a required step.

The local first-storage page is an automatic preparation state. It must not ask
for a Pod name, expose the generic CSS create-Pod form, or render a second card
inside the login surface. If preparation fails, show one concise recovery state
with Retry and keep technical details out of the default view.

The generated WebID and storage URL shown during local login should not surprise
the user with `localhost` when Cloud has assigned a service provider domain. The
SDK should resolve the optimal reachable path and still preserve the exact Pod
identity.

### Cloud-managed Local provision contract

A Cloud-managed Local Xpod is valid only when all of these facts are true:

- `/provision/status` on the Local Gateway reports `managed: true`,
  `registered: true`, the Cloud `oidcIssuer`, and the canonical managed `publicUrl`.
  A fresh `provisionCode` is required for first activation, not for restoring an
  already-bound identity.
- For first activation, the `provisionCode` includes the short-lived SP callback credential
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
- Cloud account pages use that provision scope when creating or looking up
  storage. They do not fall back to a generic localhost Pod and do not ask the
  user to choose a storage location in the Xpod product flow.
- The OIDC authorization parser must retain `provisionCode`, and the Account
  page must receive the current interaction's scope before registration or Pod
  preparation. A direct API test that supplies the code itself does not cover
  this Web handoff; fresh Web registration must also be tested end to end.
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

Xpod API Keys are created for Xpod Gateway. They are reusable across clients
unless the user chooses to label or apply them to a specific client.

The creation form has:

- name, required; prefill a sensible editable default so creation never depends
  on placeholder-only identity;
- apply-to target, optional;
- one primary button:
  - no target: `Create and copy config`;
  - with target: `Create and apply config`.

Selecting a client target changes the action semantics. It must not also require
the user to paste the same config manually. If the environment cannot write the
client config, the UI must say that before creation or fall back to copy mode.

Copy behavior must be client-specific. Codex, Claude Code, Pi, and CodeBuddy do
not share one universal environment variable block. The copy action should use
the selected client format or a clear generic Gateway format when no client is
selected.

Existing API Key rows are single-line, aligned rows:

- key name;
- redacted suffix;
- status chip;
- usage summary;
- applied client icons;
- action icons with tooltips.

Actions:

| State | Primary status style | Action |
| --- | --- | --- |
| Active | Active background | Stop icon disables the key. |
| Disabled | Disabled background | Play icon enables the key. |
| Deleted | Not shown after refresh | No row remains. |

Disable and enable are a pair. Delete is separate and removes the row after the
server confirms deletion.

## Secret Handling

Provider credentials and Xpod API Key material belong in the user's Pod when
they are durable product data.

The product may retain recoverable plaintext for Xpod API Keys when the explicit
goal is cross-device copy or client reconfiguration. If plaintext is not
available, the UI must say exactly what is missing and why. A vague message like
`this device cannot copy` is not enough when the source of truth is the Pod.

Provider API Keys must never be written into Codex, Claude Code, Pi, or
CodeBuddy. Local clients receive only Xpod Gateway endpoint plus Xpod API Key.

The shared `gatewayAccessKeyResource` remains the public, hash-only Gateway key
record. Recoverable Xpod API Key material is an Xpod product concern and is
stored in a separate Xpod-owned Pod companion resource; it must not weaken or
duplicate the shared model's `secretHash` contract. Provider credential records
are also separate and must never be reused as Gateway client keys.

### Web Management Contract

The Web UI uses the current authenticated WebID session for these management
requests. It never asks the user for a CSS Client ID or Client Secret:

| Method | Path | Meaning |
| --- | --- | --- |
| `GET` | `/api/ai/gateway/keys` | List non-deleted keys owned by the current WebID. |
| `POST` | `/api/ai/gateway/keys` | Create a named key and return its plaintext plus durable record. |
| `POST` | `/api/ai/gateway/keys/:id/reveal` | Recover plaintext from the Xpod-owned Pod companion resource. |
| `PATCH` | `/api/ai/gateway/keys/:id` | Enable or disable the exact key. |
| `DELETE` | `/api/ai/gateway/keys/:id` | Delete the exact key; it must not appear after reload. |

Create, reveal, enable, disable, and delete are owner-scoped operations. A
Bearer key accepted by `/v1/models` and `/v1/chat/completions` is the plaintext
created here, not a locally assembled `base64(client_id:client_secret)` value.

## Provider Detail UX

Provider setup must reflect real capability:

- `Import local OpenAI login` is only shown when the desktop/local environment
  can actually read and import an existing OpenAI login.
- Browser authorization opens the provider or account flow only when that flow
  is real.
- API Key setup stays available for providers that support API keys.
- Unsupported quota, OAuth, or subscription import must be explicit and quiet,
  not a broken button.

OpenAI subscription, OpenAI API Platform, provider API Keys, and Xpod API Keys
are different things. Labels must make that clear.

## Error And Loading UX

Errors should be written for users, with technical detail one click away.

Rules:

- Never mount the product shell behind the login gate.
- Never show two login cards for one login path.
- Account initialization uses the same compact `AuthSurface` dimensions as
  sign-in. Xpod passes its host mode explicitly: a browser shows one card,
  while the desktop login window is the surface itself. Loading must not fall
  back to the generic wide card or add its own size rules.
- Never leave `/auth/callback` or `/.account/*` as a blank page after failure.
- Never show raw stack traces in the list pane.
- Loading must have a timeout, a retry action, and the current authority it is
  waiting for.
- Stale OIDC client metadata should be cleared and re-registered automatically
  when the identity provider reports `unknown client`.
- A failed WebID restore should land on the remembered identity card with a
  reconnect action.
- A failed provider/API Key read should preserve the page and show a scoped
  inline error, not block unrelated providers.

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
- selected models;
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
2. Account verification and Pod creation complete without blank pages.
3. Exact local Pod binding is automatic after provisioning.
4. Cloud-managed Local uses a provision code with route credentials when direct
   public access is unavailable; no `localhost` WebID/storage fallback appears.
5. AI Connections loads from the optimal reachable Pod path while preserving the
   canonical Cloud WebID and Local SP storage identity.
6. Provider API Key can be saved to the Pod and reloaded.
7. Models can be refreshed and selected.
8. Xpod API Key can be created, listed, disabled, enabled, deleted, and copied
   or applied according to the selected client target.
9. `/v1/models` returns the selected model projection through Xpod Gateway.
10. `/v1/chat/completions` returns a real chat response through Xpod Gateway.

Desktop acceptance follows after the Web chain passes:

1. Red close hides the window and keeps tray plus owned services alive.
2. Reopen does not flash a login card while sessions are still valid.
3. Quit is explicit and does not masquerade as sign-out.
4. Tray icon is the shield mark with state overlay, not a blank square.
5. Native client apply works for supported clients and clearly falls back to
   copy for unsupported environments.

## Priority

P0:

- one WebID login path;
- automatic local Pod binding;
- AI Connections reads and writes Pod data;
- provider credential save and reload;
- Xpod API Key CRUD;
- client-specific copy/apply semantics;
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

Use this order when documents disagree:

1. This file.
2. Current implementation evidence from the running Xpod stack.
3. Current package READMEs and API docs.
4. Acceptance evidence.
5. Historical specs, plans, audits, and screenshots.

Any old document that describes another login path, another API Key model, or
another product IA must be treated as historical until updated.
