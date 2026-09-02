# AI Connection Model Discovery and Pick Implementation Plan

> **Documentation status: Historical implementation plan.** Do not execute this
> plan as current product work. Use
> [`docs/ai-connections-product-spec.md`](../../ai-connections-product-spec.md)
> and create a new implementation plan from the current worktree.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Discover each connected provider's live models, persist the current WebID's picks in its Pod, and expose only active picks through Gateway and coding-client configuration.

**Architecture:** Add provider discovery adapters and a drizzle-solid selection repository under src/api/ai-gateway/models. A coordinating service owns reconciliation, five-minute WebID/provider-scoped discovery cache, optimistic version hashes, and secret-safe errors. Management UI, Gateway listing, and routing consume the same selection boundary.

**Tech Stack:** TypeScript, Bun, Vitest, React, Playwright, Solid OIDC/DPoP, @undefineds.co/models, @undefineds.co/drizzle-solid.

---

## File map

- src/api/ai-gateway/models/ProviderModelDiscoveryAdapters.ts: five provider HTTP adapters.
- src/api/ai-gateway/models/PodModelSelectionRepository.ts: exact Pod reads and mutations.
- src/api/ai-gateway/models/ProviderModelSelectionService.ts: discovery, reconciliation, cache, public DTOs.
- src/api/handlers/AiGatewayManagementHandler.ts: authenticated APIs.
- src/api/ai-gateway/AiGatewayService.ts and routing/ModelRouter.ts: active-Pick-only projection.
- packages/ai-connection/src/ai-connection-client.ts: typed SDK.
- packages/ai-connection/src/AiConnectionPanel.tsx and AiProviderCard.tsx: picker interaction.
- tests/api/ai-gateway and tests/e2e/xpod-settings.spec.ts: behavior and product evidence.

### Task 1: Preserve credential and acceptance regressions found during verification

**Files:**
- Modify: src/api/container/index.ts
- Modify: src/api/ai-gateway/connect/index.ts
- Modify: scripts/accept-xpod-settings.ts
- Test: tests/api/container/config.test.ts
- Test: tests/api/ai-gateway/ProviderConnectAdapters.test.ts
- Test: tests/integration/XpodSettings.integration.test.ts

- [ ] **Step 1: Keep the failing-case assertions**

~~~ts
expect(loadConfigFromEnv().edition).toBe('local')
await expect(repository.listCredentials({ webId, deployment: 'local' }))
  .resolves.toEqual([expect.objectContaining({ provider: 'openai' })])
expect(dockerSpawnArgs).toEqual(['bash', '-c', expect.any(String)])
~~~

These cover inline-commented XPOD_EDITION, invalid edition rejection, legacy credential ids, hydrated provider IRIs, and Node 22 PATH preservation.

- [ ] **Step 2: Run focused tests**

~~~bash
bunx vitest run tests/api/container/config.test.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/integration/XpodSettings.integration.test.ts
~~~

Expected: all pass and no secret appears in output.

- [ ] **Step 3: Commit only those files**

~~~bash
git add src/api/container/index.ts src/api/ai-gateway/connect/index.ts scripts/accept-xpod-settings.ts tests/api/container/config.test.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/integration/XpodSettings.integration.test.ts
git commit -m "🐛 Keep connected Pod credentials visible to Gateway"
~~~

### Task 2: Implement provider discovery adapters

**Files:**
- Create: src/api/ai-gateway/models/ProviderModelDiscoveryAdapters.ts
- Test: tests/api/ai-gateway/ProviderModelDiscoveryAdapters.test.ts

- [ ] **Step 1: Write failing tests**

Cover OpenAI, Anthropic, Kimi, Bailian, and DeepSeek; pagination; malformed rows; 401/403 reauth classification; 429 retry metadata; and secret redaction.

~~~ts
const models = await adapter.discover({
  baseUrl: 'https://api.openai.com/v1',
  secret: { apiKey: 'sk-never-print' },
})
expect(models).toEqual([{ id: 'gpt-5', displayName: 'gpt-5', modelType: 'chat' }])
await expect(failing()).rejects.not.toThrow(/sk-never-print/)
~~~

- [ ] **Step 2: Prove red**

~~~bash
bunx vitest run tests/api/ai-gateway/ProviderModelDiscoveryAdapters.test.ts
~~~

Expected: FAIL because createProviderModelDiscoveryAdapters is missing.

- [ ] **Step 3: Implement the contract**

~~~ts
export type DiscoveredProviderModel = {
  id: string
  displayName?: string
  modelType: 'chat' | 'embedding' | 'image' | 'audio' | 'other'
}

