# AI Connections Product Matrix Acceptance

Date: 2026-08-10

This record is the release acceptance matrix for AI Connections. It separates live upstream evidence from deterministic contract coverage and does not treat a missing provider credential or third-party OAuth registration as a pass.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **PASS-LIVE** | Exercised against a real provider, real local Xpod, or real coding client. |
| **PASS-CONTRACT** | Deterministic provider/adapter/UI contract passed without a live provider credential. |
| **UNAVAILABLE** | Intentionally not offered by the product because no supported connection flow exists. |
| **BLOCKED-EXTERNAL** | Product path exists, but live acceptance needs a provider-issued Xpod OAuth client registration. |
| **NOT-RUN** | Product contract exists, but no matching real provider credential was available for this run. |

## Product invariants

- Upstream credentials belong to the signed-in user and are persisted through the AI Connections Pod store / drizzle-solid path.
- Coding clients receive only the Xpod endpoint and an Xpod virtual client key (`sk-base64(client_id:client_secret)`). Upstream provider credentials are never projected to client configuration.
- Only models selected into the Pod are projected through Xpod's standard interfaces. A previously selected model remains visible when upstream discovery no longer returns it, so invalid selections can be repaired instead of silently disappearing.
- OAuth offerings and API-key/token-plan offerings are separate list items with independent credentials, model discovery, quota behavior, and lifecycle.

## Provider and offering matrix

The live run used temporary local Xpod and Solid data plus user-supplied Kimi Token Plan and DeepSeek API credentials. Secrets were read from the process environment only and were not written to the repository or command arguments.

| Provider | Offering | Auth | Models | Inference protocols | Quota / balance | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Codex Subscription | OAuth | Unsupported by this offering | No supported third-party proxy flow | Rolling-window metadata | **UNAVAILABLE** — no supported Xpod OAuth connection flow is advertised. |
| OpenAI | API Platform | API key | OpenAI-compatible `/models` | Responses + Chat Completions | Provider-console metadata | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Anthropic | Claude Code Subscription | OAuth | Unsupported by this offering | No supported third-party proxy flow | Rolling-window metadata | **UNAVAILABLE** — subscription OAuth is not exposed as a reusable Xpod proxy credential. |
| Anthropic | API Platform | API key | Anthropic `/models` | Anthropic Messages | Console-only metadata | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Kimi | Official Subscription | Device-code OAuth | OpenAI-compatible `/models` using OAuth access token | Chat Completions + Anthropic Messages | Rolling-window profile | **PASS-CONTRACT**, **BLOCKED-EXTERNAL** live: requires an Xpod/Moonshot-issued OAuth client registration. |
| Kimi | Token Plan | Token-plan key | `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k` | Chat Completions + Anthropic Messages | This live run observed a `weekly` window | **PASS-LIVE**. |
| Kimi | API Platform | API key | OpenAI-compatible `/models` | Chat Completions | API balance capability | **PASS-CONTRACT**, **NOT-RUN** live: supplied Kimi credential was a Token Plan key, not an API Platform key. |
| Alibaba Bailian | Pay as You Go | API key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Console-only metadata | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Alibaba Bailian | Token Plan Personal | Token-plan key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| Alibaba Bailian | Token Plan Team | Token-plan key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| Alibaba Bailian | Coding Plan Pro | Token-plan key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| DeepSeek | API Platform | API key | `deepseek-v4-flash`, `deepseek-v4-pro` | Chat Completions; Xpod projects Responses and Messages | This live run observed CNY total/granted/topped-up balances | **PASS-LIVE**. |

## Xpod standard interface matrix

| Interface | Evidence | Acceptance |
| --- | --- | --- |
| `GET /v1/models` | Real Xpod virtual key; returned only Pod-selected Kimi and DeepSeek models. | **PASS-LIVE** |
| `POST /v1/chat/completions` | Real streaming requests to selected Kimi and DeepSeek models; semantic sentinels matched. | **PASS-LIVE** |
| `POST /v1/responses` | Real streaming requests projected to both upstream providers; semantic sentinels matched. | **PASS-LIVE** |
| `POST /v1/messages` | Direct real streaming requests to selected Kimi and DeepSeek models; semantic sentinels matched. | **PASS-LIVE** |
| Protocol tool-history conversion | Chat Completions `tool_calls`, Responses `function_call`/`function_call_output`, and Messages `tool_use`/`tool_result` round-tripped through the canonical gateway request. | **PASS-CONTRACT** |
| End-to-end tool continuation | All four real coding clients completed a file-read tool loop through Xpod and returned the file sentinel without structured error events. | **PASS-LIVE** |

