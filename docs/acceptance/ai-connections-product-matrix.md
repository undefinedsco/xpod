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
| **KNOWN-LIMITATION** | The current behavior is explicit and tested, but it is not the intended final security or capability level. |

## Product invariants

- Upstream credentials belong to the signed-in user and are persisted through the AI Connections Pod store / drizzle-solid path.
- Coding clients receive only the Xpod endpoint and an Xpod virtual client key (`sk-base64(client_id:client_secret)`). Upstream provider credentials are never projected to client configuration.
- Only models selected into the Pod are projected through Xpod's standard interfaces. A previously selected model remains visible when upstream discovery no longer returns it, so invalid selections can be repaired instead of silently disappearing.
- OAuth offerings and API-key/token-plan offerings are separate list items with independent credentials, model discovery, quota behavior, and lifecycle.

## Provider and offering matrix

The live run used temporary local Xpod and Solid data plus user-supplied Kimi Token Plan and DeepSeek API credentials. Secrets were read from the process environment only and were not written to the repository or command arguments.

This table records each Offering's upstream behavior. It does not define what coding clients see: Xpod's client-facing standard interfaces and their cross-protocol projection are accepted separately in the next table.

| Provider | Offering | Auth | Models | Upstream runtime | Quota / balance | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | Codex Subscription | OAuth | Unsupported by this offering | No supported third-party proxy flow | Rolling-window metadata | **UNAVAILABLE** — no supported Xpod OAuth connection flow is advertised. |
| OpenAI | API Platform | API key | OpenAI-compatible `/models` | Responses is the runtime adapter path; Xpod projects its other standard frontends to the canonical request | Credential-scoped quota unsupported; provider console remains the reference | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Anthropic | Claude Code Subscription | OAuth | Unsupported by this offering | No supported third-party proxy flow | Rolling-window metadata | **UNAVAILABLE** — subscription OAuth is not exposed as a reusable Xpod proxy credential. |
| Anthropic | API Platform | API key | Anthropic `/models` | Anthropic Messages | Console-only metadata | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Kimi | Official Subscription | Device-code OAuth | OpenAI-compatible `/models` using OAuth access token | Chat Completions + Anthropic Messages | Rolling-window profile | **PASS-CONTRACT**, **BLOCKED-EXTERNAL** live: requires an Xpod/Moonshot-issued OAuth client registration. |
| Kimi | Token Plan | Token-plan key | `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k` | Chat Completions + Anthropic Messages | This live run observed a `weekly` window | **PASS-LIVE**. |
| Kimi | API Platform | API key | OpenAI-compatible `/models` | Chat Completions | API balance capability | **PASS-CONTRACT**, **NOT-RUN** live: supplied Kimi credential was a Token Plan key, not an API Platform key. |
| Alibaba Bailian | Pay as You Go | API key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Console-only metadata | **PASS-CONTRACT**, **NOT-RUN** live: no matching provider credential supplied. |
| Alibaba Bailian | Token Plan Personal | Token-plan key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| Alibaba Bailian | Token Plan Team | Token-plan key | OpenAI-compatible `/models` | Chat Completions + Anthropic Messages | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| Alibaba Bailian | Coding Plan Pro | Token-plan key | OpenAI-compatible `/models` | Anthropic Messages is the coding-plan runtime path; Xpod projects its standard frontends | Unsupported quota capability | **PASS-CONTRACT**, **NOT-RUN** live. |
| DeepSeek | API Platform | API key | `deepseek-v4-flash`, `deepseek-v4-pro` | Chat Completions | This live run observed provider-reported total/granted/topped-up balances | **PASS-LIVE**. |

## Offering routing metadata matrix

Offerings are independent catalog items, not Provider-wide tabs or aliases. The registry supplies the exact console, discovery, native inference, and quota route; shared protocol adapters execute those capabilities. This is why an API Platform key and a Token Plan key for the same Provider are not interchangeable.

