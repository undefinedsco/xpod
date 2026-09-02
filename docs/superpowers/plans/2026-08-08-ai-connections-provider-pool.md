# AI Connections Provider Pool Implementation Plan

> **Documentation status: Historical implementation plan.** It records an older
> delivery slice and is not safe to replay against the current worktree. Use
> [`docs/ai-connections-product-spec.md`](../../ai-connections-product-spec.md)
> for current product behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Provider the only navigation item, manage OAuth accounts and multiple API keys inside its credential pool, select models once per Provider, and let Gateway resolve offerings, endpoints, and eligible credentials automatically.

**Architecture:** Extend the existing Provider registry with Offering descriptors and replace the one-credential-per-provider repository contract with a provider-scoped credential pool. Management APIs expose safe credential summaries by credential id, while model discovery merges sources across eligible credentials and Gateway routing selects credentials internally. The Applet consumes the grouped API and retains the existing LinX/Xpod rail + list + content shell.

**Tech Stack:** TypeScript, Bun, Vitest, React, drizzle-solid, `@undefineds.co/models`, Solid Pod resources, Xpod AI Gateway.

---

## Delivery boundaries

This plan produces one working vertical slice in Xpod. It does not add fields to the shared RDF schema: `offeringId`, priority, health, and model-source metadata are stored in the existing credential/model metadata envelope until a separately versioned `@undefineds.co/models` schema change is approved. It does not invent or reuse a vendor OAuth client id; Kimi OAuth is enabled only when an Xpod-issued integration is configured, otherwise the UI shows `auth_not_available` and keeps API Key usable.

Hard implementation constraints:

1. **Pod CRUD uses drizzle-solid ORM.** Credential, Provider, Model, Selection, and Quota persistence must use `drizzle`, resource schemas from `@undefineds.co/models`, and repository methods built on `select/insert/update/delete`. Do not add raw SPARQL, handwritten RDF serialization, or direct authenticated `fetch` for application data CRUD.
2. **Report ORM gaps before bypassing.** If drizzle-solid cannot express a required query or exact-id mutation, record the missing operation and reproduction in the relevant repository/model issue before proposing a minimal temporary bypass. The implementation plan does not pre-authorize such a bypass.
3. **Reuse login presentation and session ownership.** Solid login uses `@undefineds.co/extension-sdk/react` `AuthBoundary` with the host's existing `host.solid.requireLogin`; the Applet never creates another Inrupt session or its own Solid login card. Provider OAuth presentation reuses the login primitives exported by `@undefineds.co/shared-ui` instead of introducing Provider-specific modal styles.

## File structure

- Modify `src/api/ai-gateway/providers/ProviderRegistry.ts`: Provider/Offering/Auth/Endpoint descriptors and provider-family normalization.
- Modify `src/api/ai-gateway/connect/index.ts`: multi-credential repository, credential identity, ordering, enable/disable/delete, OAuth integration lookup.
- Modify `src/api/ai-gateway/AiGatewayService.ts`: consume ordered eligible credentials.
- Modify `src/api/ai-gateway/models/ProviderModelsService.ts`: discover through all eligible credentials and merge model sources.
- Modify `src/api/handlers/AiGatewayManagementHandler.ts`: provider detail and credential-pool management routes.
- Modify `packages/ai-connections/src/ai-connections-client.ts`: grouped provider DTOs and credential operations.
- Modify `packages/ai-connections/src/controller.tsx`: one Provider item per family.
- Split `packages/ai-connections/src/AiProviderCard.tsx` into focused credential and model sections if the implementation exceeds the existing component's responsibility.
- Modify `packages/ai-connections/src/AiConnectionsPanel.tsx`: provider detail orchestration.
- Modify `packages/ai-connections/src/AiConnectionsMain.tsx`: replace the local anonymous/error login markup with SDK `AuthBoundary`.
- Modify tests under `tests/api/ai-gateway/`, `tests/api/handlers/`, and `packages/ai-connections/test/` before production changes.

### Task 1: Provider and Offering catalog

**Files:**
- Modify: `src/api/ai-gateway/providers/ProviderRegistry.ts`
- Test: `tests/api/ai-gateway/ProviderRegistry.test.ts`

- [ ] **Step 1: Write the failing catalog tests**

