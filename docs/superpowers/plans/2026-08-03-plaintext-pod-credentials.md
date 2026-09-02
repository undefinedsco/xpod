# Plaintext Pod Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Connection persist and use API-key and browser-assisted credentials as `plaintext-v1` resources in the authenticated user's private hosted Pod, without SecretCell, locator encryption, or internal OIDC client credentials, while preserving strict owner/scope isolation and redaction.

**Architecture:** `@undefineds.co/models` remains the sole owner of the durable Credential RDF schema. Xpod authenticates and authorizes the caller, then accesses hosted private Pod resources through a narrow loopback-only CSS data channel signed with the runtime-generated gateway admin secret. Provider metadata and credential payloads remain separate; opaque Gateway Key locators are identifiers only, and legacy encrypted credentials fail closed.

**Tech Stack:** TypeScript, Bun, Vitest, Community Solid Server/Components.js, drizzle-solid, `@undefineds.co/models`, Node crypto, Awilix.

---

## Execution boundaries

Work in this order:

1. Change and release the shared contract from `/Users/ganlu/develop/models`.
2. Consume it from `/Users/ganlu/develop/xpod/.worktrees/production-startup-hotfix`.

Do not edit the dirty main Xpod checkout. Do not delete legacy encrypted schema fields in this release; readers need them to identify old records and return an explicit unsupported-storage-mode result.

### Task 1: Extend the authoritative Credential schema

**Files:**
- Modify: `/Users/ganlu/develop/models/src/namespaces.ts`
- Modify: `/Users/ganlu/develop/models/src/credential.schema.ts`
- Modify: `/Users/ganlu/develop/models/src/pod-storage-descriptor.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-runtime-schema.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/ai-gateway-schema.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/pod-storage-descriptor.test.ts`
- Modify: `/Users/ganlu/develop/models/tests/pod-secondary-resources.integration.test.ts`

- [ ] **Step 1: Add failing schema assertions**

Assert these exact predicates:

```ts
expect(predicateOf(credentialResource, 'storageMode')).toBe(UDFS.storageMode)
expect(predicateOf(credentialResource, 'secretPayload')).toBe(UDFS.secretPayload)
```

Descriptor tests must classify `secretPayload` as secret and `storageMode` as ordinary metadata. Retain legacy encrypted-field assertions for compatibility reads.

- [ ] **Step 2: Prove the red state**

Run:

```bash
cd /Users/ganlu/develop/models
yarn vitest run tests/ai-runtime-schema.test.ts tests/ai-gateway-schema.test.ts tests/pod-storage-descriptor.test.ts
```

Expected: missing-column/predicate failures for the two new fields.

- [ ] **Step 3: Add the fields**

Add namespace terms and:

```ts
export const CredentialStorageMode = {
  plaintextV1: 'plaintext-v1',
  secretCellV1: 'secret-cell-v1',
} as const

storageMode: string('storageMode').predicate(UDFS.storageMode),
secretPayload: string('secretPayload').predicate(UDFS.secretPayload),
```

Do not default `storageMode`: absence must remain distinguishable from an explicitly written plaintext record.

- [ ] **Step 4: Cover real Pod round trips**

Write a `plaintext-v1` test fixture through drizzle-solid, read it back, and assert exact JSON payload round-trip. Retain one encrypted fixture only to prove legacy rows remain detectable.

- [ ] **Step 5: Verify**

```bash
yarn vitest run tests/ai-runtime-schema.test.ts tests/ai-gateway-schema.test.ts tests/pod-storage-descriptor.test.ts tests/pod-secondary-resources.integration.test.ts
yarn test:ci
yarn build
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

Stage only listed files, inspect `git diff --cached`, and create a Lore commit:

```text
💾 Make interim Pod credential storage explicit

Credential resources need a distinguishable plaintext format while the final SecretCell ownership and rotation design remains deferred.