export interface ProviderModelDiscoveryAdapter {
  readonly provider: string
  discover(input: {
    baseUrl: string
    secret: ProviderSecret
    signal?: AbortSignal
  }): Promise<DiscoveredProviderModel[]>
}
~~~

OpenAI-compatible providers call GET {baseUrl}/models with Bearer auth. Anthropic uses its documented key/version headers. Validate base URLs with the existing provider descriptor allowlist before fetching.

- [ ] **Step 4: Prove green and commit**

~~~bash
bunx vitest run tests/api/ai-gateway/ProviderModelDiscoveryAdapters.test.ts
bun run build:ts
git add src/api/ai-gateway/models/ProviderModelDiscoveryAdapters.ts tests/api/ai-gateway/ProviderModelDiscoveryAdapters.test.ts
git commit -m "✨ Normalize live provider model catalogs"
~~~

### Task 3: Persist picks with shared Solid resources

**Files:**
- Create: src/api/ai-gateway/models/PodModelSelectionRepository.ts
- Test: tests/api/ai-gateway/PodModelSelectionRepository.test.ts
- Test: tests/integration/AiGatewayPodIsolation.integration.test.ts

- [ ] **Step 1: Write failing exact-id and isolation tests**

~~~ts
await repository.replaceSelection({
  webId: ALICE_WEB_ID,
  provider: 'openai',
  models: [{ id: 'gpt-5', displayName: 'GPT-5', modelType: 'chat' }],
  expectedVersion: emptySelectionVersion('openai'),
  auth: aliceAuth,
})
expect(await repository.listSelection({
  webId: ALICE_WEB_ID,
  provider: 'openai',
  auth: aliceAuth,
})).toMatchObject({ models: [{ id: 'gpt-5', status: 'active' }] })
~~~

Also assert inactive reconciliation, deletion on unpick, deterministic version hash, conflict rejection, and Bob receiving no Alice rows.

- [ ] **Step 2: Prove red**

~~~bash
bunx vitest run tests/api/ai-gateway/PodModelSelectionRepository.test.ts
~~~

Expected: FAIL because the repository is missing.

- [ ] **Step 3: Implement ORM-first operations**

Use aiProviderResource.buildId and aiModelResource.buildId. Provider-document reads use:

~~~ts
db.select()
  .from(aiModel)
  .where(eq(aiModel.isProvidedBy, aiProviderResource.buildId({ id: provider })))
  .execute()
~~~

Use findById/updateById/deleteById for exact targets. Do not serialize Turtle or use raw SPARQL. Compute a SHA-256 version from sorted id/status/updatedAt tuples and throw model_selection_version_conflict on mismatch.

- [ ] **Step 4: Prove green and commit**

~~~bash
bunx vitest run tests/api/ai-gateway/PodModelSelectionRepository.test.ts tests/integration/AiGatewayPodIsolation.integration.test.ts
git add src/api/ai-gateway/models/PodModelSelectionRepository.ts tests/api/ai-gateway/PodModelSelectionRepository.test.ts tests/integration/AiGatewayPodIsolation.integration.test.ts
git commit -m "✨ Make model picks durable Pod resources"
~~~

### Task 4: Coordinate discovery, reconciliation, and selection

**Files:**
- Create: src/api/ai-gateway/models/ProviderModelSelectionService.ts
- Test: tests/api/ai-gateway/ProviderModelSelectionService.test.ts

- [ ] **Step 1: Write failing service tests**

Verify active-credential requirement, successful reconciliation, failed-discovery state preservation, rejection of undiscovered ids, WebID/provider cache isolation, and five-minute expiry.

~~~ts
await service.discover({ webId: ALICE_WEB_ID, provider: 'openai', deployment: 'local', auth })
await expect(service.replaceSelection({
  webId: ALICE_WEB_ID,
  provider: 'openai',
  modelIds: ['invented-model'],
  expectedVersion,
  auth,
})).rejects.toThrow('model_not_in_discovered_catalog')
~~~

- [ ] **Step 2: Prove red, implement, then prove green**

~~~bash
bunx vitest run tests/api/ai-gateway/ProviderModelSelectionService.test.ts
~~~

Implement this public result and keep decoded secrets only on the discover stack:

~~~ts
export type ProviderModelCatalog = {
  provider: string
  fetchedAt?: string
  version: string
  status: 'ready' | 'notFetched' | 'statusUnknown'
  models: Array<DiscoveredProviderModel & {
    selected: boolean
    availability: 'available' | 'unavailable' | 'statusUnknown'
  }>
}
~~~

- [ ] **Step 3: Run and commit**

~~~bash
bunx vitest run tests/api/ai-gateway/ProviderModelSelectionService.test.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts
git add src/api/ai-gateway/models/ProviderModelSelectionService.ts tests/api/ai-gateway/ProviderModelSelectionService.test.ts
git commit -m "✨ Reconcile discovered models with Pod picks"
~~~

