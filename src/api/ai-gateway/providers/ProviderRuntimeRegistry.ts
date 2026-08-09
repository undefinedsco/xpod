import { GatewayProtocolError } from '../errors';
import { ProviderHttpTransport } from '../../service/provider-http-transport';
import { AnthropicRuntimeAdapter } from './AnthropicRuntimeAdapter';
import { BailianRuntimeAdapter } from './BailianRuntimeAdapter';
import { DeepSeekRuntimeAdapter } from './DeepSeekRuntimeAdapter';
import { KimiRuntimeAdapter } from './KimiRuntimeAdapter';
import { OpenAiRuntimeAdapter } from './OpenAiRuntimeAdapter';
import {
  createDefaultProviderRegistry,
  normalizeProviderId,
  type ProviderRegistry,
} from './ProviderRegistry';
import type { ProviderRuntimeAdapter } from './ProviderRuntimeAdapter';

export interface ProviderRuntimeRegistryOptions {
  registry?: ProviderRegistry;
  transport?: ProviderHttpTransport;
}

export class ProviderRuntimeRegistry {
  private readonly adapters = new Map<string, ProviderRuntimeAdapter>();

  public constructor(options: ProviderRuntimeRegistryOptions = {}) {
    const registry = options.registry ?? createDefaultProviderRegistry();
    const transport = options.transport ?? new ProviderHttpTransport();
    this.adapters.set('openai', new OpenAiRuntimeAdapter({
      transport,
      provider: registry.requireProvider('openai'),
    }));
    this.adapters.set('anthropic', new AnthropicRuntimeAdapter({ transport }));
    this.adapters.set('kimi', new KimiRuntimeAdapter({
      transport,
      provider: registry.requireProvider('kimi'),
    }));
    this.adapters.set('bailian', new BailianRuntimeAdapter({ transport }));
    this.adapters.set('deepseek', new DeepSeekRuntimeAdapter({
      transport,
      provider: registry.requireProvider('deepseek'),
    }));
  }

  public get(provider: string): ProviderRuntimeAdapter {
    const adapter = this.adapters.get(normalizeProviderId(provider));
    if (!adapter) {
      throw new GatewayProtocolError('Unknown provider runtime adapter', {
        code: 'invalid_request',
        status: 400,
        details: { provider },
      });
    }
    return adapter;
  }

  public list(): ProviderRuntimeAdapter[] {
    return Array.from(this.adapters.values());
  }
}
