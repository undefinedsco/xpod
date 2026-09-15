import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieJar, JSDOM } from 'jsdom';
import {
  bindAccountSessionAuthority,
  accountTokenHeaders,
  clearAccountSessionToken,
  getAccountSessionToken,
  storeAccountSessionToken,
  storedAccountTokenHeaders,
} from '../../ui/src/utils/account-session';

describe('server-owned account cookie lifetime', () => {
  const url = 'https://id.example/.account/';
  let dom: JSDOM;
  let cookieJar: CookieJar;

  function reloadDocument() {
    dom?.window.close();
    dom = new JSDOM('', { url, cookieJar });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
  }

  function accountCookie() {
    return cookieJar.getCookiesSync(url).find((cookie) => cookie.key === 'css-account');
  }

  beforeEach(() => {
    cookieJar = new CookieJar();
    reloadDocument();
  });

  afterEach(() => {
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('preserves the server remember=true expiry through login synchronization and reload', () => {
    const serverExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toUTCString();
    cookieJar.setCookieSync(`css-account=remembered-account; Path=/; Secure; SameSite=Strict; Expires=${serverExpiry}`, url);

    storeAccountSessionToken('remembered-account');
    reloadDocument();
    // Re-synchronizing the same account must not rewrite cookie attributes.
    storeAccountSessionToken('remembered-account');

    expect(getAccountSessionToken()).toBe('remembered-account');
    expect(accountCookie()?.expires).toEqual(new Date(serverExpiry));
    expect(accountCookie()?.secure).toBe(true);
    expect(accountCookie()?.sameSite).toBe('strict');
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
  });

  it('does not upgrade the server remember=false session cookie to persistent storage', () => {
    cookieJar.setCookieSync('css-account=session-account; Path=/; SameSite=Lax', url);
    storeAccountSessionToken('session-account');
    reloadDocument();
    storeAccountSessionToken('session-account');

    expect(getAccountSessionToken()).toBe('session-account');
    expect(accountCookie()?.expires).toBe('Infinity');
  });

  it('keeps the JSON-token compatibility path session-only when no server cookie is available', () => {
    storeAccountSessionToken('json-account-token');

    expect(getAccountSessionToken()).toBe('json-account-token');
    expect(accountCookie()?.expires).toBe('Infinity');
    expect(storedAccountTokenHeaders().Authorization).toBe('CSS-Account-Token json-account-token');
  });

  it('does not inherit the previous account expiry when replacing a compatibility token', () => {
    const serverExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toUTCString();
    cookieJar.setCookieSync(`css-account=old-account; Path=/; Expires=${serverExpiry}`, url);
    storeAccountSessionToken('new-account');

    expect(getAccountSessionToken()).toBe('new-account');
    expect(accountCookie()?.expires).toBe('Infinity');
  });

  it('does not resurrect an expired cookie from public account hints or legacy token copies', () => {
    cookieJar.setCookieSync('css-account=expired-account; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', url);
    window.localStorage.setItem('xpod.cssAccountToken', 'obsolete-token');
    window.sessionStorage.setItem('xpod.cssAccountToken', 'obsolete-token');
    window.localStorage.setItem('xpod.remembered-login.v1', JSON.stringify({
      account: { email: 'alice@example.test', displayName: 'Alice' },
      webId: 'https://id.example/alice/profile/card#me',
    }));

    storeAccountSessionToken(undefined);

    expect(accountCookie()).toBeUndefined();
    expect(getAccountSessionToken()).toBeUndefined();
    expect(storedAccountTokenHeaders().Authorization).toBeUndefined();
  });

  it.each([undefined, ''])('leaves the server remembered cookie intact for absent synchronization input %s', (token) => {
    const expiry = new Date(Date.now() + 86400_000).toUTCString();
    cookieJar.setCookieSync(`css-account=remembered-account; Path=/; Secure; SameSite=Strict; Expires=${expiry}`, url);

    storeAccountSessionToken(token);

    expect(getAccountSessionToken()).toBe('remembered-account');
    expect(accountCookie()?.expires).toEqual(new Date(expiry));
    expect(accountCookie()?.sameSite).toBe('strict');
  });

  it('clears the previous authority bridge before accepting a new authority', () => {
    bindAccountSessionAuthority('https://cloud-a.example/.account/');
    storeAccountSessionToken('cloud-a-token');
    expect(bindAccountSessionAuthority('https://cloud-b.example/.account/')).toBe(true);
    expect(getAccountSessionToken()).toBeUndefined();
    expect(storedAccountTokenHeaders(undefined, 'https://cloud-b.example/.account/').Authorization).toBeUndefined();
    storeAccountSessionToken('cloud-b-token');
    expect(storedAccountTokenHeaders(undefined, 'https://cloud-a.example/.account/').Authorization).toBeUndefined();
    expect(storedAccountTokenHeaders(undefined, 'https://cloud-b.example/.account/').Authorization).toContain('cloud-b-token');
  });

  it('preserves same-authority remembered cookie attributes and rejects an unscoped cookie for a foreign authority', () => {
    const serverExpiry = new Date(Date.now() + 86400_000).toUTCString();
    cookieJar.setCookieSync(`css-account=remembered-account; Path=/; Secure; SameSite=Strict; Expires=${serverExpiry}`, url);
    expect(bindAccountSessionAuthority(url)).toBe(false);
    expect(bindAccountSessionAuthority(url)).toBe(false);
    expect(accountCookie()?.expires).toEqual(new Date(serverExpiry));
    expect(accountCookie()?.sameSite).toBe('strict');
    window.localStorage.removeItem('xpod.cssAccountAuthority');
    expect(bindAccountSessionAuthority('https://foreign.example/.account/')).toBe(true);
    expect(getAccountSessionToken()).toBeUndefined();
  });

  it('clears a remembered server cookie on logout and does not restore it on reload', () => {
    const serverExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toUTCString();
    cookieJar.setCookieSync(`css-account=remembered-account; Path=/; Expires=${serverExpiry}`, url);
    window.localStorage.setItem('xpod.cssAccountToken', 'legacy-token');
    window.sessionStorage.setItem('xpod.cssAccountToken', 'legacy-token');

    clearAccountSessionToken();

    expect(accountCookie()).toBeUndefined();
    expect(window.localStorage.getItem('xpod.cssAccountToken')).toBeNull();
    expect(window.sessionStorage.getItem('xpod.cssAccountToken')).toBeNull();
    reloadDocument();
    expect(getAccountSessionToken()).toBeUndefined();
  });
});

describe('account session helpers', () => {
  let cookieValue = '';
  const localStorage = new Map<string, string>();
  const sessionStorage = new Map<string, string>();

  beforeEach(() => {
    cookieValue = '';
    localStorage.clear();
    sessionStorage.clear();

    const documentStub = {};
    Object.defineProperty(documentStub, 'cookie', {
      get: () => cookieValue,
      set: (value: string) => {
        cookieValue = value;
      },
      configurable: true,
    });

    vi.stubGlobal('document', documentStub as Document);
    const localStorageStub = {
      getItem: (key: string) => localStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorage.set(key, value);
      },
      removeItem: (key: string) => {
        localStorage.delete(key);
      },
    };
    const sessionStorageStub = {
      getItem: (key: string) => sessionStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorage.set(key, value);
      },
      removeItem: (key: string) => {
        sessionStorage.delete(key);
      },
    };

    vi.stubGlobal('window', {
      localStorage: localStorageStub,
      sessionStorage: sessionStorageStub,
    });
    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('sessionStorage', sessionStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the raw CSS account token only in the browser session cookie', () => {
    storeAccountSessionToken('acct-token-1');

    expect(localStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(sessionStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(cookieValue).toContain('css-account=acct-token-1');
    expect(cookieValue).not.toContain('Max-Age=');
    expect(getAccountSessionToken()).toBe('acct-token-1');
  });

  it('uses only the CSS account cookie as the authorization source', () => {
    cookieValue = 'css-account=cookie-token';
    localStorage.set('xpod.cssAccountToken', 'local-token');
    sessionStorage.set('xpod.cssAccountToken', 'session-token');

    expect(getAccountSessionToken()).toBe('cookie-token');

    cookieValue = '';
    expect(getAccountSessionToken()).toBeUndefined();
    expect(cookieValue).toBe('');
  });

  it('adds the CSS account authorization header without overwriting a caller header', () => {
    expect(accountTokenHeaders('acct-token-2')).toEqual({
      Accept: 'application/json',
      Authorization: 'CSS-Account-Token acct-token-2',
    });

    cookieValue = 'css-account=cookie-token';
    expect(storedAccountTokenHeaders()).toEqual({
      Accept: 'application/json',
      Authorization: 'CSS-Account-Token cookie-token',
    });

    expect(accountTokenHeaders('acct-token-2', { Authorization: 'Bearer api-key' })).toEqual({
      Authorization: 'Bearer api-key',
    });
  });

  it('ignores malformed cookie values without restoring a remembered token', () => {
    cookieValue = 'css-account=%E0%A4%A';
    sessionStorage.set('xpod.cssAccountToken', 'session-token');

    expect(getAccountSessionToken()).toBeUndefined();
    expect(cookieValue).toBe('css-account=%E0%A4%A');
  });

  it('clears legacy storage and the session cookie on logout', () => {
    storeAccountSessionToken('acct-token-3');
    sessionStorage.set('xpod.cssAccountToken', 'legacy-session-token');
    localStorage.set('xpod.cssAccountToken', 'legacy-local-token');
    clearAccountSessionToken();

    expect(localStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(sessionStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(cookieValue).toContain('css-account=;');
  });
});
