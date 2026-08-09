import {
  configureSparqlEngine,
  type SolidDatabase,
  type SPARQLQueryEngine,
} from '@undefineds.co/drizzle-solid';
import { QueryEngine } from '@comunica/query-sparql-solid';
import { ActionObserverHttp } from '@comunica/actor-query-result-serialize-stats';
import { ActionObserverHttp as JsonActionObserverHttp } from '@comunica/actor-query-result-serialize-sparql-json';
import {
  aiModelResource,
  aiProviderResource,
  credentialResource,
} from '@undefineds.co/models';
import {
  AI_CONNECTIONS_PROVIDERS,
  type AiConnectionsProvider,
  type AiGatewayModel,
  type AiProviderCredentialSummary,
  type AiProviderOffering,
  type AiProviderSummary,
} from '@undefineds.co/ai-connections/client';
import type { AiConnectionsPodStore } from '@undefineds.co/extension-sdk/web';

export interface CreateXpodAiConnectionsPodStoreInput {
  database: SolidDatabase;
  webId: string;
  podUrl: string;
}

export function createXpodAiConnectionsPodStore(
  input: CreateXpodAiConnectionsPodStoreInput,
): AiConnectionsPodStore {
  patchBrowserComunicaObserver();
  configureSparqlEngine({
    createQueryEngine: async () => new QueryEngine() as unknown as SPARQLQueryEngine,
  });
  const settingsSparqlEndpoint = new URL('settings/-/sparql', input.podUrl).toString();
  credentialResource.setSparqlEndpoint(settingsSparqlEndpoint);
  aiProviderResource.setSparqlEndpoint(settingsSparqlEndpoint);
  aiModelResource.setSparqlEndpoint(settingsSparqlEndpoint);
  return {
    async listModels() {
      await input.database.init?.(aiModelResource);
      const rows = await input.database
        .select()
        .from(aiModelResource)
        .execute() as Record<string, unknown>[];
      return rows.map(modelSummaryFromRow).filter(isDefined);
    },
    async listProviders() {
      await input.database.init?.(credentialResource, aiProviderResource, aiModelResource);
      const credentialRows = await input.database
        .select()
        .from(credentialResource)
        .execute() as Record<string, unknown>[];
      const providerRows = await input.database
        .select()
        .from(aiProviderResource)
        .execute() as Record<string, unknown>[];
      const modelRows = await input.database
        .select()
        .from(aiModelResource)
        .execute() as Record<string, unknown>[];
      return providerSummariesFromPodRows(input, credentialRows, providerRows, modelRows);
    },
    async createApiKeyCredential(provider, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const id = credentialResource.buildId({ id: `${normalizedProvider}-${crypto.randomUUID()}` });
      const version = 1;
      const baseUrl = values.baseUrl ?? offeringBaseUrl(normalizedProvider, values.offeringId);
      const row = {
        id,
        provider: aiProviderResource.buildId({ id: normalizedProvider }),
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        accountLabel: values.label,
        label: values.label,
        baseUrl,
        keyVersion: String(version),
        reauthRequired: false,
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, {
          type: 'apiKey',
          apiKey: values.apiKey,
        }),
        encryptionAlgorithm: 'PLAINTEXT',
        metadata: {
          offeringId: values.offeringId ?? 'api-platform',
          priority: values.priority ?? 100,
          enabled: true,
          health: 'healthy',
          baseUrl,
        },
      };
      await input.database.insert(credentialResource).values(row as never).execute();
      return credentialSummaryFromRow(input, normalizedProvider, row)!;
    },
    async saveOAuthCredential(provider, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const id = credentialResource.buildId({ id: `${normalizedProvider}-oauth-${crypto.randomUUID()}` });
      const row = {
        id,
        provider: aiProviderResource.buildId({ id: normalizedProvider }),
        service: 'ai',
        authMode: 'deviceCodeOAuth',
        status: 'active',
        accountLabel: 'OAuth',
        label: 'OAuth',
        expiresAt: values.expiresAt,
        scopes: values.scope ? values.scope.split(/\s+/u).filter(Boolean) : undefined,
        keyVersion: '1',
        reauthRequired: false,
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, {
          type: 'deviceCodeOAuth',
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          expiresAt: values.expiresAt,
          scope: values.scope,
          idToken: values.idToken,
        }),
        encryptionAlgorithm: 'PLAINTEXT',
        metadata: {
          offeringId: 'official-subscription',
          priority: 100,
          enabled: true,
          health: 'healthy',
          authoritativeSubject: values.accountSubject,
        },
      };
      await input.database.insert(credentialResource).values(row as never).execute();
      return credentialSummaryFromRow(input, normalizedProvider, row)!;
    },
    async updateOAuthCredential(provider, credentialId, expectedVersion, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const summary = current && credentialSummaryFromRow(input, normalizedProvider, current);
      if (!current || !summary || summary.authMode !== 'deviceCode') throw new Error('oauth_credential_not_found');
      if (summary.version !== expectedVersion) throw new Error('credential_version_conflict');
      const patch = {
        expiresAt: values.expiresAt,
        scopes: values.scope ? values.scope.split(/\s+/u).filter(Boolean) : undefined,
        keyVersion: String(expectedVersion + 1),
        reauthRequired: false,
        status: 'active',
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, credentialId, {
          type: 'deviceCodeOAuth',
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          expiresAt: values.expiresAt,
          scope: values.scope,
          idToken: values.idToken,
        }),
        metadata: {
          ...objectValue(current.metadata),
          enabled: true,
          health: 'healthy',
          authoritativeSubject: values.accountSubject
            ?? stringValue(objectValue(current.metadata)?.authoritativeSubject),
        },
      };
      const updated = await input.database.updateById(credentialResource, credentialId, patch as never);
      if (!updated) throw new Error('credential_version_conflict');
      return credentialSummaryFromRow(input, normalizedProvider, updated as Record<string, unknown>)!;
    },
    async updateProviderCredential(provider, credentialId, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const summary = current && credentialSummaryFromRow(input, normalizedProvider, current);
      if (!current || !summary) throw new Error('credential_not_found');
      if (summary.version !== values.expectedVersion) throw new Error('credential_version_conflict');
      const metadata = {
        ...objectValue(current.metadata),
        ...(values.priority === undefined ? {} : { priority: values.priority }),
        ...(values.enabled === undefined ? {} : { enabled: values.enabled }),
        ...(values.baseUrl === undefined ? {} : { baseUrl: values.baseUrl }),
      };
      const patch = {
        ...(values.label === undefined ? {} : { accountLabel: values.label, label: values.label }),
        ...(values.baseUrl === undefined ? {} : { baseUrl: values.baseUrl }),
        ...(values.enabled === undefined ? {} : { status: values.enabled ? 'active' : 'disabled' }),
        keyVersion: String(summary.version + 1),
        metadata,
      };
      const updated = await input.database.updateById(credentialResource, credentialId, patch as never);
      if (!updated) throw new Error('credential_update_failed');
      const persisted = credentialSummaryFromRow(input, normalizedProvider, updated as Record<string, unknown>);
      if (!persisted) throw new Error('credential_update_failed');
      return persisted;
    },
    async deleteProviderCredential(provider, credentialId) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const summary = current && credentialSummaryFromRow(input, normalizedProvider, current);
      if (!summary) return undefined;
      await input.database.deleteById(credentialResource, credentialId);
      return summary;
    },
    async readCredentialSecret(provider, credentialId) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      if (!current || !credentialSummaryFromRow(input, normalizedProvider, current)) {
        throw new Error('credential_not_found');
      }
      const secret = parsePlaintextSecret(input, normalizedProvider, credentialId, current.encryptedSecret);
      if (!secret) throw new Error('credential_secret_unavailable');
      return secret;
    },
    async saveDiscoveredModels(provider, credentialId, models) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource, aiModelResource);
      await ensureProviderRow(input.database, normalizedProvider);
      const credentialRow = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const providerId = providerResourceIdForCredential(normalizedProvider, credentialRow);
      await ensureProviderResourceRow(input.database, providerId, providerName(normalizedProvider));
      const existing = await input.database
        .select()
        .from(aiModelResource)
        .execute() as Record<string, unknown>[];
      const existingIds = new Set(existing.map((row) => stringValue(row.id)).filter(isDefined));
      const discovered = models
        .map(discoveredModelValue)
        .filter(isDefined);
      const discoveredIds = new Set(discovered.map((model) => model.id));
      for (const row of existing.filter((item) => providerRelationMatches(stringValue(item.isProvidedBy), providerId))) {
        const modelId = modelKeyFromRowId(stringValue(row.id), providerId);
        if (modelId && !discoveredIds.has(modelId) && stringValue(row.status) !== 'unavailable') {
          await input.database.updateById(aiModelResource, String(row.id), { status: 'unavailable' } as never);
        }
      }
      for (const model of discovered) {
        await upsertModelRow(input.database, providerId, model, existingIds);
      }
    },
    async saveModelSelection(provider, modelIds) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(aiProviderResource, aiModelResource);
      const providerId = aiProviderResource.buildId({ id: normalizedProvider });
      await ensureProviderRow(input.database, normalizedProvider);
      const hasModel = [...new Set(modelIds.map((id) => id.includes('.ttl#')
        ? id
        : modelResourceId(normalizedProvider, id)))];
      await input.database.updateById(aiProviderResource, providerId, { hasModel } as never);
    },
  };
}

