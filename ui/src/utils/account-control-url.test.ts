// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveSameOriginAccountControlUrl } from './account-control-url';

describe('same-origin Account control URL resolver', () => {
  it('resolves relative and same-origin http(s) controls to the current origin', () => {
    const origin = window.location.origin;

    expect(resolveSameOriginAccountControlUrl('/.account/account/pod/'))
      .toBe(`${origin}/.account/account/pod/`);
    expect(resolveSameOriginAccountControlUrl(`${origin}/.account/account/web-id/`))
      .toBe(`${origin}/.account/account/web-id/`);
  });

  it('rejects cross-origin, non-http, malformed, and userinfo controls', () => {
    const { protocol, host } = window.location;

    expect(resolveSameOriginAccountControlUrl('https://evil.example/.account/account/pod/')).toBeUndefined();
    expect(resolveSameOriginAccountControlUrl('javascript:alert(1)')).toBeUndefined();
    expect(resolveSameOriginAccountControlUrl(`${protocol}//user@${host}/.account/account/pod/`)).toBeUndefined();
    expect(resolveSameOriginAccountControlUrl('http://localhost:3000:bad')).toBeUndefined();
  });
});
