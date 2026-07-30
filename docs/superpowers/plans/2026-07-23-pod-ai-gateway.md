# Pod AI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pod-backed AI gateway defined in `docs/superpowers/specs/2026-07-23-pod-ai-gateway-design.md` and prove it with a real Codex streaming and tool-call connection.

**Architecture:** Refactor the existing Xpod chat routes into a protocol-neutral gateway core while preserving the current API surface. Shared durable semantics live in `@undefineds.co/models`; Xpod owns authentication, encryption, routing, provider transports, Connect and quota; LinX owns current-identity management UI and transactional client configuration.

**Tech Stack:** TypeScript 5.9, Bun, Vitest, drizzle-solid, `@undefineds.co/models`, Solid OIDC/DPoP, Web Crypto, generic Pod SecretCell, React, Electron/Tauri desktop bridge as provided by LinX.

---

## Repository and file map

The work spans three repositories and must be committed independently:

- `/Users/ganlu/develop/models`: durable RDF resources and repository helpers.
- `/Users/ganlu/develop/xpod`: gateway core, HTTP/API, encryption, provider adapters and server tests.
- `/Users/ganlu/develop/linx`: current-identity UI and coding-client configuration.

Preserve existing dirty changes in `models/src/ai-config/index.ts` and `models/tests/ai-config.test.ts`; execute in isolated worktrees and rebase/merge deliberately.

New Xpod files are grouped by responsibility under `src/api/ai-gateway/`; existing `VercelChatService` delegates to the new core and no longer owns protocol/provider branching.

## Phase A — shared Pod semantics

### Task 1: Extend shared Credential resources for encrypted gateway credentials

**Files:**
- Modify: `/Users/ganlu/develop/models/src/credential.schema.ts`
- Modify: `/Users/ganlu/develop/models/src/namespaces.ts`
- Modify: `/Users/ganlu/develop/models/src/index.ts`
- Modify: `/Users/ganlu/develop/models/src/schema.ts`
- Test: `/Users/ganlu/develop/models/tests/ai-runtime-schema.test.ts`
- Test: `/Users/ganlu/develop/models/tests/pod-secondary-resources.integration.test.ts`

- [ ] **Step 1: Add failing schema assertions**

Assert that `credentialResource` exposes `authMode`, `encryptedSecret`, `wrappedDataKey`, `encryptionAlgorithm`, `keyVersion`, `scopes`, `expiresAt`, `accountLabel`, `lastRefreshAt`, and `reauthRequired`, while retaining `apiKey` only for backward-compatible reads.

```ts
expect(credentialResource.authMode).toBeDefined();
expect(credentialResource.encryptedSecret).toBeDefined();
expect(credentialResource.wrappedDataKey).toBeDefined();
expect(credentialResource.provider.config.dataType).toBe('iri');
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd /Users/ganlu/develop/models && bun run test -- tests/ai-runtime-schema.test.ts tests/pod-secondary-resources.integration.test.ts`

Expected: FAIL because the encrypted credential columns do not exist.

- [ ] **Step 3: Add the resource fields without changing existing IDs**

Keep `credentials.ttl#{key}` and `/settings/` unchanged. Add typed literal/URI fields and exported enums:

```ts
export const ProviderAuthMode = {
  OAUTH: 'oauth', DEVICE_CODE: 'deviceCode', CONSOLE: 'console', API_KEY: 'apiKey',
} as const;

export const CredentialSecretAlgorithm = {
  AES_256_GCM: 'A256GCM',
} as const;
```

Use `udfs:` predicates in `namespaces.ts`; do not put provider-specific JSON into top-level predicates.

- [ ] **Step 4: Verify exact-ID and round-trip behavior**

Run the command from Step 2. Expected: PASS, including `findById('credentials.ttl#...')` and no unresolved resource templates.

- [ ] **Step 5: Commit the models change**

Stage only the schema/export/tests touched by this task and use a Lore commit whose intent is preserving encrypted user-owned credentials.

### Task 2: Add Gateway Access Key and Quota Snapshot resources

**Files:**
- Create: `/Users/ganlu/develop/models/src/ai-gateway.schema.ts`
- Modify: `/Users/ganlu/develop/models/src/schema.ts`
- Modify: `/Users/ganlu/develop/models/src/index.ts`
- Modify: `/Users/ganlu/develop/models/src/pod-storage-descriptor.ts`
- Create: `/Users/ganlu/develop/models/tests/ai-gateway-schema.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/pod-secondary-resources.integration.test.ts`

