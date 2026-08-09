import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';

export type AiConfigModelAssignment =
  | 'chatModel'
  | 'ocrModel'
  | 'readerModel'
  | 'embeddingModel'
  | 'indexerModel'
  | 'rerankerModel';

export interface AiConfigPolicy {
  schemaVersion: '1.0';
  models: Partial<Record<AiConfigModelAssignment, string>>;
  documentProcessing: {
    ocrEnabled: boolean;
    automaticOcr: boolean;
    imageRecognition: boolean;
    pdfRecognition: boolean;
    tableRecognition: boolean;
    processingMode: 'auto' | 'on-demand';
    ocrFallbackOrder: Array<'ocr' | 'reader' | 'plain-text'>;
    readerPolicy: 'auto' | 'always' | 'disabled';
    readerPriority: 'structure-first' | 'speed-first';
    maxFileSizeMb: number;
    maxPages: number;
    failureFallback: 'plain-text' | 'skip';
  };
  searchIndexing: {
    ftsEnabled: boolean;
    vectorEnabled: boolean;
    progressiveIndexingEnabled: boolean;
    textBackend: 'auto' | 'fts5' | 'postgres-fts';
    vectorBackend: 'auto' | 'vec' | 'pgvector';
  };
  lifecycle: {
    automaticIndexing: boolean;
    refreshAfterSourceUpdate: boolean;
    removeAfterSourceDeletion: boolean;
  };
  updatedAt?: string;
}

export type AiConfigPolicyPatch = {
  models?: Partial<Record<AiConfigModelAssignment, string | null>>;
  documentProcessing?: Partial<AiConfigPolicy['documentProcessing']>;
  searchIndexing?: Partial<AiConfigPolicy['searchIndexing']>;
  lifecycle?: Partial<AiConfigPolicy['lifecycle']>;
};

export interface AiConfigCapabilities {
  textBackends: Array<'fts5' | 'postgres-fts'>;
  vectorBackends: Array<'vec' | 'pgvector'>;
  rebuildSupported: boolean;
  rebuildTargets?: AiConfigRebuildTarget[];
}

export type AiConfigRebuildTarget = 'fts' | 'vector' | 'all';
export type AiConfigRebuildStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface AiConfigRebuildJob {
  id: string;
  target: AiConfigRebuildTarget;
  status: AiConfigRebuildStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number;
  error?: string;
}
export interface AiConfigLifecycleSnapshot {
  configurationVersion?: string;
  pending: number;
  recent: AiConfigRebuildJob[];
}
export interface AiConfigLifecycleService {
  supportedTargets(): AiConfigRebuildTarget[];
  status(owner: { webId: string; podUrl: string }): Promise<AiConfigLifecycleSnapshot>;
  schedule(input: { webId: string; podUrl: string; target: AiConfigRebuildTarget }): Promise<AiConfigRebuildJob>;
}

export interface AiConfigPolicyStore {
  read(input: { webId: string; podUrl: string }): Promise<AiConfigPolicy>;
  update(input: { webId: string; podUrl: string; patch: AiConfigPolicyPatch }): Promise<AiConfigPolicy>;
}

export interface AiConfigHandlerOptions {
  podLookupRepository: Pick<PodLookupRepository, 'findByWebId'>;
  store: AiConfigPolicyStore;
  capabilities?: () => AiConfigCapabilities;
  lifecycle?: AiConfigLifecycleService;
}

