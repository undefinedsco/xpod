# AI Connections Provider Models Design

## Outcome

AI Connections separates three concepts that must never be conflated:

1. A Provider credential is the user's real upstream API key or OAuth token and remains in the user's Pod.
2. A client credential is issued by Xpod for the current WebID and is projected into Codex, Claude Code, Pi, or CodeBuddy.
3. A Provider model catalog is discovered with that Provider's enabled credentials and stored under that Provider in the Pod.

## Provider and Offering hierarchy

- A Provider is only the supplier grouping, such as Bailian, Kimi, or DeepSeek.
- An Offering is an independently usable product sold by that Provider. It is always rendered as a list item, never as a tab and never as a synonym for an authentication method.
- Authentication methods and multiple credentials live inside one Offering. A credential cannot silently move between Offerings.
- Model discovery, quota, API compatibility, and client routing are resolved from `providerId + offeringId`, not from the Provider alone.
- Every Offering definition declares its `kind`, label, auth modes, credential prefixes, console/subscription URLs, protocol API bases, model-discovery strategy, quota strategy/URL, usage policy, region, and lifecycle state.
- Bailian exposes separate items for pay-as-you-go API, Token Plan Personal, Token Plan Team, and Coding Plan Pro. Coding Plan Lite is legacy-only and must not be offered as a current purchasable plan.
- API Key versus Token Plan is not a top-level mode switch: they are different Offerings whose credentials, API bases, catalogs, quota behavior, and usage policies may differ.

## Credential behavior

- Coding clients receive only the Xpod-issued client credential (`sk-base64(client_id:client_secret)`).
- Provider secrets never enter coding-client configuration.
- Product copy uses “客户端凭证” rather than the legacy “Gateway Key”.
- A credential row exposes two independent states: enabled/disabled and healthy/unverified/expired/error.
- Disabling or enabling succeeds only when the Pod update returns the persisted row. A missing update result is an error, never an optimistic success.
- Provider aggregate state is recomputed from the entire credential pool after every mutation.

## Model discovery and selection

- Saving or updating an Offering credential automatically requests that Offering's configured model endpoint with that credential and protocol base URL.
- A failed model sync does not discard the saved credential. The UI reports the failure and offers “刷新模型”.
- Each discovered model is stored with both Provider and Offering relations. Provider pages never consume the global Gateway `/v1/models` projection as their catalog.
- Models no longer display redundant “已选择” or implementation-oriented “上游” badges. The checkbox itself means the model is included.
- A model previously included but absent from the latest Provider response remains visible as “已失效”. It may be removed but cannot be newly included.
- The header checkbox selects or clears only currently filtered, available models and supports checked, unchecked, and indeterminate states.
- Counts read “共 N · 已加入 M · 已失效 K”.
- “验证” becomes “同步模型” before the first sync and “刷新模型” afterward. Credential rows retain a separate “测试连接” action.

## Visual behavior

- Enabled credential rows use the normal surface; disabled rows use a muted background.
- Health failures use a warning/destructive badge rather than coloring the whole row.
- Action labels are complete words: “启用”, “停用”, “测试连接”, and “删除”.
- Model search reuses the opaque Linx list-search treatment with standard border, focus ring, and 220–240px width.
- The Provider page presents Offering cards in one vertical list. Each card exposes its product description, credential method, API compatibility, console/subscription entry, quota entry, and credential/model controls without a hidden tab switch.

## Error handling

- Pod compare-and-set/update failures surface a specific conflict or persistence error and the UI reloads the persisted state.
- Provider discovery errors are sanitized but remain Provider-specific.
- Automatic sync and manual refresh use the same discovery path so their results cannot diverge.

## Acceptance

- Inspecting all four generated client configurations shows only an Xpod-issued client credential.
- Two Provider Offerings with different mocked `/models` responses show disjoint model lists after sync and after reload.
- Bailian Offering fixtures assert distinct credentials, API bases, model discovery, quota behavior, and usage policy; the UI renders them as list items and contains no Offering `tablist`.
- Disabling the last enabled credential persists after reload and changes the Provider aggregate state.
- Empty selection exposes and routes zero models.
- An unavailable included model remains visible after refresh and can be removed.

## Completion evidence

- `packages/ai-connections/test/local-acceptance.test.tsx` proves disjoint Offering catalogs survive reload, unavailable selections remain removable, the last disabled credential reloads as configured, and all four coding clients receive only Xpod client credentials.
- `packages/ai-connections/test/client-config-adapters.test.ts` generates Codex, Claude Code, Pi, and CodeBuddy files in a temporary home, verifies them, rejects Provider-key leakage, and produces a redacted review representation.
- `tests/api/ai-gateway/ProviderRegistry.test.ts` proves every current Offering has complete operational metadata and lifecycle; Coding Plan Lite is absent from the active catalog.
- `tests/api/ai-gateway/ProviderModelsAdapters.test.ts`, `ProviderQuotaAdapters.test.ts`, and `ProviderConnectAdapters.test.ts` prove Provider-and-Offering-specific discovery, quota caching/routing, credential ownership, and public DTO projection.
- `ui/src/extensions/XpodAiConnectionsPodStore.test.ts` proves truthful compare-and-set updates, Offering-qualified model persistence, exact selection identity, and unverified initial API-key health.
- The served `/settings/models` product page was exercised against fixed local Alice Pod seed data: API-key save survived discovery failure, reload retained the credential, disabling the last enabled credential rendered configured in both panes, newly saved credentials rendered unverified, Bailian rendered four vertical Offering items with zero Offering tablists, and the browser console remained error-free.
- Required verification commands: package tests, focused Gateway/Pod/handler tests, TypeScript build, package build, Settings build, `git diff --check`, and the complete `bun run test:integration` lite/full stack.
