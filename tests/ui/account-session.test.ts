import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountTokenHeaders,
  clearAccountSessionToken,
  getAccountSessionToken,
  storeAccountSessionToken,
  storedAccountTokenHeaders,
} from '../../ui/src/utils/account-session';

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

  it('keeps the raw CSS account token out of persistent storage while issuing a persistent cookie', () => {
    storeAccountSessionToken('acct-token-1');

    expect(localStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(sessionStorage.get('xpod.cssAccountToken')).toBe('acct-token-1');
    expect(cookieValue).toContain('css-account=acct-token-1');
    expect(cookieValue).toContain('Max-Age=');
    expect(getAccountSessionToken()).toBe('acct-token-1');
  });

  it('prefers the cookie and falls back only to session storage', () => {
    cookieValue = 'css-account=cookie-token';
    localStorage.set('xpod.cssAccountToken', 'local-token');
    sessionStorage.set('xpod.cssAccountToken', 'session-token');

    expect(getAccountSessionToken()).toBe('cookie-token');

    cookieValue = '';
    expect(getAccountSessionToken()).toBe('session-token');
    expect(cookieValue).toContain('css-account=session-token');
  });

  it('adds the CSS account authorization header without overwriting a caller header', () => {
    expect(accountTokenHeaders('acct-token-2')).toEqual({
      Accept: 'application/json',
      Authorization: 'CSS-Account-Token acct-token-2',
    });

    sessionStorage.set('xpod.cssAccountToken', 'session-token');
    expect(storedAccountTokenHeaders()).toEqual({
      Accept: 'application/json',
      Authorization: 'CSS-Account-Token session-token',
    });

    expect(accountTokenHeaders('acct-token-2', { Authorization: 'Bearer api-key' })).toEqual({
      Authorization: 'Bearer api-key',
    });
  });

  it('ignores malformed cookie values and restores the stored token', () => {
    cookieValue = 'css-account=%E0%A4%A';
    sessionStorage.set('xpod.cssAccountToken', 'session-token');

    expect(getAccountSessionToken()).toBe('session-token');
    expect(cookieValue).toContain('css-account=session-token');
  });

  it('clears session storage, legacy local storage, and cookie on logout', () => {
    storeAccountSessionToken('acct-token-3');
    localStorage.set('xpod.cssAccountToken', 'legacy-local-token');
    clearAccountSessionToken();

    expect(localStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(sessionStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(cookieValue).toContain('css-account=;');
  });
});