Constraint: Shared RDF semantics remain owned by @undefineds.co/models
Rejected: Reuse encryptedSecret for plaintext JSON | the name would misrepresent stored data
Confidence: high
Scope-risk: moderate
Directive: Do not remove legacy fields until an idempotent migration ships
Tested: schema, descriptor, Pod integration, CI suite, build
```

### Task 2: Release and consume models 0.2.48

**Files:**
- Modify: `/Users/ganlu/develop/models/package.json`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Bump models to `0.2.48`, build, and package**

```bash
cd /Users/ganlu/develop/models
yarn build
yarn pack:release
```

- [ ] **Step 2: Publish and verify the shared package**

Use the repository's established authenticated release command, then run:

```bash
npm view @undefineds.co/models@0.2.48 version
```

Expected: `0.2.48`. Publishing changes external state; if registry authority is unavailable, stop this task and do not update Xpod to an unpublished version.

- [ ] **Step 3: Update Xpod**

```bash
cd /Users/ganlu/develop/xpod/.worktrees/production-startup-hotfix
bun add @undefineds.co/models@0.2.48
bun run build:ts
```

Expected: dependency/lock resolve 0.2.48 and TypeScript exits 0.

- [ ] **Step 4: Commit version alignment separately**

Use one models release commit and one Xpod dependency commit. Both must include `Tested: build and package resolution`.

### Task 3: Add a loopback-only hosted Pod data channel to CSS

**Files:**
- Create: `src/http/InternalPodDataHttpHandler.ts`
- Modify: `src/index.ts`
- Modify: `config/xpod.base.json`
- Modify: `docs/COMPONENTS.md`
- Create: `tests/http/InternalPodDataHttpHandler.test.ts`
- Modify: `tests/runtime/XpodRuntime.integration.test.ts`

- [ ] **Step 1: Write authorization tests first**

Cover: missing/forged/expired/replayed marker returns 404; non-loopback transport returns 404; valid marker delegates an exact allowlisted resource to CSS `ResourceStore`; paths outside the owner's hosted Pod or AI Connection resources are rejected; bodies/logs never echo `secretPayload`.

Reuse `verifyGatewayAdminProxyHeaders` and the runtime-generated `XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET`. Add no OIDC client or new environment secret.

- [ ] **Step 2: Confirm failure**

```bash
bun run test -- tests/http/InternalPodDataHttpHandler.test.ts tests/runtime/XpodRuntime.integration.test.ts
```

Expected: missing handler/route failures.

- [ ] **Step 3: Implement the narrow protocol adapter**

Accept only GET, PUT, PATCH, DELETE for Credential, Provider, GatewayAccessKey, and QuotaSnapshot documents declared by models. Bind the signature to:

```ts
type InternalPodDataIntent = {
  ownerWebId: string
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE'
  resourceUrl: string
  principalKind: 'solid-user' | 'gateway-key'
  scopes: string[]
}
```

Verify loopback origin, owner, path, method, timestamp, and nonce before delegating to `ResourceStore`. The handler must not interpret payload JSON.

- [ ] **Step 4: Register and document it**

Export the component, add it to the CSS chain before public handling, regenerate Components.js metadata, and document its exact replacement/extension position.

- [ ] **Step 5: Verify and commit**

```bash
bun run build:components
bun run test -- tests/http/InternalPodDataHttpHandler.test.ts tests/runtime/XpodRuntime.integration.test.ts
bun run build:ts
```

Commit handler, registration, docs, and tests together. Record that a runtime-scoped capability replaces long-lived service OIDC credentials.

### Task 4: Wrap the CSS channel as a drizzle-solid fetch adapter

**Files:**
- Create: `src/api/ai-gateway/pod/HostedPodDataAccess.ts`
- Create: `tests/api/ai-gateway/HostedPodDataAccess.test.ts`
- Modify: `src/api/container/types.ts`
- Modify: `src/api/container/common.ts`
- Modify: `tests/api/container/config.test.ts`

- [ ] **Step 1: Add failing boundary tests**

Assert: Solid-user WebID must equal owner; Gateway-Key owner must equal owner and scopes must suffice; remote Pods are rejected; forwarded requests contain no browser Authorization/DPoP/cookies; only shared-model resource URLs are accepted.

- [ ] **Step 2: Implement `HostedPodDataAccess`**

Return a drizzle-solid-compatible fetch that calls CSS over loopback and signs a fresh intent. Strip caller `authorization`, `dpop`, `cookie`, and internal marker headers before adding the runtime marker.

- [ ] **Step 3: Register one singleton**

Add `hostedPodDataAccess` to `ApiContainerCradle`. Stop injecting `ClientCredentialsInternalPodAccessTokenProvider` into AI Connection. Leave that provider only for unrelated legacy consumers until separately migrated.

- [ ] **Step 4: Verify and commit**

```bash
bun run test -- tests/api/ai-gateway/HostedPodDataAccess.test.ts tests/api/container/config.test.ts
bun run build:ts
```

Expected: all exit 0.

### Task 5: Replace the encrypted record contract with plaintext-v1

**Files:**
- Create: `src/api/ai-gateway/credentials/PlaintextCredentialPayload.ts`
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/ai-gateway/AiGatewayService.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`
- Modify: `tests/api/ai-gateway/AiGatewayService.test.ts`
- Modify: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

