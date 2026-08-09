# Caller-Owned AI Connections Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interactive AI Connections use the current Solid session and make coding clients use their owner-bound CSS client credentials, with no global Xpod service identity in the default path.

**Architecture:** Split the current monolithic management client into a host-owned drizzle-solid Pod store and a stateless server operations client. Standard `/v1/*` requests reuse the Bearer token produced by `ClientCredentialsAuthenticator`; durable task delegation remains outside this plan.

**Tech Stack:** TypeScript, React 19, `@inrupt/solid-client-authn-browser`, drizzle-solid, `@undefineds.co/models`, Bun, Vitest.

---

### Task 1: Make runtime seed configuration reliable

**Files:**
- Modify: `src/runtime/bootstrap.ts`
- Test: `tests/runtime/bootstrap.test.ts`

- [x] **Step 1: Write the failing runtime mapping test**

Assert that `buildRuntimeShorthand()` maps
`CSS_SEED_CONFIG=/workspace/config/seed.dev.json` to
`seedConfig=/workspace/config/seed.dev.json`.

- [x] **Step 2: Run the test and observe `seedConfig` is undefined**

Run: `bun test tests/runtime/bootstrap.test.ts`

- [x] **Step 3: Add the canonical ENV-to-shorthand mapping**

Add `['seedConfig', envValue('CSS_SEED_CONFIG')]` beside the other CSS
shorthand inputs in `buildRuntimeShorthand()`.

- [x] **Step 4: Verify runtime tests and TypeScript**

Run:

```bash
bun test tests/runtime/bootstrap.test.ts
bun run build:ts
```

Expected: 17 runtime tests pass and `tsc` exits zero.

### Task 2: Use caller-owned CSS client credentials for standard APIs

**Files:**
- Create: `src/api/ai-gateway/auth/CallerPodAccess.ts`
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/models/ProviderModelsService.ts`
- Modify: `src/api/ai-gateway/models/ProviderCustomModelsService.ts`
- Test: corresponding repository/service tests under `tests/api/ai-gateway/`

- [ ] **Step 1: Write owner/token boundary tests**

Cover four cases for a helper with signature:

```ts
createCallerPodFetch(owner: string, auth: AuthContext | undefined, fetchImpl?: typeof fetch): typeof fetch | undefined
```

Expected behavior:

- `viaApiKey + Bearer + accessToken + matching webId` adds that Bearer token;
- owner mismatch throws `caller_owner_mismatch`;
- DPoP returns/throws `caller_dpop_replay_unsupported`;
- browser auth without a reusable token returns undefined rather than selecting a global service identity.

- [ ] **Step 2: Run the new tests and observe missing caller fetch behavior**

Run the exact changed test files with `bun test` and confirm the expected red
assertions, not import or fixture errors.

- [ ] **Step 3: Implement `createCallerPodFetch` and thread `auth` through repositories**

Every `dbForOwner(owner, auth)` calls the helper first. A delegated provider may
only be selected when `auth` explicitly represents a future delegated task;
ordinary missing caller access throws `caller_pod_access_unavailable`.

- [ ] **Step 4: Pass request auth through model discovery and quota**

Add `auth?: AuthContext` to quota/model input contracts and pass
`request.auth` from `AiGatewayManagementHandler`. Ensure snapshot CRUD receives
the same auth context.

- [ ] **Step 5: Verify standard Gateway routes with the CSS wrapper**

Create test client credentials for one WebID, wrap them with
`sk-base64(client_id:client_secret)`, and assert `/v1/models` reaches the
owner's credential collection without `gatewayInternalPodAccess`.

### Task 3: Introduce the host-owned Pod store capability

**Files:**
- Modify: `packages/extension-sdk/src/web.ts`
- Create: `ui/src/extensions/XpodAiConnectionsPodStore.ts`
- Modify: `ui/src/extensions/ai-connections-host.ts`
- Test: `ui/src/extensions/XpodAiConnectionsPodStore.test.ts`
- Test: `packages/extension-sdk/test/web-permissions.test.ts`

- [ ] **Step 1: Define contract tests for independent credential rows**

Use a real/fake SolidDatabase compatible with drizzle-solid and prove:

- list returns two same-Provider credentials;
- create writes a `plaintext-v1` compatible credential row under `/settings/`;
- update uses expected version and exact id;
- delete/revoke affects only the requested id;
- provider summaries merge selected and unavailable models.

- [ ] **Step 2: Add `AiConnectionsPodStore` to host capabilities**

The interface contains list/create/update/delete/read-secret/model-selection
methods from the approved design. It does not expose the raw Session or generic
database to the Applet.

- [ ] **Step 3: Implement the Xpod adapter using model-owned ids and repositories**

Import schemas/repositories from `@undefineds.co/models`; use the database from
`runtime.currentPod.database`. Do not duplicate URI/id construction rules in
the Applet package.

- [ ] **Step 4: Mount the adapter only for a ready Pod**

`createXpodAiConnectionsHost()` supplies `aiConnectionsPodStore` when
`runtime.currentPod` exists. Anonymous/opening states omit it.

### Task 4: Remove service delegation from interactive controller flow

**Files:**
- Modify: `packages/ai-connections/src/controller.tsx`
- Modify: `packages/ai-connections/src/AiConnectionsMain.tsx`
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Modify: `ui/src/api/ai-connections.ts`
- Test: `packages/ai-connections/test/controller.test.tsx`
- Test: `packages/ai-connections/test/interactions.test.tsx`
- Test: `ui/src/api/ai-connections.test.ts`

- [ ] **Step 1: Write controller tests without a permission capability**

An authenticated ready Pod with `aiConnectionsPodStore` must load Provider
summaries and enable API Key actions without calling `getServiceAccess`,
`ensureAgentAccess` or minting an invocation key.

- [ ] **Step 2: Compose Pod store and stateless operations client**

Read/list/create/update/delete/model-selection methods use the Pod store.
OAuth/probe/quota/client-configuration calls use authenticated operations
endpoints. Remove `serviceAccessGranted` as an action gate.

- [ ] **Step 3: Replace the service-access banner**

The main pane reports Pod readiness/data errors only. It must not show
“服务访问未授权/已授权” during ordinary management.

- [ ] **Step 4: Remove interactive invocation bootstrap**

`createXpodAiConnectionsClient()` uses `runtime.fetch` for stateless operations;
it must not call `createServiceAccessGatewayFetch`. Retain any legacy helper only
for compatibility tests until Task 7 removal.

### Task 5: Add transient Provider operations

**Files:**
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `src/api/ai-gateway/models/ProviderModelsService.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Test: corresponding handler/service/package tests

