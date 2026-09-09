import {
  BaseProviderRuntimeAdapter,
  parseOpenAiResponsesSse,
  toResponsesBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { ProviderDescriptor } from './ProviderRegistry';
import type { GatewayEvent } from '../types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_SUBSCRIPTION_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

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
    const subscription = input.credential?.metadata?.offeringId === 'official-subscription';
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: this.defaultBaseUrl,
      safeBaseUrls: this.safeBaseUrls,
    });

    try {
      const headers = new Headers();
      if (subscription) {
        const accountId = input.credential?.metadata?.accountId;
        if (typeof accountId === 'string' && accountId) {
          headers.set('ChatGPT-Account-Id', accountId);
        }
        headers.set('originator', 'xpod');
      }
      const responsesBody = toResponsesBody(input.request);
      if (subscription) {
        // ChatGPT's Codex subscription endpoint is Responses-like but rejects
        // the public Responses API max_output_tokens field.
        delete responsesBody.max_output_tokens;
      }
      yield* parseOpenAiResponsesSse(this.transport.postSse({
        url: subscription ? OPENAI_SUBSCRIPTION_RESPONSES_URL : `${baseUrl}/responses`,
        apiKey: input.apiKey,
        body: {
          ...responsesBody,
          ...(subscription ? { store: false } : {}),
        },
        headers,
        proxy: input.credential?.proxy,
        signal: input.signal,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }
}