### Task 5: Add authenticated management APIs and singleton wiring

**Files:**
- Modify: src/api/handlers/AiGatewayManagementHandler.ts
- Modify: src/api/container/common.ts
- Modify: src/api/container/types.ts
- Test: tests/api/AiGatewayManagementHandler.test.ts
- Test: tests/api/container/GatewayInternalPodAccessConfig.test.ts

- [ ] **Step 1: Write failing route tests**

Cover POST /api/ai/gateway/providers/:provider/models/discover, GET .../models, and PUT .../models/selection. Require current auth WebID, expectedVersion, known provider, valid default model, bounded body, and secret-free responses.

~~~ts
expect(selectionService.replaceSelection).toHaveBeenCalledWith(expect.objectContaining({
  webId: ALICE_WEB_ID,
  provider: 'openai',
  modelIds: ['gpt-5'],
  expectedVersion: 'sha256:selection',
  auth: expect.any(Object),
}))
~~~

- [ ] **Step 2: Implement routes and one shared service**

Map domain errors to stable 400/401/409/429/502 JSON. Register one PodModelSelectionRepository and one ProviderModelSelectionService in Awilix and inject them into management and Gateway.

- [ ] **Step 3: Run and commit**

~~~bash
bunx vitest run tests/api/AiGatewayManagementHandler.test.ts tests/api/container/GatewayInternalPodAccessConfig.test.ts
git add src/api/handlers/AiGatewayManagementHandler.ts src/api/container/common.ts src/api/container/types.ts tests/api/AiGatewayManagementHandler.test.ts tests/api/container/GatewayInternalPodAccessConfig.test.ts
git commit -m "✨ Add authenticated model selection APIs"
~~~

### Task 6: Restrict Gateway and routing to active picks

**Files:**
- Modify: src/api/ai-gateway/AiGatewayService.ts
- Modify: src/api/ai-gateway/routing/ModelRouter.ts
- Test: tests/api/ai-gateway/AiGatewayService.test.ts
- Test: tests/api/ai-gateway/ModelRouter.test.ts
- Test: tests/api/ai-gateway/AiGatewayProtocolIntegration.test.ts

- [ ] **Step 1: Write failing visibility tests**

Connected-with-no-picks returns no models. Active picks are listed and routable. Inactive picks, reauth credentials, exhausted quota, and cooldown are excluded. An unpicked request throws model_not_available.

~~~ts
await expect(service.listModels(auth)).resolves.toEqual([
  expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
])
await expect(service.execute(unpickedRequest))
  .rejects.toMatchObject({ code: 'model_not_available' })
~~~

- [ ] **Step 2: Implement one visibility rule**

Intersect active Pod picks with visible credentials and give the same set to ModelRouter. Delete the behavior where an empty credential models list means every registry model.

- [ ] **Step 3: Run and commit**

~~~bash
bunx vitest run tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ModelRouter.test.ts tests/api/ai-gateway/AiGatewayProtocolIntegration.test.ts
git add src/api/ai-gateway/AiGatewayService.ts src/api/ai-gateway/routing/ModelRouter.ts tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ModelRouter.test.ts tests/api/ai-gateway/AiGatewayProtocolIntegration.test.ts
git commit -m "🔒 Route only through active Pod model picks"
~~~

### Task 7: Add typed SDK operations and searchable picker UI

**Files:**
- Modify: packages/ai-connection/src/ai-connection-client.ts
- Modify: packages/ai-connection/src/AiConnectionPanel.tsx
- Modify: packages/ai-connection/src/AiProviderCard.tsx
- Test: packages/ai-connection/test/client.test.ts
- Test: packages/ai-connection/test/controller.test.tsx
- Test: packages/ai-connection/test/interactions.test.tsx

- [ ] **Step 1: Write failing SDK and UI tests**

~~~tsx
await user.type(screen.getByRole('searchbox', { name: '搜索模型' }), 'gpt-5')
await user.click(screen.getByRole('checkbox', { name: /gpt-5/i }))
await user.click(screen.getByRole('button', { name: '保存模型' }))
expect(client.replaceModelSelection).toHaveBeenCalledWith('openai', expect.objectContaining({
  modelIds: ['gpt-5'],
}))
~~~

Also assert connect-success auto-discovery, retry, empty state, selected count, unavailable persistence, and secret absence.

- [ ] **Step 2: Add discoverModels, getProviderModels, replaceModelSelection**

Parsers expose only id, displayName, modelType, selected, availability, version, and timestamps.

- [ ] **Step 3: Build the picker in the existing detail pane**

