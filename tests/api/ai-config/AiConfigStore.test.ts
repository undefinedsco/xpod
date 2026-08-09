import { describe, expect, it, vi } from 'vitest';
import { DrizzlePodAiConfigStore } from '../../../src/api/ai-config/AiConfigStore';

const owner = {
  webId: 'https://id.example/alice/profile/card#me',
  podUrl: 'https://storage.example/alice/',
};

describe('DrizzlePodAiConfigStore', () => {
  it('maps the shared AIConfig resource into the UI policy', async () => {
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn()
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ocrModel: '/settings/providers/paddleocr.ttl#pp-ocrv6',
          embeddingModel: '/settings/providers/openai.ttl#text-embedding-3-small',
          ocrEnabled: false,
          automaticOcr: true,
          tableRecognition: true,
          processingMode: 'on-demand',
          updatedAt: new Date('2026-08-09T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ftsEnabled: true,
          vectorEnabled: true,
          progressiveIndexingEnabled: false,
          automaticIndexing: true,
          textBackend: 'fts5',
          vectorBackend: 'vec',
        }),
      updateById: vi.fn(),
      insert: vi.fn(),
    };
    const store = createStore(db);

    const policy = await store.read(owner);

    expect(db.findById).toHaveBeenCalledTimes(2);
    expect(policy).toMatchObject({
      models: {
        ocrModel: '/settings/providers/paddleocr.ttl#pp-ocrv6',
        embeddingModel: '/settings/providers/openai.ttl#text-embedding-3-small',
      },
      documentProcessing: {
        ocrEnabled: false,
        automaticOcr: true,
        tableRecognition: true,
        processingMode: 'on-demand',
      },
      searchIndexing: {
        ftsEnabled: true,
        vectorEnabled: true,
        progressiveIndexingEnabled: false,
        textBackend: 'fts5',
        vectorBackend: 'vec',
      },
      lifecycle: { automaticIndexing: true },
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
  });

  it('merges a partial update and writes shared resource columns', async () => {
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn()
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          embeddingModel: '/settings/providers/openai.ttl#old',
        })
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ftsEnabled: true,
          vectorEnabled: false,
          progressiveIndexingEnabled: true,
          automaticIndexing: true,
          textBackend: 'auto',
          vectorBackend: 'auto',
        }),
      updateById: vi.fn(async () => ({})),
      insert: vi.fn(),
    };
    const store = createStore(db, () => new Date('2026-08-09T01:00:00.000Z'));

    const result = await store.update({
      ...owner,
      patch: {
        models: { embeddingModel: '/settings/providers/openai.ttl#new' },
        searchIndexing: { vectorEnabled: true, vectorBackend: 'vec' },
      },
    });

    expect(db.updateById).toHaveBeenCalledTimes(2);
    expect(db.updateById).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ name: 'aiConfig' }) }), 'config.ttl#config', expect.objectContaining({
      embeddingModel: '/settings/providers/openai.ttl#new',
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    }));
    expect(db.updateById).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ name: 'xpodAiConfig' }) }), 'config.ttl#config', expect.objectContaining({
      vectorEnabled: true,
      vectorBackend: 'vec',
    }));
    expect(result.models.embeddingModel).toContain('#new');
  });

  it('requires trusted Pod access instead of using request-supplied credentials', async () => {
    const store = new DrizzlePodAiConfigStore({
      internalPodAccess: { getTrustedFetch: vi.fn(async () => undefined) },
    });

    await expect(store.read(owner)).rejects.toThrow('service_access_missing');
  });
});

function createStore(db: any, now: () => Date = () => new Date()) {
  return new DrizzlePodAiConfigStore({
    internalPodAccess: { getTrustedFetch: vi.fn(async () => globalThis.fetch) },
    dbFactory: vi.fn(async () => db),
    now,
  });
}