- [ ] **Step 1: Rewrite tests around the new format**

New writes must contain:

```ts
{ storageMode: 'plaintext-v1', secretPayload: JSON.stringify({ apiKey: 'test-only-key' }) }
```

They must not write `encryptedSecret`, `wrappedDataKey`, or `encryptionAlgorithm`. Rows with legacy encryption fields or `secret-cell-v1` must throw `UnsupportedCredentialStorageModeError` before provider I/O.

- [ ] **Step 2: Confirm red tests**

```bash
bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts
```

- [ ] **Step 3: Implement a small codec**

```ts
export function encodePlaintextCredential(secret: ProviderSecret): string
export function decodePlaintextCredential(row: CredentialRow): ProviderSecret
```

Reject arrays, primitives, missing/unknown modes, and legacy encrypted rows. Errors mention only the storage mode, never payload content.

- [ ] **Step 4: Simplify consumers**

Replace `vault.seal/open/rewrap` with the codec; remove `rewrapCredential` ports. Write `storageMode`, `secretPayload`, metadata, and monotonic version only. Derive owner/deployment from the authorized repository call, not from secret JSON.

- [ ] **Step 5: Verify and commit**

Run the three focused tests plus `bun run build:ts`. Commit codec and consumers together, recording the accepted plaintext-at-rest constraint.

### Task 6: Enforce owner and scopes in every repository operation

**Files:**
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `src/api/handlers/AiGatewayHandler.ts`
- Modify: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`
- Modify: `tests/integration/AiGatewayPodIsolation.integration.test.ts`
- Modify: `tests/api/handlers/AiGatewayManagementHandler.test.ts`
- Modify: `tests/api/handlers/AiGatewayHandler.test.ts`

- [ ] **Step 1: Add failing isolation tests**

Interactive writes require the current WebID; service/node principals are rejected; inference requires a verified Gateway Key with owner match and model/protocol scopes; Alice's key cannot load Bob's credential; list/status output cannot represent `secretPayload`.

- [ ] **Step 2: Introduce one required access context**

```ts
type CredentialAccessContext =
  | { kind: 'solid-user'; webId: string }
  | { kind: 'gateway-key'; ownerWebId: string; keyId: string; scopes: readonly string[] }