Use shared Input, Button, Badge, and checkbox primitives. Preserve the existing Linx-aligned shell. Render loading, search, empty, retry, unavailable, and statusUnknown states.

- [ ] **Step 4: Run, build, and commit source only**

~~~bash
bunx vitest run packages/ai-connection/test/client.test.ts packages/ai-connection/test/controller.test.tsx packages/ai-connection/test/interactions.test.tsx
bun run build:packages
bun run build:ui
git add packages/ai-connection/src packages/ai-connection/test
git commit -m "✨ Pick provider models from AI Connection"
~~~

### Task 8: Prove real Pod persistence, isolation, and stale models

**Files:**
- Create: tests/fixtures/provider-model-catalog-server.ts
- Modify: tests/e2e/xpod-settings.spec.ts
- Modify: scripts/accept-xpod-settings.ts
- Test: tests/integration/XpodSettings.integration.test.ts

- [ ] **Step 1: Build a mutable OpenAI-compatible fixture**

It serves /v1/models plus protocol endpoints and records only authorization touches, never credentials.

- [ ] **Step 2: Extend Playwright acceptance**

Alice connects, auto-discovers, Picks gpt-5, reloads, and remains isolated from Bob. Alice /v1/models contains only gpt-5. Remove gpt-5 from the fixture, refresh, verify Settings shows unavailable, and verify /v1/models is empty.

- [ ] **Step 3: Add a model-discovery-pick acceptance gate**

Keep it distinct from visual, Pod isolation, protocol, client config, real Codex, and external OAuth gates.

- [ ] **Step 4: Run and commit**

~~~bash
set -a; source .test-data/acceptance/auth/e2e.env; set +a
bunx playwright test tests/e2e/xpod-settings.spec.ts --reporter=line --workers=1
git add tests/fixtures/provider-model-catalog-server.ts tests/e2e/xpod-settings.spec.ts scripts/accept-xpod-settings.ts tests/integration/XpodSettings.integration.test.ts
git commit -m "✅ Verify model picks in a real Solid Pod"
~~~

### Task 9: Verify four coding clients and full regression

**Files:**
- Modify: packages/ai-connection/src/client-config/codex.ts
- Modify: packages/ai-connection/src/client-config/claude.ts
- Modify: packages/ai-connection/src/client-config/pi.ts
- Modify: packages/ai-connection/src/client-config/codebuddy.ts
- Test: packages/ai-connection/test/client-config-adapters.test.ts

- [ ] **Step 1: Lock client model boundaries**

~~~ts
await expect(service.plan({ client: 'codex', model: 'unpicked-model' }))
  .rejects.toThrow('model_not_available')
~~~

Each adapter must reject empty catalogs and must not retain an old unpicked Xpod model.

- [ ] **Step 2: Run client and formal acceptance**

~~~bash
bunx vitest run packages/ai-connection/test/client-config-adapters.test.ts
bun scripts/accept-xpod-settings.ts
~~~

Expected: all controllable gates pass. real-codex and external-oauth remain not_complete only when real external credentials are absent.

- [ ] **Step 3: Run required full verification**

~~~bash
bun run build:ts
bun run test:integration
git diff --check
git status --short
~~~

Expected: complete lite/full suites pass under Node 22; no env, credential, test-data, or accidental generated files are staged.

- [ ] **Step 4: Commit any proven client fixes**

~~~bash
git add packages/ai-connection/src/client-config packages/ai-connection/test/client-config-adapters.test.ts scripts/accept-xpod-settings.ts
git commit -m "✅ Keep coding clients inside picked model boundaries"
~~~

### Task 10: Completion audit and delivery

**Files:**
- Evidence: .test-data/acceptance/xpod-light-settings-acceptance.json
- Update only if contract changed: docs/superpowers/specs/2026-08-05-ai-connection-model-pick-design.md

- [ ] **Step 1: Build a requirement-to-evidence matrix**

Cover API-key/browser auth for OpenAI, Anthropic, Kimi, Bailian, DeepSeek; Pod ownership and isolation; quota; live discovery; Pick persistence; unavailable display; active-Pick-only Responses/Chat/Messages; Codex/Claude Code/Pi/CodeBuddy; and Linx-aligned UI.

- [ ] **Step 2: Run clean final verification**

~~~bash
bun run build:ts
bun run test:integration
bun scripts/accept-xpod-settings.ts
~~~

Expected: zero local failures. External credential gates are reported truthfully and never replaced by fixtures.

- [ ] **Step 3: Audit branch contents**

~~~bash
git status --short
git diff release/0.3.71...HEAD --stat
git log --oneline release/0.3.71..HEAD
~~~

Expected: only Connections source, tests, documentation, and plans; no secrets or transient artifacts.
