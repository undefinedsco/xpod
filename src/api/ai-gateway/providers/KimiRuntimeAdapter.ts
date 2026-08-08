import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapterOptions,
} from './ProviderRuntimeAdapter';
import {
  createDefaultProviderRegistry,
  type ProviderOfferingDescriptor,
  type ProviderDescriptor,
  type ProviderModelDescriptor,
} from './ProviderRegistry';
import { GatewayProtocolError } from '../errors';

const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

export interface KimiRuntimeAdapterOptions extends ProviderRuntimeAdapterOptions {
  provider?: ProviderDescriptor;
}

export class KimiRuntimeAdapter extends OpenAiCompatibleRuntimeAdapter {
  public constructor(options: KimiRuntimeAdapterOptions = {}) {
    const provider = options.provider ?? createDefaultProviderRegistry().requireProvider('kimi');
    super({
      ...options,
      provider: 'kimi',
      descriptor: provider,
      defaultBaseUrl: provider.defaultBaseUrl || KIMI_BASE_URL,
      safeBaseUrls: Array.from(new Set([
        ...provider.safeBaseUrls,
        ...offeringBaseUrls('kimi', 'chatCompletions'),
      ])),
      supportsImages: true,
      supportsDeveloperMessages: true,
      allowToolChoiceRequired: true,
      preserveReasoningContent: true,
      reasoningEffortMapper: (effort, request, model) => mapKimiReasoningEffort(effort, request, model),
      fallbackReasoningBody: (effort, request, model) => fallbackKimiThinking(effort, request, model),
    });
  }
}

function offeringBaseUrls(productId: string, protocol: 'chatCompletions'): string[] {
  return createDefaultProviderRegistry()
    .requireProduct(productId)
    .offerings
    .flatMap((offering: ProviderOfferingDescriptor) =>
      offering.endpoints
        .filter((endpoint) => endpoint.protocol === protocol)
        .map((endpoint) => endpoint.baseUrl));
}

function mapKimiReasoningEffort(
  effort: string,
  request: { model: string },
  model: ProviderModelDescriptor | undefined,
): string | undefined {
  if (model?.capabilities?.reasoningEffort === true) {
    return 'max';
  }
  if (request.model.startsWith('kimi-k2')) {
    return undefined;
  }
  throw unsupportedKimiReasoning(request.model, effort);
}

function fallbackKimiThinking(
  effort: string,
  request: { model: string },
  model: ProviderModelDescriptor | undefined,
): Record<string, unknown> {
  if (model?.capabilities?.reasoningEffort === true) {
    return {};
  }
  if (request.model.startsWith('kimi-k2')) {
    return { thinking: { type: 'enabled' } };
  }
  throw unsupportedKimiReasoning(request.model, effort);
}

function unsupportedKimiReasoning(model: string, effort: string): never {
  throw new GatewayProtocolError('Kimi reasoning effort is not registered for this model', {
    code: 'invalid_request',
    status: 400,
    details: {
      provider: 'kimi',
      model,
      effort,
      capability: 'reasoningEffort',
    },
  });
}
