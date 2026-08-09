# Subscription Quota Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return and display the real rolling and weekly quota windows for subscription credentials without confusing them with API-platform balances.

**Architecture:** Select quota behavior by Provider Offering and credential auth mode rather than Provider alone. Normalize subscription usage into the existing `QuotaWindow` contract and keep API-key balance adapters isolated. The UI renders all returned windows, remaining percentage, reset time, observation time, and stale state.

**Tech Stack:** TypeScript, Vitest, React, existing AI Gateway quota service, existing Pod-backed quota snapshots.

---

### Task 1: Make quota adapter selection Offering-aware

**Files:**
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Test: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

- [x] Add a failing test with two adapters for one Provider and prove `official-subscription + deviceCodeOAuth` selects the subscription adapter while `api-platform + apiKey` selects the balance adapter.
- [x] Run `bunx vitest run tests/api/ai-gateway/ProviderQuotaAdapters.test.ts` and confirm the new selection test fails because adapters are currently keyed only by Provider.
- [x] Add an adapter `supports(credential)` predicate and select the first matching adapter for the normalized Provider, failing closed when no Offering/auth-mode match exists.
- [x] Re-run the focused suite and confirm it passes.

### Task 2: Normalize Codex, Claude Code, and Kimi Code usage windows

**Files:**
- Create: `src/api/ai-gateway/quota/SubscriptionQuotaAdapters.ts`
- Modify: `src/api/ai-gateway/quota/OpenAiQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/quota/AnthropicQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/quota/KimiQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/quota/index.ts`
- Test: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

- [x] Add failing response-fixture tests for Codex `secondary_window`/`primary_window`, Claude `five_hour`/`seven_day`, and Kimi Code subscription windows.
- [x] Require each fixture to normalize `used`, `limit: 100`, `remaining`, and ISO `resetsAt`; absent windows must remain absent rather than become zero.
- [x] Run the focused suite and confirm all three fixture tests fail on the current balance/unsupported implementations.
- [x] Implement small provider-specific parsers using the existing bearer-fetch and error snapshot helpers.
- [x] Preserve the current DeepSeek and Moonshot API-platform balance behavior for API-key offerings.
- [x] Re-run the focused suite and confirm it passes.

### Task 3: Register Offering-specific adapters

**Files:**
- Modify: `src/api/container/common.ts`
- Test: `tests/api/container/config.test.ts`

- [x] Add a failing container test proving subscription and API-platform adapters coexist for the same Provider.
- [x] Register the new adapters without enabling server-side browser DPoP replay or changing caller-owned Pod access.
- [x] Run `bunx vitest run tests/api/container/config.test.ts` and confirm it passes.

### Task 4: Render remaining quota and reset times

**Files:**
- Modify: `packages/ai-connections/src/AiQuotaCard.tsx`
- Test: `packages/ai-connections/test/interactions.test.tsx`

- [x] Add a failing interaction test with five-hour and weekly windows and assert `剩余 75%`, `剩余 40%`, both reset times, observation time, source, and stale state are visible.
- [x] Run `bun run --cwd packages/ai-connections test -- interactions.test.tsx` and confirm the reset-time assertions fail.
- [x] Render localized labels, remaining percentages, reset timestamps, and last-refresh metadata without fabricating unavailable numeric values.
- [x] Re-run the package suite and confirm it passes.

### Task 5: Regression and acceptance verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-pod-ai-gateway-design.md`
- Rebuild: `static/settings/**`

- [x] Document that quota capability belongs to an Offering/auth mode, not to the Provider globally.
- [x] Run quota, container, UI, and AI Connections package tests.
- [x] Run `bun run build:ts`, `bun run --cwd ui build:settings`, and `bun run test:integration`.
- [x] Run `git diff --check` and scan the staged diff for credentials before committing.
