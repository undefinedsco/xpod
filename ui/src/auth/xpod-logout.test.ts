import { describe, expect, test, vi } from 'vitest';
import {
  createXpodLogoutCoordinator,
  type XpodLogoutDomainPort,
} from './xpod-logout';

function port(overrides: Partial<XpodLogoutDomainPort> = {}): XpodLogoutDomainPort {
  return {
    logout: vi.fn(async () => undefined),
    verifyAnonymous: vi.fn(async () => true),
    ...overrides,
  };
}

describe('Xpod logout coordinator', () => {
  test('runs both domains, verifies anonymity, and is idempotent after completion', async () => {
    const account = port();
    const webId = port();
    const coordinator = createXpodLogoutCoordinator({ account, webId });

    expect(coordinator.getState()).toEqual({ status: 'idle' });
    await expect(coordinator.logout()).resolves.toEqual({
      status: 'complete',
      account: 'complete',
      webId: 'complete',
    });
    await coordinator.logout();

    expect(account.logout).toHaveBeenCalledTimes(1);
    expect(webId.logout).toHaveBeenCalledTimes(1);
    expect(account.verifyAnonymous).toHaveBeenCalledTimes(1);
    expect(webId.verifyAnonymous).toHaveBeenCalledTimes(1);
  });

  test('records partial failure and retries only the unfinished domain', async () => {
    const account = port({
      logout: vi.fn()
        .mockRejectedValueOnce(new Error('Bearer token leaked by upstream'))
        .mockResolvedValue(undefined),
    });
    const webId = port();
    const coordinator = createXpodLogoutCoordinator({ account, webId });

    await expect(coordinator.logout()).resolves.toMatchObject({
      status: 'error',
      account: 'error',
      webId: 'complete',
    });
    expect(JSON.stringify(coordinator.getState())).not.toContain('Bearer token');

    await expect(coordinator.retry()).resolves.toEqual({
      status: 'complete',
      account: 'complete',
      webId: 'complete',
    });
    expect(account.logout).toHaveBeenCalledTimes(2);
    expect(webId.logout).toHaveBeenCalledTimes(1);
  });

  test('retries only WebID when Account logout already completed', async () => {
    const account = port();
    const webId = port({
      logout: vi.fn()
        .mockRejectedValueOnce(new Error('Solid session storage is unavailable'))
        .mockResolvedValue(undefined),
    });
    const coordinator = createXpodLogoutCoordinator({ account, webId });

    await expect(coordinator.logout()).resolves.toEqual({
      status: 'error',
      account: 'complete',
      webId: 'error',
    });

    await expect(coordinator.retry()).resolves.toEqual({
      status: 'complete',
      account: 'complete',
      webId: 'complete',
    });
    expect(account.logout).toHaveBeenCalledTimes(1);
    expect(webId.logout).toHaveBeenCalledTimes(2);
  });

  test('logout() after an error retries the unfinished domains instead of returning the stale error', async () => {
    const account = port({
      logout: vi.fn()
        .mockRejectedValueOnce(new Error('Bearer token leaked by upstream'))
        .mockResolvedValue(undefined),
    });
    const webId = port();
    const coordinator = createXpodLogoutCoordinator({ account, webId });

    await expect(coordinator.logout()).resolves.toMatchObject({
      status: 'error',
      account: 'error',
      webId: 'complete',
    });

    // A second logout() must not dead-end on the old error state; it reruns
    // only the unfinished domain, exactly like retry().
    await expect(coordinator.logout()).resolves.toEqual({
      status: 'complete',
      account: 'complete',
      webId: 'complete',
    });
    expect(account.logout).toHaveBeenCalledTimes(2);
    expect(webId.logout).toHaveBeenCalledTimes(1);
  });

  test('does not report success when a domain cannot verify anonymity', async () => {
    const account = port({ verifyAnonymous: vi.fn(async () => false) });
    const webId = port();
    const coordinator = createXpodLogoutCoordinator({ account, webId });

    await expect(coordinator.logout()).resolves.toEqual({
      status: 'error',
      account: 'error',
      webId: 'complete',
    });
  });
});
