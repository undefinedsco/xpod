import { createHash } from 'node:crypto';

import { drizzle, eq, resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import {
  aiModelResource,
  aiProviderResource,
} from '@undefineds.co/models';

import type { AuthContext } from '../../auth/AuthContext';
import {
  callerPodAccessError,
  createCallerAuthenticatedPodFetch,
  isInternalPodAccessAllowed,
} from '../auth/CallerPodAccess';
import type { InternalPodAccessTokenProvider } from '../pod/HostedPodDataAccess';
import { resolveOwnerPodBaseUrl, type PodBaseUrlResolver } from '../pod/PodBaseUrlResolver';

export type PodSelectedModelStatus = 'active' | 'inactive';

const REMOVED_MODEL_STATUS = 'removed';

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
  podBaseUrlResolver?: PodBaseUrlResolver;
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

interface ModelSelectionLockState {
  tail: Promise<void>;
  references: number;
}

const modelSelectionLocks = new Map<string, ModelSelectionLockState>();

/**
 * The selected-model adapter deliberately uses only the shared ai-config
 * resources. Selection state is represented by aiModel rows: unpicked rows
 * are removed, while a picked model that disappears from a complete provider
 * discovery is retained with status="inactive".
 */
export class PodModelSelectionRepository {
  private readonly dbFactory: NonNullable<PodModelSelectionRepositoryOptions['dbFactory']>;
  private readonly internalPodAccess?: InternalPodAccessTokenProvider;
  private readonly podBaseUrlResolver?: PodBaseUrlResolver;
  private readonly providerIds: readonly string[];
  private readonly now: () => Date;

  public constructor(options: PodModelSelectionRepositoryOptions = {}) {
    this.dbFactory = options.dbFactory ?? createDefaultModelSelectionDb;
    this.internalPodAccess = options.internalPodAccess;
    this.podBaseUrlResolver = options.podBaseUrlResolver;
    this.providerIds = dedupeProviders(options.providerIds ?? DEFAULT_MODEL_SELECTION_PROVIDERS);
    this.now = options.now ?? (() => new Date());
  }

  public async listSelection(input: ListSelectionInput): Promise<PodModelSelection> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const context = await this.readSelection(db, input.webId, input.provider);
    return context.selection;
  }

  public async replaceSelection(input: ReplaceSelectionInput): Promise<PodModelSelection> {
    return withModelSelectionLock(selectionLockKey(input.webId, input.provider), () => this.replaceSelectionLocked(input));
  }

  private async replaceSelectionLocked(input: ReplaceSelectionInput): Promise<PodModelSelection> {
    const db = await this.dbForOwner(input.webId, input.auth);
    const context = await this.readSelection(db, input.webId, input.provider);
    if (input.expectedVersion !== undefined && input.expectedVersion !== context.selection.version) {
      throw new Error('model_selection_version_conflict');
    }

    const requested = normalizeRequestedModels(input.models, context.providerId, context.providerResourceId, context.webId);
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
      const defaultIri = buildModelResourceIri(context.webId, defaultModelId);
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
      // Mark omitted rows as removed before any destructive cleanup. This is
      // the logical commit point; physical deletion happens only afterwards.
      for (const deleted of deletes) {
        const marked = await tx.updateById(aiModelResource, deleted.id, {
          status: REMOVED_MODEL_STATUS,
          updatedAt: now,
        });
        if (!marked) {
          throw new Error('model_selection_exact_remove_failed');
        }
      }
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
    await cleanupRemovedModels(db, deletes);
    return (await this.readSelection(db, input.webId, input.provider)).selection;
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
    // The shared drizzle-solid schema resources are rebound while a query is
    // prepared. Keep provider reads sequential so one query cannot change the
    // base/endpoint underneath another in-flight query.
    const selections: PodModelSelection[] = [];
    for (const provider of this.providerIds) {
      selections.push((await this.readSelection(db, input.webId, provider)).selection);
    }
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
    const providerIri = buildProviderResourceIri(webId, providerResourceId);
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
    const modelRows = rows
      .filter((row) => row.status !== REMOVED_MODEL_STATUS)
      .filter((row) => relationMatches(row.isProvidedBy, providerIri, webId));
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
    assertOwnerWebId(owner);
    assertAuthOwner(owner, auth);
    const podUrl = await resolveOwnerPodBaseUrl(owner, this.podBaseUrlResolver);
    const hostedFetch = auth?.type === 'solid' && auth.webId === owner
      ? await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl: podUrl })
      : undefined;
    const callerFetch = createCallerAuthenticatedPodFetch(owner, auth);
    const trustedFetch = hostedFetch ?? callerFetch
      ?? await this.internalPodAccess?.getTrustedFetch(owner, auth, { podBaseUrl: podUrl });
    if (!trustedFetch) {
      throw new Error(isInternalPodAccessAllowed(auth)
        ? 'AI Connection service identity is not configured'
        : callerPodAccessError(owner, auth));
    }
    const podFetch: typeof fetch = async (input, init) => {
      let response: Response;
      try {
        response = await trustedFetch(input, init);
      } catch (error) {
        const url = input instanceof Request ? input.url : String(input);
        throw new Error(`model_selection_pod_fetch_failed:${url}:${errorMessage(error)}`, { cause: error });
      }
      if (response.status === 403) {
        throw new Error('service_access_missing');
      }
      return response;
    };
    const db = await this.dbFactory({
      owner,
      podUrl,
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
  if (!normalized || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(normalized)) {
    throw new Error('model_selection_provider_required');
  }
  return normalized;
}

function selectionLockKey(webId: string, provider: string): string {
  return `${webId}\u0000${normalizeProvider(provider)}`;
}

async function withModelSelectionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const state = modelSelectionLocks.get(key) ?? { tail: Promise.resolve(), references: 0 };
  modelSelectionLocks.set(key, state);
  state.references += 1;
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
    state.references -= 1;
    if (state.references === 0 && modelSelectionLocks.get(key) === state) {
      modelSelectionLocks.delete(key);
    }
  }
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

