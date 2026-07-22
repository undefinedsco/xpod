import {
  BaseProviderRuntimeAdapter,
  parseAnthropicMessagesSse,
  toAnthropicBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { GatewayEvent } from '../types';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'anthropic';

  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super(options);
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: ANTHROPIC_BASE_URL,
      safeBaseUrls: [ANTHROPIC_BASE_URL],
    });
    const headers = new Headers({
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    });

    try {
      yield* parseAnthropicMessagesSse(this.transport.postSse({
        url: `${baseUrl}/messages`,
        body: toAnthropicBody(input.request),
        headers,
        proxy: input.credential?.proxy,
        signal: input.signal,
      }));
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }
}
