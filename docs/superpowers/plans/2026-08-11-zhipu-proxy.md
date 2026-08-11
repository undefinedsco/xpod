# Zhipu Provider and Credential Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Zhipu API Platform and GLM Coding Plan Offerings and make an optional outbound proxy a durable Credential property used by every upstream request.

**Architecture:** Provider and Offering remain catalog metadata. `proxyUrl` belongs to a Credential, is stored through the shared model, and is passed to the common HTTP transport for model discovery, quota and inference; it never changes the Offering endpoint. Proxy validation and redaction are shared and provider-independent.

**Tech Stack:** TypeScript, React, drizzle-solid, `@undefineds.co/models`, Provider Registry, `proxy-agent`, Vitest.

---

### Task 1: Lock the Provider and Offering catalog

**Files:**
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Modify: `packages/ai-connections/src/controller.tsx`
- Modify: `ui/src/extensions/XpodAiConnectionsPodStore.ts`
- Modify: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Test: `ui/src/extensions/XpodAiConnectionsPodStore.test.ts`
- Test: `tests/api/ai-gateway/ProviderRegistry.test.ts`

- [ ] Add failing tests for `zhipu/api-platform` and `zhipu/coding-plan` with distinct official Base URLs.
- [ ] Add Zhipu to the shared client catalog, Settings navigation and server registry.
- [ ] Register an OpenAI-compatible runtime adapter using the catalog endpoints.
- [ ] Run the two catalog test files and verify they pass.

### Task 2: Persist and render a Credential proxy

**Files:**
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Modify: `packages/ai-connections/src/AiCredentialPoolSection.tsx`
- Modify: `ui/src/extensions/XpodAiConnectionsPodStore.ts`
- Test: `packages/ai-connections/test/interactions.test.tsx`
- Test: `ui/src/extensions/XpodAiConnectionsPodStore.test.ts`

- [ ] Add failing tests proving create, edit and reload retain `proxyUrl` independently of `baseUrl`.
- [ ] Add an optional Proxy URL input to add/edit Credential dialogs.
- [ ] Persist the shared model's `proxy` field through drizzle-solid and expose only a redacted display value.
- [ ] Validate `http:`, `https:`, `socks:` and `socks5:` URLs; reject fragments and malformed URLs.

### Task 3: Route all upstream traffic through the proxy

**Files:**
- Modify: `src/api/service/provider-http-transport.ts`
- Modify: `src/api/ai-gateway/models/ProviderModelsAdapter.ts`
- Modify: `src/api/ai-gateway/quota/ProviderQuotaAdapter.ts`
- Modify: `src/api/ai-gateway/providers/ProviderRuntimeAdapter.ts`
- Test: `tests/api/ai-gateway/ProviderModelsAdapters.test.ts`
- Test: `tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`
- Test: `tests/api/ai-gateway/AiGatewayService.test.ts`

- [ ] Add failing tests proving discovery, quota and inference receive the same Credential proxy.
- [ ] Centralize proxy agent creation and secret-safe validation in the HTTP transport.
- [ ] Ensure errors and logs never include proxy credentials or the full proxy URL.
- [ ] Run the provider matrix tests.

### Task 4: Product acceptance

**Files:**
- Modify: `static/settings/settings.html`
- Regenerate: `static/settings/assets/*`

- [ ] Build packages and Settings.
- [ ] Run `bun run test:integration`.
- [ ] Start real local Xpod and verify Zhipu appears with two Offering items.
- [ ] Save a Credential with and without Proxy, reload, sync models, query quota when supported and make one Gateway inference request.