function assertOwnerWebId(owner: string): void {
  let parsed: URL;
  try {
    parsed = new URL(owner);
  } catch {
    throw new Error('pod_model_selection_owner_invalid');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hash !== '#me' ||
      parsed.search ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.endsWith('/profile/card')) {
    throw new Error('pod_model_selection_owner_invalid');
  }
}

function dedupeProviders(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map(normalizeProvider)));
}

function normalizeRequestedModels(
  models: readonly PodSelectedModelInput[],
  _providerId: string,
  providerResourceId: string,
  webId: string,
): Map<string, NormalizedSelectedModel> {
  const normalized = new Map<string, NormalizedSelectedModel>();
  for (const input of models) {
    const model = typeof input === 'string' ? { id: input, modelType: 'chat' as const } : input;
    const id = buildModelResourceId(model.id, providerResourceId, webId);
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
  const fragmentIndex = raw.indexOf('#');
  if (fragmentIndex < 0) {
    if (
      raw.startsWith('/')
      || raw.startsWith('//')
      || raw.includes('/')
      || raw.includes('?')
      || raw.includes('\\')
      || raw === providerResourceId
      || raw.endsWith('.ttl')
      || /^[a-z][a-z0-9+.-]*:/iu.test(raw)
    ) {
      throw new Error('model_selection_model_invalid_iri');
    }
    return aiModelResource.buildId({ id: raw, isProvidedBy: providerResourceId });
  }

  const document = raw.slice(0, fragmentIndex);
  const fragment = raw.slice(fragmentIndex + 1);
  if (!document || !fragment || fragment.includes('#')) {
    throw new Error('model_selection_model_provider_mismatch');
  }
  if (raw.startsWith('//')) {
    throw new Error('model_selection_model_invalid_iri');
  }

  if (/^[a-z][a-z0-9+.-]*:/iu.test(document)) {
    if (!webId) {
      throw new Error('model_selection_model_provider_mismatch');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('model_selection_model_invalid_iri');
    }
    const podBase = new URL(`${resolvePodBaseUrl(webId).replace(/\/$/u, '')}/`);
    const expectedPath = `${podBase.pathname.replace(/\/$/u, '')}/settings/providers/${providerResourceId}`;
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.origin !== podBase.origin
      || url.pathname !== expectedPath
      || url.search
      || url.username
      || url.password
      || url.hash !== `#${fragment}`
    ) {
      throw new Error('model_selection_model_provider_mismatch');
    }
    return aiModelResource.buildId({ id: `${providerResourceId}#${fragment}` });
  }

  if (document !== providerResourceId || document.includes('/') || document.includes('?') || document.includes('\\')) {
    throw new Error('model_selection_model_provider_mismatch');
  }
  return aiModelResource.buildId({ id: `${providerResourceId}#${fragment}` });
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
  try {
    const raw = value.trim();
    if (raw === expectedIri) {
      return true;
    }
    const relative = toPodRelative(raw, webId);
    const podBase = `${resolvePodBaseUrl(webId).replace(/\/$/u, '')}/`;
    return new URL(relative, podBase).href === expectedIri;
  } catch {
    return false;
  }
}