Add assertions that `bailian`, `bailian-coding-plan`, and `bailian-token-plan` project into one `bailian` product with three offerings, while Kimi exposes `official-subscription` OAuth and `api-platform` API Key options:

```ts
it('groups offerings under one provider product', () => {
  const registry = createDefaultProviderRegistry();
  expect(registry.requireProduct('bailian').offerings.map((item) => item.id)).toEqual([
    'pay-as-you-go',
    'coding-plan',
    'token-plan',
  ]);
});

it('keeps offering and authentication mode independent', () => {
  const kimi = createDefaultProviderRegistry().requireProduct('kimi');
  expect(kimi.offerings).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'official-subscription', authModes: ['oauth'] }),
    expect.objectContaining({ id: 'api-platform', authModes: ['apiKey'] }),
  ]));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test tests/api/ai-gateway/ProviderRegistry.test.ts`

Expected: FAIL because `requireProduct` and Offering descriptors do not exist.

- [ ] **Step 3: Implement the minimal descriptor API**

Add focused public types and lookup methods:

```ts
export type ProviderProductId = 'openai' | 'anthropic' | 'kimi' | 'bailian' | 'deepseek' | string;
export type OfferingAuthMode = 'oauth' | 'deviceCode' | 'apiKey' | 'local';

export interface ProviderOfferingDescriptor {
  id: string;
  runtimeProviderIds: string[];
  label: string;
  kind: 'payAsYouGo' | 'codingPlan' | 'tokenPlan' | 'officialSubscription' | 'local' | 'custom';
  authModes: OfferingAuthMode[];
  endpoints: Array<{ protocol: GatewayProtocol; baseUrl: string; region?: string }>;
  apiKeyPrefixHints?: string[];
  oauthIntegrationId?: string;
}

export interface ProviderProductDescriptor {
  id: ProviderProductId;
  label: string;
  offerings: ProviderOfferingDescriptor[];
}
```

Keep existing runtime descriptors intact and derive product descriptors from an explicit catalog so protocol adapters remain backwards compatible.

- [ ] **Step 4: Run the focused and runtime registry tests**

Run: `bun test tests/api/ai-gateway/ProviderRegistry.test.ts tests/api/ai-gateway/ProviderRuntimeAdapters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/ai-gateway/providers/ProviderRegistry.ts tests/api/ai-gateway/ProviderRegistry.test.ts
git commit -m "✨ Model AI provider offerings independently from authentication"
```

### Task 2: Multi-credential Pod repository

**Files:**
- Modify: `src/api/ai-gateway/connect/index.ts`
- Test: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`

- [ ] **Step 1: Write failing repository tests**

Cover two API keys and two OAuth accounts under the same Provider, stable ordering, legacy credential visibility, and deleting one credential without touching siblings:

```ts
it('lists multiple credentials for one provider in priority order', async () => {
  await repository.createCredential(apiKeyRecord({ id: 'kimi-key-a', priority: 20 }));
  await repository.createCredential(apiKeyRecord({ id: 'kimi-key-b', priority: 10 }));
  expect((await repository.listProviderCredentials(input('kimi'))).map((item) => item.id))
    .toEqual(['kimi-key-b', 'kimi-key-a']);
});