- [ ] **Step 1: Write failing resource and ID tests**

```ts
expect(gatewayAccessKeyResource.buildId({ id: 'key_1' }))
  .toBe('ai/gateway/access-keys.ttl#key_1');
expect(quotaSnapshotResource.buildId({ id: 'quota_1' }))
  .toBe('ai/gateway/quota.ttl#quota_1');
```

Assert `owner` and `credential` are URI relations, not `ownerId`/`credentialId` literals.

- [ ] **Step 2: Run and observe missing exports**

Run: `cd /Users/ganlu/develop/models && bun run test -- tests/ai-gateway-schema.test.ts`

Expected: FAIL on missing resources.

- [ ] **Step 3: Implement both control-primary resources**

`gatewayAccessKeyResource` stores owner, secret hash, deployment, scopes and lifecycle timestamps. `quotaSnapshotResource` stores credential URI, status (`available|unsupported|error`), balance, serialized normalized windows, `observedAt`, and `expiresAt`. Add descriptors and top-level exports.

- [ ] **Step 4: Add repository helpers**

Create `aiGatewayRepository.findAccessKeyById`, `revokeAccessKey`, `upsertQuotaSnapshot`, and `findFreshQuotaSnapshot`. Helpers accept canonical resource IDs/IRIs and hide URI construction from Xpod.

- [ ] **Step 5: Run schema and integration tests**

Run: `cd /Users/ganlu/develop/models && bun run test -- tests/ai-gateway-schema.test.ts tests/pod-secondary-resources.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the resources**

Use explicit `git add` paths and a Lore commit.

## Phase B — Xpod gateway foundation

### Task 3: Define the protocol-neutral gateway contract

**Files:**
- Create: `src/api/ai-gateway/types.ts`
- Create: `src/api/ai-gateway/errors.ts`
- Create: `src/api/ai-gateway/protocol/ResponsesFrontend.ts`
- Create: `src/api/ai-gateway/protocol/MessagesFrontend.ts`
- Create: `src/api/ai-gateway/protocol/ChatCompletionsFrontend.ts`
- Create: `src/api/ai-gateway/protocol/index.ts`
- Create: `tests/api/ai-gateway/ProtocolFrontends.test.ts`

- [ ] **Step 1: Write fixtures and failing parser/event tests**

Use captured request shapes for text, image, tool call argument deltas, reasoning effort and usage. Tests require the common contract:

```ts
export interface GatewayRequest {
  model: string;
  instructions?: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  reasoning?: { effort?: string; exposeSummary?: boolean };
  previousResponseId?: string;
  stream: boolean;
  protocolExtensions: Record<string, unknown>;
}

export type GatewayEvent =
  | { type: 'response.started'; id: string }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; callId: string; name: string }
  | { type: 'tool.arguments.delta'; callId: string; delta: string }
  | { type: 'tool.completed'; callId: string }
  | { type: 'usage'; usage: GatewayUsage }
  | { type: 'response.completed'; finishReason: string };
