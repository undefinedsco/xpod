import { describe, expect, test } from 'bun:test';
import { isPolicyValueDirty } from './form-state';

describe('AI Config form state', () => {
  test('distinguishes reordered objects from actual policy changes', () => {
    expect(isPolicyValueDirty({ enabled: true, backend: 'auto' }, { backend: 'auto', enabled: true })).toBe(false);
    expect(isPolicyValueDirty({ enabled: true }, { enabled: false })).toBe(true);
  });

  test('treats ordered fallback changes as dirty', () => {
    expect(isPolicyValueDirty(['ocr', 'reader'], ['reader', 'ocr'])).toBe(true);
  });
});
