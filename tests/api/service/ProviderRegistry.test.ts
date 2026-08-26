import { describe, expect, it } from 'vitest';
import { resolveServerProviderTransport } from '../../../src/api/service/provider-registry';

describe('resolveServerProviderTransport', () => {
  it('allows only registered HTTPS provider endpoints in cloud edition', () => {
    expect(resolveServerProviderTransport({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1/',
      edition: 'cloud',
    })).toEqual({ baseUrl: 'https://api.openai.com/v1' });

    expect(() => resolveServerProviderTransport({
      providerId: 'openai',
      baseUrl: 'https://internal.example/v1',
      edition: 'cloud',
    })).toThrow('provider_base_url_not_allowed');

    expect(() => resolveServerProviderTransport({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      edition: 'cloud',
    })).toThrow('provider_base_url_not_allowed');
  });

  it('rejects Pod-supplied proxies in cloud edition', () => {
    expect(() => resolveServerProviderTransport({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://127.0.0.1:7890',
      edition: 'cloud',
    })).toThrow('provider_proxy_not_allowed');
  });

  it('allows explicit HTTP(S) self-hosted endpoints and proxies in local edition', () => {
    expect(resolveServerProviderTransport({
      providerId: 'custom',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      proxyUrl: 'http://user:pass@127.0.0.1:7890/',
      edition: 'local',
    })).toEqual({
      baseUrl: 'http://127.0.0.1:11434/v1',
      proxyUrl: 'http://user:pass@127.0.0.1:7890',
    });
  });

  it('rejects malformed or credential-bearing provider URLs', () => {
    expect(() => resolveServerProviderTransport({
      providerId: 'custom',
      baseUrl: 'not-a-url',
      edition: 'local',
    })).toThrow('provider_base_url_not_allowed');

    expect(() => resolveServerProviderTransport({
      providerId: 'custom',
      baseUrl: 'https://user:pass@example.com/v1',
      edition: 'local',
    })).toThrow('provider_base_url_not_allowed');
  });
});
