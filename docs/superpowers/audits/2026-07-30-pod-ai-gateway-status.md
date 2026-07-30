# Pod AI Gateway Status Audit

Date: 2026-07-30
Updated: 2026-07-31
Branch: `codex/xpod-light-settings`
Merged Gateway source: `codex/pod-ai-gateway` at `8d2284184dc3a5b1abf7330298b80396d3d0d48e`
Pre-merge HEAD: `3d1321c1ccf2427943d44b57f908fab71ec50576`
Merge-base: `e559dd520456bac3f6b5f8af47ce79f01fb70260`
Merge commit: `65d71e50`

## Summary

The Pod AI Gateway implementation from `codex/pod-ai-gateway` is integrated into the settings branch and Tasks 1-11 have code and test evidence. Tasks 12-13 are now marked complete from LinX lane evidence (`d5eae8cd`, `170cf6a6`, plus reviews) rather than Xpod-local code. Task 14 is partially complete: Xpod code, static build, focused Gateway tests, lite integration, Codex fixture smoke, and plaintext artifact scans passed, but full Docker-backed integration remains blocked by the unavailable Docker daemon. Task 15 has fixture Codex proof but remains unchecked because no real external Provider OAuth/API-key credential was connected.

## Verification Evidence

- `bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/api/ai-gateway/CredentialVault.test.ts tests/api/ai-gateway/GatewayApiKeyAuthenticator.test.ts tests/api/ai-gateway/ModelRouter.test.ts tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts tests/api/handlers/AiGatewayHandler.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/handlers/ChatHandlerGatewayScope.test.ts tests/integration/ChatHandler.integration.test.ts tests/integration/ChatKitHandler.integration.test.ts tests/integration/ChatKitAcpCliSmoke.integration.test.ts tests/integration/AiGatewayPodIsolation.integration.test.ts tests/integration/AiGatewayStreaming.integration.test.ts tests/api/container/GatewayInternalPodAccessConfig.test.ts tests/service/ChatKitAcpAuthEffect.service.test.ts tests/service/AcpThreadRuntime.service.test.ts` -> 17 files passed, 1 skipped; 158 tests passed, 3 skipped.
- `bun run test -- tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts tests/api/ai-gateway/CredentialVault.test.ts tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts tests/api/handlers/AiGatewayHandler.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/handlers/ChatHandlerGatewayScope.test.ts tests/service/VercelChatServiceConfig.test.ts tests/service/ChatKitAcpAuthEffect.service.test.ts` -> 9 files passed; 90 tests passed.
- `bun run test -- tests/integration/AiGatewayPodIsolation.integration.test.ts tests/integration/AiGatewayStreaming.integration.test.ts tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts tests/api/handlers/AiGatewayHandler.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/container/GatewayInternalPodAccessConfig.test.ts` -> 8 files passed; 90 tests passed. This run includes the new Task14 production Pod repository adapter isolation/A-B key coverage.
- `bun run build:ts` -> passed.
- `bun run build:components` -> passed; remaining output is package export warnings for dependencies.
- `bun run typecheck:test --pretty false` -> failed on existing non-Gateway test type debt. Current categories include script `import.meta` module config, old API handler/request mock typings, matrix/provision/runtime test mocks, edge/reachability tuple/init typings, RDF/quint test type drift, UI `.tsx` JSX config, and managed-agent service test fixture typings. No `src/api/ai-gateway/*`, `src/api/handlers/AiGateway*`, or `tests/integration/AiGateway*` type errors were introduced.
- `bun run test:integration:lite` -> passed with 19 files passed, 3 skipped; 101 tests passed, 5 skipped.
- `docker info` -> confirms Docker client is installed but server is unavailable: `dial unix /var/run/docker.sock: connect: no such file or directory`.
- `bun scripts/ai-gateway-codex-smoke.ts --fixture-codex-cli --report-dir .test-data/ai-gateway-codex-fixture` -> passed; Codex fixture reports streaming and tool-call runs, 3 Xpod responses, 3 upstream fixture requests, provenance from Gateway key to Pod SecretCell credential, and restore verified.
- `find .test-data logs local -type f | xargs rg -n "sk-task14-provider-secret-must-not-leak|xpod_gw_v1_cloud|sk-runtime-only|sk-pod-backed-secret|sk-aW50ZWdyYXRpb24tdGVzd|xpod_gw_v1_cloud_"` -> no matches.

## Task Status

