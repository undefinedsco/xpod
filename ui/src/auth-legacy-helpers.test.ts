import { describe, expect, test, vi } from 'vitest';

const mock = vi.fn;
import { JSDOM } from 'jsdom';
import { shouldRedirectToConsent } from './components/ProtectedRoute.utils';
import {
  fetchOidcCancelRedirectLocation,
  resolveConsentDisplayWebIds,
  resolveOidcCancelUrl,
} from './pages/ConsentPage.utils';
import { consumeReturnTo, getReturnToFromLocation, persistReturnTo } from './utils/returnTo';
import { bootstrapAccountPasswordLogin, RegistrationError } from './utils/registration-flow';

function installDom(url = 'https://id.example/.account/login/password/') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.sessionStorage = dom.window.sessionStorage;
}

describe('legacy auth helper behavior', () => {
  test('redirects logged-in users with pending OIDC consent unless explicitly allowed', () => {
    expect(shouldRedirectToConsent(true, true)).toBe(true);
    expect(shouldRedirectToConsent(true, true, true)).toBe(false);
    expect(shouldRedirectToConsent(false, true)).toBe(false);
    expect(shouldRedirectToConsent(true, false)).toBe(false);
  });

  test('accepts only Dashboard and Settings return paths and keeps storage consumable', () => {
    installDom('https://id.example/.account/login/password/?returnTo=%2Fsettings%2Fmodels');

    expect(getReturnToFromLocation()).toBe('/settings/models');
    persistReturnTo('/settings/models');
    expect(consumeReturnTo()).toBe('/settings/models');
    expect(consumeReturnTo()).toBeNull();

    installDom('https://id.example/.account/login/password/?returnTo=%2Fdashboard%2Foverview');
    expect(getReturnToFromLocation()).toBe('/dashboard/overview');
    installDom('https://id.example/.account/login/password/?returnTo=https%3A%2F%2Fevil.example%2Fsteal');
    expect(getReturnToFromLocation()).toBeNull();
  });

  test('fails closed for provision-scoped consent without scoped WebIDs', () => {
    expect(resolveConsentDisplayWebIds([], 'https://id.example/alice/profile/card#me', true)).toEqual([]);
    expect(resolveConsentDisplayWebIds([], 'https://id.example/alice/profile/card#me', false)).toEqual([
      'https://id.example/alice/profile/card#me',
    ]);
    expect(resolveConsentDisplayWebIds(['https://id.example/alice/profile/card#me'], null, true)).toEqual([
      'https://id.example/alice/profile/card#me',
    ]);
  });

  test('uses configured OIDC cancel endpoint and resolves redirect locations', async () => {
    installDom();

    expect(resolveOidcCancelUrl({ oidc: { cancel: '/custom-cancel' } }, '/.account/')).toBe('/custom-cancel');
    expect(resolveOidcCancelUrl(null, '/.account/')).toBe('/.account/oidc/cancel');

    const fetchImpl = mock(async () => new Response(JSON.stringify({ location: '/after-cancel' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    await expect(fetchOidcCancelRedirectLocation({
      cancelUrl: '/.account/oidc/cancel',
      fetchImpl,
      timeoutMs: 0,
    })).resolves.toBe('/after-cancel');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('classifies duplicate-email registration bootstrap failures', async () => {
    installDom();

    const fetchImpl = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/')) {
        return new Response(JSON.stringify({ authorization: 'account-token' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      if (url.endsWith('/.account/')) {
        return new Response(JSON.stringify({
          controls: {
            password: {
              create: '/password/create',
              login: '/password/login',
            },
          },
        }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        });
      }
      return new Response(JSON.stringify({
        message: 'There already is a login for this e-mail address.',
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 409,
      });
    });

    await expect(bootstrapAccountPasswordLogin({
      accountCreateUrl: '/account/',
      email: 'alice@example.test',
      idpIndex: '/.account/',
      password: 'secret',
      fetchImpl,
    })).rejects.toMatchObject({
      name: 'RegistrationError',
      code: 'EMAIL_ALREADY_REGISTERED',
    } satisfies Partial<RegistrationError>);
  });
});