function patchBrowserComunicaObserver(): void {
  patchObserverPrototype(ActionObserverHttp.prototype);
  patchObserverPrototype(JsonActionObserverHttp.prototype);
}

function patchObserverPrototype(source: object): void {
  const prototype = source as {
    __xpodObservedActorsPatch?: boolean;
    onRun(actor: { name: string }, action: unknown, output: unknown): unknown;
  };
  if (prototype.__xpodObservedActorsPatch) return;
  const originalOnRun = prototype.onRun;
  prototype.onRun = function (this: { observedActors?: string[] }, actor, action, output) {
    if (!Array.isArray(this.observedActors)) this.observedActors = [];
    return originalOnRun.call(this, actor, action, output);
  };
  prototype.__xpodObservedActorsPatch = true;
}

function providerSummariesFromPodRows(
  input: CreateXpodAiConnectionsPodStoreInput,
  credentialRows: Record<string, unknown>[],
  providerRows: Record<string, unknown>[],
  modelRows: Record<string, unknown>[],
): AiProviderSummary[] {
  const activeRows = credentialRows
    .filter((row) => stringValue(row.service) === 'ai')
    .filter((row) => stringValue(row.status) !== 'revoked');

  return AI_CONNECTIONS_PROVIDERS.map((provider) => {
    const credentials = activeRows
      .map((row) => credentialSummaryFromRow(input, provider, row))
      .filter(isDefined)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    const providerRow = providerRows.find((row) => providerFromRelation(stringValue(row.id)) === provider);
    const selectedIds = stringListValue(providerRow?.hasModel);
    const selectedModels = selectedIds.map((selectedId) => modelSummaryFromRows(provider, selectedId, modelRows));
    return {
      id: provider,
      name: providerName(provider),
      offerings: providerOfferings(provider),
      credentials,
      selectedModels,
      status: providerStatus(credentials),
    };
  });
}