### Task 1: Shared Credential resources

Status: Complete in `@undefineds.co/models` dependency.

Evidence:
- Current Xpod depends on `@undefineds.co/models@0.2.47`.
- Gateway credential tests exercise encrypted credential fields and Pod SecretCell storage via `tests/api/ai-gateway/CredentialVault.test.ts`, `tests/api/ai-gateway/SecretCellCredentialVault.test.ts`, and `tests/security/secret-cell/SecretCellVault.test.ts`.

Remaining:
- None for Xpod integration.

### Task 2: Gateway Access Key and Quota Snapshot resources

Status: Complete in `@undefineds.co/models` dependency and Xpod repository adapters.

Evidence:
- `tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts` uses `gatewayAccessKeyResource` and verifies opaque locators, Pod persistence, no plaintext storage, WebID isolation, deployment matching, and internal service Pod access.
- `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` verifies quota snapshot CRUD and Pod-scoped caching.

Remaining:
- None for Xpod integration.

### Task 3: Protocol-neutral gateway contract

Status: Complete.

Evidence:
- `src/api/ai-gateway/types.ts`, `errors.ts`, and protocol frontends exist for Responses, Anthropic Messages, and Chat Completions.
- `tests/api/ai-gateway/ProtocolFrontends.test.ts` passed and covers request/event mappings, tool arguments, reasoning, usage, and extension preservation.

Remaining:
- None found.

### Task 4: Generic Pod SecretCell encryption

Status: Complete.

Evidence:
- `src/security/secret-cell/*` and `src/api/ai-gateway/credentials/*` implement SecretCell and credential vaults.
- `tests/api/ai-gateway/CredentialVault.test.ts` passed and proves random DEKs/nonces, AAD binding, tamper failure, rewrap behavior, no serialized plaintext, log redaction, and buffer cleanup.
- `tests/security/secret-cell/SecretCellVault.test.ts` is present for the generic cell layer.

Remaining:
- None found.

### Task 5: Gateway API key authentication and management

Status: Complete by behavior.

Evidence:
- `tests/api/ai-gateway/GatewayApiKeyAuthenticator.test.ts`, `tests/api/ai-gateway/ClientCredentialsInternalPodAccessTokenProvider.test.ts`, and `tests/api/handlers/AiGatewayManagementHandler.test.ts` passed.
- Evidence covers key format, hash-only persistence, scopes, revocation, deployment mismatch, internal Bearer service access, DPoP caller fallback rejection, and management routes.

Remaining:
- None found.

### Task 6: Provider registry, routing and affinity

Status: Complete.

Evidence:
- `tests/api/ai-gateway/ModelRouter.test.ts` passed.
- Evidence covers five providers, aliases, exact models, default routing, disabled/reauth/quota filtering, failover, local/cloud deployment branching, WebID isolation, and HMAC affinity keys without raw identity or prompt material.

Remaining:
- None found.

### Task 7: Five provider runtime adapters

Status: Complete.

Evidence:
- `tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts` passed.
- Evidence covers OpenAI, Anthropic, Kimi, Bailian, and DeepSeek runtime adapters, streaming deltas, tool calls, reasoning, images, usage, 401/403/429 classification, cancellation, and secret redaction.

Remaining:
- Real upstream provider API smoke is not part of this completed unit contract and remains under Task 15.

### Task 8: Provider Connect lifecycle

Status: Complete by behavior despite file layout differences from the original plan.

Evidence:
- `src/api/ai-gateway/connect/index.ts` and management handler routes exist.
- `tests/api/ai-gateway/ProviderConnectAdapters.test.ts` passed.
- Evidence covers browser-assisted API key mode, Kimi device-code OAuth configuration, DeepSeek connectUnsupported reporting, signed state, expiry, one-time consumption, provider/deployment/WebID mismatch, refresh race handling, reauth-required state, revocation, and encrypted Pod writes.

Remaining:
- Real external browser OAuth with provider credentials is not proven here; retained under Task 15.

### Task 9: Quota snapshots

Status: Complete.

Evidence:
- `src/api/ai-gateway/quota/*` exists.
- `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` passed.
- Evidence covers Kimi/DeepSeek official balance parsing, OpenAI/Anthropic/Bailian unsupported state, 429 cooldown, stale snapshots, sanitized error caching, abort handling, in-flight dedupe, and WebID/deployment/provider/credential isolation.

Remaining:
- None found.

### Task 10: Gateway service and streaming HTTP handler

