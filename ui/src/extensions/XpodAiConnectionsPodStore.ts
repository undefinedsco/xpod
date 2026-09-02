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
import type {
  AiConnectionsModelSelection,
  AiConnectionsPodStore,
} from '@undefineds.co/extension-sdk/web';

// Keep the Pod adapter tolerant while consumers roll from an older compiled
// client package; the source catalog includes newer providers before every
// workspace consumer has rebuilt its dist tuple.
const POD_PROVIDERS = Array.from(new Set([...AI_CONNECTIONS_PROVIDERS, 'zhipu', 'ollama', 'custom'])) as AiConnectionsProvider[];

export interface CreateXpodAiConnectionsPodStoreInput {
  database: SolidDatabase;
  authenticatedFetch?: typeof fetch;
  webId: string;
  podUrl: string;
  /** The current host can import a local OpenAI account session into this Pod. */
  openAiSubscriptionImportAvailable?: boolean;
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
      const offeringId = values.offeringId ?? defaultOfferingFor(normalizedProvider, 'apiKey');
      const baseUrl = values.baseUrl ?? offeringBaseUrl(normalizedProvider, offeringId);
      const proxyUrl = normalizeProxyUrl(values.proxyUrl);
      const row = {
        id,
        provider: normalizedProvider === 'custom'
          ? providerResourceIdForCustomCredential(id)
          : providerResourceIdForOffering(normalizedProvider, offeringId),
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        accountLabel: values.label,
        label: values.label,
        baseUrl,
        proxyUrl,
        keyVersion: String(version),
        reauthRequired: false,
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, {
          type: 'apiKey',
          apiKey: values.apiKey,
        }),
        encryptionAlgorithm: 'PLAINTEXT',
        metadata: {
          offeringId,
          priority: values.priority ?? 100,
          enabled: true,
          health: 'unknown',
          baseUrl,
          ...(values.compatibility ? { compatibility: values.compatibility } : {}),
        },
      };
      await input.database.insert(credentialResource).values(row as never).execute();
      return credentialSummaryFromRow(input, normalizedProvider, row)!;
    },
    async createLocalCredential(provider, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const id = credentialResource.buildId({ id: `${normalizedProvider}-local-${crypto.randomUUID()}` });
      const offeringId = values.offeringId ?? defaultOfferingFor(normalizedProvider, 'local');
      const baseUrl = values.baseUrl ?? offeringBaseUrl(normalizedProvider, offeringId);
      const row = {
        id,
        provider: providerResourceIdForOffering(normalizedProvider, offeringId),
        service: 'ai',
        authMode: 'local',
        status: 'active',
        accountLabel: values.label ?? 'Local',
        label: values.label ?? 'Local',
        baseUrl,
        keyVersion: '1',
        reauthRequired: false,
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, { type: 'local' }),
        encryptionAlgorithm: 'PLAINTEXT',
        metadata: {
          offeringId,
          priority: values.priority ?? 100,
          enabled: true,
          health: 'unknown',
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
        provider: providerResourceIdForOffering(normalizedProvider, 'official-subscription'),
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
        ...(values.proxyUrl === undefined ? {} : { proxyUrl: normalizeProxyUrl(values.proxyUrl) }),
      };
      const patch = {
        ...(values.label === undefined ? {} : { accountLabel: values.label, label: values.label }),
        ...(values.baseUrl === undefined ? {} : { baseUrl: values.baseUrl }),
        ...(values.proxyUrl === undefined ? {} : { proxyUrl: normalizeProxyUrl(values.proxyUrl) }),
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
    async markCredentialHealth(provider, credentialId, health, expectedVersion) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource);
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const summary = current && credentialSummaryFromRow(input, normalizedProvider, current);
      if (!current || !summary) throw new Error('credential_not_found');
      if (summary.version !== expectedVersion) throw new Error('credential_version_conflict');
      const updated = await input.database.updateById(credentialResource, credentialId, {
        keyVersion: String(summary.version + 1),
        metadata: { ...objectValue(current.metadata), health },
      } as never);
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
      const credentialRow = await findCredentialRow(input, credentialId);
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
    async saveModelSelection(provider, selections, credentialId) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(aiProviderResource, aiModelResource);
      const scopedCredential = normalizedProvider === 'custom' && credentialId
        ? await findCredentialRow(input, credentialId)
        : null;
      if (normalizedProvider === 'custom' && credentialId && !scopedCredential) {
        throw new Error('credential_not_found');
      }
      const providerId = scopedCredential
        ? providerResourceIdForCredential(normalizedProvider, scopedCredential)
        : aiProviderResource.buildId({ id: normalizedProvider });
      await ensureProviderResourceRow(input.database, providerId, providerName(normalizedProvider));
      const providerRows = await input.database
        .select()
        .from(aiProviderResource)
        .execute() as Record<string, unknown>[];
      const persistedProviderRow = providerRows.find(
        (row) => providerRelationMatches(stringValue(row.id), providerId),
      );
      const persistedProviderId = stringValue(persistedProviderRow?.id) ?? providerId;
      const previousModelIds = stringListValue(persistedProviderRow?.hasModel);
      const modelRows = await input.database
        .select()
        .from(aiModelResource)
        .execute() as Record<string, unknown>[];
      const hasModel = [...new Set(selections.map((selection) =>
        modelSelectionResourceId(normalizedProvider, selection, modelRows, scopedCredential ? providerId : undefined)))];
      const updated = await input.database.updateById(
        aiProviderResource,
        persistedProviderId,
        { hasModel } as never,
      );
      if (!updated) throw new Error('provider_model_selection_update_failed');
      if (input.authenticatedFetch) {
        // drizzle-solid 0.3.18 currently acknowledges link-array updates without
        // serializing every URI triple. Keep the exact ORM update above as the
        // primary path, then repair this one RDF relation through authenticated
        // Solid PATCH until the adapter fix reaches Xpod. Removal criteria and
        // the upstream reproduction are tracked in docs/drizzle-solid-link-array-update-todo.md.
        await persistModelSelectionLinks(input, persistedProviderId, previousModelIds, hasModel);
      }
    },
  };
}

