import { describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => {
  const Icon = () => null;
  return {
    AlertCircle: Icon,
    Loader2: Icon,
    Shield: Icon,
  };
});
import {
  fetchOidcCancelRedirectLocation,
  resolveConsentDisplayWebIds,
  resolveOidcCancelUrl,
  resolveOidcCancelRedirectLocation,
} from '../../ui/src/pages/ConsentPage';

describe('ConsentPage WebID display rules', () => {
  it('does not show the issuer current WebID as a Local SP choice when scoped lookup is empty', () => {
    expect(resolveConsentDisplayWebIds(
      [],
      'https://id.undefineds.co/gcloud/profile/card#me',
      true,
    )).toEqual([]);
  });

  it('keeps the issuer current WebID fallback for non-scoped issuer-only consent', () => {
    expect(resolveConsentDisplayWebIds(
      [],
      'https://id.undefineds.co/gcloud/profile/card#me',
      false,
    )).toEqual(['https://id.undefineds.co/gcloud/profile/card#me']);
  });

  it('prefers scoped SP WebIDs when the selected storage provider has matching Pods', () => {
    expect(resolveConsentDisplayWebIds(
      ['https://id.undefineds.co/glocal/profile/card#me'],
      'https://id.undefineds.co/gcloud/profile/card#me',
      true,
    )).toEqual(['https://id.undefineds.co/glocal/profile/card#me']);
  });
});

describe('ConsentPage OIDC cancel redirect rules', () => {
  it('uses the cancel URL from account controls before falling back to the IDP index', () => {
    expect(resolveOidcCancelUrl({
      oidc: { cancel: '/custom/oidc/cancel' },
    }, '/.account/')).toBe('/custom/oidc/cancel');
    expect(resolveOidcCancelUrl(null, '/.account/')).toBe('/.account/oidc/cancel');
  });

  it('uses the cancel response body location', async () => {
    await expect(resolveOidcCancelRedirectLocation(new Response(JSON.stringify({
      location: 'http://127.0.0.1:1234/auth/callback?error=access_denied',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))).resolves.toBe('http://127.0.0.1:1234/auth/callback?error=access_denied');
  });

  it('falls back to the cancel response Location header', async () => {
    await expect(resolveOidcCancelRedirectLocation(new Response(JSON.stringify({}), {
      status: 200,
      headers: { Location: 'http://127.0.0.1:1234/auth/callback?error=access_denied' },
    }))).resolves.toBe('http://127.0.0.1:1234/auth/callback?error=access_denied');
  });

  it('rejects successful cancel responses without a redirect', async () => {
    await expect(resolveOidcCancelRedirectLocation(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))).rejects.toThrow(/did not return a redirect URL/);
  });

  it('surfaces server cancel errors instead of leaving the page pending', async () => {
    await expect(resolveOidcCancelRedirectLocation(new Response(JSON.stringify({
      message: 'Only interactions with a valid session are allowed',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }))).rejects.toThrow(/Only interactions with a valid session/);
  });

  it('times out a stuck cancel request', async () => {
    await expect(fetchOidcCancelRedirectLocation({
      cancelUrl: '/.account/oidc/cancel',
      timeoutMs: 1,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    })).rejects.toThrow(/timed out/);
  });
});
