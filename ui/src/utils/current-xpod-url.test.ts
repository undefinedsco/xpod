import { describe, expect, it } from 'vitest';
import { requireCurrentXpodUrl, resolveCurrentXpodUrl } from './current-xpod-url';

describe('current Xpod URL policy', () => {
  const origin = 'https://xpod.example';

  it('accepts relative and absolute URLs only on the current Xpod origin', () => {
    expect(resolveCurrentXpodUrl('/alice/profile/card#me', origin))
      .toBe('https://xpod.example/alice/profile/card#me');
    expect(resolveCurrentXpodUrl('https://xpod.example/alice/', origin))
      .toBe('https://xpod.example/alice/');
    expect(resolveCurrentXpodUrl('https://other.example/alice/', origin)).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'https://user:secret@xpod.example/alice/',
    'not a URL',
  ])('rejects unsafe current-Xpod candidates: %s', (value) => {
    expect(resolveCurrentXpodUrl(value, origin)).toBeUndefined();
    expect(() => requireCurrentXpodUrl(value, origin)).toThrow('current Xpod origin');
  });
});
