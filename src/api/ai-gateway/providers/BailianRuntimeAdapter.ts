import { GatewayProtocolError } from '../errors';
import type { GatewayEvent } from '../types';
import {
  BaseProviderRuntimeAdapter,
  parseCompatibleChatSse,
  toChatCompletionsBody,
  type ProviderRuntimeAdapterOptions,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';

const BAILIAN_STANDARD_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const BAILIAN_REGIONAL_HOSTS: Record<string, string> = {
  'cn-beijing': 'dashscope.aliyuncs.com',
  intl: 'dashscope-intl.aliyuncs.com',
};
const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9_]{3,64}$/u;

export class BailianRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider = 'bailian';

  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super(options);
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    if (input.apiKey.startsWith('sk-sp-')) {
      throw new GatewayProtocolError('Bailian Coding Plan keys (sk-sp-*) must use the bailian-coding-plan provider', {
        code: 'invalid_request',
        status: 400,
        details: { provider: 'bailian-coding-plan' },
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
