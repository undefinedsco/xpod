import { describe, expect, it } from 'vitest';
import {
  normalizeXpodReturnPath,
  isXpodProductPath,
  XPOD_PRODUCT_ALIASES,
} from '../../../src/shared/xpod-route-policy';

describe('xpod route policy', () => {
  it('normalizes the same safe callback paths accepted by the WebID login route', () => {
    expect(normalizeXpodReturnPath('/dashboard/overview?tab=runtime')).toBe('/dashboard/overview?tab=runtime');
    expect(() => normalizeXpodReturnPath('https://evil.example/')).toThrow(/safe path/i);
    expect(() => normalizeXpodReturnPath('/settings/../models')).toThrow(/safe path/i);
  });

  it('keeps first-class product roots out of legacy alias rewriting', () => {
    expect(XPOD_PRODUCT_ALIASES).toEqual({});
  });

  it('reserves applet pages without swallowing resources in same-named Pods', () => {
    for (const page of ['/tasks', '/pod/models', '/pod/search', '/device/runtime', '/inbox', '/notifications']) {
      expect(isXpodProductPath(page)).toBe(true);
      expect(normalizeXpodReturnPath(`${page}?selected=1`)).toBe(`${page}?selected=1`);
    }
    for (const resource of ['/pod/resource.ttl', '/pod/untrusted.html', '/tasks/notes.ttl', '/device/profile/card', '/inbox/message.ttl']) {
      expect(isXpodProductPath(resource)).toBe(false);
      expect(() => normalizeXpodReturnPath(resource)).toThrow(/allow-list/u);
    }
  });
});
