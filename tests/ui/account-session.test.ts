import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieJar, JSDOM } from 'jsdom';
import {
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
