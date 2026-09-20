import { describe, expect, it } from 'vitest';

import {
  createDefaultProviderRegistry,
  providerProductsForDeployment,
  type ProviderOfferingDescriptor,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { createGatewayEmbeddingModelCatalog } from '../../../src/api/ai-gateway/models/GatewayEmbeddingModelCatalog';

function offeringById(offerings: ProviderOfferingDescriptor[], id: string): ProviderOfferingDescriptor {
  const offering = offerings.find((item) => item.id === id);
  if (!offering) {
    throw new Error(`Missing offering ${id}`);
  }
  return offering;
}

function endpointMap(offering: ProviderOfferingDescriptor): Record<string, string> {
  return Object.fromEntries(offering.endpoints.map((endpoint) => [endpoint.protocol, endpoint.baseUrl]));
}

describe('ProviderRegistry provider catalog', () => {
  it('uses only the standardized Offering kinds', () => {
    const kinds = createDefaultProviderRegistry()
      .listProducts()
      .flatMap((product) => product.offerings.map((offering) => offering.kind));

    expect(new Set(kinds)).toEqual(new Set([
      'oauth-subscription',
      'api-platform',
      'token-plan',
      'local',
    ]));
  });

  it('composes auth and upstream capabilities independently on every Offering', () => {
    const products = createDefaultProviderRegistry().listProducts();

    for (const product of products) {
      for (const offering of product.offerings) {
        expect(offering.auth.length).toBeGreaterThan(0);
        expect(offering.upstream.length).toBeGreaterThan(0);
        expect(new Set(offering.auth.map((capability) => capability.protocol)).size)
          .toBe(offering.auth.length);
        expect(new Set(offering.upstream.map((capability) => `${capability.capability}:${capability.protocol}`)).size)
          .toBe(offering.upstream.length);
      }
    }
  });

  it('offers Kimi Token Plan and API Platform keys without device-code login', () => {
    const kimi = createDefaultProviderRegistry().requireProduct('kimi');

    expect(kimi.offerings.map((offering) => ({
      id: offering.id,
      kind: offering.kind,
      auth: offering.auth.map((capability) => capability.protocol),
    }))).toEqual([
      { id: 'subscription-key', kind: 'token-plan', auth: ['subscription-key'] },
      { id: 'api-platform', kind: 'api-platform', auth: ['api-key'] },
    ]);
  });

  it('groups offerings under one provider product', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireProduct('bailian').offerings.map((item) => item.id)).toEqual([
      'pay-as-you-go',
      'token-plan',
      'token-plan-team',
      'coding-plan',
    ]);
  });

  it('publishes the complete product contract on every offering', () => {
    const products = createDefaultProviderRegistry().listProducts();

    for (const product of products) {
      for (const offering of product.offerings) {
        expect(offering).toMatchObject({
          productLabel: product.label,
          kind: expect.any(String),
          authModes: expect.any(Array),
          credentialPrefixHints: expect.any(Array),
          consoleUrl: expect.stringMatching(/^https:\/\//u),
          subscriptionUrl: expect.stringMatching(/^https:\/\//u),
          endpoints: expect.any(Array),
          modelDiscovery: {
            strategy: expect.any(String),
            path: expect.stringMatching(/^\//u),
          },
          quota: {
            strategy: expect.any(String),
            url: expect.stringMatching(/^https:\/\//u),
          },
          usagePolicyUrl: expect.stringMatching(/^https:\/\//u),
          region: expect.any(String),
          lifecycle: expect.stringMatching(/^(active|legacy|unavailable)$/u),
        });
      }
    }
  });

  it.each(['local', 'cloud'] as const)('publishes the actual OpenAI subscription endpoint for %s', (deployment) => {
    const product = providerProductsForDeployment(deployment).find((item) => item.id === 'openai')!;

    expect(endpointMap(offeringById(product.offerings, 'official-subscription'))).toEqual({
      responses: 'https://chatgpt.com/backend-api/codex',
    });
    expect(endpointMap(offeringById(product.offerings, 'api-platform'))).toEqual({
      responses: 'https://api.openai.com/v1',
      chatCompletions: 'https://api.openai.com/v1',
    });
  });

  it('marks host-local subscription offerings unavailable by default', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireOffering('openai', 'official-subscription')).toMatchObject({
      label: 'OpenAI Subscription',
      lifecycle: 'unavailable',
      authModes: ['local'],
      auth: [{ protocol: 'local-none' }],
    });
    expect(registry.requireOffering('anthropic', 'official-subscription')).toMatchObject({
      lifecycle: 'unavailable',
      authModes: ['oauth'],
    });
    expect(() => registry.requireOffering('kimi', 'official-subscription')).toThrow();
  });

  it('exposes web login and session import independently for subscription offerings', () => {
    // The gateway names each entry by id and says whether this deployment can
    // offer it. The wording is the applet's (`display-wording.ts`), so a payload
    // that carried it would be a second copy - which is why these assertions are
    // about ids, connect modes and lifecycles rather than about button text.
    expect(new Map(providerProductsForDeployment('local').map((product) => [product.id, product]))
      .get('openai')?.offerings.find((offering) => offering.id === 'official-subscription')).toMatchObject({
        label: 'OpenAI Subscription',
        lifecycle: 'active',
        authModes: expect.arrayContaining(['deviceCode', 'local']),
        authorizationMethods: expect.arrayContaining([
          { id: 'browser-oauth', authMode: 'oauth', connectMode: 'authorizationCodeOAuth', lifecycle: 'active' },
          { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', lifecycle: 'active' },
          { id: 'local-session-import', authMode: 'local', lifecycle: 'active' },
        ]),
      });
    expect(new Map(providerProductsForDeployment('cloud').map((product) => [product.id, product]))
      .get('openai')?.offerings.find((offering) => offering.id === 'official-subscription')).toMatchObject({
        lifecycle: 'active',
        authorizationMethods: expect.arrayContaining([
          expect.objectContaining({ id: 'browser-oauth', lifecycle: 'unavailable' }),
          expect.objectContaining({ id: 'device-code', lifecycle: 'active' }),
          expect.objectContaining({ id: 'local-session-import', lifecycle: 'unavailable' }),
        ]),
      });
    const kimi = providerProductsForDeployment('local').find((product) => product.id === 'kimi')!;
    expect(kimi.offerings.map((offering) => offering.id)).toEqual(['subscription-key', 'api-platform']);
    expect(kimi.offerings[0]).toMatchObject({
      authModes: expect.arrayContaining(['apiKey', 'deviceCode', 'local']),
      authorizationMethods: expect.arrayContaining([
        expect.objectContaining({ id: 'api-key', lifecycle: 'active' }),
        expect.objectContaining({ id: 'device-code', lifecycle: 'active' }),
        expect.objectContaining({ id: 'local-session-import', lifecycle: 'active' }),
      ]),
    });
    // The api-platform offering has no subscription to split: it keeps the key
    // entry and the browser-assisted console entry the catalog declares.
    expect(kimi.offerings[1].authorizationMethods).toEqual([
      expect.objectContaining({ id: 'api-key', authMode: 'apiKey', lifecycle: 'active' }),
      expect.objectContaining({
        id: 'browser-login', authMode: 'apiKey', connectMode: 'browserAssistedApiKey', lifecycle: 'active',
      }),
    ]);
  });

  it('declares the browser-assisted console login only for providers that have one', () => {
    const products = new Map(providerProductsForDeployment('cloud').map((product) => [product.id, product]));
    const consoleEntries = (provider: string) => products.get(provider)?.offerings
      .flatMap((offering) => offering.authorizationMethods ?? [])
      .filter((method) => method.connectMode === 'browserAssistedApiKey')
      .map((method) => method.id) ?? [];

    // Every hosted provider whose console issues a key declares the entry, and
    // the entry is usable (it opens that offering's console URL) rather than an
    // unwired authorization.
    for (const provider of ['openai', 'anthropic', 'kimi', 'bailian', 'zhipu']) {
      expect(new Set(consoleEntries(provider))).toEqual(new Set(['browser-login']));
      for (const offering of products.get(provider)!.offerings) {
        for (const method of offering.authorizationMethods ?? []) {
          if (method.connectMode === 'browserAssistedApiKey') expect(method.lifecycle).toBe('active');
        }
      }
    }

    // DeepSeek has no account console, Ollama is a local service, and custom is
    // configured inside Xpod: none of them declares a login entry.
    for (const provider of ['deepseek', 'ollama', 'custom']) {
      expect(consoleEntries(provider)).toEqual([]);
    }
    expect(products.get('deepseek')!.offerings
      .flatMap((offering) => offering.authorizationMethods ?? [])
      .map((method) => method.id)).toEqual(['api-key']);
  });

  it('marks every current Bailian offering active and keeps Coding Plan Lite out of the current catalog', () => {
    const bailian = createDefaultProviderRegistry().requireProduct('bailian');

    expect(bailian.offerings.map((offering) => ({
      id: offering.id,
      lifecycle: offering.lifecycle,
    }))).toEqual([
      { id: 'pay-as-you-go', lifecycle: 'active' },
      { id: 'token-plan', lifecycle: 'active' },
      { id: 'token-plan-team', lifecycle: 'active' },
      { id: 'coding-plan', lifecycle: 'active' },
    ]);
    expect(bailian.offerings.map((offering) => offering.id)).not.toContain('coding-plan-lite');
  });

  it('normalizes offering runtime providers to their provider product', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireProduct('bailian-coding-plan').id).toBe('bailian');
    expect(registry.requireProduct('bailian-token-plan').id).toBe('bailian');
  });

  it('keeps offering and authentication mode independent', () => {
    const kimi = createDefaultProviderRegistry().requireProduct('kimi');

    expect(kimi.offerings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'subscription-key',
        authModes: ['apiKey'],
        credentialPrefixHints: ['sk-kimi-'],
      }),
      expect.objectContaining({ id: 'api-platform', authModes: ['apiKey'] }),
    ]));
  });

  it('describes Kimi subscription and API platform endpoints separately', () => {
    const kimi = createDefaultProviderRegistry().requireProduct('kimi');
    const subscriptionKey = offeringById(kimi.offerings, 'subscription-key');
    const apiPlatform = offeringById(kimi.offerings, 'api-platform');

    expect(subscriptionKey).toMatchObject({
      kind: 'token-plan',
      authModes: ['apiKey'],
    });
    expect(subscriptionKey.oauthIntegrationId).toBeUndefined();
    expect(endpointMap(subscriptionKey)).toEqual({
      chatCompletions: 'https://api.kimi.com/coding/v1',
      anthropic: 'https://api.kimi.com/coding/',
    });
    expect(apiPlatform).toMatchObject({
      kind: 'api-platform',
      authModes: ['apiKey'],
    });
    expect(apiPlatform.oauthIntegrationId).toBeUndefined();
    expect(endpointMap(apiPlatform)).toEqual({
      chatCompletions: 'https://api.moonshot.ai/v1',
    });
  });

  it('describes Bailian offerings with exact OpenAI-compatible and Anthropic-compatible endpoints', () => {
    const bailian = createDefaultProviderRegistry().requireProduct('bailian');

    expect(bailian.offerings.map((offering) => ({
      id: offering.id,
      kind: offering.kind,
      authModes: offering.authModes,
      endpoints: endpointMap(offering),
    }))).toEqual([
      {
        id: 'pay-as-you-go',
        kind: 'api-platform',
        authModes: ['apiKey'],
        endpoints: {
          chatCompletions: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
        },
      },
      {
        id: 'token-plan',
        kind: 'token-plan',
        authModes: ['apiKey'],
        endpoints: {
          chatCompletions: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          anthropic: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        },
      },
      {
        id: 'token-plan-team',
        kind: 'token-plan',
        authModes: ['apiKey'],
        endpoints: {
          chatCompletions: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          anthropic: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        },
      },
      {
        id: 'coding-plan',
        kind: 'token-plan',
        authModes: ['apiKey'],
        endpoints: {
          chatCompletions: 'https://coding.dashscope.aliyuncs.com/v1',
          anthropic: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
        },
      },
    ]);
  });

  it('keeps Coding Plan Lite out of the current catalog because it is legacy-only', () => {
    const ids = createDefaultProviderRegistry().requireProduct('bailian').offerings.map((item) => item.id);

    expect(ids).not.toContain('coding-plan-lite');
  });

  it('publishes Zhipu API Platform and GLM Coding Plan as distinct OpenAI-compatible Offerings', () => {
    const registry = createDefaultProviderRegistry();
    const zhipu = registry.requireProduct('zhipu');

    expect(zhipu.offerings.map((offering) => ({
      id: offering.id,
      kind: offering.kind,
      authModes: offering.authModes,
      endpoints: endpointMap(offering),
      modelDiscovery: offering.modelDiscovery,
    }))).toEqual([
      {
        id: 'api-platform',
        kind: 'api-platform',
        authModes: ['apiKey'],
        endpoints: { chatCompletions: 'https://open.bigmodel.cn/api/paas/v4' },
        modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      },
      {
        id: 'coding-plan',
        kind: 'token-plan',
        authModes: ['apiKey'],
        endpoints: { chatCompletions: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
      },
    ]);
    expect(registry.requireProvider('zhipu')).toMatchObject({
      defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      safeBaseUrls: [
        'https://open.bigmodel.cn/api/paas/v4',
        'https://open.bigmodel.cn/api/coding/paas/v4',
      ],
      protocols: ['chatCompletions'],
    });
  });

  it('publishes Ollama as a local OpenAI-compatible Offering without API-key auth', () => {
    const registry = createDefaultProviderRegistry();
    const ollama = registry.requireProduct('ollama');

    expect(ollama.offerings.map((offering) => ({
      id: offering.id,
      kind: offering.kind,
      authModes: offering.authModes,
      auth: offering.auth.map((capability) => capability.protocol),
      endpoints: endpointMap(offering),
      quota: offering.quota,
    }))).toEqual([
      {
        id: 'local',
        kind: 'local',
        authModes: ['local'],
        auth: ['local-none'],
        endpoints: { chatCompletions: 'http://localhost:11434/v1' },
        quota: { strategy: 'unsupported', url: 'https://ollama.com' },
      },
    ]);
    expect(registry.requireProvider('ollama')).toMatchObject({
      defaultBaseUrl: 'http://localhost:11434/v1',
      safeBaseUrls: ['http://localhost:11434/v1'],
      protocols: ['chatCompletions'],
      authModes: ['connectUnsupported'],
    });
  });

  it('publishes custom OpenAI and Anthropic compatible offerings without a quota API', () => {
    const registry = createDefaultProviderRegistry();
    const custom = registry.requireProduct('custom');

    expect(custom.offerings.map((offering) => ({
      id: offering.id,
      kind: offering.kind,
      authModes: offering.authModes,
      quota: offering.quota.strategy,
      endpoints: endpointMap(offering),
    }))).toEqual([
      {
        id: 'openai-compatible',
        kind: 'api-platform',
        authModes: ['apiKey'],
        quota: 'unsupported',
        endpoints: { chatCompletions: 'https://example.invalid/v1' },
      },
      {
        id: 'anthropic-compatible',
        kind: 'api-platform',
        authModes: ['apiKey'],
        quota: 'unsupported',
        endpoints: { anthropic: 'https://example.invalid/v1' },
      },
    ]);
    expect(registry.requireOffering('custom', 'openai-compatible').upstream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'balance', protocol: 'unsupported-quota' }),
      ]),
    );
  });
});