```

Every repository method must validate it before requesting hosted-Pod data. Remove the optional-auth/service-identity fallback.

- [ ] **Step 3: Separate secret and summary reads**

Keep `getSecretCredential` internal to connect/inference/quota. Return a safe `CredentialSummary` from status/list methods rather than returning a full record and redacting later.

- [ ] **Step 4: Verify and commit**

```bash
bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/integration/AiGatewayPodIsolation.integration.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/handlers/AiGatewayHandler.test.ts
bun run build:ts
```

Expected: cross-owner/scope failures happen before Pod or provider I/O.

### Task 7: Remove mandatory SecretCell and locator keys from startup

**Files:**
- Modify: `src/api/ai-gateway/auth/GatewayKeyLocatorCodec.ts`
- Modify: `src/api/ai-gateway/auth/PodGatewayAccessKeyRepository.ts`
- Modify: `src/api/ai-gateway/routing/SessionAffinityStore.ts`
- Modify: `src/api/container/index.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/container/types.ts`
- Modify: `tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts`
- Modify: `tests/api/container/GatewayInternalPodAccessConfig.test.ts`
- Modify: `tests/api/container/config.test.ts`
- Modify: `tests/ui/settings-launch.test.ts`

- [ ] **Step 1: Add the startup regression**

Resolve API routes and AI Connection with all of these absent: `XPOD_SECRET_CELL_KEY`, `XPOD_SECRET_CELL_KEY_ID`, `XPOD_GATEWAY_LOCATOR_SECRET`, `XPOD_GATEWAY_INTERNAL_CLIENT_ID`, `XPOD_GATEWAY_INTERNAL_CLIENT_SECRET`.

Add locator tests: new keys use `gakv2.<random-id>`, expose no WebID/deployment, and authorize only after repository lookup and secret-hash verification.

- [ ] **Step 2: Implement opaque locators**

Issue `gakv2` with an `OpaqueGatewayKeyLocatorCodec`. Store owner in the GatewayAccessKey resource and resolve through the hosted-Pod locator index. Keep a read-only `gakv1` decoder only when an old locator secret is configured; its absence never blocks startup or new issuance.

- [ ] **Step 3: Decouple signing and affinity**

Use `XPOD_AI_GATEWAY_CONNECT_SIGNING_SECRET` when supplied; otherwise generate an ephemeral process key and document that pending connect attempts do not survive restart. Generate a separate ephemeral affinity salt when Redis is absent. Do not reuse provider credentials or locators as keys.

- [ ] **Step 4: Remove vault requirements**

Delete container checks requiring SecretCell and stop passing vaults to connect/inference/quota. Leave SecretCell implementation isolated for future migration, but unreachable from the interim production path.

- [ ] **Step 5: Verify and commit**

```bash
bun run test -- tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts tests/api/container/GatewayInternalPodAccessConfig.test.ts tests/api/container/config.test.ts tests/ui/settings-launch.test.ts
bun run build:ts
```

Commit with `Scope-risk: broad` and record exact legacy `gakv1` behavior.

### Task 8: Make redaction structural

**Files:**
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `src/api/handlers/PodSettingsHandler.ts`
- Modify: `src/api/ai-gateway/errors.ts`
- Modify: `src/logging/SecretRedaction.ts`
- Modify: `tests/api/handlers/AiGatewayManagementHandler.test.ts`
- Modify: `tests/api/handlers/PodSettingsHandler.test.ts`
- Create: `tests/security/AiCredentialRedaction.test.ts`
- Modify: `tests/e2e/xpod-settings.spec.ts`

- [ ] **Step 1: Add canary-secret coverage**

Submit unique canaries through API-key and browser-assisted flows. Scan management/settings responses, errors, logger arguments, metrics, traces, and Inngest bodies. No surface may contain the canary. Only a raw private Pod storage assertion may see `secretPayload`.

- [ ] **Step 2: Implement allowlisted DTOs and centralized redaction**

Safe DTO fields are provider, auth mode, status, label, scopes, expiry, health, and quota. Extend logging redaction for `secretPayload`, OAuth tokens, client secrets, API keys, and proxy credentials.

Normalize legacy records to:

```json
{ "code": "unsupported_credential_storage_mode", "storageMode": "secret-cell-v1" }
```

Never include the record or parser error.

- [ ] **Step 3: Update E2E expectations**

Raw private Credential data must contain `storageMode: plaintext-v1` and the submitted payload; all ordinary product endpoints must omit the payload and canary.

- [ ] **Step 4: Verify and commit**

```bash
bun run test -- tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/handlers/PodSettingsHandler.test.ts tests/security/AiCredentialRedaction.test.ts
bun run build:ts
```

### Task 9: Document interim risk and deferred migration

**Files:**
- Modify: `docs/credential-schema.md`
- Create: `docs/security/plaintext-pod-credentials.md`
- Modify: `docs/CONFIG_STRATEGY.md`
- Modify: `example.env`
- Modify: `docs/superpowers/specs/2026-08-03-plaintext-pod-credentials-design.md`

- [ ] **Step 1: Document behavior and risk**

State that ACL/ACP protects protocol access but storage/database compromise exposes plaintext credentials. Document hosted-Pod-only support, session lifetime, Gateway Key owner/scopes, and unsupported legacy records.

- [ ] **Step 2: Correct configuration guidance**

Mark SecretCell, locator-secret, and internal OIDC variables inactive for the interim AI Connection path. Keep variables still used by unrelated features documented there; do not delete them globally without usage evidence.

- [ ] **Step 3: Preserve the migration contract**

Document enumeration of `plaintext-v1`, seal/write/remove/verify, atomicity, and idempotent restart. State that root keys, per-Pod keys, recovery/rotation, local persistence, long-running delegation, and remote-Pod access require one later approved design.

- [ ] **Step 4: Verify and commit**

```bash
rg -n "XPOD_SECRET_CELL_KEY|XPOD_GATEWAY_LOCATOR_SECRET|XPOD_GATEWAY_INTERNAL_CLIENT" docs example.env
git diff --check
```

Review every match; none may claim those variables are required for interim AI Connection.

### Task 10: Full regression and production acceptance

**Files:**
- Modify if needed: `scripts/accept-xpod-settings.ts`
- Modify if needed: `scripts/ai-gateway-codex-smoke.ts`
- Modify: `docs/superpowers/audits/2026-07-30-pod-ai-gateway-status.md`

- [ ] **Step 1: Run builds and package tests**

```bash
bun run build:ts
bun run build:components
bun run test:packages
```

Expected: all exit 0.

- [ ] **Step 2: Run the required complete integration suite**

```bash
bun run test:integration
```

Expected: lite and full suites pass. If infrastructure prevents execution, record the exact blocker and do not claim completion.

- [ ] **Step 3: Run authenticated product acceptance**

Start without the five removed variables. Sign in as seeded Alice, save a test API key, reload, and verify connected status. Issue a scoped Gateway Key, call `/v1/models`, then one controlled `/v1/responses` fixture. Sign in as Bob and prove Alice's credential cannot be listed, changed, or invoked.

```bash
bun run settings:accept
bun run smoke:ai-connection:codex
```

Expected: both exit 0 and canary scan reports zero leaks.

- [ ] **Step 4: Verify the deployment health gate**

Run the production entrypoint/container check and prove deployment fails if CSS or API is unavailable, and succeeds only when both are healthy. This prevents a repeat of the v0.3.70 partial-start state.

- [ ] **Step 5: Update audit evidence**

Record exact commands, pass/skip counts, manual URLs, unsupported cases, and accepted plaintext risk. Do not mark remote Pods or encrypted migration complete.

- [ ] **Step 6: Final diff and secret scan**

```bash
git status --short
git diff --check
rg -n "sk-[A-Za-z0-9]|api[_-]?key" src tests docs config example.env
```

Inspect every match, stage only intended files, inspect `git diff --cached`, and create the final Lore commit with exact verification and remaining gaps.

## Completion criteria

- AI Connection writes only `plaintext-v1`.
- Legacy encrypted records fail closed.
- Startup needs no SecretCell, locator, or internal OIDC client credentials.
- The dedicated repository enforces owner/scope before private Pod access.
- API-key and browser-assisted entries persist real Pod data and survive reload.
- Gateway inference can use only the authenticated owner's authorized credential.
- APIs, logs, errors, metrics, traces, and events leak no secrets.
- Models CI/build, Xpod focused tests, package tests, TS/components builds, and full integration pass.
- Production deployment stays blocked unless both CSS and API are healthy.

## Accepted interim risks

- Hosted storage/database compromise exposes plaintext provider credentials.
- Remote third-party Solid Pods are unsupported.
- Ephemeral connect signing means in-progress attempts do not survive restart unless explicitly configured.
- Old encrypted credentials require re-entry until the later migration architecture ships.
