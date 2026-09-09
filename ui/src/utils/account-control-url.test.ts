// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { resolveHostedAccountControlUrl, resolveSameOriginAccountControlUrl } from './account-control-url';

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

describe('hosted Account control URL resolver', () => {
  it('accepts controls owned by the discovered managed Account issuer', async () => {
    await expect(resolveHostedAccountControlUrl(
      'https://id.undefineds.co/.account/login/password/',
      vi.fn() as unknown as typeof fetch,
      'https://id.undefineds.co/.account/',
    )).resolves.toBe('https://id.undefineds.co/.account/login/password/');
  });

  it('maps the Cloud-issued public control through the local Gateway route', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      publicUrl: 'https://managed-node.example/',
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveHostedAccountControlUrl(
      'https://managed-node.example/.account/login/password/',
      fetchImpl,
    )).resolves.toBe(`${window.location.origin}/.account/login/password/`);
  });

  it('does not map a control that is not owned by the provisioned Xpod', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      publicUrl: 'https://managed-node.example/',
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveHostedAccountControlUrl(
      'https://untrusted.example/.account/login/password/',
      fetchImpl,
    )).resolves.toBeUndefined();
  });
});
