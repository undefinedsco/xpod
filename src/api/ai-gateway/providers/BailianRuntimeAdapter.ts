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
import { createDefaultProviderRegistry, type ProviderOfferingDescriptor } from './ProviderRegistry';

const BAILIAN_STANDARD_BASE_URL = offeringBaseUrl('pay-as-you-go', 'chatCompletions');
const BAILIAN_CODING_PLAN_BASE_URL = offeringBaseUrl('coding-plan', 'anthropic');
const BAILIAN_TOKEN_PLAN_BASE_URL = offeringBaseUrl('token-plan', 'chatCompletions');
const BAILIAN_REGIONAL_HOSTS: Record<string, string> = {
  'cn-beijing': 'dashscope.aliyuncs.com',
  intl: 'dashscope-intl.aliyuncs.com',
};
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9_]{3,64}$/u;
const CODING_PLAN_KEY_PATTERN = /^sk-sp-[A-Za-z0-9_-]+$/u;

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
    if (keyType === 'tokenPlan') {
      yield* this.executeTokenPlan(input);
      return;
    }
    if (keyType !== 'dashscope' && keyType !== 'apiKey') {
      throw new GatewayProtocolError('Unsupported Bailian credential key type', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, keyType },
      });
    }
    if (input.apiKey.startsWith('sk-sp-')) {
      throw new GatewayProtocolError('Bailian Coding Plan keys must use the Coding Plan endpoint', {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, keyType: 'codingPlan' },
      });
    }
    const baseUrl = this.resolveStandardBaseUrl(input);
    try {
      yield* parseCompatibleChatSse(this.transport.postSse({
        url: `${baseUrl}/chat/completions`,
        apiKey: input.apiKey,
        body: toChatCompletionsBody(input.request, {
          reasoningEffort: input.request.reasoning?.effort,
        }),
        proxy: input.credential?.proxy,
        signal: input.signal,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  private async *executeTokenPlan(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: BAILIAN_TOKEN_PLAN_BASE_URL,
      safeBaseUrls: [BAILIAN_TOKEN_PLAN_BASE_URL],
    });
    try {
      yield* parseCompatibleChatSse(this.transport.postSse({
        url: `${baseUrl}/chat/completions`,
        apiKey: input.apiKey,
        body: toChatCompletionsBody(input.request, {
          reasoningEffort: input.request.reasoning?.effort,
        }),
        proxy: input.credential?.proxy,
        signal: input.signal,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  private async *executeCodingPlan(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    if (!CODING_PLAN_KEY_PATTERN.test(input.apiKey)) {
      throw new GatewayProtocolError('Bailian Coding Plan credentials require an sk-sp key', {
        code: 'invalid_request',
        status: 400,
        details: {
          provider: this.provider,
          keyType: 'codingPlan',
        },
      });
    }
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
        body: toAnthropicBody(input.request, { maxOutputTokensDefault: this.maxOutputTokensDefault }),
        headers,
        proxy: input.credential?.proxy,
        signal: input.signal,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  private resolveStandardBaseUrl(input: ProviderRuntimeExecuteInput): string {
    const region = input.credential?.region;
    const workspaceId = input.credential?.workspaceId;
    if (region || workspaceId) {
      if (!region || !workspaceId) {
        throw new GatewayProtocolError('Bailian regional endpoints require both region and workspaceId', {
          code: 'invalid_request',
          status: 400,
          details: { provider: this.provider },
        });
      }
      const host = BAILIAN_REGIONAL_HOSTS[region];
      if (!host || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
        throw new GatewayProtocolError('Invalid Bailian region or workspaceId', {
          code: 'invalid_request',
          status: 400,
          details: { provider: this.provider },
        });
      }
      return `https://${host}/api/v1/workspaces/${workspaceId}/compatible-mode/v1`;
    }

    return this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: BAILIAN_STANDARD_BASE_URL,
      safeBaseUrls: [BAILIAN_STANDARD_BASE_URL],
    });
  }
}

function offeringBaseUrl(offeringId: string, protocol: 'anthropic' | 'chatCompletions'): string {
  const product = createDefaultProviderRegistry().requireProduct('bailian');
  const offering = product.offerings.find((item: ProviderOfferingDescriptor) => item.id === offeringId);
  const endpoint = offering?.endpoints.find((item) => item.protocol === protocol);
  if (!endpoint) {
    throw new Error(`Missing Bailian ${offeringId} ${protocol} endpoint`);
  }
  return endpoint.baseUrl;
}
