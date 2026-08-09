import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import {
  AnthropicModelsAdapter,
  OpenAiCompatibleModelsAdapter,
  ProviderModelsFetchError,
  ProviderModelsService,
  normalizeDiscoveredModels,
  type ModelsCredentialRecord,
  type ProviderModelsAdapter,
} from '../../../src/api/ai-gateway/models';
import { InMemoryGatewayAccessKeyRepository } from './InMemoryGatewayAccessKeyRepository';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';
import {
  createDefaultProviderRegistry,
  type OfferingAuthMode,
  type ProviderOfferingDescriptor,
  type ProviderOfferingKind,
  type ProviderProductDescriptor,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const CREDENTIAL_IRI = 'https://id.example/alice/.data/settings/credentials.ttl#cloud-kimi';

class TestKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test',
      keyId: `${context.webId}|${context.credentialIri}|${context.provider}`,
      keyVersion: 'v1',
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

function jsonFetch(
  handler: (url: string, init: RequestInit | undefined) => {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: result.headers,
    });
  }) as unknown as typeof fetch;
}

function createVault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new TestKeyWrapper() });
}

async function credential(provider: string, secret: ProviderSecret = { type: 'apiKey', apiKey: 'provider-secret' }): Promise<ModelsCredentialRecord> {
  const vault = createVault();
  const credentialIri = CREDENTIAL_IRI.replace('kimi', provider);
  return {
    id: `${provider}-credential`,
    credentialIri,
    webId: WEB_ID,
    provider,
    deployment: 'cloud',
    authMode: 'apiKey',
    encryptedSecret: await vault.seal({ webId: WEB_ID }, credentialIri, provider, secret),
    status: 'active',
  };
}

function offeringFixture(input: {
  id: string;
  provider?: string;
  label?: string;
  kind?: ProviderOfferingKind;
  authModes?: OfferingAuthMode[];
  baseUrl: string;
  modelPath?: string;
  quotaStrategy?: 'providerApi' | 'subscription' | 'console' | 'unsupported';
}): ProviderOfferingDescriptor {
  const provider = input.provider ?? 'bailian';
  const kind = input.kind ?? 'api-platform';
  const authModes = input.authModes ?? ['apiKey'];
  const modelPath = input.modelPath ?? '/models';
  const quotaStrategy = input.quotaStrategy ?? 'console';
  return {
    id: input.id,
    runtimeProviderIds: [provider],
    label: input.label ?? input.id,
    productLabel: provider,
    kind,
    authModes,
    auth: authModes.map((mode) => ({
      protocol: mode === 'oauth' || mode === 'deviceCode'
        ? 'oauth-device-code'
        : kind === 'token-plan'
          ? 'subscription-key'
          : 'api-key',
    })),
    upstream: [
      { capability: 'models', protocol: 'openai-models', options: { path: modelPath } },
      { capability: 'inference', protocol: 'openai-chat-completions' },
      { capability: quotaStrategy === 'providerApi' ? 'balance' : 'quota', protocol: quotaStrategy },
    ],
    credentialPrefixHints: ['sk-'],
    consoleUrl: `https://console.example/${input.id}`,
    subscriptionUrl: `https://console.example/${input.id}/subscribe`,
    endpoints: [{ protocol: 'chatCompletions', baseUrl: input.baseUrl }],
    modelDiscovery: { strategy: 'openaiCompatible', path: modelPath, endpointProtocol: 'chatCompletions' },
    quota: { strategy: quotaStrategy, url: `https://console.example/${input.id}/quota` },
    usagePolicyUrl: `https://console.example/${input.id}/policy`,
    region: 'global',
    lifecycle: 'active',
  };
}