- [ ] **Step 1: Write secret-safety tests**

Authenticated DPoP management requests may submit one transient Provider
credential to probe models/quota. Tests assert the secret is absent from
responses, thrown messages, logger calls and stored server state.

- [ ] **Step 2: Add credential-scoped probe inputs**

The browser reads a selected credential from its Pod store and sends:

```ts
{ offeringId, authMode, baseUrl, secret }
```

The handler validates Provider/Offering endpoint compatibility, invokes the
existing adapter and returns only discovery/quota output.

- [ ] **Step 3: Implement one-time OAuth credential handoff**

OAuth poll success returns a credential payload only once to the same owner and
attempt. A second poll returns completed-without-secret. The controller writes
the first payload to the Pod store and clears it from memory.

- [ ] **Step 4: Verify all five initial Providers and Offering validation**

Use deterministic upstream fixtures for OpenAI, Anthropic, Kimi, Bailian and
DeepSeek API-key paths; test Kimi device-code state transitions separately.

### Task 6: Replace opaque Gateway keys in the product

**Files:**
- Modify: `packages/ai-connections/src/AiConnectionsPanel.tsx`
- Modify: `packages/ai-connections/src/client-config/`
- Modify: `src/api/handlers/AiGatewayHandler.ts`
- Modify: `src/api/ai-gateway/AiGatewayService.ts`
- Test: package client-configuration tests and Gateway integration tests

- [ ] **Step 1: Change Client Access copy and input semantics**

The UI accepts/imports a CSS `client_id` and `client_secret`, formats them as
`sk-base64(...)`, and never calls `/api/ai/gateway/keys` to mint an `akv2` key.
The secret is displayed/copied once and is not persisted outside the user's
chosen client config.

- [ ] **Step 2: Accept `viaApiKey` principals on all four standard protocols**

The owner WebID comes from the token response. `/v1/models`, Responses, Chat
Completions and Messages use caller Pod access from Task 2.

- [ ] **Step 3: Add migration-only legacy handling**

Existing opaque keys may return a deprecation response or work only when an
explicit legacy configuration is enabled. Settings cannot create new ones.

- [ ] **Step 4: Verify Codex, Claude Code, Pi and CodeBuddy plans**

Plan/apply/verify/restore tests assert each generated client configuration uses
the Xpod standard endpoint and CSS wrapper.

### Task 7: Remove default service identity wiring and run acceptance

**Files:**
- Modify: `src/api/container/index.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/container/routes.ts`
- Modify: `packages/extension-sdk/src/solid-permissions.ts` only if dead exports can be narrowed
- Modify: `docs/ai-connections-capability-audit.md`
- Test: runtime/container/browser/integration suites

- [ ] **Step 1: Write container tests with both global variables absent**

Connections management and standard Gateway services resolve successfully;
`gatewayInternalPodAccess` is not required or injected into their repositories.

- [ ] **Step 2: Remove service-access/invocation from default AI Connections wiring**

Delete the ordinary UI route dependency and default container bindings. Keep
the generic SDK permission broker for other trusted Applets.

- [ ] **Step 3: Run built-product browser acceptance**

Use closed-auth Xpod with a fixed seed. Verify existing-Pod login, two API keys,
reload, exact edit/delete, model refresh/pick/unavailable projection and absence
of global service configuration.

- [ ] **Step 4: Run standard client acceptance**

With CSS client credentials for the same WebID, run `/v1/models` and one real
or deterministic streaming request for Responses, Chat and Messages. Run each
client config verifier.

- [ ] **Step 5: Run release regression**

```bash
bun run build
bun run --filter '@undefineds.co/ai-connections' test
bun run --filter '@undefineds.co/extension-sdk' test
bun run test:integration
```

Record exact counts, browser screenshots and redacted standard API commands in
the capability audit. Only then mark Connections accepted.
