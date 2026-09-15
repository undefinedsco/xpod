// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { consumeAccountContinuation, consumeReturnTo, persistReturnTo } from './returnTo';

afterEach(() => sessionStorage.clear());

describe('Account registration continuation', () => {
  it('returns a preflight registration to its application instead of the default dashboard', () => {
    persistReturnTo('/ai-connections?tab=providers');
    expect(consumeAccountContinuation(false, '/.account/create-pod/')).toBe('/ai-connections?tab=providers');
    expect(consumeReturnTo()).toBeNull();
  });
  it('gives an existing OIDC interaction priority without consuming the application destination', () => {
    persistReturnTo('/ai-connections');
    expect(consumeAccountContinuation(true, '/.account/account/')).toBe('/.account/oidc/consent/');
    expect(consumeReturnTo()).toBe('/ai-connections');
  });
  it('keeps independent account registration on its default', () => {
    expect(consumeAccountContinuation(false, '/.account/create-pod/')).toBe('/.account/create-pod/');
  });
});
