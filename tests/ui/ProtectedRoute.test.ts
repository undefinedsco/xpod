import { describe, expect, it } from 'vitest';
import { shouldRedirectToConsent } from '../../ui/src/components/ProtectedRoute';

describe('shouldRedirectToConsent', () => {
  it('redirects when logged in and oidc consent is pending', () => {
    expect(shouldRedirectToConsent(true, true)).toBe(true);
  });

  it('allows account page when oidc pending is explicitly allowed', () => {
    expect(shouldRedirectToConsent(true, true, true)).toBe(false);
  });

  it('does not redirect anonymous users', () => {
    expect(shouldRedirectToConsent(false, true)).toBe(false);
  });
});
