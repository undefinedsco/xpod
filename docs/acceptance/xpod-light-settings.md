# Xpod Lightweight Settings Acceptance

This record maps the current lightweight settings work to executable evidence. It supersedes the removed Pod Gateway, applet descriptor, provider connect, custom-model management, Pod quota service, and gateway-backed provider-management plans.

The current AI boundary is documented in [`../architecture/ai-routing.md`](../architecture/ai-routing.md). Acceptance must prove that settings data is owned by the browser Solid session and the user's Pod, while Xpod API only performs stateless probes and `/v1` routing. External `ai-gateway` is platform execution only and must never receive Pod authority or user BYOK credentials.

## Commands

- `bun run settings:accept` exits non-zero until all mandatory gates are complete.
- `bun scripts/accept-xpod-settings.ts --allow-incomplete` is only for development reports; JSON still says `complete:false`.
- `bun run test -- tests/integration/XpodSettings.integration.test.ts`
- `bun run --filter '@undefineds.co/ai-connections' test`
- `bun run test:run -- ui/src/api/ai-connections.test.ts tests/service/VercelChatServiceConfig.test.ts tests/api/auth/SolidClientCredentialsSession.test.ts tests/api/ClientCredentialsAuthenticator.test.ts tests/api/container/config.test.ts tests/api/RoutesRegistration.test.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2`
- `bun run test:run -- tests/api/handlers/AiConnectionsHandler.test.ts tests/api/ai-connections/ProviderProbeService.test.ts tests/api/ai-connections/ProviderModelsAdapters.test.ts tests/api/ai-connections/ProviderQuotaAdapters.test.ts --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2`
- `bun run test:run -- tests/api/handlers/PodSettingsHandler.test.ts tests/integration/PodSettingsApi.integration.test.ts ui/src/api/pod-settings.test.ts ui/src/pages/settings/PodPage.test.tsx --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2`
- `XPOD_SETTINGS_E2E_BASE_URL=http://127.0.0.1:3000 bunx playwright test tests/e2e/xpod-settings.spec.ts`

Generated runtime evidence is written under `.test-data/acceptance/` and is not committed. Screenshots go under `.test-data/acceptance/screenshots/`. Command gates launch child processes with a minimal allowlisted environment instead of inheriting the full shell environment.

## Requirement Map

