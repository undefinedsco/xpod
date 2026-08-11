import { describe, expect, it } from 'vitest';

import {
  createDefaultProviderRegistry,
  type ProviderOfferingDescriptor,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';

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

  it('marks OAuth subscription offerings unavailable until their provider Connect flow exists', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireOffering('openai', 'official-subscription')).toMatchObject({
      lifecycle: 'unavailable',
      authModes: ['oauth'],
    });
    expect(registry.requireOffering('anthropic', 'official-subscription')).toMatchObject({
      lifecycle: 'unavailable',
      authModes: ['oauth'],
    });
    expect(() => registry.requireOffering('kimi', 'official-subscription')).toThrow();
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
});
