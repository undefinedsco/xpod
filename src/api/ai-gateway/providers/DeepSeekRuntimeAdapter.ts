import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapterOptions,
} from './ProviderRuntimeAdapter';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export class DeepSeekRuntimeAdapter extends OpenAiCompatibleRuntimeAdapter {
  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super({
      ...options,
      provider: 'deepseek',
      defaultBaseUrl: DEEPSEEK_BASE_URL,
      safeBaseUrls: [DEEPSEEK_BASE_URL],
      supportsImages: false,
      supportsDeveloperMessages: false,
      allowToolChoiceRequired: false,
      allowReasoningEffort: true,
    });
  }
}
