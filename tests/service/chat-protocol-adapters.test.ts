import { describe, expect, it } from 'vitest';

import {
  buildChatCompletionsBodyFromMessages,
  sanitizeAiGatewayResponsesBody,
} from '../../src/api/service/chat-protocol-adapters';

describe('chat protocol adapters', () => {
  it('does not synthesize optional fields when they are absent', () => {
    const body = sanitizeAiGatewayResponsesBody({
      model: 'linx-lite',
      input: 'hello',
    });

    expect(body).toEqual({
      model: 'linx-lite',
      input: 'hello',
    });
    expect(Object.hasOwn(body, 'vector_store_ids')).toBe(false);
  });

  it('drops vector_store_ids only at the current ai-gateway responses boundary', () => {
    const body = sanitizeAiGatewayResponsesBody({
      model: 'linx-lite',
      input: 'hello',
      vector_store_ids: ['vs_123'],
    });

    expect(body).toEqual({
      model: 'linx-lite',
      input: 'hello',
    });
  });

  it('preserves explicit empty optional fields when converting supported messages fields', () => {
    const body = buildChatCompletionsBodyFromMessages({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello' }],
      stop_sequences: [],
    });

    expect(body).toEqual({
      model: 'linx-lite',
      messages: [{ role: 'user', content: 'hello' }],
    });
  });
});