describe('ProviderModelsAdapters', () => {
  it('reuses one OpenAI models protocol handler across Provider metadata endpoints', async () => {
    const fetch = jsonFetch((url) => ({ body: { data: [{ id: url.includes('deepseek') ? 'deepseek-chat' : 'moonshot-v1' }] } }));
    const registry = createDefaultProviderRegistry();
    const vault = createVault();
    const deepseek = { ...await credential('deepseek'), offeringId: 'api-platform' };
    const kimi = { ...await credential('kimi'), offeringId: 'api-platform' };
    const handler = new OpenAiCompatibleModelsAdapter({
      protocol: 'openai-models',
      registry,
      fetchImpl: fetch,
    });
    const service = new ProviderModelsService({
      vault,
      providerRegistry: registry,
      adapters: [handler],
      credentials: [deepseek, kimi],
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });

    await expect(service.list({ webId: WEB_ID, deployment: 'cloud', provider: 'deepseek' }))
      .resolves.toMatchObject({ models: [{ id: 'deepseek-chat' }] });
    await expect(service.list({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi' }))
      .resolves.toMatchObject({ models: [{ id: 'moonshot-v1' }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.deepseek.com/v1/models', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.moonshot.ai/v1/models', expect.any(Object));
  });

  it('uses the Kimi OAuth access token for official-subscription model discovery', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.kimi.com/coding/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access-token');
      return { body: { data: [{ id: 'kimi-for-coding' }] } };
    });
    const registry = createDefaultProviderRegistry();
    const adapter = new OpenAiCompatibleModelsAdapter({
      protocol: 'openai-models',
      registry,
      fetchImpl: fetch,
    });

    await expect(adapter.fetch({
      credential: {
        ...await credential('kimi'),
        offeringId: 'official-subscription',
        authMode: 'deviceCodeOAuth',
      },
      secret: { type: 'deviceCodeOAuth', accessToken: 'oauth-access-token' },
    })).resolves.toEqual([{ id: 'kimi-for-coding' }]);
  });

  it('discovers isolated model catalogs from the selected offering endpoint with bearer auth', async () => {
    const product: ProviderProductDescriptor = {
      id: 'bailian',
      label: 'Bailian',
      offerings: [
        offeringFixture({ id: 'payg', provider: 'bailian', label: 'PAYG', kind: 'api-platform', baseUrl: 'https://payg.example/v1', quotaStrategy: 'providerApi' }),
        offeringFixture({ id: 'coding', provider: 'bailian', label: 'Coding', kind: 'token-plan', baseUrl: 'https://coding.example/v1', modelPath: '/catalog/models', quotaStrategy: 'providerApi' }),
      ],
    };
    const fetch = jsonFetch((url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (url === 'https://payg.example/v1/models') {
        expect(auth).toBe('Bearer payg-secret');
        return { body: { data: [{ id: 'payg-only' }] } };
      }
      expect(url).toBe('https://coding.example/v1/catalog/models');
      expect(auth).toBe('Bearer coding-secret');
      return { body: { data: [{ id: 'coding-only' }] } };
    });
    const adapter = new OpenAiCompatibleModelsAdapter({
      provider: 'bailian',
      defaultBaseUrl: 'https://fallback.example/v1',
      product,
      fetchImpl: fetch,
    });

    const payg = await adapter.fetch({
      credential: { ...await credential('bailian'), offeringId: 'payg' },
      secret: { type: 'apiKey', apiKey: 'payg-secret' },
    });
    const coding = await adapter.fetch({
      credential: { ...await credential('bailian'), offeringId: 'coding' },
      secret: { type: 'apiKey', apiKey: 'coding-secret' },
    });

    expect(payg).toEqual([{ id: 'payg-only' }]);
    expect(coding).toEqual([{ id: 'coding-only' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects ambiguous offering discovery instead of using the provider default catalog', async () => {
    const product: ProviderProductDescriptor = {
      id: 'multi', label: 'Multi', offerings: ['one', 'two'].map((id) => ({
        ...offeringFixture({ id, provider: 'multi', kind: 'api-platform', baseUrl: `https://${id}.example/v1` }),
        credentialPrefixHints: [],
      })),
    };
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await expect(new OpenAiCompatibleModelsAdapter({
      provider: 'multi', defaultBaseUrl: 'https://fallback.example/v1', product, fetchImpl: fetch,
    }).fetch({
      credential: await credential('multi'),
      secret: { type: 'apiKey', apiKey: 'secret' },
    })).rejects.toThrow('models_offering_required:multi');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a sibling offering endpoint while preserving an explicitly safe custom endpoint', async () => {
    const offerings = ['payg', 'coding'].map((id) => offeringFixture({
      id,
      provider: 'bailian',
      kind: id === 'coding' ? 'token-plan' : 'api-platform',
      baseUrl: `https://${id}.example/v1`,
    }));
    const adapter = new OpenAiCompatibleModelsAdapter({
      provider: 'bailian',
      defaultBaseUrl: 'https://payg.example/v1',
      safeBaseUrls: ['https://payg.example/v1', 'https://coding.example/v1', 'https://proxy.example/v1'],
      product: { id: 'bailian', label: 'Bailian', offerings },
      fetchImpl: jsonFetch((url) => {
        expect(url).toBe('https://proxy.example/v1/models');
        return { body: { data: [{ id: 'proxy-model' }] } };
      }),
    });

    await expect(adapter.fetch({
      credential: { ...await credential('bailian'), offeringId: 'payg', baseUrl: 'https://coding.example/v1' },
      secret: { type: 'apiKey', apiKey: 'secret' },
    })).rejects.toThrow('unsafe_provider_base_url');
    await expect(adapter.fetch({
      credential: { ...await credential('bailian'), offeringId: 'payg', baseUrl: 'https://proxy.example/v1' },
      secret: { type: 'apiKey', apiKey: 'secret' },
    })).resolves.toEqual([{ id: 'proxy-model' }]);
  });

  it('discovers OpenAI-compatible models from the credential base URL with bearer auth', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.ai/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      return {
        body: {
          data: [
            { id: 'kimi-k2', display_name: 'Kimi K2' },
            { id: 'text-embedding-3-large' },
            { id: 'kimi-k2' },
            { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
          ],
        },
      };
    });

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: await credential('kimi'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'kimi-k2', displayName: 'Kimi K2' },
      { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
    ]);
  });

  it('prefers the credential baseUrl over the adapter default', async () => {
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.cn/v1/models');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });
    const kimiCredential = {
      ...await credential('kimi'),
      baseUrl: 'https://api.moonshot.cn/v1',
    };

    const models = await new OpenAiCompatibleModelsAdapter({
      provider: 'kimi',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
      safeBaseUrls: ['https://api.moonshot.ai/v1', 'https://api.moonshot.cn/v1'],
      fetchImpl: fetch,
    }).fetch({
      credential: kimiCredential,
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([{ id: 'kimi-k2' }]);
  });

  it('rejects an untrusted credential base URL before attaching the provider secret', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

    await expect(new OpenAiCompatibleModelsAdapter({
      provider: 'deepseek',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      safeBaseUrls: ['https://api.deepseek.com/v1'],
      fetchImpl: fetch,
    }).fetch({
      credential: {
        ...await credential('deepseek'),
        baseUrl: 'http://127.0.0.1:5790/v1',
      },
      secret: { type: 'apiKey', apiKey: 'must-not-leave' },
    })).rejects.toThrow('unsafe_provider_base_url');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers Anthropic models with x-api-key and version headers', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/models');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('provider-secret');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      return {
        body: {
          data: [
            { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1' },
            { id: 'claude-sonnet-4-5' },
          ],
        },
      };
    });

    const models = await new AnthropicModelsAdapter({ fetchImpl: fetch }).fetch({
      credential: await credential('anthropic'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    });

    expect(models).toEqual([
      { id: 'claude-opus-4-1', displayName: 'Claude Opus 4.1' },
      { id: 'claude-sonnet-4-5' },
    ]);
  });

  it('passes through the provider status code on fetch failure', async () => {
    const fetch = jsonFetch(() => ({ status: 401, body: { error: 'invalid key' } }));

    await expect(new OpenAiCompatibleModelsAdapter({
      provider: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      fetchImpl: fetch,
    }).fetch({
      credential: await credential('openai'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
    })).rejects.toMatchObject({
      name: 'ProviderModelsFetchError',
      providerStatus: 401,
    });
  });

  it('normalizes alternate list envelopes and skips invalid entries', () => {
    expect(normalizeDiscoveredModels({
      models: {
        models: [
          { name: 'models/gemini-2.5-pro' },
          { model: 'gemini-2.5-flash', title: 'Gemini 2.5 Flash' },
          { slug: '' },
          'not-an-object',
        ],
      },
    })).toEqual([
      { id: 'models/gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    ]);
    expect(normalizeDiscoveredModels({ result: [{ id: 'deepseek-chat' }] })).toEqual([
      { id: 'deepseek-chat' },
    ]);
    expect(normalizeDiscoveredModels(undefined)).toEqual([]);
  });
});

describe('ProviderModelsService', () => {
  it('discovers from an ephemeral caller-supplied API key without reading the Pod server-side', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer caller-secret');
      return { body: { data: [{ id: 'deepseek-chat' }] } };
    });
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [new OpenAiCompatibleModelsAdapter({
        provider: 'deepseek',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        fetchImpl: fetch,
      })],
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    });

    await expect(service.listFromSecret({
      webId: WEB_ID,
      provider: 'deepseek',
      credentialId: 'credentials.ttl#deepseek-primary',
      apiKey: 'caller-secret',
    })).resolves.toEqual({
      provider: 'deepseek',
      credential: 'credentials.ttl#deepseek-primary',
      models: [{ id: 'deepseek-chat' }],
      observedAt: '2026-08-09T00:00:00.000Z',
      source: 'deepseek:/models',
    });
  });

  it('discovers from an ephemeral caller-supplied OAuth access token without aliasing it as an API key', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.cn/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer caller-access-token');
      return { body: { data: [{ id: 'kimi-for-coding' }] } };
    });
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [new OpenAiCompatibleModelsAdapter({
        provider: 'kimi',
        defaultBaseUrl: 'https://api.moonshot.cn/v1',
        fetchImpl: fetch,
      })],
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    });

    await expect(service.listFromSecret({
      webId: WEB_ID,
      provider: 'kimi',
      offeringId: 'official-subscription',
      credentialId: 'credentials.ttl#kimi-oauth',
      authMode: 'deviceCodeOAuth',
      secret: { type: 'oauth', accessToken: 'caller-access-token' },
    })).resolves.toEqual({
      provider: 'kimi',
      credential: 'credentials.ttl#kimi-oauth',
      models: [{ id: 'kimi-for-coding' }],
      observedAt: '2026-08-09T00:00:00.000Z',
      source: 'kimi:official-subscription:/models',
    });
  });

  it('requires an auth-capable caller supplied secret for ephemeral model discovery', async () => {
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [new OpenAiCompatibleModelsAdapter({
        provider: 'kimi',
        defaultBaseUrl: 'https://api.moonshot.cn/v1',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      })],
    });

    await expect(service.listFromSecret({
      webId: WEB_ID,
      provider: 'kimi',
      credentialId: 'credentials.ttl#kimi-oauth',
      authMode: 'deviceCodeOAuth',
      secret: { type: 'oauth', refreshToken: 'refresh-only' },
    })).rejects.toThrow('models_secret_missing');
  });

  it('minimizes caller-supplied OAuth secrets before they reach the models adapter', async () => {
    const adapter: ProviderModelsAdapter = {
      provider: 'kimi',
      async fetch(input) {
        expect(input.secret).toEqual({ type: 'oauth', accessToken: 'caller-access-token' });
        return [{ id: 'kimi-for-coding' }];
      },
    };
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [adapter],
    });

    const result = await service.listFromSecret({
      webId: WEB_ID,
      provider: 'kimi',
      credentialId: 'credentials.ttl#kimi-oauth',
      authMode: 'deviceCodeOAuth',
      secret: {
        type: 'oauth',
        accessToken: 'caller-access-token',
        refreshToken: 'must-not-reach-adapter',
      },
    });

    expect(result.models).toEqual([{ id: 'kimi-for-coding' }]);
  });

  it('preserves the requested offering when discovering from a caller-supplied secret', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://coding.example/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer coding-secret');
      return { body: { data: [{ id: 'coding-only' }] } };
    });
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [new OpenAiCompatibleModelsAdapter({
        provider: 'bailian',
        defaultBaseUrl: 'https://fallback.example/v1',
        product: {
          id: 'bailian', label: 'Bailian', offerings: [{
            ...offeringFixture({
              id: 'coding',
              provider: 'bailian',
              label: 'Coding',
              kind: 'token-plan',
              baseUrl: 'https://coding.example/v1',
              quotaStrategy: 'providerApi',
            }),
          }],
        },
        fetchImpl: fetch,
      })],
    });

    const result = await service.listFromSecret({
      webId: WEB_ID,
      provider: 'bailian',
      offeringId: 'coding',
      credentialId: 'credential-coding',
      apiKey: 'coding-secret',
    });

    expect(result.models).toEqual([{ id: 'coding-only' }]);
    expect(result.source).toBe('bailian:coding:/models');
  });

  it('does not send an ephemeral caller secret to an untrusted discovery base URL', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [new OpenAiCompatibleModelsAdapter({
        provider: 'deepseek',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        safeBaseUrls: ['https://api.deepseek.com/v1'],
        fetchImpl: fetch,
      })],
    });

    await expect(service.listFromSecret({
      webId: WEB_ID,
      provider: 'deepseek',
      credentialId: 'credentials.ttl#deepseek-primary',
      apiKey: 'must-not-leave',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
    })).rejects.toThrow('unsafe_provider_base_url');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves the active credential, opens the vault and returns the discovery', async () => {
    const kimiCredential = await credential('kimi');
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.ai/v1/models');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });
    const service = new ProviderModelsService({
      vault: createVault(),
      credentials: [kimiCredential],
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
          fetchImpl: fetch,
        }),
      ],
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });

    const discovery = await service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    });

    expect(discovery).toEqual({
      provider: 'kimi',
      credential: kimiCredential.credentialIri,
      models: [{ id: 'kimi-k2' }],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    });
  });

  it('merges discovery across eligible credentials and records partial failures', async () => {
    const vault = createVault();
    const createKimiCredential = async (
      id: string,
      apiKey: string,
      extra: Partial<ModelsCredentialRecord> = {},
    ): Promise<ModelsCredentialRecord> => {
      const credentialIri = `https://id.example/alice/.data/settings/credentials.ttl#${id}`;
      return {
        id,
        credentialIri,
        webId: WEB_ID,
        provider: 'kimi',
        deployment: 'cloud',
        authMode: 'apiKey',
        encryptedSecret: await vault.seal({ webId: WEB_ID }, credentialIri, 'kimi', { type: 'apiKey', apiKey }),
        status: 'active',
        ...extra,
      };
    };
    const primary = await createKimiCredential('primary', 'primary-secret', {
      metadata: { models: ['kimi-retired', 'kimi-legacy'] },
    });
    const secondary = await createKimiCredential('secondary', 'secondary-secret', {
      metadata: { models: ['kimi-legacy', 'kimi-k2'] },
    });
    const tertiary = await createKimiCredential('tertiary', 'tertiary-secret');
    const disabled = await createKimiCredential('disabled', 'disabled-secret', {
      enabled: false,
    });
    const fetch = jsonFetch((_url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer primary-secret') {
        return { status: 429, body: { error: 'rate limited' } };
      }
      if (auth === 'Bearer disabled-secret') {
        throw new Error('disabled credentials must not be fetched');
      }
      if (auth === 'Bearer tertiary-secret') {
        return { body: { data: [{ id: 'kimi-k2' }] } };
      }
      return {
        body: {
          data: [
            { id: 'kimi-k2', display_name: 'Kimi K2' },
            { id: 'kimi-thinking' },
          ],
        },
      };
    });
    const repository = {
      listProviderCredentials: vi.fn(async () => [primary, secondary, tertiary, disabled]),
    };
    const service = new ProviderModelsService({
      vault,
      credentialRepository: repository as never,
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
          fetchImpl: fetch,
        }),
      ],
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });

    const discovery = await service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    });

    expect(repository.listProviderCredentials).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(discovery).toEqual({
      provider: 'kimi',
      credential: secondary.credentialIri,
      models: [
        {
          id: 'kimi-k2',
          displayName: 'Kimi K2',
          availability: 'available',
          metadata: {
            sources: [
              {
                credential: secondary.credentialIri,
                source: 'kimi:/models',
                status: 'available',
              },
              {
                credential: tertiary.credentialIri,
                source: 'kimi:/models',
                status: 'available',
              },
            ],
          },
        },
        {
          id: 'kimi-thinking',
          availability: 'available',
          metadata: {
            sources: [
              {
                credential: secondary.credentialIri,
                source: 'kimi:/models',
                status: 'available',
              },
            ],
          },
        },
        {
          id: 'kimi-retired',
          availability: 'unavailable',
          metadata: {
            sources: [
              {
                credential: primary.credentialIri,
                source: 'kimi:/models',
                status: 'error',
                error: 'provider_models_fetch_failed:429',
              },
            ],
          },
        },
        {
          id: 'kimi-legacy',
          availability: 'unavailable',
          metadata: {
            sources: [
              {
                credential: primary.credentialIri,
                source: 'kimi:/models',
                status: 'error',
                error: 'provider_models_fetch_failed:429',
              },
              {
                credential: secondary.credentialIri,
                source: 'kimi:/models',
                status: 'unavailable',
              },
            ],
          },
        },
      ],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    });
  });

  it('resolves a requested non-default active credential through the repository list with auth', async () => {
    const vault = createVault();
    const auth = { type: 'solid', webId: WEB_ID };
    const createKimiCredential = async (id: string, apiKey: string): Promise<ModelsCredentialRecord> => {
      const credentialIri = `https://id.example/alice/.data/settings/credentials.ttl#${id}`;
      return {
        id,
        credentialIri,
        webId: WEB_ID,
        provider: 'kimi',
        deployment: 'cloud',
        authMode: 'apiKey',
        encryptedSecret: await vault.seal({ webId: WEB_ID }, credentialIri, 'kimi', { type: 'apiKey', apiKey }),
        status: 'active',
      };
    };
    const primary = await createKimiCredential('primary', 'primary-secret');
    const secondary = await createKimiCredential('secondary', 'secondary-secret');
    const fetch = jsonFetch((_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secondary-secret');
      return { body: { data: [{ id: 'kimi-k2' }] } };
    });
    const repository = {
      listProviderCredentials: vi.fn(async () => [primary, secondary]),
      getActiveCredential: vi.fn(async () => primary),
    };
    const service = new ProviderModelsService({
      vault,
      credentialRepository: repository as never,
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
          fetchImpl: fetch,
        }),
      ],
    });

    const discovery = await service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: secondary.credentialIri,
      auth: auth as never,
    });

    expect(repository.listProviderCredentials).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      auth,
    });
    expect(repository.getActiveCredential).not.toHaveBeenCalled();
    expect(discovery.credential).toBe(secondary.credentialIri);
    expect(discovery.models).toEqual([{ id: 'kimi-k2' }]);
  });

  it('rejects providers without an adapter or credential with coded errors', async () => {
    const service = new ProviderModelsService({
      vault: createVault(),
      adapters: [
        new OpenAiCompatibleModelsAdapter({
          provider: 'kimi',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
        }),
      ],
    });

    await expect(service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
    })).rejects.toThrow('models_adapter_not_found:openai');
    await expect(service.list({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).rejects.toThrow('models_credential_not_found');
  });
});

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      patch: vi.fn((path: string, handler: Function) => { routes[`PATCH ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body?: unknown, url = '/api/ai/gateway/providers/kimi/models/refresh'): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = url;
  req.headers = {};
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('AiGatewayManagementHandler models routes', () => {
  it('uses an ephemeral API key for browser-owned Pod credentials', async () => {
    const modelsService = {
      list: vi.fn(),
      listFromSecret: vi.fn(async () => ({
        provider: 'deepseek',
        credential: 'credentials.ttl#deepseek-primary',
        models: [{ id: 'deepseek-chat' }],
        observedAt: '2026-08-09T00:00:00.000Z',
        source: 'deepseek:/models',
      })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'local',
      modelsService: modelsService as never,
    });

    const res = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request(
      { type: 'solid', webId: WEB_ID },
      { credentialId: 'credentials.ttl#deepseek-primary', apiKey: 'caller-secret' },
    ), res, { provider: 'deepseek' });

    expect(res.statusCode).toBe(200);
    expect(modelsService.listFromSecret).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      provider: 'deepseek',
      credentialId: 'credentials.ttl#deepseek-primary',
      apiKey: 'caller-secret',
    }));
    expect(modelsService.list).not.toHaveBeenCalled();
  });

  it('uses an ephemeral OAuth access token for browser-owned Pod credentials without API-key aliasing', async () => {
    const listFromSecret = vi.fn(async (_input: Record<string, unknown>) => ({
      provider: 'kimi',
      credential: 'credentials.ttl#kimi-oauth',
      models: [{ id: 'kimi-for-coding' }],
      observedAt: '2026-08-09T00:00:00.000Z',
      source: 'kimi:official-subscription:/models',
    }));
    const modelsService = {
      list: vi.fn(),
      listFromSecret,
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'local',
      modelsService: modelsService as never,
    });

    const res = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request(
      { type: 'solid', webId: WEB_ID },
      {
        credentialId: 'credentials.ttl#kimi-oauth',
        offeringId: 'official-subscription',
        authMode: 'deviceCodeOAuth',
        secret: { type: 'oauth', accessToken: 'caller-access-token' },
      },
    ), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(200);
    expect(listFromSecret).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      provider: 'kimi',
      credentialId: 'credentials.ttl#kimi-oauth',
      offeringId: 'official-subscription',
      authMode: 'deviceCodeOAuth',
      secret: { type: 'oauth', accessToken: 'caller-access-token' },
    }));
    const listFromSecretInput = listFromSecret.mock.calls.at(0)?.[0];
    expect(listFromSecretInput).toBeDefined();
    expect(listFromSecretInput).not.toHaveProperty('apiKey');
    expect(modelsService.list).not.toHaveBeenCalled();
  });

  it('refreshes provider models for the current Solid identity', async () => {
    const kimiCredential = await credential('kimi');
    const modelsService = {
      list: vi.fn(async () => ({
        provider: 'kimi',
        credential: kimiCredential.credentialIri,
        models: [{ id: 'kimi-k2' }],
        observedAt: '2026-08-06T00:00:00.000Z',
        source: 'kimi:/models',
      })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: modelsService as never,
    });

    const res = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request(
      { type: 'solid', webId: WEB_ID },
      { credentialIri: kimiCredential.credentialIri },
    ), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      provider: 'kimi',
      models: [{ id: 'kimi-k2' }],
    });
    expect(modelsService.list).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: kimiCredential.credentialIri,
    }));
  });

  it('rejects gateway-key principals from provider models routes', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: { list: vi.fn() } as never,
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any, {}), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage provider quota state' });
  });

  it('maps coded service errors and provider fetch failures', async () => {
    const modelsService = {
      list: vi.fn()
        .mockRejectedValueOnce(new Error('models_credential_not_found'))
        .mockRejectedValueOnce(new ProviderModelsFetchError(429, '30'))
        .mockRejectedValueOnce(new Error('unsafe_provider_base_url')),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      modelsService: modelsService as never,
    });

    const missing = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      missing,
      { provider: 'kimi' },
    );
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Provider credential not found for current identity' });

    const failed = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      failed,
      { provider: 'kimi' },
    );
    expect(failed.statusCode).toBe(502);
    expect(JSON.parse(failed.body)).toEqual({
      error: 'provider_models_fetch_failed',
      providerStatus: 429,
      retryAfter: '30',
    });

    const unsafe = response();
    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      unsafe,
      { provider: 'kimi' },
    );
    expect(unsafe.statusCode).toBe(400);
    expect(JSON.parse(unsafe.body)).toEqual({ error: 'unsafe_provider_base_url' });
  });

  it('responds 503 when the models service is not configured', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
    });
    const res = response();

    await routes['POST /api/ai/gateway/providers/:provider/models/refresh'](
      request({ type: 'solid', webId: WEB_ID }, {}),
      res,
      { provider: 'kimi' },
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'AI provider models service is not configured' });
  });
});