```

- [ ] **Step 2: Run and verify failure**

Run: `bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts`

Expected: FAIL because the frontends do not exist.

- [ ] **Step 3: Implement lossless parse/serialize frontends**

Preserve unsupported native fields under `protocolExtensions.responses`, `.anthropic`, or `.chatCompletions`. Validate completed tool argument JSON without buffering text deltas.

- [ ] **Step 4: Run focused tests**

Expected: PASS for all three request and event mappings.

- [ ] **Step 5: Commit the protocol contract**

Commit types, errors, frontends and fixtures together.

### Task 4: Implement generic Pod SecretCell envelope encryption

**Files:**
- Create: `src/api/ai-gateway/credentials/CredentialVault.ts`
- Create: `src/api/ai-gateway/credentials/SecretCellCredentialVault.ts`
- Create: `src/security/secret-cell/SecretCellVault.ts`
- Create: `src/security/secret-cell/DeploymentRootKeyProvider.ts`
- Create: `tests/api/ai-gateway/CredentialVault.test.ts`

- [ ] **Step 1: Write failing envelope round-trip and rotation tests**

Assert unique random DEKs/nonces, AES-256-GCM authentication failure on tamper, AAD binding to WebID + credential IRI + provider, and rewrap without ciphertext change.

- [ ] **Step 2: Run focused tests**

Run: `bun run test -- tests/api/ai-gateway/CredentialVault.test.ts`

Expected: FAIL on missing vault.

- [ ] **Step 3: Implement the interface**

```ts
export interface CredentialVault {
  seal(principal: GatewayPrincipal, credentialIri: string, provider: string,
       secret: ProviderSecret): Promise<EncryptedCredentialSecret>;
  open(principal: GatewayPrincipal, credentialIri: string, provider: string,
       encrypted: EncryptedCredentialSecret): Promise<ProviderSecret>;
  rewrap(principal: GatewayPrincipal, encrypted: EncryptedCredentialSecret):
       Promise<EncryptedCredentialSecret>;
}
```

Use Web Crypto for DEK generation and AES-GCM. A generic SecretCell binds each
cell to owner WebID, resource IRI, predicate/field, schema version and purpose.
Xpod operations inject an active deployment root key plus previous keys for
rotation. `SecretCellCredentialVault` adapts the generic cell envelope to the
existing Pod credential record fields; AI Connection never observes or selects
deployment. Do not add Keychain or KMS-specific production branches.

- [ ] **Step 4: Verify tests and secret-redaction assertions**

Expected: PASS; serialized errors and logger spies contain no plaintext.

- [ ] **Step 5: Commit the vault**

### Task 5: Add Gateway API Key authentication and management

**Files:**
- Create: `src/api/ai-gateway/auth/GatewayPrincipal.ts`
- Create: `src/api/ai-gateway/auth/GatewayApiKey.ts`
- Create: `src/api/ai-gateway/auth/GatewayApiKeyAuthenticator.ts`
- Modify: `src/api/auth/MultiAuthenticator.ts`
- Create: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `src/api/container/routes.ts`
- Modify: `src/api/container/main.ts`
- Create: `tests/api/ai-gateway/GatewayApiKeyAuthenticator.test.ts`
- Create: `tests/api/handlers/AiGatewayManagementHandler.test.ts`

- [ ] **Step 1: Write failing key-format, hash, scope and deployment tests**

The public format must carry version, deployment and opaque key ID but no Provider secret. Test Local/Cloud mismatch, expiry, revocation and constant-time secret verification.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `bun run test -- tests/api/ai-gateway/GatewayApiKeyAuthenticator.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts`

- [ ] **Step 3: Implement key creation and authentication**

Use a memory-hard or repository-approved hash primitive already available in the runtime; do not add a dependency. Return plaintext once from `POST /api/ai/gateway/keys`, persist only the hash, and support list/revoke routes.

- [ ] **Step 4: Register the authenticator after Solid/service auth but before legacy client-credential fallback**

Return an `AuthContext` carrying WebID and scopes so existing `ApiServer` route dispatch remains reusable.

- [ ] **Step 5: Verify tests and commit**

## Phase C — routing and providers

### Task 6: Implement Provider Registry, model routing and session affinity

**Files:**
- Create: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Create: `src/api/ai-gateway/routing/ModelRouter.ts`
- Create: `src/api/ai-gateway/routing/SessionAffinityStore.ts`
- Create: `src/api/ai-gateway/routing/InMemorySessionAffinityStore.ts`
- Create: `src/api/ai-gateway/routing/RedisSessionAffinityStore.ts`
- Modify: `src/api/service/provider-registry.ts`
- Test: `tests/api/ai-gateway/ModelRouter.test.ts`

- [ ] **Step 1: Write routing precedence and isolation tests**

Cover alias, explicit `provider/model`, exact model, default provider/model, disabled credentials, quota/cooldown, explicit credential and WebID-scoped affinity.

- [ ] **Step 2: Run and observe failure**

Run: `bun run test -- tests/api/ai-gateway/ModelRouter.test.ts`

- [ ] **Step 3: Implement capability descriptors**

Seed OpenAI, Anthropic, Kimi, Bailian and DeepSeek with auth modes, protocols, safe endpoints and capability flags. Merge dynamic model discovery without allowing discovered metadata to change credential destinations.

- [ ] **Step 4: Implement routing and affinity**

Only fail over before any client event is emitted. Key affinity by deployment + WebID hash + conversation identity; never by raw prompt.

- [ ] **Step 5: Run tests and commit**

### Task 7: Implement the five Provider Runtime Adapters

**Files:**
- Create: `src/api/ai-gateway/providers/ProviderRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/OpenAiRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/AnthropicRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/OpenAiCompatibleRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/KimiRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/BailianRuntimeAdapter.ts`
- Create: `src/api/ai-gateway/providers/DeepSeekRuntimeAdapter.ts`
- Modify: `src/api/service/provider-http-transport.ts`
- Create: `tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts`

- [ ] **Step 1: Write MSW/fetch-fixture contract tests**

For each provider assert request URL, auth header, streaming deltas, tools, reasoning, images, usage, 401/403/429 classification, cancellation and secret redaction. Bailian tests cover standard vs Coding Plan endpoints; DeepSeek tests preserve `reasoning_content` replay.

- [ ] **Step 2: Run and verify all adapters are missing**

Run: `bun run test -- tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts`

- [ ] **Step 3: Implement shared streaming transport and native adapters**

`ProviderRuntimeAdapter.execute()` returns `AsyncIterable<GatewayEvent>`. OpenAI Responses and Anthropic Messages preserve native fields; compatible adapters translate Chat Completions SSE incrementally.

- [ ] **Step 4: Implement provider-specific policies**

Kimi and Bailian select registered regional endpoints. DeepSeek rejects developer-role/tool-choice shapes it does not support and maps reasoning effort according to the live registry. Do not hardcode deprecated model names as defaults.

- [ ] **Step 5: Run adapter tests and commit**

### Task 8: Implement Connect lifecycle for OpenAI, Anthropic, Kimi, Bailian and DeepSeek capability reporting

**Files:**
- Create: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Create: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`

