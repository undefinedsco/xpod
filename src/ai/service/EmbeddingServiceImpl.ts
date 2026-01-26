import { createOpenAI } from '@ai-sdk/openai';
import { embedMany, embed as embedSingle } from 'ai';
import { EmbeddingService } from './EmbeddingService';
import type { ProviderRegistry } from './ProviderRegistry';
import type { AiCredential } from './types';

export class EmbeddingServiceImpl extends EmbeddingService {
  private providerRegistry: ProviderRegistry;

  constructor(providerRegistry: ProviderRegistry) {
    super();
    this.providerRegistry = providerRegistry;
  }

  public override async embed(text: string, credential: AiCredential, modelId: string): Promise<number[]> {
    const model = await this.createEmbeddingModel(credential, modelId);
    const result = await embedSingle({ model, value: text });
    return result.embedding;
  }

  public override async embedBatch(texts: string[], credential: AiCredential, modelId: string): Promise<number[][]> {
    if (texts.length === 0) return [];

    const model = await this.createEmbeddingModel(credential, modelId);
    const result = await embedMany({ model, values: texts });
    return result.embeddings;
  }

  private async createEmbeddingModel(credential: AiCredential, modelName: string) {
    const provider = await this.providerRegistry.getProvider(credential.provider);
    const baseUrl = credential.baseUrl || provider?.baseUrl;
    const proxyUrl = credential.proxyUrl || provider?.proxyUrl;

    if (!baseUrl) {
      throw new Error(`No baseUrl found for provider: ${credential.provider}`);
    }

    const clientConfig: Parameters<typeof createOpenAI>[0] = {
      apiKey: credential.apiKey,
      baseURL: baseUrl,
    };

    if (proxyUrl) {
      clientConfig.fetch = await this.createProxyFetch(proxyUrl);
    }

    const client = createOpenAI(clientConfig);
    return client.embedding(modelName);
  }

  private async createProxyFetch(proxyUrl: string): Promise<typeof fetch> {
    const { ProxyAgent } = await import('undici');
    const proxyAgent = new ProxyAgent(proxyUrl);

    return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      return fetch(input, { ...init, dispatcher: proxyAgent } as any);
    };
  }
}
