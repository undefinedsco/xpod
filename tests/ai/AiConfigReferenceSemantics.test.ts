import { describe, expect, it } from 'vitest';
import { aiConfigModelRef, aiConfigProviderRef } from '@undefineds.co/models';

describe('AI config reference semantics', () => {
  it('keeps provider and model relations as drizzle link target ids', () => {
    const providerBaseUrl = 'https://cloud.example/accounts/alice/pod/settings/providers/';
    const providerRef = aiConfigProviderRef('openai');
    const modelRef = aiConfigModelRef('openai', 'gpt-4o-mini');

    expect(providerRef).toBe('openai.ttl');
    expect(modelRef).toBe('openai.ttl#gpt-4o-mini');
    expect(providerRef).not.toContain('settings/providers/');
    expect(modelRef).not.toContain('settings/providers/');
    expect(new URL(providerRef, providerBaseUrl).toString())
      .toBe('https://cloud.example/accounts/alice/pod/settings/providers/openai.ttl');
    expect(new URL(modelRef, providerBaseUrl).toString())
      .toBe('https://cloud.example/accounts/alice/pod/settings/providers/openai.ttl#gpt-4o-mini');
  });
});
