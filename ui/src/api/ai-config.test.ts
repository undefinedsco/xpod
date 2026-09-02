import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { fetchAiConfig, scheduleAiConfigRebuild, testAiConfigModel, updateAiConfig } from './ai-config';

const CURRENT_ORIGIN = 'https://xpod.example';
const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window;

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: CURRENT_ORIGIN } },
  });
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  }
});

const response = {
  config: {
    schemaVersion: '1.0' as const,
    models: {},
    documentProcessing: { ocrEnabled: true, automaticOcr: true, imageRecognition: true, pdfRecognition: true, tableRecognition: false, processingMode: 'auto' as const, ocrFallbackOrder: ['ocr', 'reader', 'plain-text'] as const, readerPolicy: 'auto' as const, readerPriority: 'structure-first' as const, maxFileSizeMb: 64, maxPages: 500, failureFallback: 'plain-text' as const },
    searchIndexing: { ftsEnabled: true, vectorEnabled: false, progressiveIndexingEnabled: true, textBackend: 'auto' as const, vectorBackend: 'auto' as const },
    lifecycle: { automaticIndexing: true, refreshAfterSourceUpdate: true, removeAfterSourceDeletion: true },
  },
  capabilities: { textBackends: ['fts5' as const], vectorBackends: ['vec' as const], rebuildSupported: false },
};

describe('AI Config API', () => {
  test('loads the authenticated Pod policy', async () => {
    const fetchImpl = mock(async () => Response.json(response));
    await expect(fetchAiConfig(fetchImpl as typeof fetch)).resolves.toEqual(response);
    expect(fetchImpl).toHaveBeenCalledWith(`${CURRENT_ORIGIN}/api/ai/config`, expect.objectContaining({ method: 'GET', credentials: 'include' }));
  });

  test('patches only the edited policy section', async () => {
    const fetchImpl = mock(async () => Response.json(response));
    await updateAiConfig(fetchImpl as typeof fetch, { models: { ocrModel: 'vision-model' } });
    expect(fetchImpl).toHaveBeenCalledWith(`${CURRENT_ORIGIN}/api/ai/config`, expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ models: { ocrModel: 'vision-model' } }),
    }));
  });

  test('surfaces the API error message', async () => {
    const fetchImpl = mock(async () => Response.json({ error: 'Pod not found' }, { status: 404 }));
    await expect(fetchAiConfig(fetchImpl as typeof fetch)).rejects.toThrow('Pod not found');
  });

  test('schedules a bounded derived-index rebuild target', async () => {
    const fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ target: 'vector' });
      return new Response(JSON.stringify({ job: { id: 'job-1', target: 'vector', status: 'queued', createdAt: '2026-08-09T00:00:00.000Z' } }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    expect(await scheduleAiConfigRebuild(fetch, 'vector')).toMatchObject({ id: 'job-1', status: 'queued' });
    expect(fetch).toHaveBeenCalledWith(`${CURRENT_ORIGIN}/api/ai/config/rebuild`, expect.objectContaining({ method: 'POST' }));
  });

  test('runs bounded chat and embedding model probes', async () => {
    const fetch = mock(async () => Response.json({ ok: true })) as typeof globalThis.fetch;
    await testAiConfigModel(fetch, { id: 'qwen-vl', capabilities: ['chat'] });
    expect(fetch).toHaveBeenNthCalledWith(1, `${CURRENT_ORIGIN}/v1/chat/completions`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ model: 'qwen-vl', messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1, stream: false }),
    }));
    await testAiConfigModel(fetch, { id: 'embed-v1', capabilities: ['embedding'] });
    expect(fetch).toHaveBeenNthCalledWith(2, `${CURRENT_ORIGIN}/v1/embeddings`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ model: 'embed-v1', input: 'xpod readiness probe' }),
    }));
  });

  test('fails closed when no current browser origin is available', async () => {
    const currentWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
    delete (globalThis as typeof globalThis & { window?: unknown }).window;
    const fetchImpl = mock(async () => Response.json(response));
    try {
      await expect(fetchAiConfig(fetchImpl as typeof fetch)).rejects.toThrow('current browser origin');
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: currentWindow,
      });
    }
  });
});
