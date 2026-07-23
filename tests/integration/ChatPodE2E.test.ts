import { describe, it, expect } from 'vitest';

const RUN_GATEWAY_E2E = process.env.XPOD_RUN_AI_GATEWAY_E2E === 'true';
const suite = RUN_GATEWAY_E2E ? describe : describe.skip;

suite('Chat Pod E2E Integration (AI Connection)', () => {
  it('requires an AI Connection Gateway-key based harness instead of legacy provider env fallback', () => {
    expect(process.env.DEFAULT_API_KEY).toBeUndefined();
    expect(process.env.DEFAULT_API_BASE).toBeUndefined();
  });
});
