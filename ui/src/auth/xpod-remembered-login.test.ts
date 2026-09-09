// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  XPOD_PENDING_ACCOUNT_EMAIL_KEY,
  XPOD_PENDING_ACCOUNT_ISSUER_KEY,
  XPOD_REMEMBERED_LOGIN_KEY,
  clearRememberedXpodLogin,
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
  rememberedXpodAccountMatchesActive,
  rememberedXpodLoginMatchesActive,
  rememberXpodLogin,
  rememberPendingXpodAccountEmail,
} from './xpod-remembered-login';

const rememberedLogin = {
  account: {
    email: 'alice@example.test',
    displayName: 'Alice Zhang',
    username: 'alice',
  },
  webId: 'https://app.example/alice/profile/card#me',
  storageBinding: {
    webId: 'https://app.example/alice/profile/card#me',
    storageUrl: 'https://app.example/alice/',
  },
  routeId: 'xpod-current-origin',
};

const managedLogin = {
  account: { displayName: 'Alice', username: 'alice' },
  webId: 'https://id.example/alice/profile/card#me',
  storageBinding: {
    webId: 'https://id.example/alice/profile/card#me',
    storageUrl: 'https://local.nodes.example/alice/',
  },
  routeId: 'xpod-current-origin',
};

afterEach(() => {
  window.localStorage.clear();
});

describe('Xpod remembered login storage', () => {
  it('does not carry a remembered Local account into a Cloud Account login', () => {
    rememberPendingXpodAccountEmail('test@dev.local', window.localStorage, 'http://127.0.0.1:3000/');

    expect(readPendingXpodAccountEmail(window.localStorage, 'https://id.undefineds.co/')).toBeUndefined();
    expect(window.localStorage.getItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY)).toBeNull();
    expect(window.localStorage.getItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY)).toBeNull();
  });

  it('persists only the remembered host identity needed for re-authentication', () => {
    window.localStorage.setItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY, 'alice@example.test');
    rememberXpodLogin(rememberedLogin, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeTruthy();
    expect(window.localStorage.getItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY)).toBeNull();
    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toEqual(rememberedLogin);

    const raw = window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY) ?? '';
    expect(raw).toContain('alice@example.test');
    expect(raw).toContain('Alice Zhang');
    expect(raw).toContain('xpod-current-origin');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('account-token');
    expect(raw).not.toContain('refresh_token');
    expect(raw).not.toContain('clientSecret');
  });

  it('keeps a same-origin profile avatar but drops external avatar URLs', () => {
    rememberXpodLogin({
      ...rememberedLogin,
      account: {
        ...rememberedLogin.account,
        avatarUrl: 'https://app.example/alice/profile/avatar.png',
      },
    }, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })?.account.avatarUrl).toBe('https://app.example/alice/profile/avatar.png');

    rememberXpodLogin({
      ...rememberedLogin,
      account: {
        ...rememberedLogin.account,
        avatarUrl: 'https://tracking.example/alice.png',
      },
    }, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })?.account.avatarUrl).toBeUndefined();
  });

  it('falls back to username when display name is absent', () => {
    const remembered = {
      ...rememberedLogin,
      account: {
        email: 'alice@example.test',
        username: 'alice',
      },
    };

    rememberXpodLogin(remembered, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toEqual(remembered);
  });

  it('remembers a verified Cloud WebID and Local Pod without an Account email', () => {
    rememberXpodLogin(managedLogin, { origin: 'http://127.0.0.1:5173' });

    expect(readRememberedXpodLogin({ origin: 'http://127.0.0.1:5173' })).toEqual(managedLogin);
  });

  it.each([
    'https://id.example/alice/profile/avatar.png',
    'https://local.nodes.example/alice/profile/avatar.png',
  ])('remembers the profile avatar from the verified identity or Pod: %s', (avatarUrl) => {
    rememberXpodLogin({ ...managedLogin, account: { ...managedLogin.account, avatarUrl } });

    expect(readRememberedXpodLogin()?.account.avatarUrl).toBe(avatarUrl);
  });

  it.each([
    'https://tracking.example/alice.png',
    'https://user:password@id.example/alice.png',
    'blob:https://id.example/temporary-avatar',
    'javascript:alert(1)',
  ])('does not retain an unsafe or unrelated avatar: %s', (avatarUrl) => {
    rememberXpodLogin({ ...managedLogin, account: { ...managedLogin.account, avatarUrl } });

    const remembered = readRememberedXpodLogin();
    expect(remembered?.webId).toBe(managedLogin.webId);
    expect(remembered?.account.avatarUrl).toBeUndefined();
  });

  it('drops malformed records and credential-bearing storage URLs', () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, '{bad json');
    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toBeUndefined();
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();

    rememberXpodLogin({
      ...rememberedLogin,
      storageBinding: {
        webId: rememberedLogin.webId,
        storageUrl: 'https://user:password@pod.example/alice/',
      },
    }, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toBeUndefined();
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();
  });

  it('drops records whose remembered WebID and storage binding WebID diverge', () => {
    rememberXpodLogin({
      ...rememberedLogin,
      storageBinding: {
        webId: 'https://app.example/bob/profile/card#me',
        storageUrl: 'https://app.example/alice/',
      },
    }, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toBeUndefined();
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();
  });

  it('clears the remembered identity for Use another account', () => {
    rememberXpodLogin(rememberedLogin, {
      origin: 'https://app.example',
      storage: window.localStorage,
    });

    clearRememberedXpodLogin(window.localStorage);

    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBeNull();
    expect(readRememberedXpodLogin({
      origin: 'https://app.example',
      storage: window.localStorage,
    })).toBeUndefined();
  });
});

