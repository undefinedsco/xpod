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
  credentialDescriptor,
  credentialResource,
} from '@undefineds.co/models';
import {
  CUSTOM_DEFAULT_OFFERINGS,
  customCompatibilityValue,
  defaultOfferingFor,
  offeringBaseUrl,
  providerName,
  providerOfferings,
} from '@undefineds.co/ai-connections/provider-catalog';
import {
  AI_CONNECTIONS_PROVIDERS,
  type AiConnectionsProvider,
  type AiGatewayModel,
  type AiProviderCredentialSummary,
  type AiProviderOffering,
  type AiProviderSummary,
} from '@undefineds.co/ai-connections/client';
import {
  credentialProviderRelation,
  credentialRowKeyFor,
  credentialSecretEnvelope,
  customCredentialProviderRelation,
  decodeCredentialSecret,
  providerResourceKey,
  providerResourceReference,
} from '@undefineds.co/ai-connections/client';
import type {
  AiConnectionsModelSelection,
  AiConnectionsPodStore,
} from '@undefineds.co/extension-sdk/web';

// Keep the Pod adapter tolerant while consumers roll from an older compiled
// client package; the source catalog includes newer providers before every
// workspace consumer has rebuilt its dist tuple.
const POD_PROVIDERS = Array.from(new Set([...AI_CONNECTIONS_PROVIDERS, 'zhipu', 'ollama', 'custom'])) as AiConnectionsProvider[];

const oauthCredentialSaves = new WeakMap<SolidDatabase, Promise<void>>();

/**
 * The document the credential table lives in, taken from the models storage
 * descriptor (`/settings/credentials.ttl`) so the layout stays declared once.
 */
const CREDENTIAL_DOCUMENT_ID = credentialDescriptor.storage.base.slice(
  credentialDescriptor.storage.base.lastIndexOf('/') + 1,
);

/** The document a row id belongs to: `providers/openai.ttl#this` → `providers/openai.ttl`. */
function documentIdOfRow(rowId: string): string {
  const hash = rowId.indexOf('#');
  return hash < 0 ? rowId : rowId.slice(0, hash);
}

