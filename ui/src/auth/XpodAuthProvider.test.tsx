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
    const logout = vi.fn(async () => undefined);
    const startLogin = vi.fn(async () => undefined);
    const value = createXpodAuthValue({
      account: account(),
      runtime: {
        state: { status: 'authenticated', webId: binding.webId },
        logout,
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
});
