import { createHash } from 'node:crypto';

import { drizzle, eq, resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import {
  aiModelResource,
  aiProviderResource,
} from '@undefineds.co/models';

import type { AuthContext } from '../../auth/AuthContext';
import type { InternalPodAccessTokenProvider } from '../pod/HostedPodDataAccess';

export type PodSelectedModelStatus = 'active' | 'inactive';

export interface PodSelectedModel {
  /** Base-relative id of the AI model resource (for example, openai.ttl#gpt-5). */
  id: string;
  displayName?: string;
  modelType: string;
  status: PodSelectedModelStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PodModelSelection {
  provider: string;
  models: PodSelectedModel[];
  version: string;
  /** Base-relative model resource id, when a provider default is configured. */
  defaultModel?: string;
}

export interface PodModelSelectionDb {
  init?: (...resources: unknown[]) => Promise<void>;
  select(): {
    from(resource: typeof aiModelResource): {
      where(condition: unknown): { execute(): Promise<Record<string, unknown>[]> };
    };
  };
  findById<T = Record<string, unknown>>(
    resource: typeof aiProviderResource | typeof aiModelResource,
    id: string,
  ): Promise<T | null>;
  insert(resource: typeof aiProviderResource | typeof aiModelResource): {
    values(value: Record<string, unknown>): { execute(): Promise<unknown[]> };
  };
  updateById<T = Record<string, unknown>>(
    resource: typeof aiProviderResource | typeof aiModelResource,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<T | null>;
  deleteById(
    resource: typeof aiProviderResource | typeof aiModelResource,
    id: string,
  ): Promise<boolean>;
  transaction?<T>(transaction: (tx: PodModelSelectionDb) => Promise<T>): Promise<T>;
}

export interface PodModelSelectionRepositoryOptions {
  internalPodAccess?: InternalPodAccessTokenProvider;
  dbFactory?: (input: {
    owner: string;
    podUrl: string;
    auth?: AuthContext;
    fetch: typeof fetch;
    aiProvider: typeof aiProviderResource;
    aiModel: typeof aiModelResource;
  }) => Promise<PodModelSelectionDb>;
  /** Provider ids used by listActiveSelections; custom providers remain listable via listSelection. */
  providerIds?: readonly string[];
  now?: () => Date;
}

export interface ListSelectionInput {
  webId: string;
  provider: string;
  auth?: AuthContext;
}

export interface ReplaceSelectionInput extends ListSelectionInput {
  models: readonly PodSelectedModelInput[];
  defaultModel?: string;
  expectedVersion?: string;
}

export interface ReconcileAvailabilityInput extends ListSelectionInput {
  discoveredModels: readonly DiscoveredModelInput[];
}

export type PodSelectedModelInput = string | (Pick<PodSelectedModel, 'id' | 'modelType'>
  & Partial<Pick<PodSelectedModel, 'displayName' | 'status'>>);

export type DiscoveredModelInput = Pick<PodSelectedModel, 'id' | 'modelType'>
  & Partial<Pick<PodSelectedModel, 'displayName'>>;

export interface ListActiveSelectionsInput {
  webId: string;
  auth?: AuthContext;
}

export const DEFAULT_MODEL_SELECTION_PROVIDERS = [
  'openai',
  'anthropic',
  'kimi',
  'bailian',
  'deepseek',
] as const;

/**
 * The selected-model adapter deliberately uses only the shared ai-config
 * resources. Selection state is represented by aiModel rows: unpicked rows
 * are removed, while a picked model that disappears from a complete provider
 * discovery is retained with status="inactive".
 */
export class PodModelSelectionRepository {
  private readonly dbFactory: NonNullable<PodModelSelectionRepositoryOptions['dbFactory']>;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;
  private readonly providerIds: readonly string[];
  private readonly now: () => Date;

  public constructor(options: PodModelSelectionRepositoryOptions = {}) {
    this.dbFactory = options.dbFactory ?? createDefaultModelSelectionDb;
    this.internalPodAccess = options.internalPodAccess;
    this.providerIds = dedupeProviders(options.providerIds ?? DEFAULT_MODEL_SELECTION_PROVIDERS);
    this.now = options.now ?? (() => new Date());
  }

  public async listSelection(input: ListSelectionInput): Promise<PodModelSelection> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const context = await this.readSelection(db, input.webId, input.provider);
    return context.selection;
  }

  public async replaceSelection(input: ReplaceSelectionInput): Promise<PodModelSelection> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const context = await this.readSelection(db, input.webId, input.provider);
    if (input.expectedVersion !== undefined && input.expectedVersion !== context.selection.version) {
      throw new Error('model_selection_version_conflict');
    }

    const requested = normalizeRequestedModels(input.models, context.providerId, context.providerResourceId);
    const defaultModelId = input.defaultModel === undefined
      ? undefined
      : buildModelResourceId(input.defaultModel, context.providerResourceId, context.webId);
    if (defaultModelId !== undefined && !requested.has(defaultModelId)) {
      throw new Error('model_selection_default_not_picked');
    }

    const existingById = new Map<string, Record<string, unknown>>();
    for (const row of context.modelRows) {
      const id = rowResourceId(row, context.providerResourceId, context.webId);
      if (id) {
        existingById.set(id, { ...row, id });
      }
    }
    const now = this.now();
    const upserts = Array.from(requested.values()).map((model) => {
      const existing = existingById.get(model.id);
      if (existing) {
        return {
          id: model.id,
          existing,
          patch: modelRowPatch(model, context.providerIri, now, existing.createdAt),
        };
      }
      return {
        id: model.id,
        existing: undefined,
        patch: modelRowValues(model, context.providerIri, now),
      };
    });
    const deletes = Array.from(existingById.entries())
      .filter(([id]) => !requested.has(id))
      .map(([id, row]) => ({ id, row }));

    const providerId = context.providerResourceId;
    const providerBefore = context.providerRow;
    const providerDefaultBefore = modelIdFromRelation(
      providerBefore?.defaultModel,
      context.providerResourceId,
      context.webId,
    );
    let providerMutation: ProviderMutation | undefined;
    if (defaultModelId !== undefined) {
      const defaultIri = aiModelResource.buildIri(context.webId, { id: defaultModelId });
      if (providerBefore) {
        providerMutation = {
          kind: 'update',
          id: providerId,
          patch: { defaultModel: defaultIri },
        };
      } else {
        providerMutation = {
          kind: 'insert',
          id: providerId,
          values: { id: providerId, defaultModel: defaultIri },
        };
      }
    } else if (providerBefore && providerDefaultBefore && !requested.has(providerDefaultBefore)) {
      // Do not leave a provider pointing at a row which replaceSelection just removed.
      providerMutation = { kind: 'update', id: providerId, patch: { defaultModel: null } };
    }

    const operation = async (tx: PodModelSelectionDb): Promise<void> => {
      for (const upsert of upserts) {
        if (upsert.existing) {
          const updated = await tx.updateById(aiModelResource, upsert.id, upsert.patch);
          if (!updated) {
            throw new Error('model_selection_exact_update_failed');
          }
        } else {
          await tx.insert(aiModelResource).values(upsert.patch).execute();
        }
      }
      for (const deleted of deletes) {
        const didDelete = await tx.deleteById(aiModelResource, deleted.id);
        if (!didDelete) {
          throw new Error('model_selection_exact_delete_failed');
        }
      }
      if (providerMutation?.kind === 'update') {
        const updated = await tx.updateById(aiProviderResource, providerMutation.id, providerMutation.patch);
        if (!updated) {
          throw new Error('model_selection_provider_update_failed');
        }
      } else if (providerMutation?.kind === 'insert') {
        await tx.insert(aiProviderResource).values(providerMutation.values).execute();
      }
    };

    await this.runAtomic(db, operation, {
      modelUpserts: upserts,
      modelDeletes: deletes,
      providerBefore,
      providerMutation,
      webId: context.webId,
    });
    return this.listSelection(input);
  }

  public async reconcileAvailability(input: ReconcileAvailabilityInput): Promise<PodModelSelection> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const context = await this.readSelection(db, input.webId, input.provider);
    const discovered = new Map<string, DiscoveredModelInput>();
    for (const model of input.discoveredModels) {
      const id = buildModelResourceId(model.id, context.providerResourceId, context.webId);
      discovered.set(id, { ...model, id });
    }
    const now = this.now();
    const updates = context.modelRows.map((row) => {
      const id = rowResourceId(row, context.providerResourceId, context.webId);
      if (!id) {
        return undefined;
      }
      const found = discovered.get(id);
      const patch: Record<string, unknown> = {
        status: found ? 'active' : 'inactive',
        updatedAt: now,
      };
      if (found?.displayName !== undefined) {
        patch.displayName = found.displayName;
      }
      if (found?.modelType !== undefined) {
        patch.modelType = found.modelType;
      }
      return { id, patch };
    }).filter((value): value is { id: string; patch: Record<string, unknown> } => value !== undefined);

    const operation = async (tx: PodModelSelectionDb): Promise<void> => {
      for (const update of updates) {
        const result = await tx.updateById(aiModelResource, update.id, update.patch);
        if (!result) {
          throw new Error('model_selection_exact_update_failed');
        }
      }
    };
    await this.runAtomic(db, operation, {
      modelUpserts: updates.map((update) => ({
        id: update.id,
        existing: context.modelRows.find((row) => rowResourceId(row, context.providerResourceId, context.webId) === update.id),
        patch: update.patch,
      })),
      modelDeletes: [],
      providerBefore: context.providerRow,
      providerMutation: undefined,
      webId: context.webId,
    });
    return this.listSelection(input);
  }

  public async listActiveSelections(input: ListActiveSelectionsInput): Promise<PodModelSelection[]> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const selections = await Promise.all(
      this.providerIds.map(async (provider) => (await this.readSelection(db, input.webId, provider)).selection),
    );
    return selections
      .map((selection) => ({
        ...selection,
        models: selection.models.filter((model) => model.status === 'active'),
      }))
      .filter((selection) => selection.models.length > 0);
  }

  private async readSelection(
    db: PodModelSelectionDb,
    webId: string,
    provider: string,
  ): Promise<SelectionContext> {
    const providerId = normalizeProvider(provider);
    const providerResourceId = aiProviderResource.buildId({ id: providerId });
    const providerIri = aiProviderResource.buildIri(webId, { id: providerResourceId });
    const query = db.select().from(aiModelResource);
    if (!query || typeof query.where !== 'function') {
      throw new ModelSelectionBlockedError(
        'drizzle-solid does not expose the required aiModel.isProvidedBy relation query on plain LDP',
      );
    }
    let rows: Record<string, unknown>[];
    try {
      rows = await query.where(eq(aiModelResource.isProvidedBy, providerIri)).execute();
    } catch (error) {
      throw new ModelSelectionBlockedError(
        'drizzle-solid failed the required aiModel.isProvidedBy relation query on plain LDP',
        error,
      );
    }
    const modelRows = rows.filter((row) => relationMatches(row.isProvidedBy, providerIri, webId));
    const providerRow = await this.findProvider(db, providerResourceId);
    const models = modelRows
      .map((row) => selectedModelFromRow(row, providerResourceId, webId))
      .filter((model): model is PodSelectedModel => model !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
    const defaultModel = modelIdFromRelation(providerRow?.defaultModel, providerResourceId, webId);
    return {
      webId,
      providerId,
      providerResourceId,
      providerIri,
      modelRows,
      providerRow,
      selection: {
        provider: providerId,
        models,
        defaultModel,
        version: computeSelectionVersion(providerIri, defaultModel, models),
      },
    };
  }

  private async findProvider(db: PodModelSelectionDb, id: string): Promise<Record<string, unknown> | null> {
    try {
      return await db.findById<Record<string, unknown>>(aiProviderResource, id);
    } catch (error) {
      if (isMissingResourceError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async dbForOwner(owner: string, auth?: AuthContext): Promise<PodModelSelectionDb> {
    assertAuthOwner(owner, auth);
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(owner, auth);
    if (!trustedFetch) {
      throw new Error('AI Connection service identity is not configured');
    }
    const podFetch: typeof fetch = async (input, init) => {
      const response = await trustedFetch(input, init);
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
    const db = await this.dbFactory({
      owner,
      podUrl: resolvePodBaseUrl(owner),
      auth,
      fetch: podFetch,
      aiProvider: aiProviderResource,
      aiModel: aiModelResource,
    });
    await db.init?.(aiProviderResource, aiModelResource);
    return db;
  }

  private async runAtomic(
    db: PodModelSelectionDb,
    operation: (tx: PodModelSelectionDb) => Promise<void>,
    snapshot: MutationSnapshot,
  ): Promise<void> {
    // drizzle-solid's current remote LDP transaction callback is a sequencing
    // helper, not a rollback boundary. Keep the explicit exact-id rollback
    // below so a later upsert/delete failure cannot leave a partial selection.
    try {
      await operation(db);
    } catch (error) {
      try {
        await rollbackMutation(db, snapshot);
      } catch (rollbackError) {
        throw new ModelSelectionAtomicityError(error, rollbackError);
      }
      throw error;
    }
  }
}

export class ModelSelectionBlockedError extends Error {
  public readonly code = 'BLOCKED/NEEDS_CONTEXT';
  public readonly evidence: string;
  public readonly recommendation = 'Upgrade @undefineds.co/models and @undefineds.co/drizzle-solid with a plain-LDP eq(aiModel.isProvidedBy, providerIri) query helper before adding a raw SPARQL fallback.';

  public constructor(evidence: string, cause?: unknown) {
    super(`BLOCKED/NEEDS_CONTEXT: ${evidence}`);
    this.name = 'ModelSelectionBlockedError';
    this.evidence = cause instanceof Error ? `${evidence}: ${cause.message}` : evidence;
  }
}

class ModelSelectionAtomicityError extends Error {
  public constructor(original: unknown, rollback: unknown) {
    super(`model_selection_atomicity_error: ${errorMessage(original)}; rollback failed: ${errorMessage(rollback)}`);
    this.name = 'ModelSelectionAtomicityError';
  }
}

interface SelectionContext {
  webId: string;
  providerId: string;
  providerResourceId: string;
  providerIri: string;
  modelRows: Record<string, unknown>[];
  providerRow: Record<string, unknown> | null;
  selection: PodModelSelection;
}

interface ProviderMutationUpdate {
  kind: 'update';
  id: string;
  patch: Record<string, unknown>;
}

interface ProviderMutationInsert {
  kind: 'insert';
  id: string;
  values: Record<string, unknown>;
}

type ProviderMutation = ProviderMutationUpdate | ProviderMutationInsert;

interface MutationSnapshot {
  modelUpserts: Array<{ id: string; existing?: Record<string, unknown>; patch: Record<string, unknown> }>;
  modelDeletes: Array<{ id: string; row: Record<string, unknown> }>;
  providerBefore: Record<string, unknown> | null;
  providerMutation?: ProviderMutation;
  webId: string;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error('model_selection_provider_required');
  }
  return normalized;
}

function assertAuthOwner(owner: string, auth?: AuthContext): void {
  if (!auth) {
    return;
  }
  if (auth.type !== 'solid') {
    throw new Error('pod_model_selection_solid_auth_required');
  }
  if (auth.webId !== owner) {
    throw new Error('pod_model_selection_auth_mismatch');
  }
}

function dedupeProviders(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map(normalizeProvider)));
}

function normalizeRequestedModels(
  models: readonly PodSelectedModelInput[],
  _providerId: string,
  providerResourceId: string,
): Map<string, NormalizedSelectedModel> {
  const normalized = new Map<string, NormalizedSelectedModel>();
  for (const input of models) {
    const model = typeof input === 'string' ? { id: input, modelType: 'chat' as const } : input;
    const id = buildModelResourceId(model.id, providerResourceId);
    if (!id) {
      throw new Error('model_selection_model_required');
    }
    normalized.set(id, { ...model, id });
  }
  return normalized;
}

type NormalizedSelectedModel = {
  id: string;
  modelType: string;
  displayName?: string;
  status?: PodSelectedModelStatus;
};

function modelRowValues(model: NormalizedSelectedModel, providerIri: string, now: Date): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: model.id,
    isProvidedBy: providerIri,
    modelType: normalizeModelType(model.modelType),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  if (model.displayName !== undefined) {
    row.displayName = model.displayName;
  }
  return row;
}

