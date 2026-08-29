// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodRememberedLoginBridge } from './XpodRememberedLoginBridge';
import { XpodAuthContext, type XpodAuthValue } from './useXpodAuth';
import {
  XPOD_PENDING_ACCOUNT_EMAIL_KEY,
  XPOD_REMEMBERED_LOGIN_KEY,
  readRememberedXpodLogin,
  rememberPendingXpodAccountEmail,
} from './xpod-remembered-login';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';

vi.mock('../profile/useXpodProfileCardIdentity', () => ({
  useXpodProfileCardIdentity: vi.fn(),
}));

const mockedProfile = vi.mocked(useXpodProfileCardIdentity);

const origin = window.location.origin;
const aliceWebId = `${origin}/alice/profile/card#me`;
const aliceStorage: StorageBinding = {
  webId: aliceWebId,
  storageUrl: `${origin}/alice/`,
};

function runtime(webId: string): XpodSolidRuntimeValue {
  return {
    state: { status: 'authenticated', webId },
    webId,
  } as XpodSolidRuntimeValue;
}

function authValue({
  email,
  identity,
  webId = aliceWebId,
  selectedStorage = aliceStorage,
}: {
  email?: string;
  identity?: XpodAuthValue['account']['identity'];
  webId?: string;
  selectedStorage?: StorageBinding;
} = {}): XpodAuthValue {
  if (email) rememberPendingXpodAccountEmail(email);
  return {
    account: {
      accountState: { status: 'authenticated' },
      isLoggedIn: true,
      identity,
      retry: vi.fn(async () => undefined),
      refetchControls: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    },
    runtime: runtime(webId),
    routes: [],
    webIdState: { status: 'authenticated', webId },
    readiness: { dashboard: true, localSettings: true, podSettings: true },
    selectedStorage,
    startLogin: vi.fn(async () => undefined),
    retryLogin: vi.fn(async () => undefined),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' })),
    retryLogout: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' })),
    logoutState: { status: 'idle', account: 'idle', webId: 'idle' },
    logoutCoordinator: {} as XpodAuthValue['logoutCoordinator'],
    switchAccount: vi.fn(async () => ({ status: 'complete', account: 'complete', webId: 'complete' } as const)),
  };
}

function renderBridge(value: XpodAuthValue) {
  return render(
    <XpodAuthContext.Provider value={value}>
      <XpodRememberedLoginBridge />
    </XpodAuthContext.Provider>,
  );
}

function rememberedRecord(overrides: Record<string, unknown> = {}) {
  const { account: accountValue, ...recordOverrides } = overrides;
  const accountOverrides = accountValue as Record<string, unknown> | undefined;
  return {
    account: {
      email: 'alice@example.test',
      id: 'account-alice',
      username: 'alice',
      displayName: 'Alice',
      ...accountOverrides,
    },
    webId: aliceWebId,
    storageBinding: aliceStorage,
    routeId: 'xpod-current-origin' as const,
    ...recordOverrides,
  };
}

beforeEach(() => {
  mockedProfile.mockReturnValue({
    displayName: 'Alice from Pod',
    username: 'alice',
    avatarUrl: 'blob:http://localhost/alice-avatar',
    avatarSourceUrl: `${origin}/alice/profile/avatar.png`,
    loading: false,
    source: 'webid-profile',
    webId: aliceWebId,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mockedProfile.mockReset();
});

describe('XpodRememberedLoginBridge', () => {
  test('remembers a pure WebID login without opening a separate Account session', async () => {
    const webId = 'https://id.example/alice/profile/card#me';
    const selectedStorage = { webId, storageUrl: 'https://local.nodes.example/alice/' };
    const value = authValue({ webId, selectedStorage });
    value.account.accountState = { status: 'anonymous', mode: 'login' };
    value.account.isLoggedIn = false;
    value.readiness.dashboard = false;
    mockedProfile.mockReturnValue({
      displayName: 'Alice from Pod',
      username: 'alice',
      avatarUrl: 'blob:http://localhost/alice-avatar',
      avatarSourceUrl: 'https://local.nodes.example/alice/avatar.png',
      loading: false,
      source: 'webid-profile',
      webId,
    });

    renderBridge(value);

    await waitFor(() => expect(readRememberedXpodLogin()).toEqual({
      account: {
        displayName: 'Alice from Pod',
        username: 'alice',
        avatarUrl: 'https://local.nodes.example/alice/avatar.png',
      },
      webId,
      storageBinding: selectedStorage,
      routeId: 'xpod-current-origin',
    }));
    expect(value.account.retry).not.toHaveBeenCalled();
    expect(value.account.refetchControls).not.toHaveBeenCalled();
  });

  test('does not remember a WebID before its selected Pod is ready', () => {
    const value = authValue({ email: 'alice@example.test' });
    value.readiness.podSettings = false;
    renderBridge(value);

    expect(readRememberedXpodLogin()).toBeUndefined();
  });

  test('does not remember a selected Pod for another WebID', () => {
    renderBridge(authValue({
      email: 'alice@example.test',
      selectedStorage: { ...aliceStorage, webId: `${origin}/bob/profile/card#me` },
    }));

    expect(readRememberedXpodLogin()).toBeUndefined();
  });

  test('writes a non-sensitive composite record only after Account, WebID, and selected Pod are ready', async () => {
    renderBridge(authValue({
      email: 'alice@example.test',
      identity: { id: 'account-alice', username: 'alice', displayName: 'Alice' },
    }));

    await waitFor(() => {
      expect(readRememberedXpodLogin()).toMatchObject({
        account: {
          email: 'alice@example.test',
          id: 'account-alice',
          username: 'alice',
          displayName: 'Alice from Pod',
          avatarUrl: `${origin}/alice/profile/avatar.png`,
        },
        webId: aliceWebId,
        storageBinding: aliceStorage,
      });
    });

    const raw = window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY);
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain('apiKey');
    expect(window.localStorage.getItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY)).toBeNull();
  });

  test('never overwrites remembered Alice when the active Account, WebID, and Pod belong to Bob', async () => {
    const alice = rememberedRecord();
    const original = JSON.stringify(alice);
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, original);

    const bobWebId = `${origin}/bob/profile/card#me`;
    const bobStorage: StorageBinding = {
      webId: bobWebId,
      storageUrl: `${origin}/bob/`,
    };
    mockedProfile.mockReturnValue({
      displayName: 'Bob from Pod',
      username: 'bob',
      loading: false,
      source: 'webid-profile',
      webId: bobWebId,
    });
    renderBridge(authValue({
      email: 'bob@example.test',
      identity: { id: 'account-bob', username: 'bob', displayName: 'Bob' },
      webId: bobWebId,
      selectedStorage: bobStorage,
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.localStorage.getItem(XPOD_REMEMBERED_LOGIN_KEY)).toBe(original);
    expect(readRememberedXpodLogin()?.account.displayName).toBe('Alice');
    expect(readRememberedXpodLogin()?.webId).toBe(aliceWebId);
  });

  test('refreshes Alice display name when the Account, WebID, and Pod binding match exactly', async () => {
    window.localStorage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify(rememberedRecord({
      account: { displayName: 'Alice (old)' },
    })));

    renderBridge(authValue({
      identity: { id: 'account-alice', username: 'alice', displayName: 'Alice' },
    }));

    await waitFor(() => {
      expect(readRememberedXpodLogin()?.account.displayName).toBe('Alice from Pod');
    });
    expect(readRememberedXpodLogin()?.account.email).toBe('alice@example.test');
    expect(readRememberedXpodLogin()?.storageBinding).toEqual(aliceStorage);
  });
});