function toPodRelative(value: string, webId: string): string {
  const raw = value.trim();
  if (!raw || raw.startsWith('//') || raw.includes('?') || raw.includes('\\') || /(?:^|\/)\.\.?(?:\/|$)/u.test(raw)) {
    throw new Error('model_selection_model_invalid_iri');
  }
  const podBase = `${resolvePodBaseUrl(webId).replace(/\/$/u, '')}/`;
  const base = new URL(podBase);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(raw);
  if (!hasScheme && !raw.startsWith('/')) {
    return raw.replace(/^\/+/, '');
  }
  let url: URL;
  try {
    url = new URL(raw, podBase);
  } catch {
    throw new Error('model_selection_model_invalid_iri');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.search ||
      url.username ||
      url.password) {
    throw new Error('model_selection_model_invalid_iri');
  }
  return `${url.pathname.slice(base.pathname.length).replace(/^\/+/, '')}${url.hash}`;
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
      const current = await db.findById<Record<string, unknown>>(aiModelResource, upsert.id);
      if (!current) {
        throw new Error(`rollback_model_missing:${upsert.id}`);
      }
      const restored = await db.updateById(
        aiModelResource,
        upsert.id,
        knownModelFields(upsert.existing),
      );
      if (!restored) {
        throw new Error(`rollback_model_update_failed:${upsert.id}`);
      }
    } else {
      const current = await db.findById<Record<string, unknown>>(aiModelResource, upsert.id);
      if (current) {
        const deleted = await db.deleteById(aiModelResource, upsert.id);
        if (!deleted) {
          throw new Error(`rollback_model_delete_failed:${upsert.id}`);
        }
      }
    }
  }
  for (const deleted of snapshot.modelDeletes) {
    const current = await db.findById<Record<string, unknown>>(aiModelResource, deleted.id);
    if (!current) {
      throw new Error(`rollback_model_missing:${deleted.id}`);
    }
    const restored = await db.updateById(
      aiModelResource,
      deleted.id,
      knownModelFields(deleted.row),
    );
    if (!restored) {
      throw new Error(`rollback_model_update_failed:${deleted.id}`);
    }
  }
  if (snapshot.providerMutation) {
    const providerId = snapshot.providerMutation.id;
    if (snapshot.providerBefore) {
      const current = await db.findById<Record<string, unknown>>(aiProviderResource, providerId);
      if (!current) {
        throw new Error(`rollback_provider_missing:${providerId}`);
      }
      const restored = await db.updateById(
        aiProviderResource,
        providerId,
        knownProviderFields(snapshot.providerBefore),
      );
      if (!restored) {
        throw new Error(`rollback_provider_update_failed:${providerId}`);
      }
    } else {
      const current = await db.findById<Record<string, unknown>>(aiProviderResource, providerId);
      if (current) {
        const deleted = await db.deleteById(aiProviderResource, providerId);
        if (!deleted) {
          throw new Error(`rollback_provider_delete_failed:${providerId}`);
        }
      }
    }
  }
}

function knownModelFields(row: Record<string, unknown>): Record<string, unknown> {
  return restoreFields(row, [ 'isProvidedBy', 'modelType', 'status', 'displayName', 'createdAt', 'updatedAt' ]);
}

function knownProviderFields(row: Record<string, unknown>): Record<string, unknown> {
  return restoreFields(row, [ 'defaultModel', 'createdAt', 'updatedAt' ]);
}

function restoreFields(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of fields) {
    patch[field] = Object.prototype.hasOwnProperty.call(row, field) ? row[field] : null;
  }
  return patch;
}

async function cleanupRemovedModels(
  db: PodModelSelectionDb,
  deleted: Array<{ id: string; row: Record<string, unknown> }>,
): Promise<void> {
  for (const item of deleted) {
    try {
      await db.deleteById(aiModelResource, item.id);
    } catch {
      // The logical removal has already committed. Leaving a hidden tombstone
      // is safe and lets a later maintenance pass retry physical cleanup.
    }
  }
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
  const rawDb = drizzle(
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
  ) as unknown as PodModelSelectionDb;
  return Promise.resolve(wrapModelSelectionDb(rawDb, input.aiModel));
}

let modelCollectionEndpointTail: Promise<void> = Promise.resolve();

const MODEL_RESOURCE_BASE = '/settings/providers/';

