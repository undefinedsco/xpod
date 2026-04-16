import { describe, expect, it, vi } from 'vitest';
import { buildPodCreatePayload } from '../../ui/src/utils/pod';
import {
  checkRegistrationUsernameAvailability,
  getRegistrationUsernameError,
  makeRegistrationUsernameSuggestions,
  normalizeRegistrationUsername,
} from '../../ui/src/utils/registration';

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

  it('suggests fallback usernames when preferred one is unavailable', () => {
    const suggestions = makeRegistrationUsernameSuggestions('alice');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toEqual([ 'alice-1', 'alice-2', 'alice-3', 'alice-4', 'alice-5' ]);
  });

  it('treats 404 identity lookup as available username', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    await expect(checkRegistrationUsernameAvailability(
      'alice',
      'https://id.example/.account/',
      fetchMock as unknown as typeof fetch,
    )).resolves.toEqual({
      available: true,
      suggestions: [],
    });
  });

  it('returns only checked-available numeric suggestions for taken usernames', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 200, ok: true })
      .mockResolvedValueOnce({ status: 200, ok: true })
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true })
      .mockResolvedValueOnce({ status: 404, ok: false });

    await expect(checkRegistrationUsernameAvailability(
      'alice',
      'https://id.example/.account/',
      fetchMock as unknown as typeof fetch,
    )).resolves.toEqual({
      available: false,
      suggestions: [ 'alice-2', 'alice-3', 'alice-5' ],
    });
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
