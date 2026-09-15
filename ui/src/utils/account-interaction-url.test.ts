import { describe, expect, it } from 'vitest';
import { accountInteractionBase, scopeAccountUrl } from './account-interaction-url';

describe('Account interaction URL scope', () => {
  const location = new URL('https://id.example/.account/interaction/abc123/login/password/');
  it('keeps ordinary Account navigation unchanged', () => {
    expect(scopeAccountUrl('/.account/login/', new URL('https://id.example/.account/'))).toBe('/.account/login/');
  });
  it('preserves the scope across consent, registration and controls with query strings', () => {
    for (const path of ['oidc/consent/', 'login/password/register/', 'account/']) {
      expect(scopeAccountUrl(`/.account/${path}?test=1`, location)).toBe(`/.account/interaction/abc123/${path}?test=1`);
    }
    expect(scopeAccountUrl('https://id.example/.account/', location)).toBe('https://id.example/.account/interaction/abc123/');
  });
  it('does not rewrite external authorities, non-Account URLs, or another explicit interaction', () => {
    for (const value of ['https://other.example/.account/', '/pod/', '/.oidc/auth/resume-next', '/.account/interaction/second/oidc/consent/']) {
      expect(scopeAccountUrl(value, location)).toBe(value);
    }
  });
  it('derives the scope from the current document, without persisting it', () => {
    expect(accountInteractionBase(location.pathname)).toBe('/.account/interaction/abc123');
    expect(accountInteractionBase('/.account/')).toBe('/.account');
  });
});
