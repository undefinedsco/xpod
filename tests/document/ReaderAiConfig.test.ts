import { describe, expect, it } from 'vitest';
import { UDFS } from '@undefineds.co/models';
import { selectReaderAiConfig } from '../../src/document/ReaderAiConfig';

describe('selectReaderAiConfig', () => {
  it('selects PaddleOCR reader model and standard AI credential', () => {
    const config = selectReaderAiConfig({
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
          modelType: 'reader',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
        {
          id: 'paddleocr.ttl#chat-looking-model',
          displayName: 'Not a reader',
          modelType: 'chat',
          isProvidedBy: '/settings/providers/paddleocr.ttl',
          status: 'active',
        },
      ],
      credentials: [
        {
          id: 'cred_abc123',
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
      credentialId: 'cred_abc123',
      model: 'pp-ocrv6',
      modelDisplayName: 'PP-OCRv6',
      modelType: 'reader',
      baseUrl: undefined,
      proxyUrl: undefined,
    });
  });

  it('does not select chat models as reader models', () => {
    const config = selectReaderAiConfig({
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
          id: 'cred_abc123',
          provider: '/settings/providers/paddleocr.ttl',
          service: 'ai',
          status: 'active',
          apiKey: 'paddle-token',
        },
      ],
    });

    expect(config).toBeUndefined();
  });

  it('selects a model by canonical document capability without a product role type', () => {
    const config = selectReaderAiConfig({
      providers: [{ id: 'paddleocr', hasModel: '/settings/providers/paddleocr.ttl#pp-ocrv6' }],
      models: [{
        id: 'paddleocr.ttl#pp-ocrv6',
        rdfType: [UDFS('AIModel'), UDFS('DocumentModel')],
        capabilities: [UDFS('DocumentUnderstandingCapability')],
        isProvidedBy: '/settings/providers/paddleocr.ttl',
      }],
      credentials: [{
        id: 'cred_abc123',
        provider: '/settings/providers/paddleocr.ttl',
        service: 'ai',
        status: 'active',
        apiKey: 'paddle-token',
      }],
    });

    expect(config?.model).toBe('pp-ocrv6');
  });
});
