import { describe, expect, it } from 'vitest';
import { selectParserAiConfig } from '../../src/document/ParserAiConfig';

describe('selectParserAiConfig', () => {
  it('selects PaddleOCR parser model and standard AI credential', () => {
    const config = selectParserAiConfig({
      providers: [
        {
          id: 'paddleocr',
          displayName: 'PaddleOCR',
          defaultModel: '/settings/providers/paddleocr.ttl#pp-ocrv6',
        },
      ],
      models: [
        {
          id: 'paddleocr.ttl#pp-ocrv6',
          displayName: 'PP-OCRv6',
          modelType: 'parser',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
        {
          id: 'paddleocr.ttl#chat-looking-model',
          displayName: 'Not a parser',
          modelType: 'chat',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
      ],
      credentials: [
        {
          id: 'paddleocr-default',
          provider: '/settings/providers/paddleocr.ttl',
          service: 'ai',
          status: 'active',
          apiKey: 'paddle-token',
          isDefault: true,
        },
      ],
    });

    expect(config).toEqual({
      providerId: 'paddleocr',
      providerDisplayName: 'PaddleOCR',
      apiKey: 'paddle-token',
      credentialId: 'paddleocr-default',
      model: 'pp-ocrv6',
      modelDisplayName: 'PP-OCRv6',
      modelType: 'parser',
      baseUrl: undefined,
      proxyUrl: undefined,
    });
  });

  it('does not select chat models as parser models', () => {
    const config = selectParserAiConfig({
      providers: [{ id: 'paddleocr', hasModel: '/settings/providers/paddleocr.ttl#chat-only' }],
      models: [
        {
          id: 'paddleocr.ttl#chat-only',
          modelType: 'chat',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
      ],
      credentials: [
        {
          id: 'paddleocr-default',
          provider: '/settings/providers/paddleocr.ttl',
          service: 'ai',
          status: 'active',
          apiKey: 'paddle-token',
        },
      ],
    });

    expect(config).toBeUndefined();
  });
});
