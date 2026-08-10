# Xpod Lightweight Settings Acceptance

This record maps the July 23 Gateway spec and July 30 lightweight settings spec to executable evidence. It intentionally marks external OAuth registration, real stored credentials, Docker, and real Codex as not complete unless the required environment gates are supplied. A default incomplete acceptance run exits non-zero.

## Commands

- `bun run settings:accept` exits non-zero until all mandatory gates are complete.
- `bun scripts/accept-xpod-settings.ts --allow-incomplete` is only for development reports; JSON still says `complete:false`.
- `bun run test -- tests/integration/XpodSettings.integration.test.ts`
- `bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`
- `bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/integration/AiGatewayStreaming.integration.test.ts`
- `bun run test -- tests/api/handlers/AiClientConfigurationHandler.test.ts`
- `bun run ai-connections:accept:browser`
- `KIMI_API_KEY=... DEEPSEEK_API_KEY=... bun run ai-connections:accept:live` (real upstream and coding-client matrix; secrets stay process-local)

Generated runtime evidence is written under `.test-data/acceptance/` and is not committed. Screenshots go under `.test-data/acceptance/screenshots/`. Command gates launch child processes with a minimal allowlisted environment instead of inheriting the full shell environment.

## Requirement Map

| Requirement | Evidence | Status Rule |
| --- | --- | --- |
| Isolated real Xpod with two WebIDs/Pods | `tests/e2e/xpod-settings.spec.ts`; acceptance item `solid-pod-isolation` | The hermetic spec starts a temporary Xpod, creates two password accounts and Pods, and performs both OIDC login/consent flows itself. `XPOD_ACCEPTANCE_REAL_XPOD=true` enables the harness gate; no pre-generated browser state or test credential environment variables are accepted. |
| API key persists for WebID A and remains absent for WebID B | `tests/e2e/xpod-settings.spec.ts`; `scripts/accept-xpod-settings.ts` command gate | The E2E uses the real UI save/reload path, reads the Pod through drizzle-solid, proves the reversible secret round-trip, verifies the hermetic upstream rejects anonymous discovery and accepts both saved Bearers, and proves Bob cannot see Alice's resource. The current envelope is explicitly `PLAINTEXT` plus base64 encoding, not at-rest encryption. |
| Models, Pod, Network, Services at desktop and narrow widths | `tests/e2e/xpod-settings.spec.ts`; `tests/ui/settings-launch.test.ts` | `bun run ai-connections:accept:browser` builds the shared packages and UI, then runs Playwright against the temporary real Xpod. `XPOD_ACCEPTANCE_RUN_VISUAL=true` enables the same hermetic spec through the broader acceptance harness. |
| Header search, pane/back/focus contract | `tests/e2e/xpod-settings.spec.ts` narrow viewport test | Detail/back/focus assertions are mandatory when the spec runs. |
| Connect matrix OpenAI, Anthropic, Kimi, Bailian, DeepSeek | `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`; `docs/acceptance/ai-connections-product-matrix.md` | Contract-backed local pass for all supported offerings. DeepSeek API Platform is supported by API key and was live-accepted in the AI Connections matrix; missing real external OAuth registration remains separately not complete. |
| Quota available/stale/unsupported | `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` | Contract-backed local pass; no invented quota percentage accepted. |
| Gateway `/v1/models`, Responses, Messages, Chat Completions | `tests/api/ai-gateway/ProtocolFrontends.test.ts`; `tests/integration/AiGatewayStreaming.integration.test.ts` | Local pass covers SSE, tool, usage, cancel/error protocol behavior. |
| Codex, Claude Code, Pi, CodeBuddy plan/apply/verify/restore | `tests/api/handlers/AiClientConfigurationHandler.test.ts` | Fixture-backed local pass; preserves unrelated config and restores without leaking secrets. |
| Real Kimi/DeepSeek through all standard interfaces and coding clients | `scripts/accept-live-ai-connections.ts`; `docs/acceptance/ai-connections-product-matrix.md` | The accepted live run discovers Kimi Token Plan and DeepSeek API models/quotas, calls Models/Chat/Responses/Messages, then runs Codex, Claude Code, Pi, and CodeBuddy inference plus file-read tools against one model from each provider. |
| Real Codex streaming answer and tool call through Xpod | `scripts/ai-gateway-codex-smoke.ts --real-codex-cli`; acceptance item `real-codex` | Not complete unless `XPOD_ACCEPTANCE_RUN_CODEX=true`, the Xpod runtime was started with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`, `XPOD_ACCEPTANCE_XPOD_BASE_URL`, `XPOD_ACCEPTANCE_GATEWAY_KEY`, and existing stored provider credential are supplied. The acceptance gate passes the Gateway key to the smoke process through stdin, not a command argument or child environment; fixture mode is not accepted. The real Codex run must return `XPOD_REAL_STREAM_SENTINEL` from the stream path and `XPOD_REAL_TOOL_SENTINEL` from a tool-read path. Before launching Codex, the smoke calls the protected read-only `/v1/xpod/acceptance/provenance` endpoint with the Gateway key; the endpoint resolves the current principal and selected Pod credential metadata without opening or returning provider secret material. |
| Docker/full integration regression | `docker info && bun run test:integration` | Not complete unless `XPOD_ACCEPTANCE_RUN_DOCKER=true`; once enabled, either command failing is `fail`. |
| External OAuth/npm/Docker/credentials | `scripts/accept-xpod-settings.ts` status output | Missing env is `not_complete`; enabled gates must execute commands or validate a fresh schema `xpod.acceptance.evidence.v1` artifact with provenance hash, command, timestamp, redaction checks, non-symlink realpath, and default containment under `.test-data/acceptance/`. Artifact hashes are canonical SHA-256 over the artifact with `provenance.artifactHash` excluded; mismatches fail. External evidence paths require `XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL=true`. |

## Evidence Format

`scripts/accept-xpod-settings.ts` writes:

- `.test-data/acceptance/xpod-light-settings-acceptance.json`
- `.test-data/acceptance/xpod-light-settings-acceptance.md`

Both outputs redact provider API keys, Gateway keys, OAuth codes, bearer tokens, and every environment value whose name contains secret/token/key/password/passwd/authorization/credential. Command-gate environment evidence records only allowlisted key names with `{ "present": true }`; environment values are never written to JSON or Markdown, even for non-sensitive names. The JSON summary uses `pass`, `skip`, `notComplete`, `fail`, `healthy`, `complete`, `allowIncomplete`, and `exitCode`; `not_complete` items are explicit gaps, not successful acceptance.

Command gates terminate on timeout deterministically: macOS/Linux runs use a detached process group, send `SIGTERM`, then escalate to `SIGKILL` after the kill grace window. Windows falls back to child-process termination. Timed-out results are reported as `timedOut:true` with a non-zero result and redacted stdout/stderr previews.

Real Codex evidence must include non-secret, cross-checkable provenance: `webId`, `gatewayKeyId`, server-derived `gatewayKeyFingerprint` (`sha256` of the authenticated Gateway bearer key), `credentialIriHash`, `secretCellRefHash`, `providerId`, `providerRouteSource: "pod-credential"`, `xpodBaseUrl`, `generatedAt`, `commandHash`, and `resultHash`. User-authored JSON that asserts credential source without the protected provenance lookup is rejected.

The acceptance provenance endpoint is disabled by default and is intended only for test/acceptance runtimes. Enable it with `XPOD_ACCEPTANCE_ENDPOINTS_ENABLED=true`. Generate a dedicated Gateway key for product acceptance with `acceptance:read` plus the normal protocol scopes needed by the real Codex run (`models:read` and `inference:write`); do not reuse a default user key that lacks the acceptance scope.

OAuth evidence defaults to the acceptance evidence root `.test-data/acceptance/`. Use `XPOD_ACCEPTANCE_EVIDENCE_ROOT` only to move that root for a controlled local run. A symlink path is always rejected. A realpath outside the root is rejected unless `XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL=true` is set for an explicitly audited external artifact.
