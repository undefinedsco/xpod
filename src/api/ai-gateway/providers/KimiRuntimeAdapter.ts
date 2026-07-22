import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapterOptions,
} from './ProviderRuntimeAdapter';

const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

export class KimiRuntimeAdapter extends OpenAiCompatibleRuntimeAdapter {
  public constructor(options: ProviderRuntimeAdapterOptions = {}) {
    super({
      ...options,
      provider: 'kimi',
      defaultBaseUrl: KIMI_BASE_URL,
      safeBaseUrls: [KIMI_BASE_URL],
      supportsImages: true,
      supportsDeveloperMessages: true,
      allowToolChoiceRequired: true,
      allowReasoningEffort: true,
    });
  }
}
