import type { GatewayEvent } from '../types';
import { AnthropicRuntimeAdapter } from './AnthropicRuntimeAdapter';
import {
  OpenAiCompatibleRuntimeAdapter,
  type ProviderRuntimeAdapter,
  type ProviderRuntimeExecuteInput,
} from './ProviderRuntimeAdapter';
import type { ProviderDescriptor } from './ProviderRegistry';
import type { ProviderHttpTransport } from '../../service/provider-http-transport';

export class CustomRuntimeAdapter implements ProviderRuntimeAdapter {
  public readonly provider = 'custom';
  private readonly openai: ProviderRuntimeAdapter;
  private readonly anthropic: ProviderRuntimeAdapter;

  public constructor(input: { transport: ProviderHttpTransport; descriptor: ProviderDescriptor }) {
    this.openai = new OpenAiCompatibleRuntimeAdapter({
      transport: input.transport,
      provider: 'custom',
      descriptor: input.descriptor,
      defaultBaseUrl: input.descriptor.defaultBaseUrl,
      safeBaseUrls: input.descriptor.safeBaseUrls,
      allowCredentialBaseUrl: true,
      supportsImages: input.descriptor.capabilities.imageInput,
      supportsDeveloperMessages: true,
      allowToolChoiceRequired: true,
    });
    this.anthropic = new AnthropicRuntimeAdapter({
      transport: input.transport,
      provider: 'custom',
      defaultBaseUrl: input.descriptor.defaultBaseUrl,
      safeBaseUrls: input.descriptor.safeBaseUrls,
      allowCredentialBaseUrl: true,
    });
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const compatibility = input.credential?.compatibility ?? 'openai';
    if (compatibility === 'anthropic') {
      yield* this.anthropic.execute(input);
      return;
    }
    if (compatibility !== 'auto') {
      yield* this.openai.execute(input);
      return;
    }
    let emitted = false;
    try {
      for await (const event of this.openai.execute(input)) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      if (emitted) throw error;
      let anthropicEmitted = false;
      try {
        for await (const event of this.anthropic.execute(input)) {
          anthropicEmitted = true;
          yield event;
        }
      } catch (anthropicError) {
        if (anthropicEmitted) throw anthropicError;
        throw new Error('custom_protocol_detection_failed:openai_and_anthropic');
      }
    }
  }
}