it('revokes only the addressed credential', async () => {
  await repository.revokeCredential({ ...input('kimi'), credentialId: 'kimi-key-a' });
  expect((await repository.listProviderCredentials(input('kimi'))).map((item) => [item.id, item.status]))
    .toEqual([['kimi-key-b', 'active'], ['kimi-key-a', 'revoked']]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test tests/api/ai-gateway/ProviderConnectAdapters.test.ts`

Expected: FAIL because repository methods still resolve one deterministic provider credential id.

- [ ] **Step 3: Extend the repository contract**

Introduce credential-addressed operations while retaining the legacy lookup as a compatibility shim:

```ts
export interface ProviderCredentialQuery {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  auth?: AuthContext;
}

export interface PodCredentialRepository {
  listProviderCredentials(input: ProviderCredentialQuery): Promise<ConnectCredentialRecord[]>;
  getCredentialById(input: ProviderCredentialQuery & { credentialId: string }): Promise<ConnectCredentialRecord | undefined>;
  createCredential(record: ConnectCredentialRecord, context?: { auth?: AuthContext }): Promise<ConnectCredentialRecord>;
  updateCredential(record: ConnectCredentialRecord, context?: { auth?: AuthContext }): Promise<ConnectCredentialRecord>;
  revokeCredential(input: ProviderCredentialQuery & { credentialId: string }): Promise<ConnectCredentialRecord | undefined>;
}
```

Generate new ids with `crypto.randomUUID()` and store `offeringId`, `priority`, `enabled`, and `health` in `metadata`. Query the credential collection once through drizzle-solid and filter by normalized provider family; do not loop over one deterministic id per Provider. All writes use the repository's drizzle-solid `insert/update` operations against `credentialResource`; do not add raw SPARQL or direct Pod fetches.

- [ ] **Step 4: Add legacy migration-on-read**

Treat the existing deterministic credential as an ordinary pool member with default metadata:

```ts
const offeringId = stringMetadata(record.metadata, 'offeringId') ?? defaultOfferingFor(record.provider);
const priority = numberMetadata(record.metadata, 'priority') ?? 100;
const enabled = booleanMetadata(record.metadata, 'enabled') ?? record.status === 'active';
```

Do not rewrite the legacy Pod record until the user updates it.

- [ ] **Step 5: Run focused tests**

Run: `bun test tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/ai-gateway/connect/index.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/ai-gateway/ProviderQuotaAdapters.test.ts
git commit -m "✨ Store multiple provider credentials in each Pod"
```

### Task 3: Credential pool management API

**Files:**
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Test: `tests/api/handlers/AiGatewayManagementHandler.test.ts`

- [ ] **Step 1: Write failing route tests**

Test safe list output, create API key with offering, enable/disable/reorder, and credential-scoped deletion:

```ts
it('returns grouped providers without credential secrets', async () => {
  const body = await invoke('GET', '/api/ai/providers');
  expect(body.data[0]).toMatchObject({ id: 'kimi', credentials: expect.any(Array) });
  expect(JSON.stringify(body)).not.toMatch(/apiKey|encryptedSecret|refreshToken/);
});

it('deletes one credential by id', async () => {
  await invoke('DELETE', '/api/ai/providers/kimi/credentials/kimi-key-a');
  expect(connectService.revokeCredential).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'kimi',
    credentialId: 'kimi-key-a',
  }));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/api/handlers/AiGatewayManagementHandler.test.ts`

Expected: FAIL with missing `/api/ai/providers` and credential-id routes.

- [ ] **Step 3: Add the grouped management routes**

Implement:

```text
GET    /api/ai/providers
POST   /api/ai/providers/:provider/credentials/api-key
PATCH  /api/ai/providers/:provider/credentials/:credentialId
DELETE /api/ai/providers/:provider/credentials/:credentialId
POST   /api/ai/providers/:provider/credentials/test
```

Accept only these mutable fields in PATCH:

```ts
type CredentialPatch = {
  label?: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string;
  expectedVersion: number;
};
```

Return only id, provider, offeringId, authMode, label, enabled, priority, health, maskedHint, expiresAt, baseUrl, version, and quota status.

- [ ] **Step 4: Keep old routes as compatibility adapters**

Map the existing `/api/ai/gateway/providers/:provider/connect/*` routes to the first eligible credential, add deprecation response headers, and ensure the new Applet no longer calls them after Task 6.

- [ ] **Step 5: Run route and auth tests**

Run: `bun test tests/api/handlers/AiGatewayManagementHandler.test.ts tests/api/ai-gateway/GatewayPrincipal.test.ts`

Expected: PASS and no secrets in serialized results.

- [ ] **Step 6: Commit**

```bash
git add src/api/handlers/AiGatewayManagementHandler.ts tests/api/handlers/AiGatewayManagementHandler.test.ts
git commit -m "✨ Expose provider credential pools through scoped management APIs"
```

### Task 4: Automatic credential and offering resolution

**Files:**
- Modify: `src/api/ai-gateway/AiGatewayService.ts`
- Modify: `src/api/ai-gateway/routing/ModelRouter.ts`
- Test: `tests/api/ai-gateway/AiGatewayService.test.ts`
- Test: `tests/api/ai-gateway/ModelRouter.test.ts`

- [ ] **Step 1: Write failing selection tests**

```ts
it('uses the first healthy credential compatible with the selected model', async () => {
  credentials.listCredentials.mockResolvedValue([
    credential({ id: 'expired-oauth', priority: 0, health: 'reauthRequired' }),
    credential({ id: 'healthy-key', priority: 10, health: 'healthy', models: ['kimi-k2.5'] }),
  ]);
  await gateway.complete(requestFor('kimi/kimi-k2.5'));
  expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
    credential: expect.objectContaining({ id: 'healthy-key' }),
  }));
});

it('never sends a token-plan key to the pay-as-you-go endpoint', async () => {
  await expect(router.resolve(routeInput({ offeringId: 'token-plan', endpointOfferingId: 'pay-as-you-go' })))
    .rejects.toMatchObject({ code: 'credential_unavailable' });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ModelRouter.test.ts`

Expected: FAIL because current route assumes one active provider credential.

- [ ] **Step 3: Implement eligible credential selection**

Add a pure selector and use it before opening secrets:

```ts
export function selectEligibleCredentials(input: {
  credentials: StoredGatewayCredential[];
  runtimeProviderId: string;
  model: string;
}): StoredGatewayCredential[] {
  return input.credentials
    .filter((item) => item.status === 'active' && item.enabled !== false)
    .filter((item) => item.health !== 'reauthRequired' && item.health !== 'disabled')
    .filter((item) => credentialSupportsRuntime(item, input.runtimeProviderId))
    .filter((item) => !item.models?.length || item.models.includes(input.model))
    .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
}
```

Try the next eligible credential only for typed quota/transient failures; authentication failure marks the addressed credential invalid and stops silent cross-account fallback.

- [ ] **Step 4: Run focused service/router tests**

Run: `bun test tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ModelRouter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/ai-gateway/AiGatewayService.ts src/api/ai-gateway/routing/ModelRouter.ts tests/api/ai-gateway/AiGatewayService.test.ts tests/api/ai-gateway/ModelRouter.test.ts
git commit -m "✨ Resolve provider offerings and credentials inside the gateway"
```

### Task 5: Merge model discovery across credentials

**Files:**
- Modify: `src/api/ai-gateway/models/ProviderModelsService.ts`
- Modify: `src/api/ai-gateway/models/ProviderModelsAdapter.ts`
- Test: `tests/api/ai-gateway/ProviderModelsAdapters.test.ts`

- [ ] **Step 1: Write failing merge tests**

```ts
it('shows one model with all discovered sources', async () => {
  const result = await service.listProvider({ webId: WEB_ID, deployment: 'local', provider: 'kimi' });
  expect(result.models).toContainEqual(expect.objectContaining({
    id: 'kimi-k2.5',
    sources: expect.arrayContaining(['official-subscription', 'api-platform']),
  }));
});

it('retains a selected model when every upstream source stops returning it', async () => {
  expect(result.models).toContainEqual(expect.objectContaining({
    id: 'kimi-old',
    availability: 'unavailable',
  }));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/api/ai-gateway/ProviderModelsAdapters.test.ts`

Expected: FAIL because discovery accepts one credential and returns no source aggregation.

- [ ] **Step 3: Implement provider-level discovery**

Add:

```ts
export interface ProviderDiscoveredModel extends DiscoveredProviderModel {
  sources: string[];
  availability: 'available' | 'unavailable' | 'statusUnknown';
}

public async listProvider(input: ProviderModelsInput): Promise<ProviderModelDiscovery> {
  const credentials = await this.credentialRepository.listProviderCredentials(input);
  const results = await Promise.allSettled(credentials.filter(isDiscoverable).map((credential) =>
    this.discoverCredential(input, credential)));
  return mergeProviderDiscoveries(input.provider, results, this.selectedModels);
}
```

Do not fail the whole Provider when one credential fails. Return source-specific errors in diagnostics while preserving any successful models.

- [ ] **Step 4: Run focused tests**

Run: `bun test tests/api/ai-gateway/ProviderModelsAdapters.test.ts tests/api/ai-gateway/ProviderCustomModels.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/ai-gateway/models/ProviderModelsService.ts src/api/ai-gateway/models/ProviderModelsAdapter.ts tests/api/ai-gateway/ProviderModelsAdapters.test.ts
git commit -m "✨ Merge provider model discovery across credential sources"
```

### Task 6: Applet client and controller grouping

**Files:**
- Modify: `packages/ai-connections/src/ai-connections-client.ts`
- Modify: `packages/ai-connections/src/controller.tsx`
- Modify: `packages/ai-connections/src/AiConnectionsList.tsx`
- Test: `packages/ai-connections/test/client.test.ts`
- Test: `packages/ai-connections/test/controller.test.tsx`
- Test: `packages/ai-connections/test/two-pane.test.tsx`

- [ ] **Step 1: Write failing DTO and list tests**

```ts
it('renders one list item for Bailian', async () => {
  renderAppletWithProviders([provider('bailian', { offerings: ['pay-as-you-go', 'coding-plan', 'token-plan'] })]);
  expect(screen.getAllByRole('option', { name: /百炼/ })).toHaveLength(1);
});

it('parses multiple credentials without exposing secrets', async () => {
  const providers = await client.listProviders();
  expect(providers[0].credentials).toHaveLength(3);
  expect(JSON.stringify(providers)).not.toMatch(/encryptedSecret|apiKey/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/ai-connections/test/client.test.ts packages/ai-connections/test/controller.test.tsx packages/ai-connections/test/two-pane.test.tsx`

Expected: FAIL because the UI catalog contains three Bailian rows and summaries contain one credential.

- [ ] **Step 3: Replace the frontend contract**

Define:

```ts
export interface AiProviderCredentialSummary {
  id: string;
  offeringId: string;
  authMode: 'oauth' | 'deviceCode' | 'apiKey' | 'local';
  label?: string;
  enabled: boolean;
  priority: number;
  health: 'healthy' | 'expired' | 'invalid' | 'unknown';
  maskedHint?: string;
  expiresAt?: string;
  version: number;
}

export interface AiProviderSummary {
  id: string;
  name: string;
  offerings: AiProviderOffering[];
  credentials: AiProviderCredentialSummary[];
  selectedModels: AiGatewayModel[];
  status: 'unconfigured' | 'available' | 'attention' | 'unavailable';
}
```

Change the controller selected key from runtime provider id to product provider id. Delete the duplicated Bailian rows from the UI catalog.

- [ ] **Step 4: Make the list strictly Provider-only**

Keep search and add in the list header; each list option contains Provider name, icon, and aggregate status only. Do not show auth-method child rows.

- [ ] **Step 5: Run Applet client/controller tests**

Run: `bun test packages/ai-connections/test/client.test.ts packages/ai-connections/test/controller.test.tsx packages/ai-connections/test/two-pane.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ai-connections/src/ai-connections-client.ts packages/ai-connections/src/controller.tsx packages/ai-connections/src/AiConnectionsList.tsx packages/ai-connections/test/client.test.ts packages/ai-connections/test/controller.test.tsx packages/ai-connections/test/two-pane.test.tsx
git commit -m "✨ Show one AI Connections list item per provider"
```

### Task 7: Provider credential-pool UI

**Files:**
- Create: `packages/ai-connections/src/AiCredentialPoolSection.tsx`
- Create: `packages/ai-connections/src/AiOfferingTabs.tsx`
- Modify: `packages/ai-connections/src/AiProviderCard.tsx`
- Modify: `packages/ai-connections/src/AiConnectionsPanel.tsx`
- Modify: `packages/ai-connections/src/AiConnectionsMain.tsx`
- Test: `packages/ai-connections/test/interactions.test.tsx`
- Test: `packages/ai-connections/test/controller.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Cover Provider-only selection, adding a second Key, disabling one Key, reordering, deleting one Key, OAuth unavailable copy, and model selection remaining provider-scoped:

```ts
it('adds a second API key without replacing the first', async () => {
  renderProvider(kimiWithCredentials([key('Production')]));
  await user.click(screen.getByRole('button', { name: '添加 API Key' }));
  await user.type(screen.getByLabelText('名称'), 'Backup');
  await user.type(screen.getByLabelText('API Key'), 'sk-backup');
  await user.click(screen.getByRole('button', { name: '测试并保存' }));
  expect(api.createApiKeyCredential).toHaveBeenCalledWith('kimi', expect.objectContaining({ label: 'Backup' }));
});

it('does not ask users for an OAuth client id', () => {
  renderProvider(kimiOAuthUnavailable());
  expect(screen.queryByLabelText(/client.?id/i)).not.toBeInTheDocument();
  expect(screen.getByText('Kimi 账号登录暂不可用')).toBeInTheDocument();
});

it('delegates anonymous Solid login to the shared auth boundary', async () => {
  render(<AiConnectionsMain controller={anonymousController} />);
  expect(screen.getByText('登录后即可管理当前 Pod 的 AI 连接。')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(anonymousController.login).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/ai-connections/test/interactions.test.tsx packages/ai-connections/test/controller.test.tsx`

Expected: FAIL because the current card has one API Key input and one provider connection state.

- [ ] **Step 3: Implement Offering tabs and credential sections**

Render OAuth accounts and API Keys under the selected Offering. Use only these primary actions:

```text
OAuth: 登录 / 添加账号 / 重新授权 / 退出
API Key: 添加 / 编辑 / 启用或停用 / 删除
Pool: 测试全部 / 保存顺序
Models: 刷新模型 / 保存
```

Use native buttons and existing shared-ui components. Keep the Provider title in the content pane header and do not add an `AI Connections` page header.

For authentication presentation:

```tsx
import { AuthBoundary } from '@undefineds.co/extension-sdk/react';
import {
  LoginConnectingView,
  LoginFailureView,
  LoginProviderListView,
} from '@undefineds.co/shared-ui';
```

- Wrap anonymous/expired Solid state in `AuthBoundary` and pass the host-owned login callback; remove the custom `<section>` login/error markup from `AiConnectionsMain`.
- Configure the shared boundary with title `登录 Xpod` and description `登录后即可管理当前 Pod 的 AI 连接。`; map the boundary's issuer argument to the existing zero-argument `controller.login()` callback so session ownership remains in the host.
- Render Provider OAuth choices with `LoginProviderListView`, pending state with `LoginConnectingView`, and recoverable failure with `LoginFailureView`.
- Do not create a Kimi/Bailian-specific `LoginCardShell`, OIDC session, issuer selector, or token store.

- [ ] **Step 4: Implement reorder without a new dependency**

Use up/down keyboard-accessible controls and HTML drag events already available in React. Persist consecutive priorities `10, 20, 30...` through credential PATCH calls.

- [ ] **Step 5: Run interaction tests**

Run: `bun test packages/ai-connections/test/interactions.test.tsx packages/ai-connections/test/controller.test.tsx packages/ai-connections/test/two-pane.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ai-connections/src/AiCredentialPoolSection.tsx packages/ai-connections/src/AiOfferingTabs.tsx packages/ai-connections/src/AiProviderCard.tsx packages/ai-connections/src/AiConnectionsPanel.tsx packages/ai-connections/src/AiConnectionsMain.tsx packages/ai-connections/test/interactions.test.tsx packages/ai-connections/test/controller.test.tsx
git commit -m "✨ Manage OAuth accounts and API keys inside each provider"
```

### Task 8: Kimi OAuth integration boundary

**Files:**
- Create: `src/api/ai-gateway/connect/OAuthIntegrationRegistry.ts`
- Create: `src/api/ai-gateway/connect/OAuthConnectAdapter.ts`
- Modify: `src/api/container/common.ts`
- Modify: `src/api/handlers/AiGatewayManagementHandler.ts`
- Test: `tests/api/ai-gateway/ProviderConnectAdapters.test.ts`
- Test: `tests/api/handlers/AiGatewayManagementHandler.test.ts`

- [ ] **Step 1: Write failing integration-boundary tests**

```ts
it('reports auth_not_available when Xpod has no issued Kimi integration', async () => {
  await expect(service.beginOAuth({ provider: 'kimi', offeringId: 'official-subscription', ...owner }))
    .rejects.toMatchObject({ code: 'auth_not_available' });
});

it('never accepts clientId from the management request body', async () => {
  const response = await invoke('POST', '/api/ai/providers/kimi/credentials/oauth/begin', {
    offeringId: 'official-subscription',
    clientId: 'user-supplied',
  });
  expect(response.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts`

Expected: FAIL because the OAuth integration registry does not exist.

- [ ] **Step 3: Implement the integration registry**

```ts
export interface OAuthIntegration {
  id: string;
  clientId: string;
  flow: 'authorizationCodePkce' | 'deviceCode';
  authorizationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint: string;
  scopes: string[];
}

export class OAuthIntegrationRegistry {
  public require(id: string): OAuthIntegration {
    const integration = this.integrations.get(id);
    if (!integration) throw new GatewayProtocolError('auth_not_available', { status: 503 });
    return integration;
  }
}
```

Load only Xpod-controlled integration configuration. Do not add `XPOD_AI_GATEWAY_KIMI_CLIENT_ID` to the user-facing setup UI and do not copy OpenCodex/Kimi CLI client identifiers.

- [ ] **Step 4: Implement standard OAuth attempt behavior**

Use PKCE/state for authorization-code integrations and the existing signed attempt store for device-code integrations. Persist resulting OAuth credentials as additional pool entries rather than replacing API keys.

- [ ] **Step 5: Run security-focused tests**

Run: `bun test tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts`

Expected: PASS, including state tampering, replay, expiry, denial, and no-secret serialization cases.

- [ ] **Step 6: Commit**

```bash
git add src/api/ai-gateway/connect/OAuthIntegrationRegistry.ts src/api/ai-gateway/connect/OAuthConnectAdapter.ts src/api/container/common.ts src/api/handlers/AiGatewayManagementHandler.ts tests/api/ai-gateway/ProviderConnectAdapters.test.ts tests/api/handlers/AiGatewayManagementHandler.test.ts
git commit -m "✨ Add a vendor-safe OAuth integration boundary"
```

### Task 9: Full regression and local product acceptance

**Files:**
- Modify if evidence requires: `docs/ai-connections-capability-audit.md`
- Test: existing test suites and local Xpod product.

- [ ] **Step 1: Run package tests**

Run:

```bash
bun test packages/ai-connections/test
```

Expected: all AI Connections package tests PASS.

- [ ] **Step 2: Run targeted API tests**

Run:

```bash
bun test \
  tests/api/ai-gateway/ProviderRegistry.test.ts \
  tests/api/ai-gateway/ProviderConnectAdapters.test.ts \
  tests/api/ai-gateway/ProviderModelsAdapters.test.ts \
  tests/api/ai-gateway/ProviderQuotaAdapters.test.ts \
  tests/api/ai-gateway/AiGatewayService.test.ts \
  tests/api/ai-gateway/ModelRouter.test.ts \
  tests/api/handlers/AiGatewayManagementHandler.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 3: Run build and mandatory integration suite**

Run:

```bash
bun run build:ts
bun run test:integration
```

Expected: both commands exit 0.

- [ ] **Step 4: Start isolated local Xpod and seed a test account**

Use the repository's `docs/cli-dev-testing.md` seed flow and a `.test-data/ai-connections-provider-pool/` runtime root. Do not reuse production secrets or write test state to the repository root.

Expected: local Xpod, account, Pod, and settings UI are reachable.

- [ ] **Step 5: Perform browser acceptance**

Verify:

1. Rail + Provider list + detail align with LinX shell and no extra page header exists.
2. Bailian appears once with three Offering tabs.
3. Kimi accepts two API keys without replacing either.
4. Disabling/deleting one key leaves its siblings intact.
5. Models are selected once per Provider and `/v1/models` shows only selected entries.
6. Kimi OAuth shows no client-id input and reports unavailable when integration is absent.
7. A real test Key completes model discovery and a minimal inference request.
8. Codex client apply still resolves the selected Provider models.
9. Anonymous/expired Solid state uses the SDK `AuthBoundary`; Provider OAuth states use shared-ui login primitives and do not render a bespoke login card.
10. Pod data mutations are observable through drizzle-solid repository calls; no new raw SPARQL or handwritten RDF mutation path exists.

- [ ] **Step 6: Update the capability audit with evidence**

Change only capabilities proven by automated and browser evidence from `partial`/`missing` to `implemented`; leave real external OAuth incomplete until a legitimate Xpod-issued integration succeeds end to end.

- [ ] **Step 7: Commit acceptance evidence**

```bash
git add docs/ai-connections-capability-audit.md
git commit -m "✅ Record AI Connections provider-pool acceptance evidence"
```