- [ ] **Step 1: Capture official/opencodex-compatible authorization fixtures and write failing tests**

Do not reuse OpenAI Codex, Claude Code, or official CLI client ids and do not scrape cookies. Kimi uses official Kimi Code device-code OAuth with an Xpod/Moonshot-issued client id and exact endpoints `https://auth.kimi.com/api/oauth/device_authorization` plus `/api/oauth/token`; missing client id must report `configured=false` rather than fake availability. OpenAI, Anthropic and Bailian use `browserAssistedApiKey`: LinX opens the official console/dashboard and the current authenticated WebID submits the API key through Xpod management API. This mode must not be labeled OAuth. Test state/signature binding, PKCE only where OAuth applies, five-minute expiry, one-time consumption, callback/WebID/deployment/provider mismatch, token refresh version races, reauth-required state and revocation. DeepSeek must report `connectUnsupported` while keeping authenticated API key management available.

- [ ] **Step 2: Run and verify failure**

Run: `bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts`

- [ ] **Step 3: Implement ConnectAttempt and adapters**

Use provider-specific official device-code endpoints and console URLs only. Do not scrape cookies, do not persist authorization codes, and do not accept API keys on public callbacks. Encrypt the completed secret through `CredentialVault.seal()` before writing the Pod via a narrow Pod credential repository port.

- [ ] **Step 4: Add management routes**

Register begin, callback/poll, status, refresh and disconnect routes. Callback routes are public only for the signed one-time attempt; all other routes require Solid/current-identity management auth.

- [ ] **Step 5: Verify contract tests and commit**

### Task 9: Implement quota snapshots

