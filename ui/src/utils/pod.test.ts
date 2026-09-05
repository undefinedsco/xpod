import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_PROVISIONING_UNAVAILABLE,
  buildPodCreatePayload,
  clearStoredProvisionCode,
  getStoredProvisionCode,
  resolveCurrentProvisionTarget,
  resolveProvisionCodeForCurrentScope,
  setStoredProvisionCode,
  syncProvisionCodeFromAuthContext,
} from './pod';

describe('provision scope resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearStoredProvisionCode();
    delete window.__XPOD__;
  });

  it('caches the active OIDC interaction provisioning scope from the auth bootstrap context', () => {
    clearStoredProvisionCode();

    expect(syncProvisionCodeFromAuthContext('', {
      authenticating: true,
      provisionCode: 'signed-local-scope',
    })).toBe('signed-local-scope');

    expect(getStoredProvisionCode()).toBe('signed-local-scope');
  });

  it('clears stale provisioning scope when a new OIDC interaction has none', () => {
    setStoredProvisionCode('previous-local-scope');

    expect(syncProvisionCodeFromAuthContext('', { authenticating: true })).toBeUndefined();
    expect(getStoredProvisionCode()).toBeUndefined();
  });

  it('prefers the current OIDC interaction over stale URL provisioning scope', () => {
    setStoredProvisionCode('previous-local-scope');

    expect(syncProvisionCodeFromAuthContext('?provisionCode=stale-url-scope', { authenticating: true })).toBeUndefined();
    expect(getStoredProvisionCode()).toBeUndefined();
  });

  it('keeps the explicit create-pod URL scope for non-OIDC provisioning entrypoints', () => {
    expect(syncProvisionCodeFromAuthContext('?provisionCode=url-scope', { authenticating: false })).toBe('url-scope');
    expect(getStoredProvisionCode()).toBe('url-scope');
  });

  it('uses the current bootstrap scope even when storage did not retain it', async () => {
    window.__XPOD__ = {
      authenticating: true,
      provisionCode: 'bootstrap-local-scope',
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    await expect(resolveProvisionCodeForCurrentScope()).resolves.toBe('bootstrap-local-scope');
  });

  it('uses the active interaction instead of stale cached or caller scope when storage cannot be updated', async () => {
    setStoredProvisionCode('previous-local-scope');
    window.__XPOD__ = { authenticating: true, provisionCode: 'current-local-scope' };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    syncProvisionCodeFromAuthContext();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    await expect(resolveProvisionCodeForCurrentScope('previous-caller-scope'))
      .resolves.toBe('current-local-scope');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not let an expired active Local interaction create an unscoped Cloud Pod', async () => {
    setStoredProvisionCode('previous-local-scope');
    const expiredCode = `${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    window.__XPOD__ = { authenticating: true, provisionCode: expiredCode };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    await expect(resolveProvisionCodeForCurrentScope())
      .rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
    expect(getStoredProvisionCode()).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps an ordinary Cloud or Standalone interaction unscoped despite cached Local context', async () => {
    setStoredProvisionCode('previous-local-scope');
    window.__XPOD__ = { authenticating: true };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);

    await expect(resolveProvisionCodeForCurrentScope('previous-caller-scope'))
      .resolves.toBeUndefined();
    expect(getStoredProvisionCode()).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses explicit Local context without probing the Account host or replacing its scope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      managed: true,
      registered: false,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope('legacy-local-code'))
      .resolves.toBe('legacy-local-code');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never probes a Local endpoint on an ordinary Account page, including loopback dev hosts', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    await expect(resolveProvisionCodeForCurrentScope()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects expired explicit Local creation context rather than creating an unscoped Pod', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const expired = `${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    await expect(resolveProvisionCodeForCurrentScope(expired))
      .rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not erase an expired non-OIDC operation before the creation resolver and retry can reject it', async () => {
    const expired = `${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    syncProvisionCodeFromAuthContext(`?provisionCode=${expired}`, { authenticating: false });
    expect(getStoredProvisionCode()).toBeUndefined();
    await expect(resolveProvisionCodeForCurrentScope()).rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
    await expect(resolveProvisionCodeForCurrentScope()).rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
  });

  it('resolves current operation target metadata from expired stored scope without authorizing it', async () => {
    const expired = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'expired-service-token',
      spDomain: 'node-a.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    setStoredProvisionCode(expired);

    await expect(resolveCurrentProvisionTarget()).resolves.toEqual({
      activeProvisionCode: undefined,
      storageRoot: 'https://node-a.example/',
    });
    await expect(resolveProvisionCodeForCurrentScope()).rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
  });

  it('resolves current operation target metadata from authenticating context before stale storage', async () => {
    const stale = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'stale-service-token',
      spDomain: 'node-stale.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const current = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'current-service-token',
      spDomain: 'node-current.example',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    setStoredProvisionCode(stale);
    window.__XPOD__ = { authenticating: true, provisionCode: current };

    await expect(resolveCurrentProvisionTarget()).resolves.toEqual({
      activeProvisionCode: undefined,
      storageRoot: 'https://node-current.example/',
    });
  });

  it('keeps standalone local provisioning available', async () => {
    await expect(resolveProvisionCodeForCurrentScope('standalone-code'))
      .resolves.toBe('standalone-code');
  });

  it('includes the provision receipt with the signed provision code when creating a Pod', () => {
    expect(buildPodCreatePayload(' glocal ', 'provision-code', 'provision-receipt')).toEqual({
      name: 'glocal',
      settings: {
        provisionCode: 'provision-code',
        provisionReceipt: 'provision-receipt',
      },
    });
  });
});

function makeProvisionCode(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}
