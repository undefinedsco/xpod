import { GatewayProtocolError } from '../errors';
import type { GatewayEvent } from '../types';
import {
  BaseProviderRuntimeAdapter,
  OpenAiCompatibleRuntimeAdapter,
  parseAnthropicMessagesSse,
  toAnthropicBody,
  type CompatibleChatAdapterOptions,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';

export const BAILIAN_CODING_PLAN_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
export const BAILIAN_TOKEN_PLAN_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const CODING_PLAN_KEY_PATTERN = /^sk-sp-[A-Za-z0-9_-]+$/u;
const ANTHROPIC_VERSION = '2023-06-01';

export function assertBailianCodingPlanKey(apiKey: string, provider: string): void {
  if (!CODING_PLAN_KEY_PATTERN.test(apiKey)) {
    throw new GatewayProtocolError('Bailian Coding Plan credentials require an sk-sp key', {
      code: 'invalid_request',
      status: 400,
      details: { provider, keyType: 'codingPlan' },
    });
  }
}

export class BailianCodingPlanRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'bailian-coding-plan';

  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super(options);
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    assertBailianCodingPlanKey(input.apiKey, this.provider);
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: BAILIAN_CODING_PLAN_BASE_URL,
      safeBaseUrls: [BAILIAN_CODING_PLAN_BASE_URL],
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
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }
}

export class BailianTokenPlanRuntimeAdapter extends OpenAiCompatibleRuntimeAdapter {
  public constructor(options: Omit<CompatibleChatAdapterOptions, 'provider' | 'defaultBaseUrl' | 'safeBaseUrls'> = {}) {
    super({
      ...options,
      provider: 'bailian-token-plan',
      defaultBaseUrl: BAILIAN_TOKEN_PLAN_BASE_URL,
      safeBaseUrls: [BAILIAN_TOKEN_PLAN_BASE_URL],
    });
  }
}
