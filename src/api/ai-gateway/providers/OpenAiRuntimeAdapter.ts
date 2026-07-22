import {
  BaseProviderRuntimeAdapter,
  parseOpenAiResponsesSse,
  toResponsesBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { GatewayEvent } from '../types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'openai';

  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super(options);
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: OPENAI_BASE_URL,
      safeBaseUrls: [OPENAI_BASE_URL],
    });

    try {
      yield* parseOpenAiResponsesSse(this.transport.postSse({
        url: `${baseUrl}/responses`,
        apiKey: input.apiKey,
        body: toResponsesBody(input.request),
        proxy: input.credential?.proxy,
        signal: input.signal,
      }));
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }
}
