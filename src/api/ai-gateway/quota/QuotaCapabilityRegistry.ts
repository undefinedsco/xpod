import type { ProviderRegistry, ProviderUpstreamCapabilityDescriptor } from '../providers/ProviderRegistry';
import type { ProviderQuotaAdapter, QuotaCredentialRecord } from './ProviderQuotaAdapter';

export interface QuotaHandlerCapability {
  protocol: string;
  profile?: string;
}

export class QuotaCapabilityRegistry {
  private readonly handlers = new Map<string, ProviderQuotaAdapter>();

  public constructor(adapters: ProviderQuotaAdapter[]) {
    for (const adapter of adapters) {
      if (!adapter.capability) continue;
      const key = capabilityKey(adapter.capability.protocol, adapter.capability.profile);
      if (this.handlers.has(key)) throw new Error(`duplicate_quota_capability_handler:${key}`);
      this.handlers.set(key, adapter);
    }
  }

  public resolve(registry: ProviderRegistry, credential: QuotaCredentialRecord): ProviderQuotaAdapter | undefined {
    if (!credential.offeringId) return undefined;
    const offering = registry.requireOffering(credential.provider, credential.offeringId);
    const capability = quotaCapability(offering.upstream);
    if (!capability) return undefined;
    return this.handlers.get(capabilityKey(capability.protocol, stringOption(capability.options, 'profile')));
  }
}

function quotaCapability(capabilities: ProviderUpstreamCapabilityDescriptor[]): ProviderUpstreamCapabilityDescriptor | undefined {
  return capabilities.find((candidate) => candidate.capability === 'quota')
    ?? capabilities.find((candidate) => candidate.capability === 'balance');
}

function capabilityKey(protocol: string, profile?: string): string {
  return `${protocol}:${profile ?? 'default'}`;
}

function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' && value ? value : undefined;
}
