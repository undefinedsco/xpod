# Xpod Lightweight Settings Acceptance

This record maps the July 23 Gateway spec and July 30 lightweight settings spec to executable evidence. It intentionally marks external OAuth registration, real stored credentials, Docker, and real Codex as not complete unless the required environment gates are supplied. A default incomplete acceptance run exits non-zero.

## Commands

- `bun run settings:accept` exits non-zero until all mandatory gates are complete.
- `bun scripts/accept-xpod-settings.ts --allow-incomplete` is only for development reports; JSON still says `complete:false`.
- `bun run test -- tests/integration/XpodSettings.integration.test.ts`
- `bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`
- `bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/integration/AiGatewayStreaming.integration.test.ts`
- `bun run test -- tests/api/handlers/AiClientConfigurationHandler.test.ts`
- `XPOD_SETTINGS_E2E_BASE_URL=http://127.0.0.1:3000 bunx playwright test tests/e2e/xpod-settings.spec.ts`

Generated runtime evidence is written under `.test-data/acceptance/` and is not committed. Screenshots go under `.test-data/acceptance/screenshots/`.

## Requirement Map

| Requirement | Evidence | Status Rule |
| --- | --- | --- |
| Isolated real Xpod with two WebIDs/Pods | `tests/e2e/xpod-settings.spec.ts`; acceptance item `solid-pod-isolation` | Not complete until `XPOD_ACCEPTANCE_REAL_XPOD=true`, `XPOD_SETTINGS_E2E_BASE_URL`, `XPOD_SETTINGS_E2E_ALICE_STATE`, `XPOD_SETTINGS_E2E_BOB_STATE`, `XPOD_SETTINGS_E2E_ALICE_POD_URL`, and `XPOD_SETTINGS_E2E_TEST_API_KEY` are supplied. Once enabled, Playwright failure is `fail`. |
| API key persists for WebID A, absent for WebID B, plaintext absent from Pod | `tests/e2e/xpod-settings.spec.ts`; `scripts/accept-xpod-settings.ts` command gate | The E2E uses real browser state, UI save path, reload, authenticated Pod fetch, Bob isolation, and cleanup. |
| Models, Pod, Network, Services at desktop and narrow widths | `tests/e2e/xpod-settings.spec.ts`; `tests/ui/settings-launch.test.ts` | `XPOD_ACCEPTANCE_RUN_VISUAL=true` runs Playwright against a real host; missing env is `not_complete`, command failure is `fail`. |
| Header search, pane/back/focus contract | `tests/e2e/xpod-settings.spec.ts` narrow viewport test | Detail/back/focus assertions are mandatory when the spec runs. |
| Connect matrix OpenAI, Anthropic, Kimi, Bailian; DeepSeek unsupported | `tests/api/ai-gateway/ProviderConnectAdapters.test.ts` | Contract-backed local pass; missing real external OAuth registration is separately not complete. |
| Quota available/stale/unsupported | `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` | Contract-backed local pass; no invented quota percentage accepted. |
| Gateway `/v1/models`, Responses, Messages, Chat Completions | `tests/api/ai-gateway/ProtocolFrontends.test.ts`; `tests/integration/AiGatewayStreaming.integration.test.ts` | Local pass covers SSE, tool, usage, cancel/error protocol behavior. |
| Codex, Claude Code, Pi, CodeBuddy plan/apply/verify/restore | `tests/api/handlers/AiClientConfigurationHandler.test.ts` | Fixture-backed local pass; preserves unrelated config and restores without leaking secrets. |
| Real Codex streaming answer and tool call through Xpod | `scripts/ai-gateway-codex-smoke.ts --real-codex-cli`; acceptance item `real-codex` | Not complete unless `XPOD_ACCEPTANCE_RUN_CODEX=true`, the Xpod runtime was started with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`, `XPOD_ACCEPTANCE_XPOD_BASE_URL`, `XPOD_ACCEPTANCE_GATEWAY_KEY`, and existing stored provider credential are supplied. The Gateway key is passed via env/stdin, not a command argument; fixture mode is not accepted. Before launching Codex, the smoke calls the protected read-only `/v1/xpod/acceptance/provenance` endpoint with the Gateway key; the endpoint resolves the current principal and selected Pod credential metadata without opening or returning provider secret material. |
| Docker/full integration regression | `docker info && bun run test:integration` | Not complete unless `XPOD_ACCEPTANCE_RUN_DOCKER=true`; once enabled, either command failing is `fail`. |
| External OAuth/npm/Docker/credentials | `scripts/accept-xpod-settings.ts` status output | Missing env is `not_complete`; enabled gates must execute commands or validate a fresh schema `xpod.acceptance.evidence.v1` artifact with provenance hash, command, timestamp, and redaction checks. Artifact hashes are canonical SHA-256 over the artifact with `provenance.artifactHash` excluded; mismatches fail. |

## Evidence Format

`scripts/accept-xpod-settings.ts` writes:

- `.test-data/acceptance/xpod-light-settings-acceptance.json`
- `.test-data/acceptance/xpod-light-settings-acceptance.md`

Both outputs redact provider API keys, Gateway keys, OAuth codes, bearer tokens, and secret-like fields. Command-gate environment evidence records only allowlisted key names with `{ "present": true }`; environment values are never written to JSON or Markdown, even for non-sensitive names. The JSON summary uses `pass`, `skip`, `notComplete`, `fail`, `healthy`, `complete`, `allowIncomplete`, and `exitCode`; `not_complete` items are explicit gaps, not successful acceptance.

Real Codex evidence must include non-secret, cross-checkable provenance: `webId`, `gatewayKeyId`, server-derived `gatewayKeyFingerprint` (`sha256` of the authenticated Gateway bearer key), `credentialIriHash`, `secretCellRefHash`, `providerId`, `providerRouteSource: "pod-credential"`, `xpodBaseUrl`, `generatedAt`, `commandHash`, and `resultHash`. User-authored JSON that asserts credential source without the protected provenance lookup is rejected.

The acceptance provenance endpoint is disabled by default and is intended only for test/acceptance runtimes. Enable it with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`. Generate a dedicated Gateway key for product acceptance with `acceptance:read` plus the normal protocol scopes needed by the real Codex run (`models:read` and `inference:write`); do not reuse a default user key that lacks the acceptance scope.
