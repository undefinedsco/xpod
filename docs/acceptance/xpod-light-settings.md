# Xpod Lightweight Settings Acceptance

This record maps the July 23 Gateway spec and July 30 lightweight settings spec to executable evidence. It intentionally marks external OAuth registration, real stored credentials, Docker, and real Codex as not complete unless the required environment gates are supplied.

## Commands

- `bun run settings:accept`
- `bun run test -- tests/integration/XpodSettings.integration.test.ts`
- `bun run test -- tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`
- `bun run test -- tests/api/ai-gateway/ProtocolFrontends.test.ts tests/integration/AiGatewayStreaming.integration.test.ts`
- `bun run test -- tests/api/handlers/AiClientConfigurationHandler.test.ts`
- `XPOD_SETTINGS_E2E_BASE_URL=http://127.0.0.1:3000 bunx playwright test tests/e2e/xpod-settings.spec.ts`

Generated runtime evidence is written under `.test-data/acceptance/` and is not committed. Screenshots go under `.test-data/acceptance/screenshots/`.

## Requirement Map

| Requirement | Evidence | Status Rule |
| --- | --- | --- |
| Isolated real Xpod with two WebIDs/Pods | `tests/integration/AiGatewayPodIsolation.integration.test.ts`; acceptance item `solid-pod-isolation` | Not complete until `XPOD_ACCEPTANCE_REAL_XPOD=true` plus real stored credential/Gateway key evidence is supplied. |
| API key persists for WebID A, absent for WebID B, plaintext absent from Pod | `tests/integration/AiGatewayPodIsolation.integration.test.ts`; `scripts/accept-xpod-settings.ts` redaction and not-complete gate | Product-level real Pod inspection remains not complete without the gated real Xpod run. |
| Models, Pod, Network, Services at desktop and narrow widths | `tests/e2e/xpod-settings.spec.ts`; `tests/ui/settings-launch.test.ts` | Playwright is skipped unless `XPOD_SETTINGS_E2E_BASE_URL` points to a real host; no UI JSON interception is allowed. |
| Header search, pane/back/focus contract | `tests/e2e/xpod-settings.spec.ts` narrow viewport test | Evidence is screenshots plus Playwright assertions under the real-host gate. |
| Connect matrix OpenAI, Anthropic, Kimi, Bailian; DeepSeek unsupported | `tests/api/ai-gateway/ProviderConnectAdapters.test.ts` | Contract-backed local pass; missing real external OAuth registration is separately not complete. |
| Quota available/stale/unsupported | `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` | Contract-backed local pass; no invented quota percentage accepted. |
| Gateway `/v1/models`, Responses, Messages, Chat Completions | `tests/api/ai-gateway/ProtocolFrontends.test.ts`; `tests/integration/AiGatewayStreaming.integration.test.ts` | Local pass covers SSE, tool, usage, cancel/error protocol behavior. |
| Codex, Claude Code, Pi, CodeBuddy plan/apply/verify/restore | `tests/api/handlers/AiClientConfigurationHandler.test.ts` | Fixture-backed local pass; preserves unrelated config and restores without leaking secrets. |
| Real Codex streaming answer and tool call through Xpod | `scripts/ai-gateway-codex-smoke.ts`; acceptance item `real-codex` | Not complete unless `XPOD_ACCEPTANCE_RUN_CODEX=true`, Codex availability, stored credential and Gateway key are supplied. |
| Docker/full integration regression | `bun run test:integration` | Not complete unless Docker is available and the command exits 0. |
| External OAuth/npm/Docker/credentials | `scripts/accept-xpod-settings.ts` status output | Marked `not_complete` rather than mocked when unavailable. |

## Evidence Format

`scripts/accept-xpod-settings.ts` writes:

- `.test-data/acceptance/xpod-light-settings-acceptance.json`
- `.test-data/acceptance/xpod-light-settings-acceptance.md`

Both outputs redact provider API keys, Gateway keys, OAuth codes, bearer tokens, and secret-like fields. The JSON summary uses `pass`, `skip`, `notComplete`, and `fail`; `not_complete` items are explicit gaps, not successful acceptance.
