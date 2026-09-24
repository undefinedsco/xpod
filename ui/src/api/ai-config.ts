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
  lifecycle: { automaticIndexing: boolean; refreshAfterSourceUpdate: boolean; removeAfterSourceDeletion: boolean };
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
export interface AiConfigRebuildJob { id: string; target: AiConfigRebuildTarget; status: 'queued' | 'running' | 'succeeded' | 'failed'; createdAt: string; startedAt?: string; completedAt?: string; progress?: number; error?: string }
export interface AiConfigLifecycleSnapshot { configurationVersion?: string; pending: number; recent: AiConfigRebuildJob[] }

export interface AiConfigResponse {
  config: AiConfigPolicy;
  capabilities: AiConfigCapabilities;
  lifecycle: AiConfigLifecycleSnapshot;
}

export async function fetchAiConfig(authenticatedFetch: typeof fetch): Promise<AiConfigResponse> {
  return readResponse(authenticatedFetch(currentOriginApiUrl('/api/ai/config'), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  }));
}

export async function updateAiConfig(
  authenticatedFetch: typeof fetch,
  patch: AiConfigPolicyPatch,
): Promise<AiConfigResponse> {
  return readResponse(authenticatedFetch(currentOriginApiUrl('/api/ai/config'), {
    method: 'PATCH',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }));
}

export async function scheduleAiConfigRebuild(authenticatedFetch: typeof fetch, target: AiConfigRebuildTarget): Promise<AiConfigRebuildJob> {
  const response = await authenticatedFetch(currentOriginApiUrl('/api/ai/config/rebuild'), { method: 'POST', credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ target }) });
  const payload = await response.json().catch(() => undefined) as { job?: AiConfigRebuildJob; error?: string } | undefined;
  if (!response.ok || !payload?.job) throw new Error(payload?.error ?? 'Index rebuild request failed');
  return payload.job;
}

export async function testAiConfigModel(
  authenticatedFetch: typeof fetch,
  model: { id: string; capabilities: string[] },
): Promise<void> {
  const embedding = model.capabilities.some((capability) => capability.toLowerCase() === 'embedding');
  const response = await authenticatedFetch(currentOriginApiUrl(embedding ? '/v1/embeddings' : '/v1/chat/completions'), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(embedding
      ? { model: model.id, input: 'xpod readiness probe' }
      : { model: model.id, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1, stream: false }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: string | { message?: string } } | undefined;
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    throw new Error(message ?? 'Model readiness probe failed');
  }
  await response.arrayBuffer();
}

function currentOriginApiUrl(path: string): string {
  if (typeof window === 'undefined') {
    throw new Error('AI Config API requires the current browser origin');
  }
  return new URL(path, window.location.origin).toString();
}

async function readResponse(responsePromise: Promise<Response>): Promise<AiConfigResponse> {
  const response = await responsePromise;
  const payload = await response.json().catch(() => undefined) as (AiConfigResponse & { error?: string }) | undefined;
  if (!response.ok || !payload?.config || !payload.capabilities) {
    throw new Error(payload?.error ?? 'AI Config request failed');
  }
  return payload;
}
