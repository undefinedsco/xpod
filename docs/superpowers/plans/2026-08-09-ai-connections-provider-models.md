# AI Connections Provider Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make client credentials unambiguous, persist credential state honestly, and keep every Provider's discovered model catalog isolated and usable.

**Architecture:** The existing PodStore remains the source of truth. Provider operations read the current credential from the opened Pod, call the Provider-specific adapter, and persist Provider-qualified model rows; the UI derives aggregate state and selection strictly from those persisted records. Coding-client projection continues to use CSS client credentials, with product terminology corrected.

**Tech Stack:** React 19, TypeScript, drizzle-solid, Vitest/Bun test, Xpod Gateway adapters.

---

### Task 0: Lock the Offering contract

**Files:**
- Modify: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Modify: `packages/ai-connections/src/types.ts`
- Test: `tests/api/ai-gateway/ProviderRegistry.test.ts`
- Modify: `packages/ai-connections/src/components/**`

- [ ] Add failing registry tests proving every Bailian Offering is a distinct operational product with its own auth modes, credential prefixes, console/subscription URLs, protocol API bases, model-discovery strategy, quota strategy/URL, usage policy, region, and lifecycle state.
- [ ] Require pay-as-you-go API, Token Plan Personal, Token Plan Team, and Coding Plan Pro; mark Coding Plan Lite legacy-only rather than presenting it as currently purchasable.
- [ ] Add a failing component test asserting Offerings render as vertical list items and no Offering `tablist` exists.
- [ ] Remove `AiOfferingTabs` from the product path. Authentication methods and multiple credentials render inside their owning Offering item.
- [ ] Route discovery, quota, credential creation, and model selection using `providerId + offeringId`.
- [ ] Run focused registry and component suites and confirm the contract remains green.

### Task 1: Make credential mutations persistence-truthful

**Files:**
- Modify: `ui/src/extensions/XpodAiConnectionsPodStore.ts`
- Modify: `ui/src/extensions/XpodAiConnectionsPodStore.test.ts`
- Modify: `packages/ai-connections/src/AiConnectionsPanel.tsx`
- Test: `packages/ai-connections/test/interactions.test.tsx`

- [ ] Add a failing PodStore test where `updateById` returns `undefined` and assert `updateProviderCredential` rejects instead of returning a synthesized row.
- [ ] Run `bun test ui/src/extensions/XpodAiConnectionsPodStore.test.ts` and confirm the new test fails on the optimistic fallback.
- [ ] Remove the `(updated ?? { ...current, ...patch })` fallback and throw `credential_update_failed` when no persisted row is returned.
- [ ] Add a failing interaction test that disables the last enabled credential and expects the Provider aggregate state to become configured-but-disabled after reload.
- [ ] Replace single-row status patching with a helper that derives status from the full credential array: enabled+healthy is available, enabled+unhealthy is attention, all disabled is configured, empty is unconfigured.
- [ ] Run both focused suites and confirm they pass.

### Task 2: Prove Provider-specific model discovery

**Files:**
- Modify: `tests/api/ai-gateway/ProviderModelsAdapters.test.ts`
- Modify: `packages/ai-connections/test/controller.test.tsx`
- Modify: `ui/src/extensions/XpodAiConnectionsPodStore.test.ts`
- Modify: `packages/ai-connections/src/controller.tsx`

- [ ] Add adapter tests with different OpenAI-compatible and Anthropic model payloads and assert exact Provider URL and authentication headers.
- [ ] Add a controller test with two Offering credentials returning disjoint catalogs and assert each `discoverModels(provider, offering)` result and saved rows remain Provider-and-Offering-qualified.
- [ ] Add a PodStore round-trip test asserting `isProvidedBy` and Offering ownership map each row back to only its owning product after reload.
- [ ] Run the focused tests to reproduce any cross-Provider contamination before changing production code.
- [ ] Fix the first proven boundary that loses Provider identity; do not add client-side filtering as a substitute for correcting persisted relations.
- [ ] Re-run tests and assert OpenAI and DeepSeek catalogs remain disjoint.

### Task 3: Automatically sync after credential save

**Files:**
- Modify: `packages/ai-connections/src/AiConnectionsPanel.tsx`
- Modify: `packages/ai-connections/test/interactions.test.tsx`

- [ ] Add a failing interaction test: after `createProviderCredential` succeeds, `discoverModels(provider)` runs once, persists the result, and displays Provider-specific models.
- [ ] Add a failure test: credential creation remains successful when discovery fails, while the Provider displays a retryable model-sync error.
- [ ] Extract one `syncProviderModels(provider)` callback shared by automatic sync and manual refresh.
- [ ] Call it after successful credential creation/update without rolling back the credential on sync failure.
- [ ] Run the interaction suite and confirm both success and failure paths pass.

### Task 4: Simplify model selection UI

**Files:**
- Modify: `packages/ai-connections/src/AiProviderCard.tsx`
- Modify: `packages/ai-connections/test/interactions.test.tsx`

- [ ] Add failing UI assertions that selected models have no “已选择” badge and no model displays “上游”.
- [ ] Add tests for the header tri-state checkbox operating only on filtered available models.
- [ ] Add tests that an unavailable selected model remains visible, is labeled “已失效”, can be removed, and cannot be newly selected.
- [ ] Implement counts as `共 N · 已加入 M · 已失效 K` and rename “验证” to “同步模型”/“刷新模型”.
- [ ] Replace the translucent search styling with the standard opaque Linx list-search dimensions and focus treatment.
- [ ] Run the package interaction suite.

### Task 5: Clarify credential UI and terminology

**Files:**
- Modify: `packages/ai-connections/src/AiCredentialPoolSection.tsx`
- Modify: `packages/ai-connections/src/AiClientConfigurationSection.tsx`
- Modify: `packages/ai-connections/src/AiConnectionsPanel.tsx`
- Test: `packages/ai-connections/test/interactions.test.tsx`

- [ ] Add failing copy and accessibility assertions for “客户端凭证”, “测试连接”, “启用”, and “停用”.
- [ ] Render enabled and health as separate labels; use muted background only for disabled rows.
- [ ] Replace user-visible “Gateway Key” text while retaining compatibility method names internally for this release.
- [ ] Add explanatory copy: “用于访问 Xpod，不是 Provider API Key”.
- [ ] Run package tests and visually compare the page to the annotated screenshots.

### Task 6: End-to-end verification

**Files:**
- Rebuild: `static/settings/**`

- [ ] Run `bun run --cwd packages/ai-connections test` and require zero failures.
- [ ] Run Provider adapter, PodStore, routing, and client-configuration focused suites and require zero failures.
- [ ] Run `bun run build:ts`, `bun run --cwd packages/ai-connections build`, and `bun run --cwd ui build:settings`.
- [ ] Run `bun run test:integration`.
- [ ] In the local product page, add two mocked Provider credentials with disjoint model catalogs; verify auto-sync, refresh persistence, selection, unavailable retention, disable persistence, and client-credential projection.
- [ ] Inspect generated Codex, Claude Code, Pi, and CodeBuddy configurations with secrets redacted and confirm no Provider API key is present.
- [ ] Run `git diff --check`, review generated assets, commit with Lore trailers, and push `codex/ai-provider-pool`.
