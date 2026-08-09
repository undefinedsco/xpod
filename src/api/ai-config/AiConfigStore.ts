import { drizzle } from '@undefineds.co/drizzle-solid';
import { aiConfigResource } from '@undefineds.co/models';
import type { InternalPodAccessTokenProvider } from '../ai-gateway/auth/PodGatewayAccessKeyRepository';
import type {
  AiConfigModelAssignment,
  AiConfigPolicy,
  AiConfigPolicyPatch,
  AiConfigPolicyStore,
} from '../handlers/AiConfigHandler';
import { xpodAiConfigResource } from './XpodAiConfigSchema';

type AiConfigRow = Record<string, unknown>;

interface AiConfigDb {
  init?: (...resources: unknown[]) => Promise<void>;
  findById<TRow>(resource: unknown, id: string): Promise<TRow | null>;
  updateById<TRow>(resource: unknown, id: string, patch: unknown): Promise<TRow | null>;
  insert(resource: unknown): {
    values(row: unknown): { execute(): Promise<unknown> };
  };
}

export interface DrizzlePodAiConfigStoreOptions {
  internalPodAccess?: InternalPodAccessTokenProvider;
  dbFactory?: (input: { webId: string; podUrl: string; fetch: typeof fetch }) => Promise<AiConfigDb>;
  now?: () => Date;
}

export class DrizzlePodAiConfigStore implements AiConfigPolicyStore {
  private readonly dbFactory: NonNullable<DrizzlePodAiConfigStoreOptions['dbFactory']>;
  private readonly now: () => Date;

  public constructor(private readonly options: DrizzlePodAiConfigStoreOptions) {
    this.dbFactory = options.dbFactory ?? createAiConfigDb;
    this.now = options.now ?? (() => new Date());
  }

  public async read(input: { webId: string; podUrl: string }): Promise<AiConfigPolicy> {
    const { db } = await this.open(input);
    const id = aiConfigResourceId();
    const [sharedRow, productRow] = await Promise.all([
      db.findById<AiConfigRow>(aiConfigResource, id),
      db.findById<AiConfigRow>(xpodAiConfigResource, id),
    ]);
    return policyFromRows(sharedRow, productRow);
  }

  public async update(input: {
    webId: string;
    podUrl: string;
    patch: AiConfigPolicyPatch;
  }): Promise<AiConfigPolicy> {
    const { db } = await this.open(input);
    const id = aiConfigResourceId();
    const [sharedCurrent, productCurrent] = await Promise.all([
      db.findById<AiConfigRow>(aiConfigResource, id),
      db.findById<AiConfigRow>(xpodAiConfigResource, id),
    ]);
    const mergedPolicy = mergePolicy(policyFromRows(sharedCurrent, productCurrent), input.patch, this.now());

    await Promise.all([
      writeRow(db, aiConfigResource, id, sharedCurrent, sharedRowFromPolicy(mergedPolicy)),
      writeRow(db, xpodAiConfigResource, id, productCurrent, productRowFromPolicy(mergedPolicy)),
    ]);
    return mergedPolicy;
  }

  private async open(input: { webId: string; podUrl: string }): Promise<{ db: AiConfigDb }> {
    const trustedFetch = await this.options.internalPodAccess?.getTrustedFetch(input.webId);
    if (!trustedFetch) throw new Error('service_access_missing');
    const db = await this.dbFactory({ ...input, fetch: trustedFetch });
    await db.init?.(aiConfigResource, xpodAiConfigResource);
    return { db };
  }
}

function aiConfigResourceId(): string {
  return aiConfigResource.buildId({ id: 'config' });
}

function policyFromRows(sharedRow: AiConfigRow | null, productRow: AiConfigRow | null): AiConfigPolicy {
  const defaults = defaultPolicy();
  if (!sharedRow && !productRow) return defaults;
  const shared = sharedRow ?? {};
  const product = productRow ?? {};
  const models: AiConfigPolicy['models'] = {};
  for (const key of modelKeys) {
    if (typeof shared[key] === 'string' && shared[key]) models[key] = shared[key] as string;
  }
  return {
    schemaVersion: '1.0',
    models,
    documentProcessing: {
      ocrEnabled: booleanValue(shared.ocrEnabled, defaults.documentProcessing.ocrEnabled),
      automaticOcr: booleanValue(shared.automaticOcr, defaults.documentProcessing.automaticOcr),
      imageRecognition: booleanValue(shared.imageRecognition, defaults.documentProcessing.imageRecognition),
      pdfRecognition: booleanValue(shared.pdfRecognition, defaults.documentProcessing.pdfRecognition),
      tableRecognition: booleanValue(shared.tableRecognition, defaults.documentProcessing.tableRecognition),
      processingMode: shared.processingMode === 'on-demand' ? 'on-demand' : 'auto',
      ocrFallbackOrder: fallbackOrder(shared.ocrFallbackOrder),
      readerPolicy: shared.readerPolicy === 'always' || shared.readerPolicy === 'disabled' ? shared.readerPolicy : 'auto',
      readerPriority: shared.readerPriority === 'speed-first' ? 'speed-first' : 'structure-first',
      maxFileSizeMb: boundedValue(shared.maxFileSizeMb, defaults.documentProcessing.maxFileSizeMb),
      maxPages: boundedValue(shared.maxPages, defaults.documentProcessing.maxPages),
      failureFallback: shared.failureFallback === 'skip' ? 'skip' : 'plain-text',
    },
    searchIndexing: {
      ftsEnabled: booleanValue(product.ftsEnabled, defaults.searchIndexing.ftsEnabled),
      vectorEnabled: booleanValue(product.vectorEnabled, defaults.searchIndexing.vectorEnabled),
      progressiveIndexingEnabled: booleanValue(product.progressiveIndexingEnabled, defaults.searchIndexing.progressiveIndexingEnabled),
      textBackend: textBackend(product.textBackend),
      vectorBackend: vectorBackend(product.vectorBackend),
    },
    lifecycle: {
      automaticIndexing: booleanValue(product.automaticIndexing, defaults.lifecycle.automaticIndexing),
      refreshAfterSourceUpdate: booleanValue(product.refreshAfterSourceUpdate, defaults.lifecycle.refreshAfterSourceUpdate),
      removeAfterSourceDeletion: booleanValue(product.removeAfterSourceDeletion, defaults.lifecycle.removeAfterSourceDeletion),
    },
    updatedAt: isoDate(shared.updatedAt),
  };
}

