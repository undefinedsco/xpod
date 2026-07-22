import { GatewayProtocolError } from '../errors';
import type { GatewayEvent } from '../types';
import {
  BaseProviderRuntimeAdapter,
  parseAnthropicMessagesSse,
  parseCompatibleChatSse,
  toAnthropicBody,
  toChatCompletionsBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';

const BAILIAN_STANDARD_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const BAILIAN_CODING_PLAN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

export class BailianRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'bailian';

  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super(options);
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const keyType = input.credential?.keyType ?? 'dashscope';
    if (keyType === 'codingPlan') {
      yield* this.executeCodingPlan(input);
      return;
    }
    if (keyType !== 'dashscope' && keyType !== 'apiKey') {
      throw new GatewayProtocolError('Unsupported Bailian credential key type', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, keyType },
      });
    }
    if (input.apiKey.startsWith('cp-')) {
      throw new GatewayProtocolError('Bailian Coding Plan keys must use the Coding Plan endpoint', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, keyType: 'codingPlan' },
      });
    }
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: BAILIAN_STANDARD_BASE_URL,
      safeBaseUrls: [BAILIAN_STANDARD_BASE_URL],
    });
    try {
      yield* parseCompatibleChatSse(this.transport.postSse({
        url: `${baseUrl}/chat/completions`,
        apiKey: input.apiKey,
        body: toChatCompletionsBody(input.request, {
          includeReasoningEffort: true,
        }),
        proxy: input.credential?.proxy,
        signal: input.signal,
      }));
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  private async *executeCodingPlan(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    if (!input.request.model.includes('coder')) {
      throw new GatewayProtocolError('Bailian Coding Plan credentials can only use Coding Plan models', {
        code: 'invalid_request',
        status: 400,
        details: {
          provider: this.provider,
          keyType: 'codingPlan',
          model: input.request.model,
        },
      });
    }
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: BAILIAN_CODING_PLAN_BASE_URL,
      safeBaseUrls: [BAILIAN_CODING_PLAN_BASE_URL],
    });
    const headers = new Headers({
      'x-api-key': input.apiKey,
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