const HAS_MODEL_PREDICATE = 'https://undefineds.co/ns#hasModel';

async function persistModelSelectionLinks(
  input: CreateXpodAiConnectionsPodStoreInput,
  providerId: string,
  previousModelIds: string[],
  modelIds: string[],
): Promise<void> {
  const providerIri = absoluteResourceIri(aiProviderResource, input.podUrl, providerId);
  const previousModelIris = previousModelIds
    .map((id) => absoluteResourceIri(aiModelResource, input.podUrl, id));
  const modelIris = modelIds.map((id) => absoluteResourceIri(aiModelResource, input.podUrl, id));
  const triples = (iris: string[]) => iris
    .map((modelIri) => `<${providerIri}> <${HAS_MODEL_PREDICATE}> <${modelIri}> .`)
    .join('\n');
  const operations = [
    previousModelIris.length > 0 ? `DELETE DATA { ${triples(previousModelIris)} }` : undefined,
    modelIris.length > 0 ? `INSERT DATA { ${triples(modelIris)} }` : undefined,
  ].filter((operation): operation is string => Boolean(operation));
  if (operations.length === 0) return;
  const response = await input.authenticatedFetch!(providerIri.split('#', 1)[0]!, {
    method: 'PATCH',
    headers: { 'content-type': 'application/sparql-update' },
    body: operations.join(';\n'),
  });
  if (!response.ok) throw new Error(`provider_model_selection_persist_failed:${response.status}`);
}

