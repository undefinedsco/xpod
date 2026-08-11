import { describe, expect, test, vi } from 'vitest';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import {
  getXpodRouteReadiness,
  createXpodAuthValue,
  type XpodAuthAccountSource,
} from './XpodAuthProvider';

const binding: StorageBinding = {
  storageUrl: 'https://app.example/alice/',
  webId: 'https://app.example/alice/profile/card#me',
};

function account(overrides: Partial<XpodAuthAccountSource> = {}): XpodAuthAccountSource {
  return {
    accountState: { status: 'anonymous', mode: 'login' },
    isLoggedIn: false,
    identity: undefined,
    retry: vi.fn(async () => undefined),
    refetchControls: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('XpodAuthProvider policy', () => {
  test('dashboard readiness follows Account only, while Pod-backed Settings needs WebID and exact binding', () => {
    expect(getXpodRouteReadiness({ account: account({ isLoggedIn: true, accountState: { status: 'authenticated' } }), solidState: { status: 'anonymous' } })).toEqual({
      dashboard: true,
      localSettings: true,
      podSettings: false,
    });
    expect(getXpodRouteReadiness({ account: account(), solidState: { status: 'authenticated', webId: binding.webId }, selectedStorage: binding })).toEqual({
      dashboard: false,
      localSettings: true,
      podSettings: true,
    });
    expect(getXpodRouteReadiness({ account: account(), solidState: { status: 'authenticated', webId: binding.webId } })).toEqual({
      dashboard: false,
      localSettings: true,
      podSettings: false,
    });
  });

  test('stale authenticated WebID is logged out before the one local transaction starts', async () => {
    let webIdStatus: 'authenticated' | 'anonymous' = 'authenticated';
    const logout = vi.fn(async () => {
      webIdStatus = 'anonymous';
    });
    const startLogin = vi.fn(async () => undefined);
    const value = createXpodAuthValue({
      account: account(),
      runtime: {
        state: { status: 'authenticated', webId: binding.webId },
        logout,
        session: { getSnapshot: () => ({ status: webIdStatus, ...(webIdStatus === 'authenticated' ? { webId: binding.webId } : {}) }) },
      },
      startLogin,
    });

    await value.startLogin('/dashboard/overview');
    expect(logout).toHaveBeenCalledTimes(1);
    expect(startLogin).toHaveBeenCalledWith('/dashboard/overview', undefined);
  });

  test('never treats an authenticated WebID as Dashboard Account proof', async () => {
    const value = createXpodAuthValue({
      account: account(),
      runtime: { state: { status: 'authenticated', webId: binding.webId }, logout: vi.fn(async () => undefined) },
      startLogin: vi.fn(async () => undefined),
    });
    expect(value.readiness.dashboard).toBe(false);
    expect(value.readiness.localSettings).toBe(true);
  });

  test('coordinates Account and WebID logout and refreshes Account controls before success', async () => {
    let webIdStatus: 'authenticated' | 'anonymous' = 'authenticated';
    const accountLogout = vi.fn(async () => undefined);
    const refetchControls = vi.fn(async () => undefined);
    const runtimeLogout = vi.fn(async () => {
      webIdStatus = 'anonymous';
    });
    const value = createXpodAuthValue({
      account: account({ isLoggedIn: true, accountState: { status: 'authenticated' }, isAnonymous: () => true, logout: accountLogout, refetchControls }),
      runtime: {
        state: { status: 'authenticated', webId: binding.webId },
        logout: runtimeLogout,
        session: { getSnapshot: () => ({ status: webIdStatus, ...(webIdStatus === 'authenticated' ? { webId: binding.webId } : {}) }) },
      },
      startLogin: vi.fn(async () => undefined),
    });

    await expect(value.logout()).resolves.toEqual({
      status: 'complete',
      account: 'complete',
      webId: 'complete',
    });
    expect(accountLogout).toHaveBeenCalledTimes(1);
    expect(refetchControls).toHaveBeenCalledTimes(1);
    expect(runtimeLogout).toHaveBeenCalledTimes(1);
  });

  test('switch Account waits for the same complete logout transaction before local login', async () => {
    let webIdStatus: 'authenticated' | 'anonymous' = 'authenticated';
    const accountLogout = vi.fn(async () => undefined);
    const runtimeLogout = vi.fn(async () => { webIdStatus = 'anonymous'; });
    const startLogin = vi.fn(async () => undefined);
    const value = createXpodAuthValue({
      account: account({ isLoggedIn: true, accountState: { status: 'authenticated' }, isAnonymous: () => true, logout: accountLogout }),
      runtime: {
        state: { status: 'authenticated', webId: binding.webId },
        logout: runtimeLogout,
        session: { getSnapshot: () => ({ status: webIdStatus, ...(webIdStatus === 'authenticated' ? { webId: binding.webId } : {}) }) },
      },
      startLogin,
    });

    await value.switchAccount('/dashboard/overview');
    expect(accountLogout).toHaveBeenCalledTimes(1);
    expect(runtimeLogout).toHaveBeenCalledTimes(1);
    expect(startLogin).toHaveBeenCalledWith('/dashboard/overview', undefined);
  });

  test('resets a completed logout before login so the next logout still clears both domains', async () => {
    let webIdStatus: 'authenticated' | 'anonymous' = 'authenticated';
    let accountLoggedIn = true;
    const accountSource = account({
      isLoggedIn: true,
      isAnonymous: () => !accountLoggedIn,
    });
    const accountLogout = vi.fn(async () => {
      accountLoggedIn = false;
      accountSource.isLoggedIn = false;
    });
    accountSource.logout = accountLogout;
    const runtimeLogout = vi.fn(async () => {
      webIdStatus = 'anonymous';
    });
    const startLogin = vi.fn(async () => {
      accountLoggedIn = true;
      accountSource.isLoggedIn = true;
      webIdStatus = 'authenticated';
    });
    const value = createXpodAuthValue({
      account: accountSource,
      runtime: {
        state: { status: 'authenticated', webId: binding.webId },
        logout: runtimeLogout,
        session: { getSnapshot: () => ({ status: webIdStatus, ...(webIdStatus === 'authenticated' ? { webId: binding.webId } : {}) }) },
      },
      startLogin,
    });

    await value.logout();
    await value.startLogin('/dashboard/overview');
    await value.logout();

    expect(accountLogout).toHaveBeenCalledTimes(2);
    expect(runtimeLogout).toHaveBeenCalledTimes(2);
  });
});
