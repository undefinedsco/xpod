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
  const sessionStorage = new Map<string, string>();

  beforeEach(() => {
    cookieValue = '';
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
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          sessionStorage.set(key, value);
        },
        removeItem: (key: string) => {
          sessionStorage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the CSS account token in session storage and cookie', () => {
    storeAccountSessionToken('acct-token-1');

    expect(sessionStorage.get('xpod.cssAccountToken')).toBe('acct-token-1');
    expect(cookieValue).toContain('css-account=acct-token-1');
    expect(getAccountSessionToken()).toBe('acct-token-1');
  });

  it('prefers the cookie and falls back to session storage', () => {
    cookieValue = 'css-account=cookie-token';
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

  it('clears both storage layers on logout', () => {
    storeAccountSessionToken('acct-token-3');
    clearAccountSessionToken();

    expect(sessionStorage.get('xpod.cssAccountToken')).toBeUndefined();
    expect(cookieValue).toContain('css-account=;');
  });
});