## Coding client matrix

Every client was configured with the same temporary local Xpod endpoint and virtual client key in an isolated temporary home. The acceptance runner applies native configuration, verifies ownership, runs inference and a real file-read tool, restores configuration, and verifies that no Xpod-owned state remains.

| Client | Binary | Native config | Inference | File-read tool | Restore | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Locally installed CLI | Pass | Pass | Pass | Pass | **PASS-LIVE** |
| Claude Code | Locally installed CLI | Pass | Pass | Pass | Pass | **PASS-LIVE** |
| Pi | Locally installed CLI | Pass | Pass | Pass | Pass | **PASS-LIVE** |
| CodeBuddy | Locally installed CLI | Pass | Pass | Pass | Pass | **PASS-LIVE** |

The runner parses each client's structured event stream. A zero process exit code is not enough: `is_error`, `type=error`, or `error_during_execution` fails acceptance even when a CLI exits successfully.

## Solid OIDC, Pod, and UI matrix

In addition to the committed live runner, a separate interactive browser acceptance used two temporary Solid accounts and Pods against a temporary local Xpod runtime. Playwright drove the real OIDC login and consent pages without route interception. These browser rows are current-run evidence, but the interactive flow is not yet a committed one-command artifact.

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Shared Solid OIDC session | Real login and consent completed and returned to the applet in the separate interactive run. | **PASS-LIVE** (interactive) |
| Existing Pod reuse | The provisioned Pod was reused; login did not force a second storage creation. | **PASS-LIVE** (interactive) |
| Pod credential persistence | Credential resources were written and read through `createXpodAiConnectionsPodStore` / drizzle-solid. | **PASS-LIVE** |
| Owner isolation | Account A and B had distinct WebIDs, service-access resources, and AI Connection resources; neither read the other's records. | **PASS-LIVE** (interactive) |
| Provider discovery and selection UI | Upstream models, selected state, invalid/vanished selected state, search, add/remove, and balance details have interaction coverage. | **PASS-CONTRACT** |
| Unavailable OAuth UI | Unavailable offerings render an explanation without login or API-key actions. | **PASS-CONTRACT** |
| Layout | Desktop `1440×900` and mobile `390×844` had no page error or horizontal overflow in the separate interactive run. | **PASS-LIVE** (interactive) |

## Repeatable commands

The live command requires real provider secrets in the process environment and deletes its temporary Xpod, Pod, workspace, and client configuration directories when it exits:

```bash
KIMI_API_KEY=... DEEPSEEK_API_KEY=... bun run ai-connections:accept:live
```

Deterministic acceptance:

```bash
bun run test -- \
  tests/api/ai-gateway/ProviderRegistry.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderModelsAdapters.test.ts \
  tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts \
  tests/api/ai-gateway/ProtocolFrontends.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts \
  tests/integration/AiGatewayStreaming.integration.test.ts \
  tests/api/handlers/AiClientConfigurationHandler.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts
bun run test:run -- ui/src/pages/settings/ModelsPage.client-config.test.tsx
bun --cwd packages/ai-connections test
bun run build:ts
bun run test:integration
```

## Remaining release risks

- Kimi device-code OAuth cannot receive **PASS-LIVE** until Moonshot issues an Xpod-owned OAuth client registration. The UI must never ask a user to paste or reuse the official Kimi CLI client id.
- OpenAI, Anthropic, Bailian, and Kimi API Platform live-provider rows need matching real credentials before they can move from **PASS-CONTRACT** / **NOT-RUN** to **PASS-LIVE**.
- Model and quota dispatch are capability-driven. Runtime authentication and inference still compose provider-specific runtime adapters behind the common capability metadata, so “adding a provider requires metadata only” is not yet an accepted invariant.
- Browser OIDC, two-owner isolation, and geometry should be promoted from interactive evidence to a committed hermetic acceptance command before they become a mandatory CI release gate.
- At-rest cryptographic encryption is not accepted in this matrix. The current Pod envelope is explicitly `PLAINTEXT`/reversible encoding; the shared Pod data-grid encryption design remains a separate TODO and must not be described as encrypted storage.

## Provider references

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Anthropic Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
- [Kimi API Platform](https://platform.kimi.ai/docs/api/overview)
- [Alibaba Bailian Token Plan](https://help.aliyun.com/en/model-studio/token-plan-overview)
- [Alibaba Bailian Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)
- [DeepSeek model list](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/)