/**
 * drizzle-solid mutates shared schema resources while registering a database
 * (the absolute Pod base is written back to the table).  The model schemas are
 * process-wide exports, so restore their relative base before every serialized
 * operation; otherwise a later owner's provider IRI and LDP target can retain
 * the previous owner's Pod URL.
 */
function resetSharedModelResourceState(): void {
  aiProviderResource.setBase(MODEL_RESOURCE_BASE);
  aiModelResource.setBase(MODEL_RESOURCE_BASE);
  const setProviderEndpoint = (aiProviderResource as typeof aiProviderResource & {
    setSparqlEndpoint?: (endpoint: string | undefined) => void;
  }).setSparqlEndpoint;
  const setModelEndpoint = (aiModelResource as typeof aiModelResource & {
    setSparqlEndpoint?: (endpoint: string | undefined) => void;
  }).setSparqlEndpoint;
  setProviderEndpoint?.call(aiProviderResource, undefined);
  setModelEndpoint?.call(aiModelResource, undefined);
}

function wrapModelSelectionDb(db: PodModelSelectionDb, modelResource: typeof aiModelResource): PodModelSelectionDb {
  const wrapped: PodModelSelectionDb = {
    init: db.init ? (...resources) => withModelEndpointLock(() => db.init!(...resources)) : undefined,
    select: () => {
      const query = db.select();
      return {
        from: (resource: typeof aiModelResource) => {
          const from = query.from(resource);
          if (resource !== modelResource) {
            return from;
          }
          return {
            where: (condition: unknown) => {
              const where = from.where(condition);
              return {
                execute: () => withModelCollectionEndpoint(modelResource, () => where.execute()),
              };
            },
          };
        },
      };
    },
    findById: async <T = Record<string, unknown>>(
      resource: typeof aiProviderResource | typeof aiModelResource,
      id: string,
    ) => withModelEndpointLock(
      () => db.findById<T>(resource, id),
    ),
    insert: (resource) => {
      const insert = db.insert(resource);
      return {
        values: (value: Record<string, unknown>) => {
          const values = insert.values(value);
          return {
            execute: () => withModelEndpointLock(() => values.execute()),
          };
        },
      };
    },
    updateById: async <T = Record<string, unknown>>(
      resource: typeof aiProviderResource | typeof aiModelResource,
      id: string,
      patch: Record<string, unknown>,
    ) => withModelEndpointLock(
      () => db.updateById<T>(resource, id, patch),
    ),
    deleteById: (
      resource: typeof aiProviderResource | typeof aiModelResource,
      id: string,
    ) => withModelEndpointLock(() => db.deleteById(resource, id)),
    ...(db.transaction ? { transaction: db.transaction.bind(db) } : {}),
  };
  return wrapped;
}

async function withModelCollectionEndpoint<T>(resource: typeof aiModelResource, operation: () => Promise<T>): Promise<T> {
  return withModelEndpointLock(async() => {
    const getEndpoint = (resource as typeof aiModelResource & {
      getSparqlEndpoint?: () => string | undefined;
    }).getSparqlEndpoint;
    const setEndpoint = (resource as typeof aiModelResource & {
      setSparqlEndpoint?: (endpoint: string) => void;
    }).setSparqlEndpoint;
    const previousEndpoint = typeof getEndpoint === 'function' ? getEndpoint.call(resource) : undefined;
    if (typeof setEndpoint === 'function' && typeof getEndpoint === 'function') {
      setEndpoint.call(resource, previousEndpoint ?? '/settings/providers/-/sparql');
    }
    try {
      return await operation();
    } finally {
      if (typeof setEndpoint === 'function') {
        setEndpoint.call(resource, previousEndpoint as string);
      }
    }
  });
}

async function withModelEndpointLock<T>(operation: () => Promise<T>): Promise<T> {
  const previousTail = modelCollectionEndpointTail;
  let release!: () => void;
  modelCollectionEndpointTail = new Promise<void>((resolve) => { release = resolve; });
  await previousTail;
  resetSharedModelResourceState();
  try {
    return await operation();
  } finally {
    resetSharedModelResourceState();
    release();
  }
}

function buildProviderResourceIri(webId: string, resourceId: string): string {
  return new URL(resourceId, `${resolvePodBaseUrl(webId)}/settings/providers/`).href;
}

function buildModelResourceIri(webId: string, resourceId: string): string {
  return new URL(resourceId, `${resolvePodBaseUrl(webId)}/settings/providers/`).href;
}
