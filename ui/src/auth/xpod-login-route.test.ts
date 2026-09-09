import { describe, expect, test } from 'vitest';
import {
  normalizeXpodReturnPath,
  XPOD_RETURN_PATH_PREFIXES,
} from '../../../src/shared/xpod-route-policy';
import {
  normalizeXpodReturnTo,
  XPOD_LOGIN_RETURN_PREFIXES,
} from './xpod-login-route';

describe('Xpod return-path policy', () => {
  test('uses the shared allow-list and normalization implementation in the callback', () => {
    expect(XPOD_LOGIN_RETURN_PREFIXES).toBe(XPOD_RETURN_PATH_PREFIXES);

    for (const path of [
      '/dashboard/overview?tab=runtime',
      '/settings/models?surface=ai-config',
      '/ai-connections?surface=ai-connections',
    ]) {
      expect(normalizeXpodReturnTo(path)).toBe(normalizeXpodReturnPath(path));
    }
  });

  test('applies the same rejection policy at the callback boundary', () => {
    for (const path of ['https://evil.example/', '/settings/../models', '/%2f%2fevil.example']) {
      expect(() => normalizeXpodReturnTo(path)).toThrow();
      expect(() => normalizeXpodReturnPath(path)).toThrow();
    }
  });
});