**Files:**
- Create: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Create: `src/api/ai-gateway/quota/OpenAiQuotaAdapter.ts`
- Create: `src/api/ai-gateway/quota/AnthropicQuotaAdapter.ts`
- Create: `src/api/ai-gateway/quota/KimiQuotaAdapter.ts`
- Create: `src/api/ai-gateway/quota/BailianQuotaAdapter.ts`
- Create: `src/api/ai-gateway/quota/DeepSeekQuotaAdapter.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Create: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

- [ ] **Step 1: Write supported, stale and unsupported tests**

Fixtures must prove that missing official data produces `unsupported`, never an invented percentage, and 429 produces cooldown rather than remaining quota.

- [ ] **Step 2: Implement normalized snapshots and Pod caching**

Normalize provider windows to `{ name, used?, limit?, remaining?, resetsAt? }`; store `observedAt`, `expiresAt`, source and status via `aiGatewayRepository`.

- [ ] **Step 3: Run tests and commit**

## Phase D — HTTP integration and migration

### Task 10: Build the Gateway service and streaming HTTP handler

**Files:**
- Create: `src/api/ai-gateway/AiGatewayService.ts`
- Create: `src/api/handlers/AiGatewayHandler.ts`
- Modify: `src/api/handlers/ChatHandler.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/container/routes.ts`
- Create: `tests/api/handlers/AiGatewayHandler.test.ts`
- Modify: `tests/integration/ChatHandler.integration.test.ts`

- [ ] **Step 1: Write end-to-end handler tests with fake adapters**

Cover all four routes, non-streaming aggregation, streaming SSE, tool deltas, usage, cancellation, pre-stream failover, post-stream terminal errors and `GET /v1/models` WebID filtering.

- [ ] **Step 2: Run and verify failure**

Run: `bun run test -- tests/api/handlers/AiGatewayHandler.test.ts tests/integration/ChatHandler.integration.test.ts`

- [ ] **Step 3: Implement service orchestration**

Authenticate, parse, route, open Credential through the vault, execute adapter, serialize events and record health without exposing the secret to handler code.

- [ ] **Step 4: Replace route internals, preserving URLs**

`registerChatRoutes` delegates `/v1/responses`, `/v1/messages`, `/v1/chat/completions`, and `/v1/models` to `AiGatewayHandler`. Do not add parallel versioned routes.

- [ ] **Step 5: Run tests and commit**

### Task 11: Remove the old provider branching from VercelChatService

**Files:**
- Modify: `src/api/service/VercelChatService.ts`
- Modify: `src/api/service/chat-routing.ts`
- Modify: `src/api/service/chat-protocol-adapters.ts`
- Modify: `src/api/service/ai-gateway-transport.ts`
- Modify: `tests/service/VercelChatServiceConfig.test.ts`
- Modify: `tests/ai/AiProviderFallback.test.ts`

- [ ] **Step 1: Add regression tests locking public behavior**

Prove ChatKit/internal callers still reach the same gateway service and usage accounting, without platform-level Provider/API-key fallback.

- [ ] **Step 2: Delete duplicate protocol/provider decisions**

Retain only ChatKit orchestration in `VercelChatService`; delete direct `/responses` and `/messages` upstream calls and fallback converters now owned by frontends/adapters.

- [ ] **Step 3: Run focused and type tests**

Run: `bun run test -- tests/service/VercelChatServiceConfig.test.ts tests/ai/AiProviderFallback.test.ts && bun run build:ts`

Expected: PASS.

- [ ] **Step 4: Commit the migration**

## Phase E — LinX current-identity management

### Task 12: Add the current-identity Gateway management client and UI

**Files:**
- Create: `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/services/ai-gateway-client.ts`
- Modify: `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/hooks/useModelServices.ts`
- Modify: `/Users/ganlu/develop/linx/apps/web/src/modules/model-services/types.ts`
- Modify: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/SettingsContentPane.tsx`
- Create: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/AiGatewaySettings.tsx`
- Create: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/AiProviderCard.tsx`
- Create: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/AiQuotaCard.tsx`
- Test: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/AiGatewaySettings.test.tsx`

- [ ] **Step 1: Write failing current-session UI tests**

Mock one current WebID at a time. Assert that only its Gateway endpoint, Providers, Connect attempts, keys and quota are visible; no simultaneous Local/Cloud selector exists.

- [ ] **Step 2: Implement the authenticated management client**

Derive the API base from the current session using `resolveCurrentPodBaseUrl`/existing LinX client URL helpers. Reuse authenticated fetch; never accept an arbitrary Pod URL from form input.

- [ ] **Step 3: Implement Provider Connect/API Key and quota UI**

Open system browser for Connect, poll attempt status, mask account identity, expose refresh/disconnect, show `unsupported` explicitly and never render secret payloads after creation.

- [ ] **Step 4: Run LinX web tests and commit in the LinX repo**

Use the repository's existing Bun test command discovered from `apps/web/package.json`; expected: focused tests PASS.

### Task 13: Implement transactional client configurators

