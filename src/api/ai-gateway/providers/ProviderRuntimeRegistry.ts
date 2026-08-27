import { GatewayProtocolError } from '../errors';
import { ProviderHttpTransport } from '../../service/provider-http-transport';
import { AnthropicRuntimeAdapter } from './AnthropicRuntimeAdapter';
import { BailianRuntimeAdapter } from './BailianRuntimeAdapter';
import { DeepSeekRuntimeAdapter } from './DeepSeekRuntimeAdapter';
import { KimiRuntimeAdapter } from './KimiRuntimeAdapter';
import { OpenAiRuntimeAdapter } from './OpenAiRuntimeAdapter';
import { OpenAiCompatibleRuntimeAdapter } from './ProviderRuntimeAdapter';
import {
  createDefaultProviderRegistry,
  normalizeProviderId,
  type ProviderRegistry,
} from './ProviderRegistry';
import type { ProviderDescriptor } from './ProviderRegistry';
import type { ProviderRuntimeAdapter } from './ProviderRuntimeAdapter';

export interface ProviderRuntimeRegistryOptions {
  registry?: ProviderRegistry;
  transport?: ProviderHttpTransport;
}

export class ProviderRuntimeRegistry {
  private readonly adapters = new Map<string, ProviderRuntimeAdapter>();
  private readonly registry: ProviderRegistry;
  private readonly transport: ProviderHttpTransport;

  public constructor(options: ProviderRuntimeRegistryOptions = {}) {
    const registry = options.registry ?? createDefaultProviderRegistry();
    const transport = options.transport ?? new ProviderHttpTransport();
    this.registry = registry;
    this.transport = transport;
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

  public get(provider: string, routeDescriptor?: ProviderDescriptor): ProviderRuntimeAdapter {
    const providerId = normalizeProviderId(provider);
    const existing = this.adapters.get(providerId);
    if (existing) {
      return existing;
    }
    const descriptor = routeDescriptor ?? this.registry.getProvider(providerId);
    if (!descriptor) {
      throw new GatewayProtocolError('Unknown provider runtime adapter', {
        code: 'invalid_request',
        status: 400,
        details: { provider },
      });
    }
    const adapter = new OpenAiCompatibleRuntimeAdapter({
      provider: providerId,
      defaultBaseUrl: descriptor.defaultBaseUrl,
      safeBaseUrls: descriptor.safeBaseUrls,
      descriptor,
      transport: this.transport,
    });
    // Custom providers are defined by mutable Pod credentials. Recreate their
    // adapter so a Base URL change cannot keep an obsolete endpoint allowlist
    // alive for the lifetime of the Xpod process. Built-in adapters remain
    // cached above because their endpoint boundaries are deployment-owned.
    return adapter;
  }

  public list(): ProviderRuntimeAdapter[] {
    return Array.from(this.adapters.values());
  }
}
