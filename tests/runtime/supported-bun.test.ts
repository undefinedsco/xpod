import { describe, expect, it } from 'vitest';
import { ensureSupportedBun } from '../../src/runtime/compat/ensureSupportedBun';

describe('supported Bun service runtime', () => {
  it.each(['1.3.8', '1.3.12', '1.3.14', '1.4.1', '1.4.2-canary.1', 'invalid'])('rejects unsupported Bun %s before starting services', (version) => {
    expect(() => ensureSupportedBun(version)).toThrow(/requires Bun >=1\.4\.2.*WebSocket shutdown/u);
  });
  it.each(['1.4.2', '1.4.2+build', '1.4.3', '1.5.0', '2.0.0'])('accepts supported Bun %s', (version) => {
    expect(() => ensureSupportedBun(version)).not.toThrow();
  });
  it('preserves the Node compatibility runtime', () => {
    expect(() => ensureSupportedBun(undefined)).not.toThrow();
  });
});