function modelRowPatch(
  model: NormalizedSelectedModel,
  providerIri: string,
  now: Date,
  createdAt: unknown,
): Record<string, unknown> {
  const row = modelRowValues(model, providerIri, now);
  delete row.id;
  if (createdAt !== undefined) {
    delete row.createdAt;
  }
  return row;
}

function selectedModelFromRow(
  row: Record<string, unknown>,
  providerResourceId: string,
  webId: string,
): PodSelectedModel | undefined {
  const rawId = typeof row.id === 'string' ? row.id : row['@id'];
  if (typeof rawId !== 'string' || !rawId.trim()) {
    return undefined;
  }
  const id = buildModelResourceId(rawId, providerResourceId, webId);
  return {
    id,
    ...(typeof row.displayName === 'string' && row.displayName ? { displayName: row.displayName } : {}),
    modelType: normalizeModelType(row.modelType),
    status: row.status === 'inactive' ? 'inactive' : 'active',
    ...(dateValue(row.createdAt) ? { createdAt: dateValue(row.createdAt) } : {}),
    ...(dateValue(row.updatedAt) ? { updatedAt: dateValue(row.updatedAt) } : {}),
  };
}

function rowResourceId(row: Record<string, unknown>, providerResourceId: string, webId: string): string | undefined {
  const rawId = typeof row.id === 'string' ? row.id : row['@id'];
  return typeof rawId === 'string' && rawId.trim()
    ? buildModelResourceId(rawId, providerResourceId, webId)
    : undefined;
}

