import { describe, expect, it } from 'vitest';
import {
  CUSTOM_DEFAULT_OFFERINGS,
  DEFAULT_PROVIDER_OFFERINGS,
  PROVIDER_OFFERINGS,
} from '@undefineds.co/ai-connections/provider-catalog';
import { DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

/**
 * The server projects its product catalog from @undefineds.co/ai-connections, so
 * "the two agree" is true by construction and worth nothing as a test. What can
 * still break silently is the wiring around that projection: a catalog provider
 * or offering that never reaches the published products, or a runtime capability
 * override that stops applying because its offering was renamed.
 */
function catalogOfferings(providerId: string): typeof DEFAULT_PROVIDER_OFFERINGS {
  if (providerId === 'custom') return CUSTOM_DEFAULT_OFFERINGS;
  return (PROVIDER_OFFERINGS as Record<string, typeof DEFAULT_PROVIDER_OFFERINGS>)[providerId]
    ?? DEFAULT_PROVIDER_OFFERINGS;
}

function publishedOffering(providerId: string, offeringId: string) {
  const product = DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.find((candidate) => candidate.id === providerId);
  if (!product) throw new Error(`provider ${providerId} is missing from the published catalog`);
  const offering = product.offerings.find((candidate) => candidate.id === offeringId);
  if (!offering) throw new Error(`offering ${providerId}/${offeringId} is missing from the published catalog`);
  return offering;
}

describe('provider catalog wiring', () => {
  it('publishes every catalog provider', () => {
    const expected = [ ...Object.keys(PROVIDER_OFFERINGS), 'custom' ].sort();
    const published = DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS.map((product) => product.id).sort();
    expect(published).toEqual(expected);
  });

  it('publishes every catalog offering of every provider', () => {
    for (const product of DEFAULT_PROVIDER_PRODUCT_DESCRIPTORS) {
      expect({
        provider: product.id,
        offerings: product.offerings.map((offering) => offering.id),
      }).toEqual({
        provider: product.id,
        offerings: catalogOfferings(product.id).map((offering) => offering.id),
      });
    }
  });

  it('keeps runtime capability overrides attached to the offerings they describe', () => {
    const protocols = (providerId: string, offeringId: string): string[] =>
      publishedOffering(providerId, offeringId).upstream.map((capability) => capability.protocol);

    // Renaming an offering in the shared catalog would detach these overrides
    // without any other symptom.
    expect(protocols('openai', 'official-subscription')).toEqual([ 'codex-models', 'rolling-quota-windows' ]);
    expect(protocols('anthropic', 'official-subscription')).toEqual([ 'rolling-quota-windows' ]);
    expect(protocols('kimi', 'subscription-key')).toEqual([ 'openai-models', 'chatCompletions', 'anthropic', 'rolling-quota-windows' ]);
    expect(protocols('kimi', 'api-platform')).toEqual([ 'openai-models', 'chatCompletions', 'api-balance' ]);
    expect(protocols('deepseek', 'api-platform')).toEqual([ 'openai-models', 'chatCompletions', 'api-balance' ]);
  });

  it('derives an inference capability from every catalog endpoint', () => {
    // An offering without a capability override must publish one inference route
    // per declared endpoint, otherwise the projected endpoints route nowhere.
    expect(publishedOffering('openai', 'api-platform').upstream).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'inference',
        protocol: 'responses',
        options: { baseUrl: 'https://api.openai.com/v1' },
      }),
      expect.objectContaining({
        capability: 'inference',
        protocol: 'chatCompletions',
        options: { baseUrl: 'https://api.openai.com/v1' },
      }),
    ]));
  });

  it('keeps the developer-message restriction on the Kimi coding endpoint', () => {
    expect(publishedOffering('kimi', 'subscription-key').endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: 'chatCompletions', region: 'cn', supportsDeveloperMessages: false }),
    ]));
  });
});
