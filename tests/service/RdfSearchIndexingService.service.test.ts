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
    const indexVectorSource = vi.fn(async (
      _source: Parameters<NonNullable<RdfEngineLike['indexVectorSource']>>[0],
      _chunks: Parameters<NonNullable<RdfEngineLike['indexVectorSource']>>[1],
    ) => {});
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
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputKind: 'semantic',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        projectionPolicyVersion: 'rdf-vector-projection-v1',
      }),
      expect.objectContaining({
        chunkKey: 'ops',
        embedding: [0, 1, 0],
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputKind: 'semantic',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        projectionPolicyVersion: 'rdf-vector-projection-v1',
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
    const indexVectorSource = vi.fn(async (
      _source: Parameters<NonNullable<RdfEngineLike['indexVectorSource']>>[0],
      _chunks: Parameters<NonNullable<RdfEngineLike['indexVectorSource']>>[1],
    ) => {});
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

    const indexCall = indexVectorSource.mock.calls[0];
    if (!indexCall) {
      throw new Error('Expected RDF vector indexing call');
    }
    const [indexedSource, vectorChunks] = indexCall;
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

  it('can index separate locator and semantic embedding inputs without mixing body into locator text', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [
      [1, 0],
      [0, 1],
    ]);
    const getAiConfig = vi.fn(async () => ({
      providerId: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-test',
      credentialId: 'cred-1',
      embeddingModel: 'text-embedding-v4',
    }));
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig },
      embeddingService: { embedBatch },
      embeddingInputKinds: ['locator', 'semantic'],
      projectionPolicyVersion: 'test-policy-v2',
    });

    const result = await service.indexVectorSource({
      context,
      source: {
        ...source,
        localPath: 'docs/runtime/guide.md',
      },
      chunks: [{
        chunkKey: 'install',
        ordinal: 0,
        level: 2,
        heading: 'Install',
        path: ['Runtime', 'Install'],
        content: 'Body content should stay out of the locator projection.',
        startOffset: 0,
        endOffset: 55,
      }],
    });

    expect(embedBatch).toHaveBeenCalledWith([
      'Path: docs / runtime / guide.md\nHeading: Runtime / Install',
      'Body content should stay out of the locator projection.',
    ], {
      provider: 'dashscope',
      apiKey: 'sk-test',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      proxyUrl: undefined,
    }, 'text-embedding-v4');
    expect(indexVectorSource).toHaveBeenCalledWith(expect.objectContaining({
      source: source.source,
      localPath: 'docs/runtime/guide.md',
    }), [
      expect.objectContaining({
        chunkKey: 'install',
        embedding: [1, 0],
        provider: 'dashscope',
        model: 'text-embedding-v4',
        inputKind: 'locator',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        projectionPolicyVersion: 'test-policy-v2',
        content: 'Path: docs / runtime / guide.md\nHeading: Runtime / Install',
      }),
      expect.objectContaining({
        chunkKey: 'install',
        embedding: [0, 1],
        provider: 'dashscope',
        model: 'text-embedding-v4',
        inputKind: 'semantic',
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        projectionPolicyVersion: 'test-policy-v2',
        content: 'Body content should stay out of the locator projection.',
      }),
    ]);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      model: 'text-embedding-v4',
      chunkCount: 2,
    });
  });

  it('propagates embedding model version into vector identity', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [
      [1, 0],
    ]);
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig: vi.fn(async () => ({
        providerId: 'dashscope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'sk-test',
        credentialId: 'cred-1',
        embeddingModel: 'text-embedding-v4',
        embeddingModelVersion: '2026-06',
      })) },
      embeddingService: { embedBatch },
    });

    await service.indexVectorSource({
      context,
      source,
      chunks: [{
        chunkKey: 'versioned',
        ordinal: 0,
        level: 1,
        content: 'Versioned embedding identity.',
        startOffset: 0,
        endOffset: 29,
      }],
    });

    expect(indexVectorSource).toHaveBeenCalledWith(source, [
      expect.objectContaining({
        chunkKey: 'versioned',
        provider: 'dashscope',
        model: 'text-embedding-v4',
        modelVersion: '2026-06',
      }),
    ]);
  });

  it('skips over-budget embedding inputs with an explicit reason instead of truncating them', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [
      [1, 0],
    ]);
    const getAiConfig = vi.fn(async () => ({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      credentialId: 'cred-1',
      embeddingModel: 'text-embedding-3-small',
    }));
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig },
      embeddingService: { embedBatch },
      maxEmbeddingInputChars: 20,
    });

    const result = await service.indexVectorSource({
      context,
      source,
      chunks: [
        {
          chunkKey: 'small',
          ordinal: 0,
          level: 1,
          content: 'short semantic',
          startOffset: 0,
          endOffset: 14,
        },
        {
          chunkKey: 'large',
          ordinal: 1,
          level: 1,
          content: 'this semantic input is too large to embed without summarization',
          startOffset: 15,
          endOffset: 75,
        },
      ],
    });

    expect(embedBatch).toHaveBeenCalledWith([
      'short semantic',
    ], expect.anything(), 'text-embedding-3-small');
    expect(indexVectorSource).toHaveBeenCalledWith(source, [
      expect.objectContaining({
        chunkKey: 'small',
        content: 'short semantic',
      }),
    ]);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      model: 'text-embedding-3-small',
      chunkCount: 1,
      skippedInputs: [
        {
          chunkKey: 'large',
          inputKind: 'semantic',
          reason: 'input_too_large',
          inputChars: 63,
          maxChars: 20,
        },
      ],
    });
  });

  it('summarizes over-budget embedding inputs when a summary service is configured', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [
      [1, 0],
    ]);
    const summarize = vi.fn(async () => ({
      content: 'short summary',
      model: 'summary-model',
      provider: 'summary-provider',
      promptVersion: 'summary-v1',
      rounds: 1,
    }));
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
      summaryService: { summarize },
      maxEmbeddingInputChars: 20,
      summaryPromptVersion: 'summary-v1',
    });

    const result = await service.indexVectorSource({
      context,
      source: {
        ...source,
        sourceHash: 'source-hash-v1',
      },
      chunks: [{
        chunkKey: 'large',
        ordinal: 0,
        level: 1,
        content: 'this semantic input is too large to embed without summarization',
        startOffset: 0,
        endOffset: 63,
      }],
    });

    expect(summarize).toHaveBeenCalledWith({
      content: 'this semantic input is too large to embed without summarization',
      inputKind: 'semantic',
      chunkKey: 'large',
      sourceHash: 'source-hash-v1',
      maxChars: 20,
      promptVersion: 'summary-v1',
    });
    expect(embedBatch).toHaveBeenCalledWith([
      'short summary',
    ], expect.anything(), 'text-embedding-3-small');
    expect(indexVectorSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceHash: 'source-hash-v1',
    }), [
      expect.objectContaining({
        chunkKey: 'large',
        content: 'short summary',
        inputKind: 'semantic',
        summaryMetadata: {
          status: 'summarized',
          provider: 'summary-provider',
          model: 'summary-model',
          promptVersion: 'summary-v1',
          sourceHash: 'source-hash-v1',
          originalChars: 63,
          summaryChars: 13,
          rounds: 1,
        },
      }),
    ]);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      model: 'text-embedding-3-small',
      chunkCount: 1,
      summarizedInputs: [
        {
          chunkKey: 'large',
          inputKind: 'semantic',
          originalChars: 63,
          summaryChars: 13,
          rounds: 1,
        },
      ],
    });
  });

  it('skips over-budget embedding inputs with an explicit summary failure reason', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const summarize = vi.fn(async () => {
      throw new Error('summary quota exceeded');
    });
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
      summaryService: { summarize },
      maxEmbeddingInputChars: 20,
      summaryPromptVersion: 'summary-v1',
    });

    const result = await service.indexVectorSource({
      context,
      source: {
        ...source,
        sourceHash: 'source-hash-v1',
      },
      chunks: [{
        chunkKey: 'large',
        ordinal: 0,
        level: 1,
        content: 'this semantic input is too large to embed without summarization',
        startOffset: 0,
        endOffset: 63,
      }],
    });

    expect(embedBatch).not.toHaveBeenCalled();
    expect(indexVectorSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceHash: 'source-hash-v1',
    }), []);
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      chunkCount: 0,
      skippedInputs: [
        {
          chunkKey: 'large',
          inputKind: 'semantic',
          reason: 'summary_failed',
          inputChars: 63,
          maxChars: 20,
          message: 'summary quota exceeded',
        },
      ],
    });
  });

  it('skips summary outputs that still exceed the embedding input budget', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => [[1, 0]]);
    const summarize = vi.fn(async () => ({
      content: 'this summary is also too long',
      provider: 'summary-provider',
      model: 'summary-model',
      promptVersion: 'summary-v1',
      rounds: 1,
    }));
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
      summaryService: { summarize },
      maxEmbeddingInputChars: 20,
      summaryPromptVersion: 'summary-v1',
    });

    const result = await service.indexVectorSource({
      context,
      source,
      chunks: [{
        chunkKey: 'large',
        ordinal: 0,
        level: 1,
        content: 'this semantic input is too large to embed without summarization',
        startOffset: 0,
        endOffset: 63,
      }],
    });

    expect(embedBatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'indexed',
      source: source.source,
      chunkCount: 0,
      skippedInputs: [
        {
          chunkKey: 'large',
          inputKind: 'semantic',
          reason: 'summary_too_large',
          inputChars: 63,
          maxChars: 20,
          summaryChars: 29,
        },
      ],
    });
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

  it('returns a clear skipped result when the embedding provider rejects the credential', async () => {
    const indexVectorSource = vi.fn(async () => {});
    const embedBatch = vi.fn(async () => {
      throw new Error('401 Unauthorized: API key expired');
    });
    const service = new RdfSearchIndexingService({
      rdfEngine: { indexVectorSource } as unknown as RdfEngineLike,
      store: { getAiConfig: vi.fn(async () => ({
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'expired-key',
        credentialId: 'cred-expired',
        embeddingModel: 'text-embedding-3-small',
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

    expect(indexVectorSource).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'skipped',
      source: source.source,
      reason: 'embedding_provider_failed',
      message: '401 Unauthorized: API key expired',
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