function buildModelResourceId(rawValue: string, providerResourceId: string, webId?: string): string {
  const raw = rawValue.trim();
  if (!raw) {
    throw new Error('model_selection_model_required');
  }
  const relative = webId ? toPodRelative(raw, webId) : raw.replace(/^\/+/u, '');
  if (relative.includes('#')) {
    const [document, fragment] = relative.split('#', 2);
    const providerDocument = document === providerResourceId || document.endsWith(`/${providerResourceId}`)
      ? providerResourceId
      : document;
    if (providerDocument !== providerResourceId || !fragment) {
      throw new Error('model_selection_model_provider_mismatch');
    }
    return aiModelResource.buildId({ id: `${providerResourceId}#${fragment}` });
  }
  return aiModelResource.buildId({ id: relative, isProvidedBy: providerResourceId });
}

function modelIdFromRelation(value: unknown, providerResourceId: string, webId: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    return buildModelResourceId(value, providerResourceId, webId);
  } catch {
    return undefined;
  }
}

function relationMatches(value: unknown, expectedIri: string, webId: string): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const raw = value.trim();
  if (raw === expectedIri) {
    return true;
  }
  try {
    return new URL(raw, `${resolvePodBaseUrl(webId).replace(/\/$/u, '')}/`).href === expectedIri;
  } catch {
    return false;
  }
}