Status: Complete.

Evidence:
- `src/api/ai-gateway/AiGatewayService.ts` and `src/api/handlers/AiGatewayHandler.ts` exist and routes are registered through Chat routes.
- `tests/api/handlers/AiGatewayHandler.test.ts`, `tests/integration/AiGatewayStreaming.integration.test.ts`, `tests/integration/AiGatewayPodIsolation.integration.test.ts`, and `tests/integration/ChatHandler.integration.test.ts` passed.
- Evidence covers four protocol routes, non-streaming aggregation, SSE streaming, tool deltas, usage, cancellation, pre-stream failover, post-stream terminal errors, `/v1/models` filtering, and Pod isolation.

Remaining:
- None found.

### Task 11: Remove old provider branching from VercelChatService

Status: Complete.

Evidence:
- Old service files `src/api/service/chat-routing.ts`, `chat-protocol-adapters.ts`, and `ai-gateway-transport.ts` were removed by the Gateway merge.
- `tests/service/VercelChatServiceConfig.test.ts`, `tests/ai/AiProviderFallback.test.ts`, and ChatKit integration tests passed in focused/lite runs.
- Evidence proves `VercelChatService` delegates to `AiGatewayService`, defers stream execution until response start, aborts gateway iteration on cancel, lists Gateway models, and does not fall back to Pod/platform provider secrets.

Remaining:
- None found.

### Task 12: LinX current-identity management UI

Status: Complete from LinX lane evidence.

Evidence:
- LinX lane evidence records commit `d5eae8cd` plus review artifacts for current-identity Gateway management UI behavior.

Remaining:
- None for this Xpod audit; source lives outside this worktree.

### Task 13: Transactional client configurators

Status: Complete from LinX lane evidence.

Evidence:
- LinX lane evidence records commit `170cf6a6` plus review artifacts for transactional client configurators, backup, apply, verify, and restore safety.

Remaining:
- None for this Xpod audit; source lives outside this worktree.

### Task 14: Security, integration and full regression gates

Status: Partially complete; checked as partial in the plan.

Evidence:
- Security and integration fixtures exist and passed: `AiGatewayPodIsolation.integration.test.ts`, `AiGatewayStreaming.integration.test.ts`, credential vault tests, gateway key repository tests, internal Pod access tests, and ACP runtime secret-scrubbing tests.
- New Task14 coverage in `AiGatewayPodIsolation.integration.test.ts` proves Gateway execution through the production `PodConnectedCredentialRepository` adapter, two-WebID isolation, production `PodGatewayAccessKeyRepository` A/B key authentication, deployment mismatch, revocation, and no plaintext key/secret persistence.
- Lite integration passed with 101 tests and 5 skips.
- Secret/plaintext evidence: credential vault JSON/log checks do not contain fixture plaintext; Pod access key repository JSON does not contain issued plaintext or secret; `.test-data`, `logs`, and `local` scans found no Task14 fixture provider/key plaintext markers.
- Browser Bearer/DPoP fallback evidence: `PodGatewayAccessKeyRepository.test.ts` requires internal service Pod access and rejects replaying caller DPoP tokens; `ClientCredentialsInternalPodAccessTokenProvider.test.ts` rejects DPoP service token responses and only attaches internal Bearer.

Remaining:
- Full Docker-backed integration did not run because Docker daemon is unavailable on this machine.
- `bun run typecheck:test` still fails on non-Gateway test type debt outside this task.

### Task 15: Real Codex client product path

Status: Fixture-proven only; not complete.

Evidence:
- `scripts/ai-gateway-codex-smoke.ts --fixture-codex-cli` passed with Codex CLI `0.144.5`, streaming output `XPOD STREAM OK`, tool-call output `XPOD-CODEX-TOOL-FIXTURE`, provenance linking Gateway key `gak_codex_smoke` to Pod SecretCell credential IRI, no printed secret material, and restore verified.
- `tests/integration/ChatKitAcpCliSmoke.integration.test.ts` ran during lite integration and passed, but its real CLI assertions are best-effort and gated by installed CLI plus `AI_CONNECTION_API_KEY` / `AI_CONNECTION_BASE_URL`.

Remaining:
- Real external Provider OAuth/API-key connection through browser/API-key flow.
- Real Gateway key against a live Xpod process with a real encrypted Provider credential.
- Real Codex streaming and tool-call run through that live external Provider credential.
- LinX transactional Codex config apply/restore path.