describe('ProviderRegistry embedding catalog', () => {
  it('provides the embedding models a deployment may use', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.listManagedEmbeddingModels('openai').map((model) => model.id))
      .toEqual(['text-embedding-3-small', 'text-embedding-3-large']);
    expect(registry.listManagedEmbeddingModels('bailian').map((model) => model.id))
      .toEqual(['text-embedding-v4']);
    expect(registry.listManagedEmbeddingModels('zhipu').map((model) => model.id))
      .toEqual(['embedding-2']);
    // Providers without an embedding product stay empty instead of advertising one.
    expect(registry.listManagedEmbeddingModels('deepseek')).toEqual([]);
    expect(registry.listManagedEmbeddingModels('kimi')).toEqual([]);
    expect(registry.listManagedEmbeddingModels('custom')).toEqual([]);
  });

  it('resolves runtime provider vocabularies onto catalog providers', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.resolveManagedProviderId('dashscope')).toBe('bailian');
    expect(registry.resolveManagedProviderId('qwen')).toBe('bailian');
    expect(registry.resolveManagedProviderId('moonshot')).toBe('kimi');
    expect(registry.resolveManagedProviderId('bedrock')).toBeUndefined();
    expect(registry.isManagedEmbeddingModel('dashscope', 'text-embedding-v4')).toBe(true);
    expect(registry.isManagedEmbeddingModel('bailian', 'text-embedding-v4')).toBe(true);
    expect(registry.isManagedEmbeddingModel('bailian', 'text-embedding-3-small')).toBe(false);
    expect(registry.isManagedEmbeddingModel('bedrock', 'text-embedding-v4')).toBe(false);
  });

  it('keeps chat models out of the embedding catalog', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.isManagedEmbeddingModel('openai', 'gpt-5')).toBe(false);
    expect(registry.isManagedEmbeddingModel('openai', 'text-embedding-3-small')).toBe(true);
  });

  it('keeps embedding capability when models.dev merges a provider catalog', () => {
    const registry = createDefaultProviderRegistry();

    registry.mergeDiscoveredModels('openai', [{
      id: 'text-embedding-3-small',
      contextWindow: 8192,
      metadata: { source: 'models.dev' },
    }]);

    expect(registry.isManagedEmbeddingModel('openai', 'text-embedding-3-small')).toBe(true);
  });
});