function toPodRelative(value: string, webId: string): string {
  const podBase = `${resolvePodBaseUrl(webId).replace(/\/$/u, '')}/`;
  try {
    const url = new URL(value, podBase);
    if (url.origin === new URL(podBase).origin && url.pathname.startsWith(new URL(podBase).pathname)) {
      return `${url.pathname.slice(new URL(podBase).pathname.length).replace(/^\/+/, '')}${url.hash}`;
    }
  } catch {
    // Resource helpers will reject malformed ids below.
  }
  return value.replace(/^\/+/, '');
}

function normalizeModelType(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'chat';
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

export function computeSelectionVersion(
  providerIri: string,
  defaultModel: string | undefined,
  models: readonly PodSelectedModel[],
): string {
  const facts = [
    `provider=${providerIri}`,
    `defaultModel=${defaultModel ?? ''}`,
    ...models
      .map((model) => [
        model.id,
        model.displayName ?? '',
        model.modelType,
        model.status,
      ].join('\u001f'))
      .sort(),
  ];
  return createHash('sha256').update(facts.join('\n')).digest('hex');
}

function isMissingResourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:not found|missing|404)/iu.test(message);
}

async function rollbackMutation(db: PodModelSelectionDb, snapshot: MutationSnapshot): Promise<void> {
  for (const upsert of snapshot.modelUpserts) {
    if (upsert.existing) {
      const original = withoutIdentity(upsert.existing);
      const current = await db.findById<Record<string, unknown>>(aiModelResource, upsert.id);
      if (current) {
        const deleted = await db.deleteById(aiModelResource, upsert.id);
        if (!deleted) {
          throw new Error(`rollback_model_delete_failed:${upsert.id}`);
        }
        await db.insert(aiModelResource).values({ id: upsert.id, ...original }).execute();
      } else {
        await db.insert(aiModelResource).values({ id: upsert.id, ...original }).execute();
      }
    } else {
      await db.deleteById(aiModelResource, upsert.id).catch(() => undefined);
    }
  }
  for (const deleted of snapshot.modelDeletes) {
    const current = await db.findById<Record<string, unknown>>(aiModelResource, deleted.id);
    if (!current) {
      await db.insert(aiModelResource).values(deleted.row).execute();
    }
  }
  if (snapshot.providerMutation) {
    const providerId = snapshot.providerMutation.id;
    if (snapshot.providerBefore) {
      const current = await db.findById<Record<string, unknown>>(aiProviderResource, providerId);
      if (current) {
        const deleted = await db.deleteById(aiProviderResource, providerId);
        if (!deleted) {
          throw new Error(`rollback_provider_delete_failed:${providerId}`);
        }
      }
      await db.insert(aiProviderResource).values({
        id: providerId,
        ...withoutIdentity(snapshot.providerBefore),
      }).execute();
    } else {
      await db.deleteById(aiProviderResource, providerId).catch(() => undefined);
    }
  }
}

function withoutIdentity(row: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...row };
  delete copy.id;
  delete copy['@id'];
  return copy;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultModelSelectionDb(input: {
  owner: string;
  podUrl: string;
  fetch: typeof fetch;
  aiProvider: typeof aiProviderResource;
  aiModel: typeof aiModelResource;
}): Promise<PodModelSelectionDb> {
  return Promise.resolve(drizzle(
    {
      fetch: input.fetch,
      info: { webId: input.owner, podUrl: input.podUrl, isLoggedIn: true },
    } as any,
    {
      schema: {
        aiProvider: input.aiProvider,
        aiModel: input.aiModel,
      },
      podUrl: input.podUrl,
    },
  ) as unknown as PodModelSelectionDb);
}