function absoluteResourceIri(
  resource: typeof aiProviderResource | typeof aiModelResource,
  podUrl: string,
  id: string,
): string {
  if (/^https?:\/\//u.test(id)) return id;
  return resource.buildIri(podUrl, { id } as never);
}

async function findCredentialRow(
  input: CreateXpodAiConnectionsPodStoreInput,
  credentialIdOrIri: string,
): Promise<Record<string, unknown> | null> {
  const direct = await input.database.findById(credentialResource, credentialIdOrIri) as Record<string, unknown> | null;
  if (direct) return direct;
  const rows = await input.database
    .select()
    .from(credentialResource)
    .execute() as Record<string, unknown>[];
  return rows.find((row) => {
    const id = stringValue(row.id);
    return id === credentialIdOrIri
      || (id ? credentialResource.buildIri(input.podUrl, { id }) === credentialIdOrIri : false);
  }) ?? null;
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

  return POD_PROVIDERS.map((provider) => {
    const credentials = activeRows
      .map((row) => credentialSummaryFromRow(input, provider, row))
      .filter(isDefined)
      .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    const providerRow = providerRows.find((row) => providerResourceKey(stringValue(row.id)) === provider);
    const selectedIds = stringListValue(providerRow?.hasModel);
    const selectedModels = selectedIds.map((selectedId) => modelSummaryFromRows(provider, selectedId, modelRows));
    return {
      id: provider,
      name: provider === 'custom'
        ? credentials.find((credential) => credential.label)?.label ?? providerName(provider)
        : providerName(provider),
      offerings: provider === 'custom'
        ? customProviderOfferings(activeRows.filter((row) => credentialSummaryFromRow(input, provider, row)))
        : providerOfferings(provider, input.openAiSubscriptionImportAvailable === true),
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
    offeringId: stringValue(metadata?.offeringId)
      ?? offeringFromProviderRelation(stringValue(row.provider))
      ?? defaultOfferingFor(provider, authMode),
    authMode,
    label: stringValue(row.accountLabel) ?? stringValue(row.label),
    enabled: booleanValue(metadata?.enabled) ?? stringValue(row.status) === 'active',
    priority: numberValue(metadata?.priority) ?? 100,
    health: healthValue(metadata?.health) ?? (booleanValue(row.reauthRequired) ? 'expired' : 'healthy'),
    maskedHint: maskedHintFromEncryptedSecret(input, provider, id, row.encryptedSecret),
    baseUrl: stringValue(row.baseUrl),
    proxyUrl: redactProxyUrl(stringValue(row.proxyUrl) ?? stringValue(metadata?.proxyUrl)),
    compatibility: customCompatibilitySummary(metadata?.compatibility),
    expiresAt: isoStringValue(row.expiresAt),
    version: numberValue(row.keyVersion) ?? 0,
  };
}

function customCompatibilitySummary(value: unknown): 'auto' | 'openai' | 'anthropic' | undefined {
  return value === 'auto' || value === 'openai' || value === 'anthropic' ? value : undefined;
}

function modelSummaryFromRows(
  provider: AiConnectionsProvider,
  selectedId: string,
  rows: Record<string, unknown>[],
): AiGatewayModel {
  const exactRow = rows.find((candidate) => (
    providerResourceReference(stringValue(candidate.id)) === providerResourceReference(selectedId)
  ));
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
    credentialId: customCredentialIdFromProviderRelation(exactProviderResource),
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
    credentialId: customCredentialIdFromProviderRelation(providerResource),
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

function providerResourceIdForOffering(
  provider: AiConnectionsProvider,
  offeringId: string,
): string {
  const canonicalOfferingId = canonicalOfferingIdFor(provider, offeringId) ?? offeringId;
  return aiProviderResource.buildId({ id: `${provider}-${canonicalOfferingId}.ttl#this` });
}

function providerResourceIdForCustomCredential(credentialId: string): string {
  return aiProviderResource.buildId({ id: `custom-instance-${encodeURIComponent(credentialId)}.ttl#this` });
}

function customCredentialIdFromProviderRelation(value: string | undefined): string | undefined {
  const key = providerResourceKey(value);
  const encoded = key?.startsWith('custom-instance-') ? key.slice('custom-instance-'.length) : undefined;
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
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

function modelSelectionResourceId(
  provider: AiConnectionsProvider,
  selection: AiConnectionsModelSelection,
  rows: Record<string, unknown>[],
  scopedProviderId?: string,
): string {
  const resourceId = stringValue(selection.resourceId);
  const offeringId = canonicalOfferingIdFor(provider, stringValue(selection.offeringId));
  const providerId = scopedProviderId ?? (offeringId
    ? aiProviderResource.buildId({ id: `${provider}-${offeringId}.ttl#this` })
    : aiProviderResource.buildId({ id: provider }));
  const selectionId = stringValue(selection.id);
  const matchingRows = selectionId ? rows.filter((row) => {
    const rowProvider = stringValue(row.isProvidedBy);
    const rowProviderKey = providerResourceKey(rowProvider);
    const belongsToProduct = scopedProviderId
      ? providerRelationMatches(rowProvider, scopedProviderId)
      : rowProviderKey === provider
      || rowProviderKey?.startsWith(`${provider}-`) === true;
    return belongsToProduct
      && modelKeyFromRowId(stringValue(row.id), rowProvider ?? providerId) === selectionId;
  }) : [];
  const exactRow = scopedProviderId
    ? matchingRows[0]
    : offeringId
    ? matchingRows.find((row) => providerRelationMatches(stringValue(row.isProvidedBy), providerId))
    : matchingRows.length === 1 ? matchingRows[0] : undefined;
  if (resourceId) {
    const row = rows.find((candidate) => stringValue(candidate.id) === resourceId);
    if (!row && exactRow) return String(exactRow.id);
    const rowProvider = stringValue(row?.isProvidedBy);
    const rowProviderKey = providerResourceKey(rowProvider);
    const matchesProduct = scopedProviderId
      ? providerRelationMatches(rowProvider, scopedProviderId)
      : rowProviderKey === provider
      || rowProviderKey?.startsWith(`${provider}-`) === true;
    const matchesOffering = Boolean(scopedProviderId) || !offeringId || providerRelationMatches(rowProvider, providerId);
    if (!row || !matchesProduct || !matchesOffering) {
      throw new Error('invalid_model_selection_resource');
    }
    return resourceId;
  }

  if (!selectionId) throw new Error('invalid_model_selection_resource');
  return stringValue(exactRow?.id) ?? modelResourceId(providerId, selectionId);
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

function providerOfferings(
  provider: AiConnectionsProvider,
  openAiSubscriptionImportAvailable = false,
): AiProviderOffering[] {
  return (PROVIDER_OFFERINGS[provider] ?? DEFAULT_PROVIDER_OFFERINGS).map((offering) => {
    if (
      provider === 'openai'
      && offering.id === 'official-subscription'
      && openAiSubscriptionImportAvailable
    ) {
      return {
        ...offering,
        lifecycle: 'active',
        authModes: ['local'],
      };
    }
    return { ...offering };
  });
}

function customProviderOfferings(credentialRows: Record<string, unknown>[]): AiProviderOffering[] {
  const configured = new Map<string, AiProviderOffering>();
  for (const row of credentialRows) {
    const metadata = objectValue(row.metadata);
    const offeringId = stringValue(metadata?.offeringId) ?? 'openai-compatible';
    const compatibility = customCompatibilityValue(metadata?.compatibility, offeringId);
    const baseUrl = stringValue(row.baseUrl) ?? stringValue(metadata?.baseUrl);
    const base = CUSTOM_DEFAULT_OFFERINGS.find((offering) => offering.id === offeringId)
      ?? CUSTOM_DEFAULT_OFFERINGS.find((offering) => offering.id === `${compatibility}-compatible`)
      ?? CUSTOM_DEFAULT_OFFERINGS[0]!;
    configured.set(offeringId, {
      ...base,
      id: offeringId,
      endpoints: baseUrl
        ? [{ protocol: compatibility === 'anthropic' ? 'anthropic' : 'chatCompletions', baseUrl }]
        : base.endpoints,
      modelDiscovery: compatibility === 'anthropic'
        ? { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' }
        : { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    });
  }
  return configured.size > 0 ? [...configured.values()] : CUSTOM_DEFAULT_OFFERINGS;
}

function customCompatibilityValue(value: unknown, offeringId?: string): 'openai' | 'anthropic' {
  if (value === 'anthropic' || offeringId === 'anthropic-compatible') return 'anthropic';
  return 'openai';
}

const DEFAULT_PROVIDER_OFFERINGS: AiProviderOffering[] = [
  { id: 'api-platform', label: 'API 平台', kind: 'api-platform', lifecycle: 'active', authModes: ['apiKey'] },
];

const CUSTOM_DEFAULT_OFFERINGS: AiProviderOffering[] = [
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    kind: 'api-platform',
    lifecycle: 'active',
    authModes: ['apiKey'],
    runtimeProviderIds: ['custom'],
    endpoints: [],
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: 'openaiCompatible', url: '/usage' },
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic 兼容',
    kind: 'api-platform',
    lifecycle: 'active',
    authModes: ['apiKey'],
    runtimeProviderIds: ['custom'],
    endpoints: [],
    modelDiscovery: { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' },
    quota: { strategy: 'console', url: '' },
  },
];

const KIMI_SUBSCRIPTION_URL = 'https://www.kimi.com/code';
const KIMI_USAGE_POLICY_URL = 'https://www.kimi.com/user/agreement';
const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_ANTHROPIC_BASE_URL = 'https://api.kimi.com/coding/';
const MOONSHOT_CONSOLE_URL = 'https://platform.moonshot.cn/console/api-keys';
const MOONSHOT_ACCOUNT_URL = 'https://platform.moonshot.cn/console/account';
const MOONSHOT_USAGE_POLICY_URL = 'https://platform.moonshot.cn/docs/intro';
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';
const BAILIAN_CONSOLE_URL = 'https://bailian.console.aliyun.com/';
const BAILIAN_USAGE_POLICY_URL = 'https://help.aliyun.com/zh/model-studio/';
const ZHIPU_CONSOLE_URL = 'https://open.bigmodel.cn/usercenter/apikeys';
const ZHIPU_USAGE_POLICY_URL = 'https://open.bigmodel.cn/';
const ZHIPU_API_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const ZHIPU_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

const PROVIDER_OFFERINGS: Partial<Record<AiConnectionsProvider, AiProviderOffering[]>> = {
  openai: [
    {
      id: 'official-subscription',
      label: 'OpenAI Subscription',
      kind: 'oauth-subscription',
      lifecycle: 'unavailable',
      authModes: ['oauth'],
      productLabel: 'OpenAI',
      runtimeProviderIds: ['openai'],
      credentialPrefixHints: [],
      consoleUrl: 'https://chatgpt.com/codex',
      subscriptionUrl: 'https://chatgpt.com/codex',
      endpoints: [],
      modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'responses' },
      quota: { strategy: 'subscription', url: 'https://chatgpt.com/codex' },
      usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
      region: 'global',
    },
    {
      id: 'api-platform',
      label: 'API 平台',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: 'OpenAI',
      runtimeProviderIds: ['openai'],
      credentialPrefixHints: ['sk-'],
      consoleUrl: 'https://platform.openai.com/api-keys',
      subscriptionUrl: 'https://platform.openai.com/settings/organization/billing/overview',
      endpoints: [
        { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
        { protocol: 'chatCompletions', baseUrl: 'https://api.openai.com/v1' },
      ],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'responses' },
      quota: { strategy: 'providerApi', url: 'https://platform.openai.com/usage' },
      usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
      region: 'global',
    },
  ],
  anthropic: [
    {
      id: 'official-subscription',
      label: 'Claude Code 订阅',
      kind: 'oauth-subscription',
      lifecycle: 'unavailable',
      authModes: ['oauth'],
      productLabel: 'Anthropic',
      runtimeProviderIds: ['anthropic'],
      credentialPrefixHints: [],
      consoleUrl: 'https://claude.ai/',
      subscriptionUrl: 'https://claude.ai/settings/billing',
      endpoints: [],
      modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'anthropic' },
      quota: { strategy: 'subscription', url: 'https://claude.ai/settings/usage' },
      usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
      region: 'global',
    },
    {
      id: 'api-platform',
      label: 'API 平台',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: 'Anthropic',
      runtimeProviderIds: ['anthropic'],
      credentialPrefixHints: ['sk-ant-'],
      consoleUrl: 'https://console.anthropic.com/settings/keys',
      subscriptionUrl: 'https://console.anthropic.com/settings/plans',
      endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }],
      modelDiscovery: { strategy: 'anthropic', path: '/models', endpointProtocol: 'anthropic' },
      quota: { strategy: 'console', url: 'https://console.anthropic.com/settings/limits' },
      usagePolicyUrl: 'https://www.anthropic.com/legal/aup',
      region: 'global',
    },
  ],
  kimi: [
    kimiOffering({
      id: 'subscription-key',
      label: 'Token 套餐',
      kind: 'token-plan',
      authModes: ['apiKey'],
      productLabel: 'Kimi Coding',
      runtimeProviderIds: ['kimi'],
      credentialPrefixHints: ['sk-kimi-'],
      baseUrl: KIMI_CODING_BASE_URL,
      anthropicBaseUrl: KIMI_ANTHROPIC_BASE_URL,
      quotaStrategy: 'subscription',
      quotaUrl: KIMI_SUBSCRIPTION_URL,
      consoleUrl: KIMI_SUBSCRIPTION_URL,
      subscriptionUrl: KIMI_SUBSCRIPTION_URL,
      usagePolicyUrl: KIMI_USAGE_POLICY_URL,
    }),
    kimiOffering({
      id: 'api-platform',
      label: 'API 平台',
      kind: 'api-platform',
      authModes: ['apiKey'],
      productLabel: 'Moonshot AI',
      runtimeProviderIds: ['kimi'],
      credentialPrefixHints: ['sk-'],
      baseUrl: MOONSHOT_BASE_URL,
      quotaStrategy: 'console',
      quotaUrl: MOONSHOT_ACCOUNT_URL,
      consoleUrl: MOONSHOT_CONSOLE_URL,
      subscriptionUrl: MOONSHOT_ACCOUNT_URL,
      usagePolicyUrl: MOONSHOT_USAGE_POLICY_URL,
    }),
  ],
  bailian: [
    bailianOffering({ id: 'pay-as-you-go', label: 'Pay as You Go', kind: 'api-platform', runtimeProviderIds: ['bailian'], credentialPrefixHints: ['sk-'], region: 'cn', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', quotaStrategy: 'console', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'token-plan', label: 'Token Plan Personal', kind: 'token-plan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'token-plan-team', label: 'Token Plan Team', kind: 'token-plan', runtimeProviderIds: ['bailian-token-plan'], credentialPrefixHints: ['sk-'], region: 'cn-beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', anthropicBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
    bailianOffering({ id: 'coding-plan', label: 'Coding Plan Pro', kind: 'token-plan', runtimeProviderIds: ['bailian-coding-plan'], credentialPrefixHints: ['sk-sp-'], region: 'cn', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', anthropicBaseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', quotaStrategy: 'subscription', consoleUrl: BAILIAN_CONSOLE_URL, usagePolicyUrl: BAILIAN_USAGE_POLICY_URL }),
  ],
  deepseek: [
    {
      id: 'api-platform',
      label: 'API 平台',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: 'DeepSeek',
      runtimeProviderIds: ['deepseek'],
      credentialPrefixHints: ['sk-'],
      consoleUrl: 'https://platform.deepseek.com/api_keys',
      subscriptionUrl: 'https://platform.deepseek.com/usage',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.deepseek.com/v1' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'console', url: 'https://platform.deepseek.com/usage' },
      usagePolicyUrl: 'https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-use.html',
      region: 'global',
    },
  ],
  zhipu: [
    {
      id: 'api-platform',
      label: 'API 平台',
      kind: 'api-platform',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: '智谱 AI',
      runtimeProviderIds: ['zhipu'],
      credentialPrefixHints: ['id.'],
      consoleUrl: ZHIPU_CONSOLE_URL,
      subscriptionUrl: 'https://open.bigmodel.cn/finance-center/expense-manage',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: ZHIPU_API_BASE_URL, region: 'cn' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'console', url: 'https://open.bigmodel.cn/finance-center/expense-manage' },
      usagePolicyUrl: ZHIPU_USAGE_POLICY_URL,
      region: 'cn',
    },
    {
      id: 'coding-plan',
      label: 'GLM Coding Plan',
      kind: 'token-plan',
      lifecycle: 'active',
      authModes: ['apiKey'],
      productLabel: '智谱 AI',
      runtimeProviderIds: ['zhipu'],
      credentialPrefixHints: ['id.'],
      consoleUrl: ZHIPU_CONSOLE_URL,
      subscriptionUrl: 'https://bigmodel.cn/glm-coding',
      endpoints: [{ protocol: 'chatCompletions', baseUrl: ZHIPU_CODING_BASE_URL, region: 'cn' }],
      modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      quota: { strategy: 'subscription', url: 'https://bigmodel.cn/glm-coding' },
      usagePolicyUrl: ZHIPU_USAGE_POLICY_URL,
      region: 'cn',
    },
  ],
};

function kimiOffering(input: {
  id: string;
  label: string;
  kind: NonNullable<AiProviderOffering['kind']>;
  authModes: NonNullable<AiProviderOffering['authModes']>;
  productLabel: string;
  runtimeProviderIds: string[];
  credentialPrefixHints?: string[];
  baseUrl: string;
  anthropicBaseUrl?: string;
  quotaStrategy: string;
  quotaUrl: string;
  consoleUrl?: string;
  subscriptionUrl?: string;
  usagePolicyUrl: string;
}): AiProviderOffering {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    lifecycle: 'active',
    authModes: input.authModes,
    productLabel: input.productLabel,
    runtimeProviderIds: input.runtimeProviderIds,
    credentialPrefixHints: input.credentialPrefixHints,
    consoleUrl: input.consoleUrl,
    subscriptionUrl: input.subscriptionUrl,
    endpoints: offeringEndpoints(input.baseUrl, input.anthropicBaseUrl, 'cn'),
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: input.quotaStrategy, url: input.quotaUrl },
    usagePolicyUrl: input.usagePolicyUrl,
    region: 'cn',
  };
}

function bailianOffering(input: {
  id: string;
  label: string;
  kind: NonNullable<AiProviderOffering['kind']>;
  runtimeProviderIds: string[];
  credentialPrefixHints: string[];
  region: string;
  baseUrl: string;
  anthropicBaseUrl?: string;
  quotaStrategy: string;
  consoleUrl: string;
  usagePolicyUrl: string;
}): AiProviderOffering {
  return {
    id: input.id,
    label: input.label,
    lifecycle: 'active',
    productLabel: 'Alibaba Bailian',
    kind: input.kind,
    authModes: ['apiKey'],
    runtimeProviderIds: input.runtimeProviderIds,
    credentialPrefixHints: input.credentialPrefixHints,
    consoleUrl: input.consoleUrl,
    subscriptionUrl: input.consoleUrl,
    endpoints: offeringEndpoints(input.baseUrl, input.anthropicBaseUrl, input.region),
    modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
    quota: { strategy: input.quotaStrategy, url: input.consoleUrl },
    usagePolicyUrl: input.usagePolicyUrl,
    region: input.region,
  };
}

function offeringEndpoints(
  chatCompletionsBaseUrl: string,
  anthropicBaseUrl: string | undefined,
  region: string,
): NonNullable<AiProviderOffering['endpoints']> {
  return [
    { protocol: 'chatCompletions', baseUrl: chatCompletionsBaseUrl, region },
    ...(anthropicBaseUrl ? [{ protocol: 'anthropic', baseUrl: anthropicBaseUrl, region }] : []),
  ];
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
    case 'zhipu':
      return '智谱 AI';
    case 'ollama':
      return 'Ollama';
    case 'custom':
      return 'Custom';
  }
}

function defaultOfferingFor(provider: AiConnectionsProvider, authMode: AiProviderCredentialSummary['authMode']): string {
  if (provider === 'openai' && (authMode === 'local' || authMode === 'oauth' || authMode === 'deviceCode')) {
    return 'official-subscription';
  }
  if (provider === 'kimi' && (authMode === 'oauth' || authMode === 'deviceCode')) {
    return 'official-subscription';
  }
  if (provider === 'bailian') return 'pay-as-you-go';
  if (provider === 'custom') return 'openai-compatible';
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
  const key = providerResourceKey(value);
  const direct = providerValue(key);
  if (direct) return direct;
  return POD_PROVIDERS.find((provider) => key?.startsWith(`${provider}-`));
}

function offeringFromProviderRelation(value: string | undefined): string | undefined {
  const key = providerResourceKey(value);
  if (!key) return undefined;
  if (key.startsWith('custom-instance-')) return undefined;
  if (key === 'bailian-token-plan-personal') return 'token-plan';
  if (key === 'bailian-token-plan-team') return 'token-plan-team';
  if (key === 'bailian-coding-plan-pro') return 'coding-plan';
  if (key === 'bailian-pay-as-you-go') return 'pay-as-you-go';
  for (const provider of POD_PROVIDERS) {
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
  if (normalized === 'zhipu' || normalized.startsWith('zhipu-')) return 'zhipu';
  if ((POD_PROVIDERS as readonly string[]).includes(normalized)) {
    return normalized as AiConnectionsProvider;
  }
  for (const provider of POD_PROVIDERS) {
    if (normalized.startsWith(`${provider}-`)) return provider;
    if (provider === 'bailian' && (normalized === 'bailian-token-plan' || normalized === 'bailian-coding-plan')) {
      return provider;
    }
  }
  return undefined;
}

function normalizeProxyUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || !value.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('invalid_proxy_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
    || !parsed.hostname) {
    throw new Error('invalid_proxy_url');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function redactProxyUrl(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || !value.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return undefined;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
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