describe('Xpod remembered login active identity matching', () => {
  it('matches the canonical WebID and Pod across origins without Account data', () => {
    expect(rememberedXpodLoginMatchesActive(managedLogin, {
      webId: managedLogin.webId,
      selectedStorage: managedLogin.storageBinding,
    })).toBe(true);
    expect(rememberedXpodLoginMatchesActive(managedLogin, {
      webId: managedLogin.webId,
      selectedStorage: { ...managedLogin.storageBinding, storageUrl: 'https://other.nodes.example/alice/' },
    })).toBe(false);
  });

  it('matches the active Account, WebID and selected storage after URL normalization', () => {
    expect(rememberedXpodLoginMatchesActive({
      ...rememberedLogin,
      account: {
        ...rememberedLogin.account,
        id: ' account-id ',
        webId: 'https://app.example/alice/profile/card#me',
      },
      storageBinding: {
        webId: rememberedLogin.webId,
        storageUrl: 'https://app.example/alice',
      },
    }, {
      accountIdentity: {
        id: 'account-id',
        username: 'alice',
        webId: 'https://app.example/alice/profile/card#me',
      },
      webId: 'https://app.example/alice/profile/card#me',
      selectedStorage: {
        webId: 'https://app.example/alice/profile/card#me',
        storageUrl: 'https://app.example/alice/#ignored',
      },
    })).toBe(true);
  });

  it('allows missing Account comparison fields when the active WebID and storage match', () => {
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      accountIdentity: {
        displayName: 'Renamed Alice',
      },
      webId: rememberedLogin.webId,
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(true);
  });

  it('rejects missing active WebID or selected storage', () => {
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(false);
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: rememberedLogin.webId,
    })).toBe(false);
  });

  it('rejects mismatched WebID and selected storage pairs', () => {
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: 'https://app.example/bob/profile/card#me',
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(false);
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: rememberedLogin.webId,
      selectedStorage: {
        webId: rememberedLogin.webId,
        storageUrl: 'https://app.example/bob/',
      },
    })).toBe(false);
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: rememberedLogin.webId,
      selectedStorage: {
        webId: 'https://app.example/bob/profile/card#me',
        storageUrl: rememberedLogin.storageBinding.storageUrl,
      },
    })).toBe(false);
  });

  it('does not treat opaque or presentation Account fields as authentication keys', () => {
    expect(rememberedXpodLoginMatchesActive({
      ...rememberedLogin,
      account: { ...rememberedLogin.account, id: 'account-a' },
    }, {
      accountIdentity: { id: 'account-b' },
      webId: rememberedLogin.webId,
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(true);

    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      accountIdentity: { username: 'renamed-alice', displayName: 'Renamed Alice' },
      webId: rememberedLogin.webId,
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(true);

    // Account-control WebID endpoints do not participate in identity
    // matching; the canonical comparison is active WebID + selected Pod.
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      accountIdentity: { webId: 'https://app.example/.account/account/alice/webid/' },
      webId: rememberedLogin.webId,
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(true);
  });

  it('compares the submitted Account email without claiming WebID readiness', () => {
    expect(rememberedXpodAccountMatchesActive(rememberedLogin, {
      accountEmail: ' ALICE@example.test ',
    })).toBe(true);
    expect(rememberedXpodAccountMatchesActive(rememberedLogin, {
      accountEmail: 'bob@example.test',
    })).toBe(false);
  });

  it('rejects active records whose URL fields cannot be normalized to the current origin', () => {
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: 'https://evil.example/alice/profile/card#me',
      selectedStorage: rememberedLogin.storageBinding,
    })).toBe(false);
    expect(rememberedXpodLoginMatchesActive(rememberedLogin, {
      webId: rememberedLogin.webId,
      selectedStorage: {
        webId: rememberedLogin.webId,
        storageUrl: 'https://evil.example/alice/',
      },
    })).toBe(false);
  });
});
