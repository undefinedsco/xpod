import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RdfDerivedIndexingListener } from '../../src/storage/RdfDerivedIndexingListener';

describe('RdfDerivedIndexingListener', () => {
  it('refreshes PostgreSQL text and vector structures from one authority read', async () => {
    const engine = engineMock();
    const resourceStore = {
      getRepresentation: vi.fn().mockResolvedValue({
        data: Readable.from(['hello searchable world']),
        metadata: { contentType: 'text/markdown' },
      }),
    };
    const listener = createListener({
      rdfEngine: engine,
      resourceStore: resourceStore as any,
      embeddingService: { embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2]]) } as any,
      resolveCredential: async () => ({ apiKey: 'secret', provider: 'test' }),
      defaultModel: 'embed-v1',
    });

    await listener.onResourceChanged(change('https://pod.example/alice/doc.md', 'update'));

    expect(resourceStore.getRepresentation).toHaveBeenCalledTimes(1);
    expect(engine.indexTextSource).toHaveBeenCalledTimes(1);
    expect(engine.indexVectorSource).toHaveBeenCalledTimes(1);
    expect(engine.indexVectorSource.mock.calls[0]![1][0]).toMatchObject({
      embedding: [0.1, 0.2],
      model: 'embed-v1',
      content: 'hello searchable world',
    });
  });

  it('deletes both derived structures without reading deleted authority', async () => {
    const engine = engineMock();
    const resourceStore = { getRepresentation: vi.fn() };
    const listener = createListener({
      rdfEngine: engine,
      resourceStore: resourceStore as any,
    });

    await listener.onResourceChanged(change('https://pod.example/alice/doc.md', 'delete'));

    expect(engine.deleteTextSource).toHaveBeenCalledWith('https://pod.example/alice/doc.md');
    expect(engine.deleteVectorSource).toHaveBeenCalledWith('https://pod.example/alice/doc.md');
    expect(resourceStore.getRepresentation).not.toHaveBeenCalled();
  });

  it('fails the journal delivery when vector refresh cannot complete', async () => {
    const engine = engineMock();
    engine.indexVectorSource.mockRejectedValue(new Error('vector unavailable'));
    const listener = createListener({
      rdfEngine: engine,
      resourceStore: {
        getRepresentation: vi.fn().mockResolvedValue({ data: Readable.from(['body']), metadata: {} }),
      } as any,
      embeddingService: { embedBatch: vi.fn().mockResolvedValue([[1]]) } as any,
      resolveCredential: async () => ({ apiKey: 'secret', provider: 'test' }),
    });

    await expect(listener.onResourceChanged(change('/alice/doc.md', 'update')))
      .rejects.toThrow('vector unavailable');
  });
});

function createListener(options: any): RdfDerivedIndexingListener {
  return new RdfDerivedIndexingListener(
    options.rdfEngine,
    options.resourceStore,
    options.embeddingService,
    options.sparqlEngine,
    options.resolveCredential,
    options.defaultModel,
    options.supportedExtensions,
  );
}

function engineMock() {
  return {
    indexTextSource: vi.fn().mockResolvedValue(undefined),
    deleteTextSource: vi.fn().mockResolvedValue(1),
    indexVectorSource: vi.fn().mockResolvedValue(undefined),
    deleteVectorSource: vi.fn().mockResolvedValue(1),
  };
}

function change(path: string, action: 'create' | 'update' | 'delete') {
  return { path, action, isContainer: false, timestamp: Date.now() } as const;
}