| Requirement | Evidence | Status Rule |
| --- | --- | --- |
| Isolated real Xpod with two WebIDs/Pods | `tests/e2e/xpod-settings.spec.ts`; acceptance item `solid-pod-isolation` | Not complete until `XPOD_ACCEPTANCE_REAL_XPOD=true`, `XPOD_SETTINGS_E2E_BASE_URL`, `XPOD_SETTINGS_E2E_ALICE_STATE`, `XPOD_SETTINGS_E2E_BOB_STATE`, and `XPOD_SETTINGS_E2E_TEST_API_KEY` are supplied. Once enabled, Playwright failure is `fail`. |
| Browser settings directly persist user provider data in Pod | `tests/e2e/xpod-settings.spec.ts`; `packages/ai-connections/test/client.test.ts`; `packages/ai-connections/test/controller.test.tsx`; `ui/src/api/ai-connections.test.ts`; `scripts/accept-xpod-settings.ts` command gate | The real E2E must use browser UI save, reload, and WebID A/B isolation through the logged-in browser Solid sessions. It must not rely on plain global `fetch` against a Pod URL, because that does not represent the Inrupt DPoP session. Plaintext `credential.apiKey` persistence is locked by package mutation/serialization tests, not by reading Turtle through a test-only Pod URL. Xpod API must not be required for settings persistence. |
| Stateless provider probes do not own Pod authority | `tests/api/handlers/AiConnectionsHandler.test.ts`; `tests/api/ai-connections/ProviderProbeService.test.ts`; `tests/api/ai-connections/ProviderModelsAdapters.test.ts` | `/api/ai/connections/providers/:provider/models/refresh` and `/quota/refresh` must accept only transient request-body `apiKey` and optional `baseUrl`, must not forward auth/WebID/Pod authority to provider adapters, must reject unsafe provider base URLs, and must not return the secret. |
| Pod status remains outside AI configuration | `tests/api/handlers/PodSettingsHandler.test.ts`; `tests/integration/PodSettingsApi.integration.test.ts`; `ui/src/api/pod-settings.test.ts`; `ui/src/pages/settings/PodPage.test.tsx` | `/api/pod/settings/status` reports identity and platform-owned usage only. It must not register an AI Connection reader, read provider rows from the Pod, or return an `aiConnection` field. |
| Models, Pod, Network, Services at desktop and narrow widths | `tests/e2e/xpod-settings.spec.ts`; `tests/ui/settings-launch.test.ts` | `XPOD_ACCEPTANCE_RUN_VISUAL=true` runs Playwright against a real host; missing env is `not_complete`, command failure is `fail`. |
| Header search, pane/back/focus contract | `tests/e2e/xpod-settings.spec.ts` narrow viewport test | Detail/back/focus assertions are mandatory when the spec runs. |
| AI routing boundary | `tests/service/VercelChatServiceConfig.test.ts`; `tests/api/container/config.test.ts`; `tests/api/RoutesRegistration.test.ts`; acceptance item `ai-routing-boundary` | Platform models `linx-lite` and `linx` must use server-only `DEFAULT_API_BASE`/`DEFAULT_API_KEY` and external `ai-gateway` without reading the Pod. Browser DPoP must not be replayed server-side. Xpod API may read Pod-backed user models and provider credentials only through caller-owned `sk-base64(client_id:client_secret)` client credentials, and those secrets must never be forwarded to `ai-gateway`. |
| Removed provider-management paths stay removed | `tests/api/container/config.test.ts`; `tests/api/RoutesRegistration.test.ts` | ProviderConnect, CustomModel, Pod quota service, credential vault, gateway WebID, gateway ACP grant, invocation key, compatibility, fallback, and migration paths must not be registered or accepted as evidence. |
| External OAuth/npm/Docker/credentials | `scripts/accept-xpod-settings.ts` status output | Missing env is `not_complete`; enabled gates must execute commands or validate a fresh schema `xpod.acceptance.evidence.v1` artifact with provenance hash, command, timestamp, redaction checks, non-symlink realpath, and default containment under `.test-data/acceptance/`. Artifact hashes are canonical SHA-256 over the artifact with `provenance.artifactHash` excluded; mismatches fail. External evidence paths require `XPOD_ACCEPTANCE_OAUTH_EVIDENCE_AUDITED_EXTERNAL=true`. |
| Docker/full integration regression | `docker info && bun run test:integration` | Not complete unless `XPOD_ACCEPTANCE_RUN_DOCKER=true`; once enabled, either command failing is `fail`. |

## Explicitly Removed Acceptance Paths

Do not accept evidence based on these removed designs:

- Xpod API persisting browser settings data into the user's Pod.
- Xpod Pod-status API reading or summarizing AI provider configuration from the user's Pod.
- Xpod API replaying browser DPoP tokens to read Pod AI settings.
- Plain global fetch reads of Pod Turtle as proof of browser DPoP settings persistence.
- External `ai-gateway` reading Pods or receiving Pod authority.
- Gateway WebIDs, platform Pod-reading identities, or user-Pod ACP grants.
- Gateway invocation keys or transient routing tokens for Pod reads.
- Legacy bearer records stored in a user's Pod.
- The removed applet descriptor endpoint.
- The removed bearer-key management endpoint.
- ProviderConnect or CustomModel management APIs.
- Pod quota services or provider credential vaults inside Xpod API.
- Compatibility layers, fallback routes, or migrations for removed gateway-backed provider management.
- Local coding-client auto-configuration from Xpod-issued bearer keys.

## Evidence Format

`scripts/accept-xpod-settings.ts` writes:

- `.test-data/acceptance/xpod-light-settings-acceptance.json`
- `.test-data/acceptance/xpod-light-settings-acceptance.md`

Both outputs redact provider API keys, OAuth codes, bearer tokens, and every environment value whose name contains secret/token/key/password/passwd/authorization/credential. Command-gate environment evidence records only allowlisted key names with `{ "present": true }`; environment values are never written to JSON or Markdown, even for non-sensitive names.

The JSON summary uses `pass`, `skip`, `notComplete`, `fail`, `healthy`, `complete`, `allowIncomplete`, and `exitCode`. `not_complete` items are explicit gaps, not successful acceptance.

## Deployment Note

Passing this acceptance suite proves the current code boundary. It does not prove production has already been replaced.

Production replacement requires separate release evidence: deployed image digest, runtime configuration for `DEFAULT_API_BASE` and `DEFAULT_API_KEY`, smoke output for `linx-lite` and `linx`, and confirmation that removed bearer-key, applet descriptor, connect, invocation-token, fallback, and gateway Pod-access routes are not exposed.
