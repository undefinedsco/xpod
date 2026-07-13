import { describe, expect, it, vi } from 'vitest';
import { EmbeddingServiceImpl } from '../../src/ai/service/EmbeddingServiceImpl';
import { ProviderRegistryImpl } from '../../src/ai/service/ProviderRegistryImpl';
import { selectReaderAiConfig } from '../../src/document/ReaderAiConfig';
import { DefaultExtensionRuntime } from '../../src/extensions/ExtensionRuntime';
import { PodCredentialResolver } from '../../src/extensions/PodCredentialResolver';
import type { ExtensionContext } from '../../src/extensions/types';

vi.mock('ai', () => ({
  embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  embedMany: vi.fn().mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((_, index) => [index + 0.1, index + 0.2]),
  })),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn().mockReturnValue({
    embedding: vi.fn().mockReturnValue({ modelId: 'server-smoke-embedding-model' }),
  }),
}));

const readerModel = 'https://id.example/alice/settings/providers/paddleocr.ttl#PP-OCRv6';
const embeddingModel = 'https://id.example/alice/settings/providers/dashscope.ttl#text-embedding-v4';

describe('server ExtensionRuntime smoke', () => {
  it('uses one target Pod ExtensionContext to resolve model credentials, invoke reader, and run embedding', async () => {
    const authenticatedFetch = vi.fn();
    const emit = vi.fn();
    const context: ExtensionContext = {
      webId: 'https://id.example/alice/profile/card#me',
      podBaseUrl: 'https://id.example/alice/',
      fetch: authenticatedFetch,
      emit,
    };

    const readerConfig = selectReaderAiConfig({
      providers: [
        {
          id: 'paddleocr',
          displayName: 'PaddleOCR',
          defaultModel: '/settings/providers/paddleocr.ttl#PP-OCRv6',
        },
      ],
      models: [
        {
          id: 'paddleocr.ttl#PP-OCRv6',
          displayName: 'PP-OCRv6',
          modelType: 'reader',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
      ],
      credentials: [
        {
          id: 'cred_reader',
          provider: '/settings/providers/paddleocr.ttl',
          service: 'ai',
          status: 'active',
          isDefault: true,
        },
      ],
    });
    const embeddingConfig = {
      model: embeddingModel,
      credential: 'https://id.example/alice/settings/credentials.ttl#cred_embedding',
    };
    expect(readerConfig).toMatchObject({
      providerId: 'paddleocr',
      model: 'PP-OCRv6',
      credentialId: 'cred_reader',
    });
    expect(JSON.stringify({ readerConfig, embeddingConfig })).not.toContain('secret');

    const credentialReader = {
      getAiCredential: vi.fn(async (
        _podBaseUrl: string,
        providerId: string,
        _fetch: typeof fetch,
        _webId?: string,
        options?: { credentialId?: string },
      ) => {
        if (providerId === 'paddleocr' && options?.credentialId === 'cred_reader') {
          return {
            provider: 'paddleocr',
            credentialId: 'cred_reader',
            apiKey: 'paddle-secret',
            baseUrl: 'https://paddle.example/v1/parse',
          };
        }
        if (providerId === 'dashscope' && options?.credentialId === 'cred_embedding') {
          return {
            provider: 'dashscope',
            credentialId: 'cred_embedding',
            apiKey: 'dashscope-secret',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          };
        }
        return null;
      }),
    };
    const providerFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      result: {
        layoutParsingResults: [
          { markdown: { text: '# Server smoke\n\nReader output for embedding.' }, pageId: 1 },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const runtime = new DefaultExtensionRuntime({
      credentialResolver: new PodCredentialResolver({ credentialReader }),
      embeddingService: new EmbeddingServiceImpl(new ProviderRegistryImpl()),
      fetch: providerFetch,
    });

    const readResult = await runtime.read(context, {
      model: readerModel,
      credential: 'https://id.example/alice/settings/credentials.ttl#cred_reader',
      source: 'https://id.example/alice/files/report.png',
      output: 'markdown',
      pages: '1',
    });
    const embeddingResult = await runtime.embed(context, {
      model: embeddingConfig.model,
      credential: embeddingConfig.credential,
      texts: [readResult.markdown ?? ''],
    });

    expect(credentialReader.getAiCredential).toHaveBeenCalledWith(
      context.podBaseUrl,
      'paddleocr',
      context.fetch,
      context.webId,
      { credentialId: 'cred_reader' },
    );
    expect(credentialReader.getAiCredential).toHaveBeenCalledWith(
      context.podBaseUrl,
      'dashscope',
      context.fetch,
      context.webId,
      { credentialId: 'cred_embedding' },
    );
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(readResult).toMatchObject({
      reader: 'paddleocr',
      model: 'PP-OCRv6',
      markdown: '# Server smoke\n\nReader output for embedding.',
    });
    expect('trace' in readResult).toBe(false);
    expect(embeddingResult).toEqual({ vectors: [[0.1, 0.2]] });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ capability: 'reader', type: 'extension.completed' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ capability: 'embedding', type: 'extension.completed' }));
    expect(JSON.stringify({ readResult, embeddingResult, readerConfig, embeddingConfig })).not.toContain('paddle-secret');
    expect(JSON.stringify({ readResult, embeddingResult, readerConfig, embeddingConfig })).not.toContain('dashscope-secret');
  });
});