function plaintextEnvelope(
  input: CreateXpodAiConnectionsPodStoreInput,
  provider: AiConnectionsProvider,
  id: string,
  secret: Record<string, unknown>,
): string {
  return JSON.stringify({
    algorithm: 'PLAINTEXT',
    encoding: 'base64',
    ciphertext: encodeBase64Json(secret),
    webId: input.webId,
    credentialIri: credentialResource.buildIri(input.podUrl, { id }),
    provider,
  });
}

function encodeBase64Json(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function credentialSummaryFromRow(
  input: CreateXpodAiConnectionsPodStoreInput,
  expectedProvider: AiConnectionsProvider,
  row: Record<string, unknown>,
): AiProviderCredentialSummary | undefined {
  const id = stringValue(row.id);
  if (!id) return undefined;
  const provider = providerFromRelation(stringValue(row.provider)) ?? providerFromCredentialId(id);
  if (provider !== expectedProvider) return undefined;
  const metadata = objectValue(row.metadata);
  const authMode = authModeValue(row.authMode);
  if (!authMode) return undefined;
  return {
    id,
    provider,
    offeringId: stringValue(metadata?.offeringId) ?? defaultOfferingFor(provider, authMode),
    authMode,
    label: stringValue(row.accountLabel) ?? stringValue(row.label),
    enabled: booleanValue(metadata?.enabled) ?? stringValue(row.status) === 'active',
    priority: numberValue(metadata?.priority) ?? 100,
    health: healthValue(metadata?.health) ?? (booleanValue(row.reauthRequired) ? 'expired' : 'healthy'),
    maskedHint: maskedHintFromEncryptedSecret(input, provider, id, row.encryptedSecret),
    baseUrl: stringValue(row.baseUrl),
    expiresAt: isoStringValue(row.expiresAt),
    version: numberValue(row.keyVersion) ?? 0,
  };
}

function modelSummaryFromRows(
  provider: AiConnectionsProvider,
  selectedId: string,
  rows: Record<string, unknown>[],
): AiGatewayModel {
  const exactRow = rows.find((candidate) => stringValue(candidate.id) === selectedId);
  const exactProviderResource = stringValue(exactRow?.isProvidedBy);
  const selectedKey = exactRow
    ? modelKeyFromRowId(selectedId, exactProviderResource ?? provider) ?? selectedId
    : modelKeyFromRowId(selectedId, provider) ?? selectedId;
  const row = exactRow ?? rows.find((candidate) => {
    const rowId = stringValue(candidate.id);
    const rowProvider = stringValue(candidate.isProvidedBy);
    return rowId === selectedId
      || modelKeyFromRowId(rowId, provider) === selectedKey
      || (providerFromRelation(rowProvider) === provider && modelKeyFromRowId(rowId, rowProvider ?? provider) === selectedKey);
  });
  return {
    id: selectedKey,
    provider,
    offeringId: offeringFromProviderRelation(stringValue(row?.isProvidedBy)),
    resourceId: stringValue(row?.id) ?? selectedId,
    displayName: stringValue(row?.displayName),
    availability: stringValue(row?.status) === 'unavailable' || !row ? 'unavailable' : 'available',
  };
}

function modelSummaryFromRow(row: Record<string, unknown>): AiGatewayModel | undefined {
  const providerResource = stringValue(row.isProvidedBy);
  const provider = providerFromRelation(providerResource);
  const id = provider && modelKeyFromRowId(stringValue(row.id), providerResource ?? provider);
  if (!provider || !id) return undefined;
  return {
    id,
    provider,
    offeringId: offeringFromProviderRelation(providerResource),
    resourceId: stringValue(row.id),
    displayName: stringValue(row.displayName),
    availability: stringValue(row.status) === 'unavailable' ? 'unavailable' : 'available',
  };
}

function discoveredModelValue(value: unknown): { id: string; displayName?: string } | undefined {
  const row = objectValue(value);
  const id = stringValue(row?.id);
  if (!id) return undefined;
  return { id, displayName: stringValue(row?.displayName) };
}

function providerResourceIdForCredential(
  provider: AiConnectionsProvider,
  credentialRow: Record<string, unknown> | null,
): string {
  const rawProvider = stringValue(credentialRow?.provider);
  const rawProviderReference = providerResourceReference(rawProvider);
  const rawProviderKey = providerResourceKey(rawProvider);
  if (rawProviderReference && rawProviderKey && rawProviderKey !== provider && rawProviderReference.includes('#')) {
    return aiProviderResource.buildId({ id: rawProviderReference });
  }

  const offeringId = stringValue(objectValue(credentialRow?.metadata)?.offeringId);
  const canonicalOfferingId = canonicalOfferingIdFor(provider, offeringId ?? runtimeOfferingIdFor(provider, rawProviderKey));
  if (canonicalOfferingId) {
    return aiProviderResource.buildId({ id: `${provider}-${canonicalOfferingId}.ttl#this` });
  }

  return aiProviderResource.buildId({ id: provider });
}

function canonicalOfferingIdFor(
  provider: AiConnectionsProvider,
  offeringId: string | undefined,
): string | undefined {
  if (!offeringId) return undefined;
  const normalized = offeringId.trim().toLowerCase();
  if (provider === 'bailian') {
    if (normalized === 'token-plan') return 'token-plan-personal';
    if (normalized === 'coding-plan') return 'coding-plan-pro';
    if (normalized === 'payg') return 'pay-as-you-go';
  }
  return normalized;
}

function runtimeOfferingIdFor(
  provider: AiConnectionsProvider,
  providerKey: string | undefined,
): string | undefined {
  if (!providerKey || providerKey === provider) return undefined;
  if (provider === 'bailian') {
    if (providerKey === 'bailian-token-plan') return 'token-plan-personal';
    if (providerKey === 'bailian-coding-plan') return 'coding-plan-pro';
  }
  return undefined;
}

function providerRelationMatches(value: string | undefined, expected: string): boolean {
  const actualReference = providerResourceReference(value);
  const expectedReference = providerResourceReference(expected);
  return actualReference !== undefined && actualReference === expectedReference;
}

async function ensureProviderRow(database: SolidDatabase, provider: AiConnectionsProvider): Promise<void> {
  const id = aiProviderResource.buildId({ id: provider });
  const rows = await database.select().from(aiProviderResource).execute() as Record<string, unknown>[];
  if (rows.some((row) => providerRelationMatches(stringValue(row.id), id))) return;
  await database.insert(aiProviderResource).values({
    id,
    displayName: providerName(provider),
  } as never).execute();
}

async function ensureProviderResourceRow(
  database: SolidDatabase,
  providerId: string,
  displayName: string,
): Promise<void> {
  const rows = await database.select().from(aiProviderResource).execute() as Record<string, unknown>[];
  if (rows.some((row) => providerRelationMatches(stringValue(row.id), providerId))) return;
  await database.insert(aiProviderResource).values({
    id: providerId,
    displayName,
  } as never).execute();
}

async function upsertModelRow(
  database: SolidDatabase,
  providerId: string,
  model: { id: string; displayName?: string },
  existingIds: Set<string>,
): Promise<void> {
  const id = modelResourceId(providerId, model.id);
  const patch = {
    displayName: model.displayName ?? model.id,
    isProvidedBy: providerId,
    status: 'active',
  };
  if (existingIds.has(id)) {
    await database.updateById(aiModelResource, id, patch as never);
    return;
  }
  await database.insert(aiModelResource).values({ id, ...patch } as never).execute();
  existingIds.add(id);
}

function modelResourceId(provider: string, modelId: string): string {
  const providerResource = providerResourceReference(provider) ?? `${provider}.ttl`;
  const providerDocument = providerResource.split('#', 1)[0] ?? providerResource;
  return `${providerDocument}#${encodeURIComponent(modelId)}`;
}

function modelKeyFromRowId(id: string | undefined, provider: string): string | undefined {
  if (!id) return undefined;
  const providerResource = providerResourceReference(provider);
  const providerDocument = providerResource?.split('#', 1)[0] ?? provider;
  const marker = providerDocument.endsWith('.ttl') ? `${providerDocument}#` : `${providerDocument}.ttl#`;
  const index = id.lastIndexOf(marker);
  if (index < 0) return undefined;
  try {
    return decodeURIComponent(id.slice(index + marker.length));
  } catch {
    return id.slice(index + marker.length);
  }
}

function stringListValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(stringValue).filter(isDefined);
  const single = stringValue(value);
  return single ? [single] : [];
}

