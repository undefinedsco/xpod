import { describe, expect, it } from 'vitest';

import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';

describe('ProviderRuntimeRegistry', () => {
  it('does not cache adapters for mutable custom provider endpoints', () => {
    const providers = createDefaultProviderRegistry();
    const firstDescriptor = {
      id: 'timecc',
      label: 'timecc',
      authModes: ['apiKey'],
      protocols: ['chatCompletions'],
      defaultBaseUrl: 'https://timicc.example/v1',
      safeBaseUrls: ['https://timicc.example/v1'],
      capabilities: {},
      models: [{ id: 'linx-lite' }],
    } as const;
    const runtimes = new ProviderRuntimeRegistry({ registry: providers });

    const first = runtimes.get('timecc', firstDescriptor);
    const refreshedDescriptor = {
      ...firstDescriptor,
      defaultBaseUrl: 'https://timicc.example',
      safeBaseUrls: ['https://timicc.example'],
    };

    expect(runtimes.get('timecc', refreshedDescriptor)).not.toBe(first);
    expect(providers.getProvider('timecc')).toBeUndefined();
  });
});