export interface CreateXpodAiConnectionsPodStoreInput {
  database: SolidDatabase;
  authenticatedFetch?: typeof fetch;
  webId: string;
  podUrl: string;
  /** @deprecated Authorization methods are supplied by the Gateway capability route. */
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
    /**
     * `settings/credentials.ttl`: the document the credential rows live in, and
     * therefore the live-update topic of the credentials table. The document
     * name comes from the models storage descriptor, not from a second copy of
     * the layout kept here.
     */
    credentialsTableDocument() {
      return credentialResource.buildIri(input.podUrl, { id: CREDENTIAL_DOCUMENT_ID });
    },
    /**
     * `providers/<provider>.ttl`: the provider's own row plus its model rows.
     * A custom provider instance owns its own document, so its instance id
     * selects that document.
     */
    providerTableDocument(provider, instanceId) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      const rowId = normalizedProvider === 'custom' && instanceId
        ? providerResourceIdForCustomCredential(instanceId)
        : providerResourceId(normalizedProvider);
      return aiProviderResource.buildIri(input.podUrl, { id: documentIdOfRow(rowId) });
    },
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
      const requestedId = stringValue(values.id);
      const id = requestedId ?? credentialResource.buildId({ id: credentialRowKeyFor(normalizedProvider, 'apiKey') });
      const version = 1;
      const offeringId = storedOfferingIdFor(
        normalizedProvider,
        values.offeringId ?? defaultOfferingFor(normalizedProvider, 'apiKey'),
      );
      const baseUrl = values.baseUrl ?? offeringBaseUrl(normalizedProvider, offeringId);
      const proxyUrl = normalizeProxyUrl(values.proxyUrl);
      const row = {
        id,
        provider: normalizedProvider === 'custom'
          ? providerResourceIdForCustomCredential(id)
          : providerResourceId(normalizedProvider),
        service: 'ai',
        authMode: 'apiKey',
        offeringId,
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
          ...offeringMetadata(offeringId),
          priority: values.priority ?? 100,
          enabled: true,
          health: 'unknown',
          baseUrl,
          ...(values.compatibility ? { compatibility: values.compatibility } : {}),
        },
      };
      await writeCreatedCredentialRow(input, id, row, requestedId !== undefined);
      return credentialSummaryFromRow(input, normalizedProvider, row)!;
    },
    async createLocalCredential(provider, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const requestedId = stringValue(values.id);
      const id = requestedId ?? credentialResource.buildId({ id: credentialRowKeyFor(normalizedProvider, 'local') });
      const offeringId = storedOfferingIdFor(
        normalizedProvider,
        values.offeringId ?? defaultOfferingFor(normalizedProvider, 'local'),
      );
      const baseUrl = values.baseUrl ?? offeringBaseUrl(normalizedProvider, offeringId);
      const row = {
        id,
        provider: providerResourceId(normalizedProvider),
        service: 'ai',
        authMode: 'local',
        offeringId,
        status: 'active',
        accountLabel: values.label ?? 'Local',
        label: values.label ?? 'Local',
        baseUrl,
        keyVersion: '1',
        reauthRequired: false,
        encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, { type: 'local' }),
        encryptionAlgorithm: 'PLAINTEXT',
        metadata: {
          ...offeringMetadata(offeringId),
          priority: values.priority ?? 100,
          enabled: true,
          health: 'unknown',
          baseUrl,
        },
      };
      await writeCreatedCredentialRow(input, id, row, requestedId !== undefined);
      return credentialSummaryFromRow(input, normalizedProvider, row)!;
    },
    async saveOAuthCredential(provider, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      const previous = oauthCredentialSaves.get(input.database) ?? Promise.resolve();
      const saving = previous.then(async () => {
        await input.database.init?.(credentialResource, aiProviderResource);
        const offeringId = storedOfferingIdFor(
          normalizedProvider,
          values.offeringId ?? defaultOfferingFor(normalizedProvider, 'deviceCode'),
        );
        const rows = await input.database.select().from(credentialResource).execute() as Record<string, unknown>[];
        const current = rows.find((row) => {
          const summary = credentialSummaryFromRow(input, normalizedProvider, row);
          if (!summary || (summary.authMode !== 'deviceCode' && summary.authMode !== 'oauth')
            || canonicalOfferingIdFor(normalizedProvider, summary.offeringId)
              !== canonicalOfferingIdFor(normalizedProvider, offeringId)
            || (row.status !== 'active' && row.status !== 'disabled')) return false;
          const secret = parsePlaintextSecret(input, normalizedProvider, summary.id, row.encryptedSecret);
          return matchesOAuthIdentity(values, objectValue(row.metadata), secret);
        });
        const currentSummary = current && credentialSummaryFromRow(input, normalizedProvider, current);
        const currentMetadata = objectValue(current?.metadata);
        const currentSecret = currentSummary && parsePlaintextSecret(input, normalizedProvider, currentSummary.id, current?.encryptedSecret);
        const id = currentSummary?.id ?? credentialResource.buildId({ id: `${normalizedProvider}-oauth-${crypto.randomUUID()}` });
        const accountLabel = values.accountLabel ?? 'OAuth';
        const accountId = values.accountId ?? stringValue(currentMetadata?.accountId) ?? stringValue(currentSecret?.accountId);
        const accountSubject = values.accountSubject ?? stringValue(currentMetadata?.authoritativeSubject) ?? stringValue(currentSecret?.accountSubject) ?? stringValue(currentSecret?.authoritativeSubject);
        const row = {
          ...current,
          id,
          provider: providerResourceId(normalizedProvider),
          service: 'ai',
          authMode: 'deviceCodeOAuth',
          offeringId,
          status: currentSummary?.enabled === false ? 'disabled' : 'active',
          accountLabel: current?.accountLabel ?? accountLabel,
          label: current?.label ?? accountLabel,
          expiresAt: values.expiresAt,
          scopes: values.scope ? values.scope.split(/\s+/u).filter(Boolean) : undefined,
          keyVersion: String((currentSummary?.version ?? 0) + 1),
          reauthRequired: false,
          encryptedSecret: plaintextEnvelope(input, normalizedProvider, id, {
            type: 'deviceCodeOAuth',
            accessToken: values.accessToken,
            refreshToken: values.refreshToken,
            expiresAt: values.expiresAt,
            scope: values.scope,
            idToken: values.idToken,
            accountId,
            accountSubject,
            accountLabel: values.accountLabel,
            offeringId,
            authorizationMethodId: values.authorizationMethodId,
          }),
          encryptionAlgorithm: 'PLAINTEXT',
          metadata: {
            ...currentMetadata,
            ...offeringMetadata(offeringId),
            priority: currentSummary?.priority ?? 100,
            enabled: currentSummary?.enabled ?? true,
            health: 'healthy',
            authoritativeSubject: accountSubject,
            accountId,
            authorizationMethodId: values.authorizationMethodId,
          },
        };
        if (current) {
          const patch: Record<string, unknown> = { ...row };
          delete patch.id;
          const updated = await input.database.updateById(credentialResource, id, patch as never);
          if (!updated) throw new Error('credential_version_conflict');
        } else {
          await input.database.insert(credentialResource).values(row as never).execute();
        }
        return credentialSummaryFromRow(input, normalizedProvider, row)!;
      });
      oauthCredentialSaves.set(input.database, saving.then(() => undefined, () => undefined));
      return saving;
    },
    async updateOAuthCredential(provider, credentialId, expectedVersion, values) {
      const normalizedProvider = providerValue(provider);
      if (!normalizedProvider) throw new Error('unsupported_provider');
      await input.database.init?.(credentialResource, aiProviderResource);
      const current = await input.database.findById(credentialResource, credentialId) as Record<string, unknown> | null;
      const summary = current && credentialSummaryFromRow(input, normalizedProvider, current);
      if (!current || !summary || summary.authMode !== 'deviceCode') throw new Error('oauth_credential_not_found');
      if (summary.version !== expectedVersion) throw new Error('credential_version_conflict');
      const currentSecret = parsePlaintextSecret(input, normalizedProvider, credentialId, current.encryptedSecret);
      const accountId = values.accountId ?? stringValue(objectValue(current.metadata)?.accountId) ?? stringValue(currentSecret?.accountId);
      const accountSubject = values.accountSubject ?? stringValue(objectValue(current.metadata)?.authoritativeSubject)
        ?? stringValue(currentSecret?.accountSubject) ?? stringValue(currentSecret?.authoritativeSubject);
      const offeringId = storedOfferingIdFor(normalizedProvider, values.offeringId ?? summary.offeringId);
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
          accountId,
          accountSubject,
          accountLabel: values.accountLabel ?? stringValue(current.accountLabel),
          offeringId,
          authorizationMethodId: values.authorizationMethodId
            ?? stringValue(objectValue(current.metadata)?.authorizationMethodId),
        }),
        accountLabel: values.accountLabel ?? stringValue(current.accountLabel),
        label: values.accountLabel ?? stringValue(current.label),
        offeringId,
        metadata: {
          ...objectValue(current.metadata),
          ...offeringMetadata(offeringId),
          enabled: true,
          health: 'healthy',
          authoritativeSubject: accountSubject,
          accountId,
          authorizationMethodId: values.authorizationMethodId
            ?? stringValue(objectValue(current.metadata)?.authorizationMethodId),
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
      for (const row of existing.filter((item) => modelRowBelongsToProvider(item, providerId, normalizedProvider))) {
        const modelId = modelKeyFromRowId(stringValue(row.id), providerId)
          ?? modelKeyFromResourceId(stringValue(row.id));
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
        : providerResourceId(normalizedProvider);
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

/**
 * Writes a credential row the credential-creation paths built.
 *
 * A live collection creates the row first - optimistically, from the models
 * descriptor - and then calls the store for the complete row at that same id,
 * because the secret envelope and the columns the descriptor does not declare
 * are the store's to write. That row already exists, so it is updated in place:
 * two writers must never race to insert one credential. Without a caller id the
 * row is new and the insert is the only write.
 */
async function writeCreatedCredentialRow(
  input: CreateXpodAiConnectionsPodStoreInput,
  id: string,
  row: Record<string, unknown>,
  upsert: boolean,
): Promise<void> {
  const existing = upsert
    ? await input.database.findById(credentialResource, id)
    : null;
  if (!existing) {
    await input.database.insert(credentialResource).values(row as never).execute();
    return;
  }
  const patch = { ...row };
  delete patch.id;
  const updated = await input.database.updateById(credentialResource, id, patch as never);
  if (!updated) throw new Error('credential_create_failed');
}

/**
 * The envelope format and the provider relation live in the capability package
 * (`@undefineds.co/ai-connections/client`), because the collection layer writes
 * the same rows through the models descriptor. This adapter only supplies the
 * account and Pod context they need.
 */
function plaintextEnvelope(
  input: CreateXpodAiConnectionsPodStoreInput,
  provider: AiConnectionsProvider,
  id: string,
  secret: Record<string, unknown>,
): string {
  return credentialSecretEnvelope({
    webId: input.webId,
    provider,
    credentialIri: credentialResource.buildIri(input.podUrl, { id }),
    secret,
  });
}

function matchesOAuthIdentity(
  incoming: { accountId?: string; accountSubject?: string },
  metadata: Record<string, unknown> | undefined,
  secret: Record<string, unknown> | undefined,
): boolean {
  let matched = false;
  for (const [value, candidates] of [
    [incoming.accountId, [metadata?.accountId, secret?.accountId]],
    [incoming.accountSubject, [metadata?.authoritativeSubject, secret?.accountSubject, secret?.authoritativeSubject]],
  ] as const) {
    const known = [...new Set(candidates.map(stringValue).filter(isDefined).filter((item) => item.trim()))];
    // Conflicting authoritative fields must never collapse distinct accounts.
    if (known.length > 1) return false;
    if (!value?.trim() || !known.length) continue;
    if (known[0] !== value) return false;
    matched = true;
  }
  return matched;
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
    offeringId: credentialOfferingIdFromRow(row, provider, authMode),
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

/**
 * Which offering a credential row declares.
 *
 * The offering is an attribute of the credential, so the row's own
 * `udfs:offeringId` wins. The two fallbacks cover only rows written before that
 * attribute existed, and both go away with the storage migration:
 *
 * 1. `metadata.offeringId` - the migration-window copy this store still writes
 *    for applet builds compiled against a models release that has no
 *    `offeringId` column (see `offeringMetadata`).
 * 2. the offering segment of the provider resource id - the old shape, where the
 *    offering was encoded in the provider document name
 *    (`providers/openai-official-subscription.ttl#this`). The migration script
 *    normalises those references to `providers/openai.ttl`.
 *
 * This is the single switch point for reading a credential's offering.
 */
function credentialOfferingIdFromRow(
  row: Record<string, unknown>,
  provider: AiConnectionsProvider,
  authMode: AiProviderCredentialSummary['authMode'],
): string {
  return stringValue(row.offeringId)
    ?? stringValue(objectValue(row.metadata)?.offeringId)
    ?? legacyOfferingFromProviderRelation(stringValue(row.provider))
    ?? defaultOfferingFor(provider, authMode);
}

/**
 * MIGRATION WINDOW: write the offering both as the credential's `udfs:offeringId`
 * attribute and inside the `metadata` JSON.
 *
 * `@undefineds.co/models` releases before this change declare no `offeringId`
 * column, and drizzle-solid drops values whose key is not a declared column, so
 * an applet bundle built against such a release would persist neither. Drop the
 * `metadata` copy once every consumer is built against the release that declares
 * `offeringId` and no reader needs the fallback in `credentialOfferingIdFromRow`.
 */
function offeringMetadata(offeringId: string): { offeringId: string } {
  return { offeringId };
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
    // A model's document is its provider's, whatever offering discovered it, so
    // this is only set for rows that still live in a legacy offering document.
    offeringId: legacyOfferingFromProviderRelation(stringValue(row?.isProvidedBy)),
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
    offeringId: legacyOfferingFromProviderRelation(providerResource),
    credentialId: customCredentialIdFromProviderRelation(providerResource),
    resourceId: stringValue(row.id),
    displayName: stringValue(row.displayName),
    availability: stringValue(row.status) === 'unavailable' ? 'unavailable' : 'available',
    ...modelTypeEvidence(row),
  };
}


function discoveredModelValue(
  value: unknown,
): { id: string; displayName?: string; modelType?: AiGatewayModel['modelType'] } | undefined {
  const row = objectValue(value);
  const id = stringValue(row?.id);
  if (!id) return undefined;
  return {
    id,
    displayName: stringValue(row?.displayName),
    // 同步模型的返回值带类型，落库时必须一起带上：Pod 行没有类型，embedding
    // 模型之后就和普通聊天模型无从区分，也就不会出现在向量模型里。
    modelType: discoveredRowModelType(row?.modelType),
  };
}

function providerResourceIdForCredential(
  provider: AiConnectionsProvider,
  credentialRow: Record<string, unknown> | null,
): string {
  // A custom credential keeps its own instance-scoped provider document: that
  // document is what keeps two user-defined endpoints' models apart, and it is
  // not an offering. Every catalog provider shares `providers/<provider>.ttl`;
  // the offering lives on the credential, never in this id.
  const instanceId = customCredentialIdFromProviderRelation(stringValue(credentialRow?.provider));
  if (instanceId) {
    return providerResourceIdForCustomCredential(instanceId);
  }
  return providerResourceId(provider);
}

/**
 * The provider document a product's rows live in: `providers/<provider>.ttl`.
 *
 * `id` expresses storage layout only. An offering is an attribute of the
 * credential (`udfs:offeringId`), so it must never appear here - a provider id
 * carrying an offering segment makes every offering a phantom provider document
 * and every `hasModel` entry in it a dangling reference.
 *
 * The relation itself is built by `@undefineds.co/ai-connections` (the same
 * helper the collection layer writes new rows with), so both writers agree on
 * the value by construction.
 */
function providerResourceId(provider: AiConnectionsProvider): string {
  return credentialProviderRelation(provider);
}

function providerResourceIdForCustomCredential(credentialId: string): string {
  return customCredentialProviderRelation(credentialId);
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

/**
 * The offering id a credential records.
 *
 * An offering id is catalog content, so this stores the catalog's own id
 * (`token-plan`, `coding-plan`, `pay-as-you-go`, …) lower-cased. The bootstrap
 * naming turned two Bailian ids into document-name variants; those are folded
 * back so the attribute never carries a storage-layout artefact.
 */
function storedOfferingIdFor(
  provider: AiConnectionsProvider,
  offeringId: string,
): string {
  const normalized = offeringId.trim().toLowerCase();
  if (provider === 'bailian') {
    if (normalized === 'token-plan-personal') return 'token-plan';
    if (normalized === 'coding-plan-pro') return 'coding-plan';
  }
  return normalized;
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

function providerRelationMatches(value: string | undefined, expected: string): boolean {
  const actualReference = providerResourceReference(value);
  const expectedReference = providerResourceReference(expected);
  return actualReference !== undefined && actualReference === expectedReference;
}

/**
 * Whether a model row belongs to a provider's discovery scope.
 *
 * MIGRATION WINDOW: rows written before the offering left the provider id sit in
 * `<provider>-<offering>.ttl` documents, so discovery still has to see them to
 * retire models that disappeared upstream. New rows only ever match `providerId`,
 * and the migration moves the old ones into the provider's own document.
 */
function modelRowBelongsToProvider(
  row: Record<string, unknown>,
  providerId: string,
  provider: AiConnectionsProvider,
): boolean {
  const relation = stringValue(row.isProvidedBy);
  if (providerRelationMatches(relation, providerId)) return true;
  if (provider === 'custom') return false;
  return providerResourceKey(relation)?.startsWith(`${provider}-`) === true;
}

/** The model key a resource id names, whatever document the id lives in. */
function modelKeyFromResourceId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const index = id.lastIndexOf('#');
  if (index < 0 || index === id.length - 1) return undefined;
  const fragment = id.slice(index + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
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
  model: { id: string; displayName?: string; modelType?: AiGatewayModel['modelType'] },
  existingIds: Set<string>,
): Promise<void> {
  const id = modelResourceId(providerId, model.id);
  const patch = {
    displayName: model.displayName ?? model.id,
    isProvidedBy: providerId,
    status: 'active',
    // Never overwrite a type an earlier sync already established with nothing:
    // discovery is the only writer of this column, and an embedding model that
    // loses it is no longer selectable for embedding.
    ...(model.modelType ? { modelType: model.modelType } : {}),
  };
  if (existingIds.has(id)) {
    await database.updateById(aiModelResource, id, patch as never);
    return;
  }
  await database.insert(aiModelResource).values({ id, ...patch } as never).execute();
  existingIds.add(id);
}

/**
 * The model type a Pod row carries, as the list shows it.
 *
 * A row's type is the Pod's own record of what the model is for, and the
 * settings list marks embedding models with the same capability token the
 * Gateway projection uses.
 */
function modelTypeEvidence(row: Record<string, unknown>): Pick<AiGatewayModel, 'modelType' | 'capabilities'> {
  const modelType = discoveredRowModelType(row.modelType);
  if (!modelType) return {};
  return {
    modelType,
    ...(modelType === 'embedding' ? { capabilities: ['embedding'] } : {}),
  };
}

/** Only the two classes the Pod stores are written or shown. */
function discoveredRowModelType(value: unknown): AiGatewayModel['modelType'] {
  const normalized = stringValue(value)?.trim().toLowerCase();
  return normalized === 'chat' || normalized === 'embedding' ? normalized : undefined;
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
  // One provider document holds every offering's models, so a selection is
  // stored as `<provider>.ttl#<model>` whatever offering it was picked under.
  // Encoding the offering here is what produced the dangling `hasModel`
  // references to `openai-official-subscription.ttl#…`.
  const providerId = scopedProviderId ?? providerResourceId(provider);
  const selectionId = stringValue(selection.id);
  const matchingRows = selectionId ? rows.filter((row) => {
    const rowProvider = stringValue(row.isProvidedBy);
    const rowProviderKey = providerResourceKey(rowProvider);
    // `startsWith` keeps rows written before the offering left the provider id
    // readable until the migration has moved them.
    const belongsToProduct = scopedProviderId
      ? providerRelationMatches(rowProvider, scopedProviderId)
      : rowProviderKey === provider
      || rowProviderKey?.startsWith(`${provider}-`) === true;
    return belongsToProduct
      && modelKeyFromRowId(stringValue(row.id), rowProvider ?? providerId) === selectionId;
  }) : [];
  const exactRow = scopedProviderId
    ? matchingRows[0]
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
    if (row && !matchesProduct) {
      throw new Error('invalid_model_selection_resource');
    }
    // A pinned selection can outlive the document it named: the storage model
    // has moved model documents between provider files, so a selection written
    // before that still points at the provider's older document name. It is
    // carried over to where the model lives now rather than failing the write,
    // which would strand every other model in the selection. A reference into
    // another product's documents is still rejected.
    if (!row) {
      const carriedId = selectionId ?? modelKeyFromResourceId(resourceId);
      const referencedProvider = providerResourceKey(resourceId);
      const belongsToProduct = scopedProviderId
        ? providerRelationMatches(referencedProvider, scopedProviderId)
        : referencedProvider === provider
        || referencedProvider?.startsWith(`${provider}-`) === true;
      if (!carriedId || !belongsToProduct) {
        throw new Error('invalid_model_selection_resource');
      }
      return modelResourceId(providerId, carriedId);
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


function customProviderOfferings(credentialRows: Record<string, unknown>[]): AiProviderOffering[] {
  const configured = new Map<string, AiProviderOffering>();
  for (const row of credentialRows) {
    const metadata = objectValue(row.metadata);
    const offeringId = credentialOfferingIdFromRow(row, 'custom', authModeValue(row.authMode) ?? 'apiKey');
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

function providerStatus(credentials: AiProviderCredentialSummary[]): AiProviderSummary['status'] {
  if (credentials.some((credential) => credential.health === 'expired' || credential.health === 'invalid')) {
    return 'attention';
  }
  if (credentials.some((credential) => credential.enabled)) return 'available';
  return credentials.length > 0 ? 'configured' : 'unconfigured';
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
  return decodeCredentialSecret({
    webId: input.webId,
    provider,
    credentialIri: credentialResource.buildIri(input.podUrl, { id }),
    envelope: encryptedSecret,
  });
}

function providerFromRelation(value: string | undefined): AiConnectionsProvider | undefined {
  const key = providerResourceKey(value);
  const direct = providerValue(key);
  if (direct) return direct;
  return POD_PROVIDERS.find((provider) => key?.startsWith(`${provider}-`));
}

/**
 * MIGRATION WINDOW ONLY: the offering an old provider reference encoded in its
 * document name (`providers/openai-official-subscription.ttl`).
 *
 * New references are `providers/<provider>.ttl` and carry no offering, so this
 * returns `undefined` for everything written now. It stays until the migration
 * has normalised the references already in Pods, and it is the only place that
 * still reads an offering out of a resource id.
 */
function legacyOfferingFromProviderRelation(value: string | undefined): string | undefined {
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
