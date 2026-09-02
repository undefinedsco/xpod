import {
  BaseProviderRuntimeAdapter,
  parseAnthropicMessagesSse,
  toAnthropicBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { GatewayEvent } from '../types';
import type { ProviderHttpTransport } from '../../service/provider-http-transport';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicRuntimeAdapterOptions extends ProviderRuntimeAdapterOptions {
  provider?: string;
  defaultBaseUrl?: string;
  safeBaseUrls?: string[];
  allowCredentialBaseUrl?: boolean;
  transport?: ProviderHttpTransport;
}

export class AnthropicRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider: string;
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];
  private readonly allowCredentialBaseUrl: boolean;

  public constructor(options: AnthropicRuntimeAdapterOptions = {}) {
    super(options);
    this.provider = options.provider ?? 'anthropic';
    this.defaultBaseUrl = options.defaultBaseUrl ?? ANTHROPIC_BASE_URL;
    this.safeBaseUrls = options.safeBaseUrls ?? [ANTHROPIC_BASE_URL];
    this.allowCredentialBaseUrl = options.allowCredentialBaseUrl ?? false;
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: this.defaultBaseUrl,
      safeBaseUrls: this.safeBaseUrls,
      allowCredentialBaseUrl: this.allowCredentialBaseUrl,
    });
    const headers = new Headers({
      'x-api-key': input.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    });

    try {
      yield* parseAnthropicMessagesSse(this.transport.postSse({
        url: `${baseUrl}/messages`,
        body: toAnthropicBody(input.request, { maxOutputTokensDefault: this.maxOutputTokensDefault }),
        headers,
        proxy: input.credential?.proxy,
        signal: input.signal,
        allowPrivateNetwork: input.credential?.allowPrivateNetwork === true,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }
}
