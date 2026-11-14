import { describe, expect, it } from 'vitest';
import { parseGatewayModelList } from '../../../src/api/ai-gateway/models/GatewayModelProjection';

describe('Gateway public model projection', () => {
  it('preserves declared metadata and strips arbitrary nested and top-level fields', () => {
    const models = parseGatewayModelList({ data: [{
      id: 'model', owned_by: 'upstream', display_name: ' Model ', context_window: 128_000,
      capabilities: { toolCalls: true, imageInput: false, embedding: false, fast: 'yes', secret: 'do-not-return' },
      protocols: ['chatCompletions', 'responses', 'anthropic', 'secret-protocol', 42],
      modalities: { input: ['text', 42], output: ['image'], secret: 'do-not-return' },
      custom: true, custom_capabilities: ['reasoning', 42], secret: 'do-not-return', metadata: { apiKey: 'do-not-return' },
    }] });
    expect(models).toEqual([{
      id: 'model', object: 'model', owned_by: 'upstream', display_name: 'Model', context_window: 128_000,
      capabilities: { toolCalls: true, imageInput: false, embedding: false },
      protocols: ['chatCompletions', 'responses', 'anthropic'],
      modalities: { input: ['text'], output: ['image'] }, custom: true, custom_capabilities: ['reasoning'],
    }]);
  });

  it('deduplicates model identities, binds platform ownership, and leaves absent or invalid capabilities unknown', () => {
    expect(parseGatewayModelList({ data: [null, [], {}, { id: ' x ', context_window: -1, capabilities: { toolCalls: 'true' } }, { id: 'x' }, { id: 'X' }] }, { ownerOverride: 'platform-undefineds' }))
      .toEqual([{ id: 'x', object: 'model', owned_by: 'platform-undefineds' }, { id: 'X', object: 'model', owned_by: 'platform-undefineds' }]);
    expect(parseGatewayModelList({ data: [{ id: 'x', context_window: Number.POSITIVE_INFINITY }] }, { fallbackOwner: 'cloud' }))
      .toEqual([{ id: 'x', object: 'model', owned_by: 'cloud' }]);
    expect(parseGatewayModelList({ error: 'not a model list' })).toEqual([]);
  });
});
