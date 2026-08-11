import { describe, expect, it } from 'vitest';
import {
  normalizeXpodReturnPath,
  resolveXpodAliasTarget,
  XPOD_PRODUCT_ALIASES,
} from '../../../src/shared/xpod-route-policy';

describe('xpod route policy', () => {
  it('normalizes the same safe callback paths accepted by the WebID login route', () => {
    expect(normalizeXpodReturnPath('/dashboard/overview?tab=runtime')).toBe('/dashboard/overview?tab=runtime');
    expect(() => normalizeXpodReturnPath('https://evil.example/')).toThrow(/safe path/i);
    expect(() => normalizeXpodReturnPath('/settings/../models')).toThrow(/safe path/i);
  });

  it('keeps only genuine legacy dashboard aliases and never rewrites first-class AI surfaces', () => {
    expect(XPOD_PRODUCT_ALIASES).toEqual({
      '/status': '/dashboard/overview',
      '/network': '/dashboard/network',
    });
    expect(resolveXpodAliasTarget('/status', '/status?tab=runtime#pane'))
      .toBe('/dashboard/overview?tab=runtime');
  });
});
