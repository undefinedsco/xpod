import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchModelsDevCatalog,
  modelsDevModelDescriptors,
  resetModelsDevCatalogCache,
  syncProviderRegistryFromModelsDev,
  syncProviderRegistryWithModelsDev,
  XPOD_PROVIDER_TO_MODELS_DEV,
} from '../../../src/api/ai-gateway/providers/ModelsDevCatalog';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const catalogFixture = {
  'alibaba-cn': {
    id: 'alibaba-cn',
    name: 'Alibaba (China)',
    api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    env: ['DASHSCOPE_API_KEY'],
    models: {
      'qwen3-coder-480b-a35b-instruct': {
        id: 'qwen3-coder-480b-a35b-instruct',
        name: 'Qwen3-Coder 480B-A35B Instruct',
        reasoning: false,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 262144, output: 65536 },
        cost: { input: 0.861, output: 3.441 },
      },
      'qwen3-vl-plus': {
        id: 'qwen3-vl-plus',
        name: 'Qwen3 VL Plus',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
      },
    },
  },
  moonshotai: {
    id: 'moonshotai',
    name: 'Moonshot AI',
    api: 'https://api.moonshot.ai/v1',
    models: {
      'kimi-k2': { id: 'kimi-k2', name: 'Kimi K2', tool_call: true },
    },
  },
};

afterEach((): void => {
  resetModelsDevCatalogCache();
});

describe('models.dev catalog sync', (): void => {
  it('maps every Xpod provider to a models.dev entry', (): void => {
    expect(XPOD_PROVIDER_TO_MODELS_DEV).toMatchObject({
      openai: 'openai',
      anthropic: 'anthropic',
      kimi: 'moonshotai',
      bailian: 'alibaba-cn',
      deepseek: 'deepseek',
    });
  });

  it('converts models.dev model entries into provider model descriptors', (): void => {
    const descriptors = modelsDevModelDescriptors(catalogFixture['alibaba-cn']);
    const coder = descriptors.find((model) => model.id === 'qwen3-coder-480b-a35b-instruct');
    expect(coder).toMatchObject({
      contextWindow: 262144,
      inputModalities: ['text'],
      capabilities: { toolCalls: true, reasoningEffort: false, imageInput: false },
      metadata: { source: 'models.dev', name: 'Qwen3-Coder 480B-A35B Instruct' },
    });
    const vision = descriptors.find((model) => model.id === 'qwen3-vl-plus');
    expect(vision?.capabilities?.imageInput).toBe(true);
  });

  it('merges models.dev models into the static provider seeds without dropping seed models', (): void => {
    const registry = createDefaultProviderRegistry();
    const synced = syncProviderRegistryWithModelsDev(registry, catalogFixture as never);

    expect(synced).toEqual(expect.arrayContaining(['bailian', 'kimi']));
    const bailian = registry.requireProvider('bailian');
    expect(bailian.models.some((model) => model.id === 'qwen3-coder-480b-a35b-instruct')).toBe(true);
    expect(bailian.models.some((model) => model.id === 'qwen-max')).toBe(true);
    expect(registry.requireProvider('kimi').models.some((model) => model.id === 'kimi-k2')).toBe(true);
  });

  it('skips providers missing from the catalog payload', (): void => {
    const registry = createDefaultProviderRegistry();
    const synced = syncProviderRegistryWithModelsDev(registry, {});

    expect(synced).toEqual([]);
    expect(registry.requireProvider('bailian').models).toHaveLength(2);
  });

  it('fetches the catalog once and serves subsequent syncs from cache', async (): Promise<void> => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return Response.json(catalogFixture);
    }) as typeof fetch;

    const first = await fetchModelsDevCatalog({ fetch: fetchImpl });
    const second = await fetchModelsDevCatalog({ fetch: fetchImpl });

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it('falls back to static seeds when the catalog fetch fails', async (): Promise<void> => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof fetch;
    const registry = createDefaultProviderRegistry();

    const synced = await syncProviderRegistryFromModelsDev(registry, { fetch: fetchImpl });

    expect(synced).toEqual([]);
    expect(registry.requireProvider('bailian').models).toHaveLength(2);
  });

  it('syncs a registry end-to-end through the fetch wrapper', async (): Promise<void> => {
    const fetchImpl = (async (): Promise<Response> => Response.json(catalogFixture)) as typeof fetch;
    const registry = createDefaultProviderRegistry();

    const synced = await syncProviderRegistryFromModelsDev(registry, { fetch: fetchImpl });

    expect(synced).toEqual(expect.arrayContaining(['bailian', 'kimi']));
    expect(registry.requireProvider('bailian').models.length).toBeGreaterThan(2);
  });
});
