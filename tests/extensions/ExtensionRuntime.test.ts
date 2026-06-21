import { describe, expect, it, vi } from 'vitest';
import { DefaultExtensionRuntime } from '../../src/extensions/ExtensionRuntime';
import { PodCredentialResolver } from '../../src/extensions/PodCredentialResolver';
import type { CredentialResolver, ExtensionContext } from '../../src/extensions/types';
import { selectReaderAiConfig } from '../../src/document/ReaderAiConfig';

const context: ExtensionContext = {
  webId: 'https://id.example/alice/profile/card#me',
  podBaseUrl: 'https://id.example/alice/',
  fetch: vi.fn(),
  emit: vi.fn(),
};

const readerModel = 'https://id.example/alice/settings/providers/paddleocr.ttl#PP-OCRv6';
const embeddingModel = 'https://id.example/alice/settings/providers/dashscope.ttl#text-embedding-v4';

describe('ExtensionRuntime credential boundary', () => {
  it('invokes a reader extension from context + model URI + source URI only', async () => {
    const credentialResolver: CredentialResolver = {
      resolve: vi.fn().mockResolvedValue({
        service: 'ai',
        provider: 'paddleocr',
        credentialId: 'cred_reader',
        apiKey: 'paddle-secret',
        baseUrl: 'https://paddle.example/v1/parse',
      }),
    };
    const providerFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      result: {
        layoutParsingResults: [
          { markdown: { text: '# Parsed' }, pageId: 1 },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const runtime = new DefaultExtensionRuntime({ credentialResolver, fetch: providerFetch });

    const result = await runtime.read(context, {
      model: readerModel,
      credential: 'https://id.example/alice/settings/credentials.ttl#cred_reader',
      source: 'https://id.example/alice/files/report.png',
      pages: '1',
      output: 'markdown',
    });

    expect(credentialResolver.resolve).toHaveBeenCalledWith({
      service: 'ai',
      capability: 'reader',
      provider: 'paddleocr',
      credentialId: 'cred_reader',
      model: readerModel,
    }, context);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = providerFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://paddle.example/v1/parse');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer paddle-secret' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      file: 'https://id.example/alice/files/report.png',
      model: 'PP-OCRv6',
      pageRange: '1',
    });
    expect(result.markdown).toBe('# Parsed');
    expect(result.model).toBe('PP-OCRv6');
    expect('trace' in result).toBe(false);
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'extension.completed',
      capability: 'reader',
      provider: 'paddleocr',
      model: 'PP-OCRv6',
    }));
    expect(JSON.stringify(result)).not.toContain('paddle-secret');
  });

  it('embeds texts from context + model URI without source or index metadata', async () => {
    const credentialResolver: CredentialResolver = {
      resolve: vi.fn().mockResolvedValue({
        service: 'ai',
        capability: 'embedding',
        provider: 'dashscope',
        credentialId: 'cred_embedding',
        apiKey: 'dashscope-secret',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    };
    const embeddingService = {
      embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    };
    const runtime = new DefaultExtensionRuntime({ credentialResolver, embeddingService });

    const result = await runtime.embed(context, {
      model: embeddingModel,
      credential: 'https://id.example/alice/settings/credentials.ttl#cred_embedding',
      texts: ['hello'],
    });

    expect(credentialResolver.resolve).toHaveBeenCalledWith({
      service: 'ai',
      capability: 'embedding',
      provider: 'dashscope',
      credentialId: 'cred_embedding',
      model: embeddingModel,
    }, context);
    expect(embeddingService.embedBatch).toHaveBeenCalledWith(['hello'], expect.objectContaining({
      provider: 'dashscope',
      apiKey: 'dashscope-secret',
      credentialId: 'cred_embedding',
    }), 'text-embedding-v4');
    expect(result).toEqual({ vectors: [[0.1, 0.2, 0.3]] });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'extension.completed',
      capability: 'embedding',
      provider: 'dashscope',
      model: 'text-embedding-v4',
    }));
    expect(JSON.stringify(result)).not.toContain('dashscope-secret');
  });

  it('adapts an authenticated target Pod context into Pod credential resolution without caring where the login session came from', async () => {
    const credentialReader = {
      getAiCredential: vi.fn().mockResolvedValue({
        provider: 'dashscope',
        apiKey: 'dashscope-secret',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    };
    const resolver = new PodCredentialResolver({ credentialReader });

    const credential = await resolver.resolve({
      service: 'ai',
      provider: 'dashscope',
      credentialId: 'https://id.example/alice/settings/credentials.ttl#cred_embedding',
      model: embeddingModel,
    }, context);

    expect(credentialReader.getAiCredential).toHaveBeenCalledWith(
      'https://id.example/alice/',
      'dashscope',
      context.fetch,
      'https://id.example/alice/profile/card#me',
      { credentialId: 'https://id.example/alice/settings/credentials.ttl#cred_embedding' },
    );
    expect(credential).toEqual({
      service: 'ai',
      provider: 'dashscope',
      credentialId: 'https://id.example/alice/settings/credentials.ttl#cred_embedding',
      apiKey: 'dashscope-secret',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      proxyUrl: undefined,
    });
  });

  it('resolves non-AI extension credentials through the same Pod credential boundary', async () => {
    const credentialReader = {
      getAiCredential: vi.fn(),
    };
    const genericCredentialReader = {
      getCredential: vi.fn().mockResolvedValue({
        service: 'storage',
        capability: 'upload',
        provider: 's3',
        credentialId: 'cred_storage',
        apiKey: 's3-secret',
        baseUrl: 'https://s3.example',
      }),
    };
    const resolver = new PodCredentialResolver({ credentialReader, genericCredentialReader });

    const credential = await resolver.resolve({
      service: 'storage',
      capability: 'upload',
      provider: 's3',
      credentialId: 'https://id.example/alice/settings/credentials.ttl#cred_storage',
    }, context);

    expect(credentialReader.getAiCredential).not.toHaveBeenCalled();
    expect(genericCredentialReader.getCredential).toHaveBeenCalledWith({
      service: 'storage',
      capability: 'upload',
      provider: 's3',
      credentialId: 'https://id.example/alice/settings/credentials.ttl#cred_storage',
    }, context);
    expect(credential).toEqual({
      service: 'storage',
      capability: 'upload',
      provider: 's3',
      credentialId: 'cred_storage',
      apiKey: 's3-secret',
      baseUrl: 'https://s3.example',
    });
  });

  it('keeps Pod config selection secret-free before the runtime resolves the model URI', async () => {
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
    expect(readerConfig).toEqual(expect.objectContaining({
      providerId: 'paddleocr',
      model: 'PP-OCRv6',
      credentialId: 'cred_reader',
    }));
    expect(JSON.stringify(readerConfig)).not.toContain('apiKey');
  });
});