export function registerAiConfigRoutes(server: ApiServer, options: AiConfigHandlerOptions): void {
  server.get('/api/ai/config', async (request, response) => {
    const owner = await resolveOwner(request, response, options);
    if (!owner) return;
    try {
      const config = await options.store.read(owner);
      sendJson(response, 200, {
        config,
        capabilities: resolveCapabilities(options),
        lifecycle: options.lifecycle ? await options.lifecycle.status(owner) : emptyLifecycle(config.updatedAt),
      });
    } catch {
      sendJson(response, 500, { error: 'Failed to read AI Config' });
    }
  });

  server.patch('/api/ai/config', async (request, response) => {
    const owner = await resolveOwner(request, response, options);
    if (!owner) return;
    const body = await readBoundedJsonBody(request, { limitBytes: 32 * 1024 });
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    const patch = parsePolicyPatch(body.value);
    if (!patch) {
      sendJson(response, 400, { error: 'Invalid AI Config update' });
      return;
    }
    try {
      const config = await options.store.update({ ...owner, patch });
      sendJson(response, 200, {
        config,
        capabilities: resolveCapabilities(options),
        lifecycle: options.lifecycle ? await options.lifecycle.status(owner) : emptyLifecycle(config.updatedAt),
      });
    } catch {
      sendJson(response, 500, { error: 'Failed to update AI Config' });
    }
  });

  server.post('/api/ai/config/rebuild', async (request, response) => {
    const owner = await resolveOwner(request, response, options);
    if (!owner) return;
    if (!options.lifecycle) {
      sendJson(response, 409, { error: 'Index rebuild is unavailable on this runtime' });
      return;
    }
    const body = await readBoundedJsonBody(request, { limitBytes: 4 * 1024 });
    if (!body.ok) { sendJson(response, body.status, { error: body.error }); return; }
    const target = parseRebuildTarget(body.value);
    if (!target) { sendJson(response, 400, { error: 'Invalid rebuild target' }); return; }
    if (!options.lifecycle.supportedTargets().includes(target)) {
      sendJson(response, 409, { error: `Rebuild target ${target} is unsupported` });
      return;
    }
    try {
      sendJson(response, 202, { job: await options.lifecycle.schedule({ ...owner, target }) });
    } catch {
      sendJson(response, 500, { error: 'Failed to schedule index rebuild' });
    }
  });
}

async function resolveOwner(
  request: AuthenticatedRequest,
  response: ServerResponse,
  options: AiConfigHandlerOptions,
): Promise<{ webId: string; podUrl: string } | undefined> {
  if (!request.auth || request.auth.type !== 'solid') {
    sendJson(response, 401, { error: 'Authentication required' });
    return undefined;
  }
  const webId = request.auth.webId;
  const pod = await options.podLookupRepository.findByWebId(webId);
  const podUrl = pod?.storageUrl ?? pod?.baseUrl;
  if (!podUrl) {
    sendJson(response, 404, { error: 'Pod not found' });
    return undefined;
  }
  return { webId, podUrl };
}

function parsePolicyPatch(value: unknown): AiConfigPolicyPatch | undefined {
  if (!isRecord(value)) return undefined;
  const patch: AiConfigPolicyPatch = {};

  if ('models' in value) {
    if (!isRecord(value.models)) return undefined;
    const models: NonNullable<AiConfigPolicyPatch['models']> = {};
    for (const key of modelAssignmentKeys) {
      const candidate = value.models[key];
      if (candidate !== undefined) {
        if (candidate !== null && (typeof candidate !== 'string' || !candidate.trim())) return undefined;
        models[key] = candidate === null ? null : candidate.trim();
      }
    }
    if (Object.keys(value.models).some((key) => !modelAssignmentKeys.includes(key as AiConfigModelAssignment))) return undefined;
    patch.models = models;
  }

  if ('documentProcessing' in value) {
    if (!isRecord(value.documentProcessing)) return undefined;
    const parsed = parseDocumentProcessing(value.documentProcessing);
    if (!parsed) return undefined;
    patch.documentProcessing = parsed;
  }

  if ('searchIndexing' in value) {
    if (!isRecord(value.searchIndexing)) return undefined;
    const parsed = parseSearchIndexing(value.searchIndexing);
    if (!parsed) return undefined;
    patch.searchIndexing = parsed;
  }

  if ('lifecycle' in value) {
    if (!isRecord(value.lifecycle)) return undefined;
    const allowed = ['automaticIndexing', 'refreshAfterSourceUpdate', 'removeAfterSourceDeletion'];
    if (Object.keys(value.lifecycle).some((key) => !allowed.includes(key))) return undefined;
    for (const key of allowed) if (value.lifecycle[key] !== undefined && typeof value.lifecycle[key] !== 'boolean') return undefined;
    patch.lifecycle = value.lifecycle as AiConfigPolicyPatch['lifecycle'];
  }

  if (Object.keys(value).some((key) => !['models', 'documentProcessing', 'searchIndexing', 'lifecycle'].includes(key))) return undefined;
  return patch;
}