**Files:**
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/types.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/transaction.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/codex.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/claude-code.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/pi.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/codebuddy.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/index.ts`
- Create: `/Users/ganlu/develop/linx/apps/desktop/src/lib/ai-client-config/ai-client-config.test.ts`
- Modify: `/Users/ganlu/develop/linx/apps/web/src/modules/settings/components/AiGatewaySettings.tsx`

- [ ] **Step 1: Write fixture-based merge/restore tests for all four clients**

For each native config fixture assert detection, dry-run diff, timestamped backup, merge-only `xpod` fields, current-WebID replacement, permissions, syntax verification, rollback and restore without touching non-Xpod settings. Add symlink rejection tests.

- [ ] **Step 2: Implement a shared transaction**

```ts
export interface ClientConfigAdapter {
  detect(): Promise<ClientDetection>;
  inspect(): Promise<ClientConfigSnapshot>;
  plan(input: CurrentGatewayConfig): Promise<ClientConfigPlan>;
  apply(plan: ClientConfigPlan): Promise<ClientConfigResult>;
  verify(): Promise<ClientVerification>;
  restore(backupId: string): Promise<void>;
}
```

Write to a same-directory temporary file, fsync, atomically rename, verify, and rollback on failure. Use native secret storage/environment references when supported; otherwise require explicit UI consent and mode `0600`.

- [ ] **Step 3: Implement native format adapters**

Preserve existing Codex TOML, Claude settings/env, Pi model configuration and CodeBuddy configuration. The adapter owns only the stable `xpod` provider and records the WebID hash needed for safe replacement.

- [ ] **Step 4: Add UI dry-run, apply and restore actions**

The UI shows exact affected client/files, never Provider Credential values.

- [ ] **Step 5: Run desktop/web focused tests and commit in LinX**

## Phase F — verification and real Codex acceptance

### Task 14: Security, integration and full regression gates

**Files:**
- Create: `tests/integration/AiGatewayPodIsolation.integration.test.ts`
- Create: `tests/integration/AiGatewayStreaming.integration.test.ts`
- Create: `scripts/ai-gateway-codex-smoke.ts`
- Modify: `package.json`

- [ ] **Step 1: Add two-WebID isolation and plaintext scans**

Prove Key A cannot read/use WebID B credentials, Local keys fail against Cloud, revoked keys fail, and Pod/log/test artifacts do not contain fixture plaintext secrets.

- [ ] **Step 2: Add streaming integration fixtures**

Run one native Responses adapter and one converted adapter through HTTP; verify ordered SSE, tools, reasoning usage, cancellation and no post-stream replay.

- [ ] **Step 3: Run focused integration and static gates**

Run:

```bash
bun run build:ts
bun run typecheck:test
bun run test -- tests/api/ai-gateway tests/api/handlers/AiGatewayHandler.test.ts
bun run test -- tests/integration/AiGatewayPodIsolation.integration.test.ts tests/integration/AiGatewayStreaming.integration.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 4: Run mandatory full integration regression**

Run: `bun run test:integration`

Expected: lite and full integration suites exit 0. If environment credentials are stale, repair the fixture credentials and rerun; do not waive the gate.

- [ ] **Step 5: Commit test infrastructure**

### Task 15: Connect a real Codex client and prove the product path

**Files:**
- Use: `scripts/ai-gateway-codex-smoke.ts`
- Write runtime evidence under: `.test-data/ai-gateway-codex/`

- [ ] **Step 1: Start Xpod with a dedicated test WebID and Pod**

Use `.test-data/ai-gateway-codex/` for all runtime files. Connect one real Provider through the implemented browser flow or API Key flow, then confirm the Pod contains ciphertext and no plaintext.

- [ ] **Step 2: Create a scoped Gateway Key and configure Codex through the LinX adapter**

Run the adapter dry-run, apply and verify. Inspect the resulting Codex provider entry and confirm it points at Xpod, not the upstream Provider.

- [ ] **Step 3: Run a real streaming answer**

Invoke the installed Codex CLI with the `xpod` provider and a deterministic prompt. Capture sanitized event timestamps and assert more than one output delta before completion.

- [ ] **Step 4: Run a real tool-call task**

Give Codex a disposable workspace and a task that requires reading a fixture file with an allowed tool. Assert the Gateway observed the tool call lifecycle and Codex returned the fixture-derived answer.

- [ ] **Step 5: Prove identity and credential provenance**

Correlate the request's Gateway key ID, WebID and encrypted Provider Credential IRI. Evidence must show the current WebID's Pod credential was used and no server-default credential exists in the path.

- [ ] **Step 6: Restore Codex config and clean temporary services**

Use the LinX adapter restore operation. Keep only sanitized reports under `.test-data/ai-gateway-codex/`; tests clean credentials and temporary databases in `afterAll`.

- [ ] **Step 7: Run the final completion audit**

Check every requirement in the design against code, tests and runtime evidence. Rerun `bun run build:ts` and `bun run test:integration` immediately before the final report. Do not mark complete if any Provider auth mode, protocol, client adapter, quota state or real Codex assertion lacks evidence.
