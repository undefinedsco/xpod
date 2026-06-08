import { describe, expect, it, vi } from 'vitest';
import { RdfSearchIndexingService } from '../../src/api/service/RdfSearchIndexingService';
import type { RdfEngineLike, RdfTextChunkInput } from '../../src/storage/rdf';

const context = {
  type: 'solid' as const,
  webId: 'https://id.example/alice#me',
  accessToken: 'token',
};

const source = {
  source: 'https://pod.example/alice/notes.md',
  workspace: 'https://pod.example/alice/',
  localPath: 'notes.md',
  contentType: 'text/markdown',
  sourceVersion: 'etag-1',
};

describe('RdfSearchIndexingService', () => {
  it('indexes RDF vector source chunks with the user Pod embedding credential', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const getAiConfig = vi.fn(async () => ({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://127.0.0.1:7890',
      apiKey: 'sk-test',
      credentialId: 'cred-1',
      embeddingModel: 'text-embedding-3-small',
    }));
    const chunks: RdfTextChunkInput[] = [
      {
        chunkKey: 'intro',
        ordinal: 0,
        level: 1,
        heading: 'Intro',
        path: ['Intro'],
        content: 'Runtime approvals must be visible to the managed agent.',
        startOffset: 0,
        endOffset: 56,
      },
      {
        chunkKey: 'ops',
        ordinal: 1,
        level: 1,
        heading: 'Ops',
        path: ['Ops'],
        content: 'The operator can steer a running session.',
        startOffset: 57,
        endOffset: 98,
      },
    ];
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig },
      embeddingService: { embedBatch },
    });

    const result = await service.indexVectorSource({ context, source, chunks });

    expect(getAiConfig).toHaveBeenCalledWith(context);
    expect(embedBatch).toHaveBeenCalledWith([
      'Runtime approvals must be visible to the managed agent.',
      'The operator can steer a running session.',
    ], {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://127.0.0.1:7890',
    }, 'text-embedding-3-small');
    expect(indexVectorSource).toHaveBeenCalledWith(source, [
      expect.objectContaining({
        chunkKey: 'intro',
        embedding: [1, 0, 0],
        model: 'text-embedding-3-small',
      }),
      expect.objectContaining({
        chunkKey: 'ops',
        embedding: [0, 1, 0],
        model: 'text-embedding-3-small',
      }),
    ]);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      model: 'text-embedding-3-small',
      chunkCount: 2,
    });
  });

  it('derives chunks and source hash from text when explicit chunks are not provided', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async (texts: string[]) => texts.map((_text, index) => [index + 1, 0]));
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig: vi.fn(async () => ({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        credentialId: 'cred-1',
        embeddingModel: 'text-embedding-3-small',
      })) },
      embeddingService: { embedBatch },
    });

    await service.indexVectorSource({
      context,
      source,
      text: '# Intro\nRuntime approvals.\n\n# Ops\nOperator steering.',
    });

    const [indexedSource, vectorChunks] = indexVectorSource.mock.calls[0];
    expect(indexedSource).toMatchObject({
      ...source,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(vectorChunks).toEqual([
      expect.objectContaining({
        chunkKey: expect.stringMatching(/^[a-f0-9]{24}$/),
        heading: 'Intro',
        embedding: [1, 0],
      }),
      expect.objectContaining({
        chunkKey: expect.stringMatching(/^[a-f0-9]{24}$/),
        heading: 'Ops',
        embedding: [2, 0],
      }),
    ]);
  });

  it('clears stale vector chunks when the source becomes empty', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const getAiConfig = vi.fn(async () => undefined);
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig },
      embeddingService: { embedBatch },
    });

    const result = await service.indexVectorSource({ context, source, text: '' });

    expect(getAiConfig).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(indexVectorSource).toHaveBeenCalledWith(expect.objectContaining({
      source: source.source,
    }), []);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      chunkCount: 0,
    });
  });

  it('does not write vectors without a configured embedding model', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig: vi.fn(async () => ({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        credentialId: 'cred-1',
      })) },
      embeddingService: { embedBatch },
    });

    const result = await service.indexVectorSource({
      context,
      source,
      chunks: [{
        chunkKey: 'intro',
        ordinal: 0,
        level: 1,
        content: 'Runtime approvals.',
        startOffset: 0,
        endOffset: 18,
      }],
    });

    expect(embedBatch).not.toHaveBeenCalled();
    expect(indexVectorSource).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'skipped',
      source: source.source,
      reason: 'embedding_model_unavailable',
    });
  });

  it('can delete RDF vector sources through the configured RDF engine', async () => {
    const deleteVectorSource = vi.fn(async () => 3);
    const service = new RdfSearchIndexingService({
      rdfEngine: { deleteVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig: vi.fn() },
      embeddingService: { embedBatch: vi.fn() },
    });

    await expect(service.deleteVectorSource({ source: source.source })).resolves.toEqual({
      status: 'deleted',
      source: source.source,
      deletedChunks: 3,
    });
    expect(deleteVectorSource).toHaveBeenCalledWith(source.source);
  });
});
