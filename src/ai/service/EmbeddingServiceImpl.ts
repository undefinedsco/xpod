import { createOpenAI } from '@ai-sdk/openai';
import { embedMany, embed as embedSingle } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { EmbeddingService } from './EmbeddingService';
import { EmbeddingModelPolicy } from './EmbeddingModelPolicy';
import type { ProviderRegistry } from './ProviderRegistry';
import type { AiCredential } from './types';

export interface EmbeddingServiceImplOptions {
  /**
   * Deployment embedding policy. Every embedding call goes through this service,
   * so this is the hard boundary: Cloud never reaches a provider with an
   * embedding model — or an endpoint — its gateway catalog does not provide,
   * regardless of what the user's Pod contains.
   */
  policy?: EmbeddingModelPolicy;
}

export class EmbeddingServiceImpl extends EmbeddingService {
  protected readonly logger = getLoggerFor(this);
  private providerRegistry: ProviderRegistry;
  private readonly policy: EmbeddingModelPolicy;

  constructor(providerRegistry: ProviderRegistry, options: EmbeddingServiceImplOptions = {}) {
    super();
    this.providerRegistry = providerRegistry;
    this.policy = options.policy ?? EmbeddingModelPolicy.allowAll();
  }

  public override async embed(text: string, credential: AiCredential, modelId: string): Promise<number[]> {
    this.policy.assertAllowed({ provider: credential.provider, model: modelId });
    const model = await this.createEmbeddingModel(credential, modelId);
    const result = await embedSingle({ model, value: text });
    return result.embedding;
  }

  public override async embedBatch(texts: string[], credential: AiCredential, modelId: string): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.policy.assertAllowed({ provider: credential.provider, model: modelId });
    const model = await this.createEmbeddingModel(credential, modelId);
    const modelInfo = await this.providerRegistry.getEmbeddingModel(credential.provider, modelId);
    const maxBatchSize = modelInfo?.maxBatchSize;
    if (!maxBatchSize || texts.length <= maxBatchSize) {
      const result = await embedMany({ model, values: texts });
      return result.embeddings;
    }

    const embeddings: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += maxBatchSize) {
      const batch = texts.slice(offset, offset + maxBatchSize);
      const result = await embedMany({ model, values: batch });
      embeddings.push(...result.embeddings);
    }
    return embeddings;
  }

  private async createEmbeddingModel(credential: AiCredential, modelName: string) {
    const provider = await this.providerRegistry.getProvider(credential.provider);
    const endpoint = this.policy.resolveEndpoint({
      provider: credential.provider,
      baseUrl: credential.baseUrl || provider?.baseUrl,
      proxyUrl: credential.proxyUrl || provider?.proxyUrl,
    });
    const baseUrl = endpoint.baseUrl;
    if (!baseUrl) {
      throw new Error(`No baseUrl found for provider: ${credential.provider}`);
    }
    if (endpoint.source === 'catalog' && credential.baseUrl && credential.baseUrl !== baseUrl) {
      this.logger.info(
        `Ignoring Pod-provided embedding endpoint for ${credential.provider}; this deployment provides ${baseUrl}`,
      );
    }

    const clientConfig: Parameters<typeof createOpenAI>[0] = {
      apiKey: credential.apiKey,
      baseURL: baseUrl,
    };

    if (endpoint.proxyUrl) {
      clientConfig.fetch = await this.createProxyFetch(endpoint.proxyUrl);
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
