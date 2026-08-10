import {
  BaseProviderRuntimeAdapter,
  parseOpenAiResponsesSse,
  toResponsesBody,
  type ProviderImageGenerationInput,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { ProviderDescriptor } from './ProviderRegistry';
import type { GatewayEvent } from '../types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiRuntimeAdapterOptions extends ProviderRuntimeAdapterOptions {
  provider?: ProviderDescriptor;
}

export class OpenAiRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'openai';
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];

  public constructor(options: OpenAiRuntimeAdapterOptions = {}) {
    super(options);
    this.defaultBaseUrl = options.provider?.defaultBaseUrl ?? OPENAI_BASE_URL;
    this.safeBaseUrls = options.provider?.safeBaseUrls ?? [OPENAI_BASE_URL];
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: this.defaultBaseUrl,
      safeBaseUrls: this.safeBaseUrls,
    });

    try {
      yield* parseOpenAiResponsesSse(this.transport.postSse({
        url: `${baseUrl}/responses`,
        apiKey: input.apiKey,
        body: toResponsesBody(input.request),
        proxy: input.credential?.proxy,
        signal: input.signal,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  public async generateImage(input: ProviderImageGenerationInput): Promise<Record<string, unknown>> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: this.defaultBaseUrl,
      safeBaseUrls: this.safeBaseUrls,
    });
    return this.requestOpenAiImage(input, baseUrl);
  }
}
