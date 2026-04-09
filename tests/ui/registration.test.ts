import { describe, expect, it } from 'vitest';
import { buildPodCreatePayload } from '../../ui/src/utils/pod';
import { getRegistrationUsernameError, normalizeRegistrationUsername } from '../../ui/src/utils/registration';

describe('registration username helpers', () => {
  it('normalizes username to trimmed lowercase text', () => {
    expect(normalizeRegistrationUsername('  Alice-01  ')).toBe('alice-01');
  });

  it('rejects invalid username characters', () => {
    expect(getRegistrationUsernameError('alice_01')).toBe('Username can only contain lowercase letters, numbers, and hyphens');
  });

  it('accepts lowercase hyphenated usernames', () => {
    expect(getRegistrationUsernameError('alice-01')).toBeUndefined();
  });
});

describe('buildPodCreatePayload', () => {
  it('adds provisionCode settings when provided', () => {
    expect(buildPodCreatePayload('alice', 'pc-123')).toEqual({
      name: 'alice',
      settings: { provisionCode: 'pc-123' },
    });
  });

  it('omits settings when no provisionCode exists', () => {
    expect(buildPodCreatePayload('alice')).toEqual({ name: 'alice' });
  });
});
