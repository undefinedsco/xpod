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

Generated runtime evidence is written under `.test-data/acceptance/` and is not committed. Screenshots go under `.test-data/acceptance/screenshots/`. Command gates launch child processes with a minimal allowlisted environment instead of inheriting the full shell environment.

## Requirement Map

| Requirement | Evidence | Status Rule |
| --- | --- | --- |
| Isolated real Xpod with two WebIDs/Pods | `tests/e2e/xpod-settings.spec.ts`; acceptance item `solid-pod-isolation` | Not complete until `XPOD_ACCEPTANCE_REAL_XPOD=true`, `XPOD_SETTINGS_E2E_BASE_URL`, `XPOD_SETTINGS_E2E_ALICE_STATE`, `XPOD_SETTINGS_E2E_BOB_STATE`, `XPOD_SETTINGS_E2E_ALICE_POD_URL`, and `XPOD_SETTINGS_E2E_TEST_API_KEY` are supplied. Once enabled, Playwright failure is `fail`. |
| API key persists for WebID A, absent for WebID B, plaintext absent from Pod | `tests/e2e/xpod-settings.spec.ts`; `scripts/accept-xpod-settings.ts` command gate | The E2E uses real browser state, UI save path, reload, authenticated Pod fetch, Bob isolation, and best-effort Alice credential cleanup from `finally`. |
| Models, Pod, Network, Services at desktop and narrow widths | `tests/e2e/xpod-settings.spec.ts`; `tests/ui/settings-launch.test.ts` | `XPOD_ACCEPTANCE_RUN_VISUAL=true` runs Playwright against a real host; missing env is `not_complete`, command failure is `fail`. |
| Header search, pane/back/focus contract | `tests/e2e/xpod-settings.spec.ts` narrow viewport test | Detail/back/focus assertions are mandatory when the spec runs. |
| Connect matrix OpenAI, Anthropic, Kimi, Bailian; DeepSeek unsupported | `tests/api/ai-gateway/ProviderConnectAdapters.test.ts` | Contract-backed local pass; missing real external OAuth registration is separately not complete. |
| Quota available/stale/unsupported | `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` | Contract-backed local pass; no invented quota percentage accepted. |
| Gateway `/v1/models`, Responses, Messages, Chat Completions | `tests/api/ai-gateway/ProtocolFrontends.test.ts`; `tests/integration/AiGatewayStreaming.integration.test.ts` | Local pass covers SSE, tool, usage, cancel/error protocol behavior. |
| Codex, Claude Code, Pi, CodeBuddy plan/apply/verify/restore | `tests/api/handlers/AiClientConfigurationHandler.test.ts` | Fixture-backed local pass; preserves unrelated config and restores without leaking secrets. |
| Real Codex streaming answer and tool call through Xpod | `scripts/ai-gateway-codex-smoke.ts --real-codex-cli`; acceptance item `real-codex` | Not complete unless `XPOD_ACCEPTANCE_RUN_CODEX=true`, the Xpod runtime was started with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`, `XPOD_ACCEPTANCE_XPOD_BASE_URL`, `XPOD_ACCEPTANCE_API_KEY`, and existing stored provider credential are supplied. `XPOD_ACCEPTANCE_API_KEY` must be a Solid client credentials wrapper in `sk-base64(client_id:client_secret)` form, not a raw provider key. The acceptance gate passes the API key to the smoke process through stdin, not a command argument or child environment; fixture mode is not accepted. The real Codex run must return `XPOD_REAL_STREAM_SENTINEL` from the stream path and `XPOD_REAL_TOOL_SENTINEL` from a tool-read path. Before launching Codex, the smoke calls the protected read-only `/v1/xpod/acceptance/provenance` endpoint with the API key; the endpoint resolves the current principal and selected Pod credential metadata without opening or returning provider secret material. |
| Docker/full integration regression | `docker info && bun run test:integration` | Not complete unless `XPOD_ACCEPTANCE_RUN_DOCKER=true`; once enabled, either command failing is `fail`. |
| External OAuth/npm/Docker/credentials | `scripts/accept-xpod-settings.ts` status output | Missing env is `not_complete`; enabled gates must execute commands or validate a fresh schema `xpod.acceptance.evidence.v1` artifact with provenance hash, command, timestamp, redaction checks, non-symlink realpath, and default containment under `.test-data/acceptance/`. Artifact hashes are canonical SHA-256 over the artifact with `provenance.artifactHash` excluded; mismatches fail. External evidence paths require `XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL=true`. |

## Evidence Format

`scripts/accept-xpod-settings.ts` writes:

- `.test-data/acceptance/xpod-light-settings-acceptance.json`
- `.test-data/acceptance/xpod-light-settings-acceptance.md`

Both outputs redact provider API keys, Solid client-credential API keys, OAuth codes, bearer tokens, and every environment value whose name contains secret/token/key/password/passwd/authorization/credential. Command-gate environment evidence records only allowlisted key names with `{ "present": true }`; environment values are never written to JSON or Markdown, even for non-sensitive names. The JSON summary uses `pass`, `skip`, `notComplete`, `fail`, `healthy`, `complete`, `allowIncomplete`, and `exitCode`; `not_complete` items are explicit gaps, not successful acceptance.

Command gates terminate on timeout deterministically: macOS/Linux runs use a detached process group, send `SIGTERM`, then escalate to `SIGKILL` after the kill grace window. Windows falls back to child-process termination. Timed-out results are reported as `timedOut:true` with a non-zero result and redacted stdout/stderr previews.

Real Codex evidence must include non-secret, cross-checkable provenance: `webId`, `authType`, optional `clientIdHash`, `credentialIriHash`, `credentialPayloadRefHash`, `providerId`, `providerRouteSource: "pod-credential"`, `xpodBaseUrl`, `generatedAt`, `commandHash`, and `resultHash`. User-authored JSON that asserts credential source without the protected provenance lookup is rejected.

The acceptance provenance endpoint is disabled by default and is intended only for test/acceptance runtimes. Enable it with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`. Generate a dedicated Solid client credential for product acceptance and pass it as `XPOD_ACCEPTANCE_API_KEY` in `sk-base64(client_id:client_secret)` form. Do not reuse a raw provider key. The endpoint reports non-sensitive provenance such as WebID, auth type, client id hash and Pod credential metadata so acceptance can verify the request is using the real Solid principal and a stored Pod credential.

OAuth evidence defaults to the acceptance evidence root `.test-data/acceptance/`. Use `XPOD_ACCEPTANCE_EVIDENCE_ROOT` only to move that root for a controlled local run. A symlink path is always rejected. A realpath outside the root is rejected unless `XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL=true` is set for an explicitly audited external artifact.