describe('gateway embedding catalog adapter', () => {
  const registry = createDefaultProviderRegistry();

  it('provides the operator-designated endpoint for cloud providers', () => {
    const catalog = createGatewayEmbeddingModelCatalog(registry, 'cloud');

    expect(catalog.managedEmbeddingBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(catalog.managedEmbeddingBaseUrl('dashscope'))
      .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(catalog.isManagedEmbeddingModel('openai', 'text-embedding-3-small')).toBe(true);
  });

  it('never provides a local-only provider in cloud', () => {
    const catalog = createGatewayEmbeddingModelCatalog(registry, 'cloud');

    // Ollama's only offering is a local daemon; pinning Cloud egress to it would
    // mean Cloud calling its own loopback.
    expect(catalog.managedEmbeddingBaseUrl('ollama')).toBeUndefined();
    expect(catalog.isManagedEmbeddingModel('ollama', 'nomic-embed-text')).toBe(false);
  });

  it('keeps local-only providers usable in a local deployment', () => {
    const catalog = createGatewayEmbeddingModelCatalog(registry, 'local');

    expect(catalog.managedEmbeddingBaseUrl('ollama')).toBe('http://localhost:11434/v1');
    expect(catalog.isManagedEmbeddingModel('ollama', 'nomic-embed-text')).toBe(true);
  });
});

describe('ProviderRegistry deployment provider set', () => {
  const registry = createDefaultProviderRegistry();

  it('cloud provides only the operator-designated providers', () => {
    expect(registry.isProvidedInDeployment('openai', 'cloud')).toBe(true);
    expect(registry.isProvidedInDeployment('bailian', 'cloud')).toBe(true);
    expect(registry.isProvidedInDeployment('zhipu', 'cloud')).toBe(true);
    // Self-hosted endpoints and local daemons are Local-only.
    expect(registry.isProvidedInDeployment('custom', 'cloud')).toBe(false);
    expect(registry.isProvidedInDeployment('ollama', 'cloud')).toBe(false);
    expect(registry.isProvidedInDeployment('bedrock', 'cloud')).toBe(false);
    expect(registry.listProvidedProviders('cloud').map((provider) => provider.id))
      .toEqual(['openai', 'anthropic', 'kimi', 'bailian', 'deepseek', 'zhipu']);
  });

  it('local provides every catalog provider', () => {
    expect(registry.isProvidedInDeployment('custom', 'local')).toBe(true);
    expect(registry.isProvidedInDeployment('ollama', 'local')).toBe(true);
    expect(registry.listProvidedProviders('local').map((provider) => provider.id))
      .toEqual(['openai', 'anthropic', 'kimi', 'bailian', 'deepseek', 'zhipu', 'ollama', 'custom']);
  });
});
