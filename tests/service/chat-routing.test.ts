import { describe, expect, it, vi } from 'vitest';

import {
  resolveChatExecutionRoute,
  resolveMessagesProviderRoute,
  resolveResponsesProviderRoute,
} from '../../src/api/service/chat-routing';

describe('chat routing', () => {
  it('routes platform models to ai-gateway when the model is recognized there', async () => {
    const shouldUseAiGateway = vi.fn().mockResolvedValue(true);

    await expect(resolveChatExecutionRoute({
      model: 'linx-lite',
      shouldUseAiGateway,
    })).resolves.toBe('ai-gateway');
    expect(shouldUseAiGateway).toHaveBeenCalledWith('linx-lite');
  });

  it('routes unknown models to provider execution when ai-gateway does not claim them', async () => {
    const shouldUseAiGateway = vi.fn().mockResolvedValue(false);

    await expect(resolveChatExecutionRoute({
      model: 'gpt-4o-mini',
      shouldUseAiGateway,
    })).resolves.toBe('provider');
  });

  it('uses chat fallback when the provider does not support responses', () => {
    expect(resolveResponsesProviderRoute('https://api.mistral.ai/v1')).toBe('chat-fallback');
    expect(resolveResponsesProviderRoute('https://api.openai.com/v1')).toBe('native');
  });

  it('uses chat fallback when the provider does not support messages', () => {
    expect(resolveMessagesProviderRoute('https://api.openai.com/v1')).toBe('chat-fallback');
    expect(resolveMessagesProviderRoute('https://api.anthropic.com/v1')).toBe('native');
  });
});