function providerOfferings(provider: AiConnectionsProvider): AiProviderOffering[] {
  if (provider === 'kimi') {
    return [
      { id: 'official-subscription', label: '官方订阅', kind: 'officialSubscription', authModes: ['oauth'] },
      { id: 'api-platform', label: 'API 平台', kind: 'payAsYouGo', authModes: ['apiKey'] },
    ];
  }
  if (provider === 'bailian') {
    const consoleUrl = 'https://bailian.console.aliyun.com/';
    const usagePolicyUrl = 'https://help.aliyun.com/zh/model-studio/';
    return [
      bailianOffering({ id: 'pay-as-you-go', label: 'Pay as You Go', kind: 'payAsYouGo', runtimeProviderIds: ['bailian'], credentialPrefixHints: ['sk-'], region: 'cn', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', quotaStrategy: 'console', consoleUrl, usagePolicyUrl }),
      bailianOffering({ id: 'token-plan', label: 'Token Plan Personal', kind: 'tokenPlan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', quotaStrategy: 'subscription', consoleUrl, usagePolicyUrl }),
      bailianOffering({ id: 'token-plan-team', label: 'Token Plan Team', kind: 'tokenPlan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', quotaStrategy: 'subscription', consoleUrl, usagePolicyUrl }),
      bailianOffering({ id: 'coding-plan', label: 'Coding Plan Pro', kind: 'codingPlan', runtimeProviderIds: ['bailian-coding-plan'], credentialPrefixHints: ['sk-sp-'], region: 'cn', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', quotaStrategy: 'subscription', consoleUrl, usagePolicyUrl }),
    ];
  }
  return [{ id: 'api-platform', label: 'API 平台', kind: 'payAsYouGo', authModes: ['apiKey'] }];
}

function bailianOffering(input: {
  id: string;
  label: string;
  kind: string;
  runtimeProviderIds: string[];
  credentialPrefixHints: string[];
  region: string;
  baseUrl: string;
  quotaStrategy: string;
  consoleUrl: string;
  usagePolicyUrl: string;
}): AiProviderOffering {
  return {
    id: input.id,
    label: input.label,
    productLabel: 'Alibaba Bailian',
    kind: input.kind,
    authModes: ['apiKey'],
    runtimeProviderIds: input.runtimeProviderIds,
    credentialPrefixHints: input.credentialPrefixHints,
    consoleUrl: input.consoleUrl,
    subscriptionUrl: input.consoleUrl,
    endpoints: [{ protocol: 'chatCompletions', baseUrl: input.baseUrl, region: input.region }],
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: input.quotaStrategy, url: input.consoleUrl },
    usagePolicyUrl: input.usagePolicyUrl,
    region: input.region,
  };
}

function providerStatus(credentials: AiProviderCredentialSummary[]): AiProviderSummary['status'] {
  if (credentials.some((credential) => credential.health === 'expired' || credential.health === 'invalid')) {
    return 'attention';
  }
  if (credentials.some((credential) => credential.enabled)) return 'available';
  return credentials.length > 0 ? 'configured' : 'unconfigured';
}

function providerName(provider: AiConnectionsProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'kimi':
      return 'Kimi';
    case 'bailian':
      return '百炼';
    case 'deepseek':
      return 'DeepSeek';
  }
}

function defaultOfferingFor(provider: AiConnectionsProvider, authMode: AiProviderCredentialSummary['authMode']): string {
  if (provider === 'kimi' && (authMode === 'oauth' || authMode === 'deviceCode')) {
    return 'official-subscription';
  }
  if (provider === 'bailian') return 'pay-as-you-go';
  return 'api-platform';
}

function offeringBaseUrl(provider: AiConnectionsProvider, offeringId?: string): string | undefined {
  const offering = providerOfferings(provider).find((candidate) =>
    candidate.id === (offeringId ?? defaultOfferingFor(provider, 'apiKey')));
  if (!offering) return undefined;
  const discoveryProtocol = offering.modelDiscovery?.endpointProtocol;
  return offering.endpoints?.find((endpoint) => endpoint.protocol === discoveryProtocol)?.baseUrl
    ?? offering.endpoints?.[0]?.baseUrl;
}

function maskedHintFromEncryptedSecret(
  input: CreateXpodAiConnectionsPodStoreInput,
  provider: AiConnectionsProvider,
  id: string,
  encryptedSecret: unknown,
): string | undefined {
  const parsed = parsePlaintextSecret(input, provider, id, encryptedSecret);
  const apiKey = stringValue(parsed?.apiKey);
  if (!apiKey) return undefined;
  return apiKey.length <= 8
    ? `${apiKey.slice(0, 2)}…`
    : `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}

function parsePlaintextSecret(
  input: CreateXpodAiConnectionsPodStoreInput,
  provider: AiConnectionsProvider,
  id: string,
  encryptedSecret: unknown,
): Record<string, unknown> | undefined {
  if (typeof encryptedSecret !== 'string' || !encryptedSecret.trim()) return undefined;
  try {
    const envelope = JSON.parse(encryptedSecret) as Record<string, unknown>;
    if (envelope.algorithm !== 'PLAINTEXT'
      || envelope.webId !== input.webId
      || envelope.provider !== provider) {
      return undefined;
    }
    const expectedIri = credentialResource.buildIri(input.podUrl, { id });
    if (envelope.credentialIri !== expectedIri) {
      return undefined;
    }
    const secret = envelope.encoding === 'base64'
      ? decodeBase64Json(String(envelope.ciphertext))
      : JSON.parse(String(envelope.ciphertext));
    return objectValue(secret);
  } catch {
    return undefined;
  }
}

function decodeBase64Json(value: string): unknown {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function providerFromRelation(value: string | undefined): AiConnectionsProvider | undefined {
  return providerValue(providerResourceKey(value));
}

function offeringFromProviderRelation(value: string | undefined): string | undefined {
  const key = providerResourceKey(value);
  if (!key) return undefined;
  if (key === 'bailian-token-plan-personal') return 'token-plan';
  if (key === 'bailian-token-plan-team') return 'token-plan-team';
  if (key === 'bailian-coding-plan-pro') return 'coding-plan';
  if (key === 'bailian-pay-as-you-go') return 'pay-as-you-go';
  for (const provider of AI_CONNECTIONS_PROVIDERS) {
    if (key.startsWith(`${provider}-`)) return key.slice(provider.length + 1);
  }
  return undefined;
}

function providerFromCredentialId(id: string): AiConnectionsProvider | undefined {
  const match = /\/([^/#]+)\.ttl#/u.exec(id);
  return providerValue(match?.[1]);
}

function providerValue(value: unknown): AiConnectionsProvider | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((AI_CONNECTIONS_PROVIDERS as readonly string[]).includes(normalized)) {
    return normalized as AiConnectionsProvider;
  }
  for (const provider of AI_CONNECTIONS_PROVIDERS) {
    if (normalized.startsWith(`${provider}-`)) return provider;
    if (provider === 'bailian' && (normalized === 'bailian-token-plan' || normalized === 'bailian-coding-plan')) {
      return provider;
    }
  }
  return undefined;
}

function providerResourceReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutFragment = value.split('#', 1)[0] ?? value;
  const fileName = withoutFragment.split('/').filter(Boolean).at(-1) ?? withoutFragment;
  if (!fileName) return undefined;
  const document = fileName.endsWith('.ttl') ? fileName : `${fileName}.ttl`;
  const fragmentIndex = value.indexOf('#');
  return fragmentIndex < 0 ? document : `${document}${value.slice(fragmentIndex)}`;
}

function providerResourceKey(value: string | undefined): string | undefined {
  const reference = providerResourceReference(value);
  if (!reference) return undefined;
  return (reference.split('#', 1)[0] ?? reference).replace(/\.ttl$/u, '');
}

function authModeValue(value: unknown): AiProviderCredentialSummary['authMode'] | undefined {
  if (value === 'oauth' || value === 'deviceCode' || value === 'apiKey' || value === 'local') {
    return value;
  }
  if (value === 'deviceCodeOAuth') return 'deviceCode';
  return undefined;
}

function healthValue(value: unknown): AiProviderCredentialSummary['health'] | undefined {
  if (value === 'healthy' || value === 'expired' || value === 'invalid' || value === 'unknown') {
    return value;
  }
  if (value === 'reauthRequired') return 'expired';
  if (value === 'disabled') return 'unknown';
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isoStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return stringValue(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
