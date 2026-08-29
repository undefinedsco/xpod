import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_PROVISIONING_UNAVAILABLE,
  clearStoredProvisionCode,
  getStoredProvisionCode,
  resolveProvisionCodeForCurrentScope,
  setStoredProvisionCode,
  syncProvisionCodeFromAuthContext,
} from './pod';

describe('provision scope resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl)).resolves.toBe('bootstrap-local-scope');
  });

  it('uses the active interaction instead of stale cached or caller scope when storage cannot be updated', async () => {
    setStoredProvisionCode('previous-local-scope');
    window.__XPOD__ = { authenticating: true, provisionCode: 'current-local-scope' };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    syncProvisionCodeFromAuthContext();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl, 'previous-caller-scope'))
      .resolves.toBe('current-local-scope');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not let an expired active Local interaction create an unscoped Cloud Pod', async () => {
    setStoredProvisionCode('previous-local-scope');
    const expiredCode = `${btoa(JSON.stringify({ exp: 1 }))}.signature`;
    window.__XPOD__ = { authenticating: true, provisionCode: expiredCode };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl))
      .rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
    expect(getStoredProvisionCode()).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps an ordinary Cloud or Standalone interaction unscoped despite cached Local context', async () => {
    setStoredProvisionCode('previous-local-scope');
    window.__XPOD__ = { authenticating: true };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl, 'previous-caller-scope'))
      .resolves.toBeUndefined();
    expect(getStoredProvisionCode()).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never falls back to local provisioning for a managed node without Cloud credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      managed: true,
      registered: false,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl, 'legacy-local-code'))
      .rejects.toThrow(CLOUD_PROVISIONING_UNAVAILABLE);
  });

  it('keeps standalone local provisioning available', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      managed: false,
      registered: false,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(resolveProvisionCodeForCurrentScope(fetchImpl, 'standalone-code'))
      .resolves.toBe('standalone-code');
  });
});
