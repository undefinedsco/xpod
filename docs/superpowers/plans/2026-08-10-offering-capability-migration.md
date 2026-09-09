# Offering Capability Metadata Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Provider metadata compose three standardized Offering kinds with internal upstream capability references, then drive quota and model discovery from those references instead of Provider-specific selection.

**Architecture:** `ProviderRegistry` remains the metadata fact source, but every Offering gains a stable commercial `kind`, typed auth capability references, and typed upstream capability references. Quota and model services resolve the Offering once and dispatch by capability protocol; AI Connections receives safe Offering metadata but does not expose upstream protocol selection as configuration.

**Tech Stack:** TypeScript, Vitest, React, existing ProviderRegistry, existing normalized model/quota contracts.

---

### Task 1: Standardize Offering metadata and validation

**Files:**
- Modify: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Test: `tests/api/ai-gateway/ProviderRegistry.test.ts`

- [x] Add failing tests that require every default Offering kind to be `oauth-subscription`, `api-platform`, or `token-plan`, and require unique registered auth/upstream capability protocols.
- [x] Run `bunx vitest run tests/api/ai-gateway/ProviderRegistry.test.ts` and confirm the legacy kinds fail.
- [x] Add `ProviderAuthCapabilityDescriptor`, `ProviderUpstreamCapabilityDescriptor`, `getOffering`, `requireOffering`, and constructor validation for unknown/duplicate capability protocols.
- [x] Convert default Provider metadata to the three stable kinds and add internal `auth`/`upstream` references while preserving public links and endpoints.
- [x] Re-run the focused registry suite and confirm it passes.

### Task 2: Drive quota selection by Offering capability

**Files:**
- Create: `src/api/ai-gateway/quota/QuotaCapabilityRegistry.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/quota/SubscriptionQuotaAdapters.ts`
- Modify: `src/api/ai-gateway/quota/index.ts`
- Modify: `src/api/container/common.ts`
- Test: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`
- Test: `tests/api/container/config.test.ts`

- [x] Add failing tests proving Kimi OAuth and Kimi Token Plan both select `rolling-quota-windows/kimi-code`, while Kimi API Platform selects `api-balance/moonshot`.
- [x] Run the focused quota tests and confirm current `provider -> adapter[]` selection cannot satisfy capability dispatch.
- [x] Introduce a typed `quota protocol -> handler` registry and resolve the quota/balance capability from `ProviderRegistry.requireOffering(provider, offeringId)`.
- [x] Retain normalized snapshot caching and caller-owned credential behavior; keep legacy Offering predicates only on the read-compatibility path.
- [x] Re-run quota and container tests and confirm they pass.

### Task 3: Drive model discovery by Offering capability

**Files:**
- Modify: `src/api/ai-gateway/models/ProviderModelsAdapter.ts`
- Modify: `src/api/ai-gateway/models/ProviderModelsService.ts`
- Modify: `src/api/container/common.ts`
- Test: `tests/api/ai-gateway/ProviderModelsAdapters.test.ts`

- [x] Add failing tests proving two Providers with `openai-models` reuse one protocol handler with different metadata endpoints, and Anthropic selects `anthropic-models`.
- [x] Run the focused models suite and confirm current adapters are keyed by Provider.
- [x] Replace Provider identity in the models adapter contract with a typed discovery protocol and dispatch from the Offering upstream metadata.
- [x] Keep SSRF/base URL safety scoped to the selected Offering and preserve normalized discovery results.
- [x] Re-run the models suite and confirm it passes.

### Task 4: Keep upstream protocols internal to AI Connections

**Files:**
- Modify: `src/api/ai-gateway/connect/index.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Modify: `packages/ai-connections/src/AiCredentialPoolSection.tsx`
- Modify: `packages/ai-connections/src/offering-label.ts`
- Test: `packages/ai-connections/test/client.test.ts`
- Test: `packages/ai-connections/test/interactions.test.tsx`

- [x] Add failing client parsing tests for the three Offering kinds and an interaction assertion that upstream protocol names are not editable or presented as connection choices.
- [x] Run the focused package tests and confirm legacy kind labels/protocol presentation fail.
- [x] Publish only safe Offering metadata needed for connection UX; retain upstream metadata for diagnostics without creating configuration controls.
- [x] Render the stable labels `账号订阅`, `API 平台`, and `Token 套餐`, with auth method, official links, credentials, models, and quota semantics driven by Offering.
- [x] Re-run the AI Connections package suite and confirm it passes.

### Task 5: Compatibility, documentation, and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-pod-ai-gateway-design.md`
- Rebuild: `static/settings/**`

- [x] Add read-only normalization for legacy Offering kinds/IDs, while ensuring every new public response and write uses the stable Offering kind.
- [x] Document that Xpod public protocol projection is independent of upstream Offering capabilities.
- [x] Run `bun run build:ts`, `bun run --cwd packages/ai-connections test`, and all focused Provider registry/models/quota tests.
- [x] Run `bun run --cwd ui build:settings` and `bun run test:integration`.
- [x] Run `git diff --check`, scan staged changes for credentials, and commit with Lore trailers.
