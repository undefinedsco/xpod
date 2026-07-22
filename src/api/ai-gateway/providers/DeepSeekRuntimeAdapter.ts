import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapterOptions,
} from './ProviderRuntimeAdapter';
import {
  createDefaultProviderRegistry,
  type ProviderDescriptor,
  type ProviderModelDescriptor,
} from './ProviderRegistry';
import { GatewayProtocolError } from '../errors';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export interface DeepSeekRuntimeAdapterOptions extends ProviderRuntimeAdapterOptions {
  provider?: ProviderDescriptor;
}

export class DeepSeekRuntimeAdapter extends OpenAiCompatibleRuntimeAdapter {
  public constructor(options: DeepSeekRuntimeAdapterOptions = {}) {
    const provider = options.provider ?? createDefaultProviderRegistry().requireProvider('deepseek');
    super({
      ...options,
      provider: 'deepseek',
      descriptor: provider,
      defaultBaseUrl: provider.defaultBaseUrl || DEEPSEEK_BASE_URL,
      safeBaseUrls: provider.safeBaseUrls,
      supportsImages: false,
      supportsDeveloperMessages: false,
      allowToolChoiceRequired: false,
      preserveReasoningContent: true,
      reasoningEffortMapper: (effort, request, model) => mapDeepSeekReasoningEffort(effort, request.model, model),
    });
  }
}

function mapDeepSeekReasoningEffort(
  effort: string,
  modelId: string,
  model: ProviderModelDescriptor | undefined,
): string {
  if (model?.capabilities?.reasoningEffort !== true) {
    throw new GatewayProtocolError('DeepSeek reasoning effort is not registered for this model', {
      code: 'invalid_request',
      status: 400,
      details: {
        provider: 'deepseek',
        model: modelId,
        effort,
        capability: 'reasoningEffort',
      },
    });
  }
  if (effort === 'low' || effort === 'medium') {
    return 'high';
  }
  if (effort === 'xhigh') {
    return 'max';
  }
  return effort === 'max' ? 'max' : 'high';
}