function mergePolicy(current: AiConfigPolicy, patch: AiConfigPolicyPatch, now: Date): AiConfigPolicy {
  const models = { ...current.models };
  for (const key of modelKeys) {
    const value = patch.models?.[key];
    if (value === null) delete models[key];
    else if (value !== undefined) models[key] = value;
  }
  return {
    schemaVersion: '1.0',
    models,
    documentProcessing: { ...current.documentProcessing, ...patch.documentProcessing },
    searchIndexing: { ...current.searchIndexing, ...patch.searchIndexing },
    lifecycle: { ...current.lifecycle, ...patch.lifecycle },
    updatedAt: now.toISOString(),
  };
}

function sharedRowFromPolicy(policy: AiConfigPolicy): AiConfigRow {
  return {
    ...Object.fromEntries(modelKeys.map((key) => [key, policy.models[key] ?? null])),
    ...policy.documentProcessing,
    ocrFallbackOrder: policy.documentProcessing.ocrFallbackOrder.join(','),
    updatedAt: policy.updatedAt ? new Date(policy.updatedAt) : new Date(),
  };
}

function productRowFromPolicy(policy: AiConfigPolicy): AiConfigRow {
  return {
    ...policy.searchIndexing,
    ...policy.lifecycle,
  };
}

async function writeRow(
  db: AiConfigDb,
  resource: unknown,
  id: string,
  current: AiConfigRow | null,
  row: AiConfigRow,
): Promise<void> {
  if (current) {
    await db.updateById(resource, id, row);
    return;
  }
  await db.insert(resource).values({ id, ...row }).execute();
}

function defaultPolicy(): AiConfigPolicy {
  return {
    schemaVersion: '1.0',
    models: {},
    documentProcessing: {
      ocrEnabled: true,
      automaticOcr: true,
      imageRecognition: true,
      pdfRecognition: true,
      tableRecognition: false,
      processingMode: 'auto',
      ocrFallbackOrder: ['ocr', 'reader', 'plain-text'],
      readerPolicy: 'auto',
      readerPriority: 'structure-first',
      maxFileSizeMb: 64,
      maxPages: 500,
      failureFallback: 'plain-text',
    },
    searchIndexing: {
      ftsEnabled: true,
      vectorEnabled: true,
      progressiveIndexingEnabled: true,
      textBackend: 'auto',
      vectorBackend: 'auto',
    },
    lifecycle: { automaticIndexing: true, refreshAfterSourceUpdate: true, removeAfterSourceDeletion: true },
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback; }
function fallbackOrder(value: unknown): AiConfigPolicy['documentProcessing']['ocrFallbackOrder'] {
  if (typeof value !== 'string') return ['ocr', 'reader', 'plain-text'];
  const items = value.split(',').filter((item): item is 'ocr' | 'reader' | 'plain-text' => ['ocr', 'reader', 'plain-text'].includes(item));
  return items.length ? items : ['ocr', 'reader', 'plain-text'];
}

function textBackend(value: unknown): AiConfigPolicy['searchIndexing']['textBackend'] {
  return value === 'fts5' || value === 'postgres-fts' ? value : 'auto';
}

function vectorBackend(value: unknown): AiConfigPolicy['searchIndexing']['vectorBackend'] {
  return value === 'vec' || value === 'pgvector' ? value : 'auto';
}

function isoDate(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

const modelKeys: AiConfigModelAssignment[] = [
  'chatModel',
  'ocrModel',
  'readerModel',
  'embeddingModel',
  'indexerModel',
  'rerankerModel',
];

async function createAiConfigDb(input: {
  webId: string;
  podUrl: string;
  fetch: typeof fetch;
}): Promise<AiConfigDb> {
  return drizzle({
    fetch: input.fetch,
    info: { webId: input.webId, isLoggedIn: true },
  } as any, {
    podUrl: input.podUrl,
    schema: { aiConfig: aiConfigResource, xpodAiConfig: xpodAiConfigResource },
  }) as unknown as AiConfigDb;
}
