import { describe, expect, it } from 'vitest';
import {
  normalizeXpodReturnPath,
  resolveXpodAliasTarget,
} from '../../../src/shared/xpod-route-policy';

describe('xpod route policy', () => {
  it('normalizes the same safe callback paths accepted by the WebID login route', () => {
    expect(normalizeXpodReturnPath('/dashboard/overview?tab=runtime')).toBe('/dashboard/overview?tab=runtime');
    expect(() => normalizeXpodReturnPath('https://evil.example/')).toThrow(/safe path/i);
    expect(() => normalizeXpodReturnPath('/settings/../models')).toThrow(/safe path/i);
  });

  it('canonicalizes aliases without copying fragments or allowing an absolute target', () => {
    expect(resolveXpodAliasTarget('/ai-config', '/ai-config?provider=kimi&surface=other#pane'))
      .toBe('/settings/models?surface=ai-config&provider=kimi');
    expect(resolveXpodAliasTarget('/status', '/status?tab=runtime#pane'))
      .toBe('/dashboard/overview?tab=runtime');
  });
});