| Offering | Console / plan | Model discovery | Native upstream inference | Quota / balance route |
| --- | --- | --- | --- | --- |
| OpenAI Codex Subscription | `chatgpt.com/codex` | Unsupported | Unavailable for third-party proxying | Codex rolling-window profile, contract only |
| OpenAI API Platform | `platform.openai.com/api-keys` | `api.openai.com/v1/models` | Responses and Chat Completions at `api.openai.com/v1` | Provider usage console; no invented credential balance |
| Anthropic Claude Code Subscription | `claude.ai` | Unsupported | Unavailable for third-party proxying | Five-hour/week/model rolling windows, contract only |
| Anthropic API Platform | `console.anthropic.com/settings/keys` | `api.anthropic.com/v1/models` | Messages at `api.anthropic.com/v1` | Provider limits console |
| Kimi Official Subscription | `kimi.com/code` | `api.kimi.com/coding/v1/models` with OAuth access token | Chat Completions at `/coding/v1`; Messages at `/coding/` | Five-hour/week rolling windows; live OAuth externally blocked |
| Kimi Token Plan | `kimi.com/code` | `api.kimi.com/coding/v1/models` with Token Plan key | Chat Completions at `/coding/v1`; Messages at `/coding/` | Token-plan rolling windows; live run observed `weekly` |
| Kimi API Platform | `platform.moonshot.cn/console/api-keys` | `api.moonshot.ai/v1/models` | Chat Completions at `api.moonshot.ai/v1` | Moonshot balance capability / account console |
| Bailian Pay as You Go | `bailian.console.aliyun.com` | `/compatible-mode/v1/models` | Chat Completions at `/compatible-mode/v1`; Messages at `/apps/anthropic` | Console-only |
| Bailian Token Plan Personal / Team | `bailian.console.aliyun.com` | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models` | Token Plan Chat Completions and Messages endpoints; Personal and Team retain distinct Offering identities | Unsupported subscription quota capability |
| Bailian Coding Plan Pro | `bailian.console.aliyun.com` | `coding.dashscope.aliyuncs.com/v1/models` | Chat Completions at `/v1`; Messages at `/apps/anthropic` | Unsupported subscription quota capability |
| DeepSeek API Platform | `platform.deepseek.com/api_keys` | `api.deepseek.com/v1/models` | Chat Completions at `api.deepseek.com/v1` | Official `/user/balance` normalized into total/granted/topped-up windows |

## Credential lifecycle and owner matrix

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Multiple keys in one Offering | Alice creates two OpenAI API Platform rows; the hermetic upstream rejects anonymous discovery and records each stored Bearer as a non-secret `primary` / `sibling` label. Alice then disables/enables one row, deletes only that row, and retains the sibling in the real Pod. | **PASS-LIVE** (local hermetic) |
| Multiple Offerings under one Provider | Repository and UI contracts retain independent `offeringId`, endpoint, priority, enabled state, health, and catalog identity. | **PASS-CONTRACT** |
| OAuth and API-key siblings coexist | Kimi Connect contracts refresh/disconnect the requested OAuth row without selecting or replacing a coexisting API-key row. | **PASS-CONTRACT**; OAuth live remains **BLOCKED-EXTERNAL** |
| Exact-row edit/test/reorder/disable/delete | UI, management handler, and Pod repository tests require credential id plus version/CAS and do not mutate a sibling. | **PASS-CONTRACT**; disable/enable/delete sibling is also **PASS-LIVE** locally |
| Owner-bound management | Solid management routes derive the owner from the current WebID; wrong-owner, expired, insufficient-scope, and ordinary Gateway-key callers are rejected. | **PASS-CONTRACT** |
| Two-user Pod isolation | Alice and Bob use separate real OIDC sessions, WebIDs, and Pods; Bob cannot list Alice's credentials, selected models, or Gateway key. | **PASS-LIVE** (local hermetic) |
| Gateway key lifecycle | The browser run returns plaintext once, verifies Alice can call `/v1/models`, proves Bob cannot see Alice's key, revokes it, then observes `401`; stored listings omit plaintext/hash and protocol tests cover wrong scope and wrong owner. | **PASS-LIVE** (local hermetic) and **PASS-CONTRACT** |

## Model lifecycle matrix

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Offering-scoped upstream discovery | Discovery uses the selected credential's Offering metadata and rejects ambiguous, sibling, or untrusted endpoints before attaching a secret. | **PASS-CONTRACT**; Kimi Token Plan and DeepSeek are **PASS-LIVE** |
| Pick-only projection | An active credential with an empty Pick projects no models; `/v1/models` returns the union of enabled credentials' selected models only. | **PASS-CONTRACT** and **PASS-LIVE** for the two real Providers |
| Reload persistence | A model picked through the real UI survives reload through the drizzle-solid Pod store. | **PASS-LIVE** (local hermetic) |
| Selected model disappears upstream | Refresh retains the selected row as `已失效`; it remains visible and repairable but cannot be newly selected. | **PASS-LIVE** (local hermetic) |
| Offering isolation | Refresh marks only the requested Offering stale, preserves custom models, and keeps same-named models from different Offerings distinct. | **PASS-CONTRACT** |
| Optimistic failure recovery | A failed Pod selection write rolls the checkbox state back and presents a retryable error. | **PASS-CONTRACT** |

## Offering metadata and provider capability matrix

The UI displays Provider groups, but every actionable row is an Offering. API key, token plan, and OAuth rows can coexist under the same Provider because they have different auth flows, endpoint metadata, model discovery, quota behavior, and runtime adapters.

| Capability | Evidence | Acceptance |
| --- | --- | --- |
| Offering identity | Provider id, Offering id, auth type, user-facing label, official URL, console URL, quota URL, and endpoint metadata are exposed as descriptor data, not inferred from display text. | **PASS-CONTRACT** |
| API key vs token plan | Kimi API Platform, Kimi Token Plan, Bailian pay-as-you-go, Bailian token-plan personal/team, Bailian coding-plan, DeepSeek API Platform, OpenAI API Platform, and Anthropic API Platform remain distinct Offering rows even when they share a Provider name. | **PASS-CONTRACT** |
| Provider endpoint routing | Model discovery, quota lookup, Chat Completions, Responses projection, and Anthropic Messages projection are chosen by provider/offering capability metadata plus runtime adapter support. | **PASS-CONTRACT** |
| OAuth handling | OAuth offerings do not ask users to paste official CLI client ids. Kimi OAuth is blocked only on external Xpod/Moonshot registration; OpenAI/Anthropic subscription OAuth remains unavailable because no supported reusable proxy credential flow is offered. | **PASS-CONTRACT** / **BLOCKED-EXTERNAL** |
| Quota windows | Kimi OAuth rolling five-hour and weekly windows are contract-covered; Kimi Token Plan live returned weekly quota metadata; DeepSeek live returned provider balance fields; unsupported quota rows stay explicit instead of inventing percentages. | **PASS-CONTRACT** and provider-specific **PASS-LIVE** rows above |
| Message-role compatibility | Runtime capability metadata controls whether an upstream accepts `developer`. Kimi coding Offerings normalize `developer` to `system`, while providers that support the role retain it. | **PASS-CONTRACT** and exercised by the Kimi Token Plan **PASS-LIVE** client matrix |

## Xpod standard interface matrix

| Interface | Evidence | Acceptance |
| --- | --- | --- |
| `GET /v1/models` | Real Xpod virtual key; returned only Pod-selected Kimi and DeepSeek models. | **PASS-LIVE** |
| `POST /v1/chat/completions` | Real streaming requests to selected Kimi and DeepSeek models; semantic sentinels matched. | **PASS-LIVE** |
| `POST /v1/responses` | Real streaming requests projected to both upstream providers; semantic sentinels matched. | **PASS-LIVE** |
| `POST /v1/messages` | Direct real streaming requests to selected Kimi and DeepSeek models; semantic sentinels matched. | **PASS-LIVE** |
| Protocol tool-history conversion | Chat Completions `tool_calls`, Responses `function_call`/`function_call_output`, and Messages `tool_use`/`tool_result` round-tripped through the canonical gateway request. | **PASS-CONTRACT** |
| End-to-end tool continuation | All four real coding clients completed a file-read tool loop through Xpod and returned the file sentinel without structured error events. | **PASS-LIVE** |

Live and contract coverage must not be conflated across Providers:

| Provider / Offering | `/v1/models` | Chat Completions | Responses | Messages |
| --- | --- | --- | --- | --- |
| OpenAI API Platform | Contract; live not run | Contract; live not run | Contract; live not run | Xpod projection contract; live not run |
| Anthropic API Platform | Contract; live not run | Xpod projection contract; live not run | Xpod projection contract; live not run | Contract; live not run |
| Kimi Official Subscription | Contract; live externally blocked | Contract; live externally blocked | Projection contract; live externally blocked | Contract; live externally blocked |
| Kimi Token Plan | **PASS-LIVE** | **PASS-LIVE** | **PASS-LIVE** | **PASS-LIVE** |
| Kimi API Platform | Contract; live not run | Contract; live not run | Projection contract; live not run | Projection contract; live not run |
| Bailian offerings | Contract; live not run | Contract; live not run | Projection contract; live not run | Contract; live not run |
| DeepSeek API Platform | **PASS-LIVE** | **PASS-LIVE** | **PASS-LIVE** | **PASS-LIVE** |

## Credential, model, and security lifecycle matrix

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Multiple credentials under one Offering | The browser acceptance creates two API-key credentials for the same Offering, disables/enables the second one, deletes it, and verifies the primary credential remains available. | **PASS-LIVE** (local hermetic) |
| Multiple Offering types under one Provider | Provider grouping is visual only; credential CRUD and selected-model state are keyed by Offering, so OAuth, API Platform, and Token Plan entries do not overwrite each other. | **PASS-CONTRACT** |
| Upstream discovery to Pod pick | Users can fetch upstream models for a credential, pick specific models into the Pod, reload, and see only selected models exposed by the Xpod standard interfaces. | **PASS-LIVE** (local hermetic + Kimi/DeepSeek live) |
| Stale selected models | If upstream discovery later removes a previously selected model, Xpod keeps the selected model visible as stale/invalid so the user can repair it; it is not silently deleted. | **PASS-LIVE** (local hermetic) |
| Gateway virtual key projection | Client configuration shows only Xpod endpoint plus Xpod virtual key. It does not ask for, display, or write upstream provider keys into Codex, Claude Code, Pi, or CodeBuddy config. | **PASS-CONTRACT** and **PASS-LIVE** client acceptance |
| Owner isolation and invalid ownership | Account B cannot list Account A's credential, selected model, or Gateway key. Protocol-level owner and revoked-key negative checks are contract-covered by the Gateway handler suite. | **PASS-LIVE** UI isolation, **PASS-CONTRACT** protocol negatives |
| Secret storage scope | Provider credentials are stored in the user's Pod data path. The current secret cell envelope is reversible `PLAINTEXT` plus base64 and is accepted only as non-encrypted storage for this release. | **PASS-LIVE** (local hermetic), encryption **TODO** |

## Coding client matrix

Every client was configured with the same temporary local Xpod endpoint and virtual client key in an isolated temporary home. For each client, the acceptance runner separately selected the real DeepSeek and Kimi model, applied native configuration, verified ownership, ran inference and a real file-read tool, restored configuration, and verified that no Xpod-owned state remained.

| Client | DeepSeek `deepseek-v4-flash` inference / tool | Kimi `kimi-for-coding` inference / tool | Native config / restore | Acceptance |
| --- | --- | --- | --- | --- |
| Codex | Pass / Pass | Pass / Pass | Pass / Pass | **PASS-LIVE** |
| Claude Code | Pass / Pass | Pass / Pass | Pass / Pass | **PASS-LIVE** |
| Pi | Pass / Pass | Pass / Pass | Pass / Pass | **PASS-LIVE** |
| CodeBuddy | Pass / Pass | Pass / Pass | Pass / Pass | **PASS-LIVE** |

The runner parses each client's structured event stream. A zero process exit code is not enough: `is_error`, `type=error`, or `error_during_execution` fails acceptance even when a CLI exits successfully.

## Solid OIDC, Pod, and UI matrix

The committed hermetic Playwright acceptance starts a temporary local Xpod and a test-only upstream Provider HTTP server, creates two temporary Solid accounts and Pods, and drives the real OIDC login and consent pages without intercepting product requests. It needs no pre-generated storage state, external account, or provider credential.

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Shared Solid OIDC session | Both real password login and consent flows returned to `/settings/models`; no bearer/DPoP server fallback or storage-state injection was used. | **PASS-LIVE** (local hermetic) |
| Existing Pod reuse | Both accounts were provisioned once before login; OIDC reused those Pods and did not request a second storage creation. | **PASS-LIVE** (local hermetic) |
| Pod credential persistence | The UI-created credential survived reload and was read through `createXpodAiConnectionsPodStore` / drizzle-solid. Its current `PLAINTEXT`/base64 envelope round-trips but is not described as encrypted. | **PASS-LIVE** (local hermetic) |
| Owner isolation | Account A and B have distinct WebIDs and Pods; B cannot list A's credential, selected model, or Gateway key. | **PASS-LIVE** (local hermetic) |
| Provider discovery and selection UI | The real management path fetched models from an upstream fixture that returns `401` without the saved Provider Bearer, persisted a picked model, and retained it as `已失效` after upstream discovery removed it. Search and add actions stay in the list header. | **PASS-LIVE** (local hermetic) |
| Unavailable OAuth UI | Unavailable offerings render an explanation without login or API-key actions. | **PASS-CONTRACT** |
| Layout | Desktop `1440×900` and mobile `390×844` exercise Models, Pod, Network, and Services with no horizontal overflow; pane-header alignment, search placement, focus/back behavior, and SDK visual tokens are asserted and screenshots are captured. | **PASS-LIVE** (local hermetic) |

## Secret handling matrix

| Requirement | Evidence | Acceptance |
| --- | --- | --- |
| Provider secret stays in the owner's Pod | Real UI persistence and reload use the AI Connections Pod store / drizzle-solid; provider credentials are not configured through server environment variables. | **PASS-LIVE** (local hermetic) |
| Coding clients receive virtual credentials only | Native client plans contain the Xpod endpoint plus Xpod-issued virtual key; tests reject any upstream key in projected config or client output. | **PASS-CONTRACT** and **PASS-LIVE** for real client runs |
| Management responses do not echo secrets | Credential lists, provider summaries, quota cache rows, errors, and test responses omit or redact secret material. | **PASS-CONTRACT** |
| Current Pod envelope | The current `PLAINTEXT` marker plus base64 payload is reversible and deliberately described as **not encrypted**. | **KNOWN-LIMITATION**; shared Pod encryption design remains TODO |

## Repeatable commands

The live command requires real provider secrets in the process environment and deletes its temporary Xpod, Pod, workspace, and client configuration directories when it exits:

```bash
KIMI_API_KEY=... DEEPSEEK_API_KEY=... bun run ai-connections:accept:live
```

Deterministic acceptance:

```bash
bun run ai-connections:accept:browser
bun run test:run -- \
  tests/api/ai-gateway/ProviderRegistry.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderModelsAdapters.test.ts \
  tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts \
  tests/api/ai-gateway/ProtocolFrontends.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts \
  tests/integration/AiGatewayStreaming.integration.test.ts \
  tests/api/handlers/AiClientConfigurationHandler.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts \
  tests/api/handlers/AiGatewayHandler.test.ts \
  tests/api/ai-gateway/AiGatewayService.test.ts \
  tests/api/ai-gateway/PodGatewayAccessKeyRepository.test.ts \
  tests/api/ai-gateway/CallerPodAccess.test.ts \
  tests/scripts/accept-live-ai-connections.test.ts
bun run test:run -- ui/src/pages/settings/ModelsPage.client-config.test.tsx
bun --cwd packages/ai-connections run test
bun run build:ts
bun run build:components
bun run test:integration
```

## Remaining release risks

- Kimi device-code OAuth cannot receive **PASS-LIVE** until Moonshot issues an Xpod-owned OAuth client registration. The UI must never ask a user to paste or reuse the official Kimi CLI client id.
- OpenAI, Anthropic, Bailian, and Kimi API Platform live-provider rows need matching real credentials before they can move from **PASS-CONTRACT** / **NOT-RUN** to **PASS-LIVE**.
- Model and quota dispatch are capability-driven. Runtime authentication and inference still compose provider-specific runtime adapters behind the common capability metadata, so “adding a provider requires metadata only” is not yet an accepted invariant.
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