function parseDocumentProcessing(value: Record<string, unknown>): AiConfigPolicyPatch['documentProcessing'] | undefined {
  const allowed = ['ocrEnabled', 'automaticOcr', 'imageRecognition', 'pdfRecognition', 'tableRecognition', 'processingMode', 'ocrFallbackOrder', 'readerPolicy', 'readerPriority', 'maxFileSizeMb', 'maxPages', 'failureFallback'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
  for (const key of ['ocrEnabled', 'automaticOcr', 'imageRecognition', 'pdfRecognition', 'tableRecognition'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return undefined;
  }
  if (value.processingMode !== undefined && value.processingMode !== 'auto' && value.processingMode !== 'on-demand') return undefined;
  if (value.ocrFallbackOrder !== undefined && (!Array.isArray(value.ocrFallbackOrder) || value.ocrFallbackOrder.length < 1 || value.ocrFallbackOrder.length > 3 || value.ocrFallbackOrder.some((item) => !['ocr', 'reader', 'plain-text'].includes(String(item))))) return undefined;
  if (value.readerPolicy !== undefined && !['auto', 'always', 'disabled'].includes(String(value.readerPolicy))) return undefined;
  if (value.readerPriority !== undefined && !['structure-first', 'speed-first'].includes(String(value.readerPriority))) return undefined;
  if (value.failureFallback !== undefined && !['plain-text', 'skip'].includes(String(value.failureFallback))) return undefined;
  if (value.maxFileSizeMb !== undefined && !boundedInteger(value.maxFileSizeMb, 1, 1024)) return undefined;
  if (value.maxPages !== undefined && !boundedInteger(value.maxPages, 1, 10_000)) return undefined;
  return value as AiConfigPolicyPatch['documentProcessing'];
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function parseSearchIndexing(value: Record<string, unknown>): AiConfigPolicyPatch['searchIndexing'] | undefined {
  const allowed = ['ftsEnabled', 'vectorEnabled', 'progressiveIndexingEnabled', 'textBackend', 'vectorBackend'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
  for (const key of ['ftsEnabled', 'vectorEnabled', 'progressiveIndexingEnabled'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return undefined;
  }
  if (value.textBackend !== undefined && !['auto', 'fts5', 'postgres-fts'].includes(String(value.textBackend))) return undefined;
  if (value.vectorBackend !== undefined && !['auto', 'vec', 'pgvector'].includes(String(value.vectorBackend))) return undefined;
  return value as AiConfigPolicyPatch['searchIndexing'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultCapabilities(): AiConfigCapabilities {
  return { textBackends: [], vectorBackends: [], rebuildSupported: false };
}

function resolveCapabilities(options: AiConfigHandlerOptions): AiConfigCapabilities {
  const capabilities = options.capabilities?.() ?? defaultCapabilities();
  const rebuildTargets = options.lifecycle?.supportedTargets() ?? [];
  return { ...capabilities, rebuildSupported: rebuildTargets.length > 0, rebuildTargets };
}

function emptyLifecycle(configurationVersion?: string): AiConfigLifecycleSnapshot { return { configurationVersion, pending: 0, recent: [] }; }
function parseRebuildTarget(value: unknown): AiConfigRebuildTarget | undefined {
  if (!isRecord(value)) return undefined;
  return value.target === 'fts' || value.target === 'vector' || value.target === 'all' ? value.target : undefined;
}

const modelAssignmentKeys: AiConfigModelAssignment[] = [
  'chatModel',
  'ocrModel',
  'readerModel',
  'embeddingModel',
  'indexerModel',
  'rerankerModel',
];

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
