// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';
import { resolveOnDemandSessionCredential } from './ondemand-session-credential';
import type { SessionRequestCredential } from './session-request-credential';

const ORIGIN = window.location.origin;
const INDEX = `${ORIGIN}/.account/`;
const COLLECTION = `${ORIGIN}/.account/account/account-1/client-credentials/`;

function holder(label: string): SessionRequestCredential {
  return {
    authorization: async () => `Bearer ${label}`,
    apiKey: async () => label,
    clientId: () => label,
    release: async () => undefined,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolveOnDemandSessionCredential', () => {
  it('uses a binding the page already resolved without reading the Account index', async () => {
    const accountFetch = vi.fn();
    const createCredential = vi.fn(() => holder('sk-ready'));
    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/alice/profile/card#me`,
      binding: { collection: COLLECTION, webId: `${ORIGIN}/alice/profile/card#me`, assertCurrent: () => undefined },
      accountFetch: accountFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
      createCredential,
    });

    expect(accountFetch).not.toHaveBeenCalled();
    expect(createCredential).toHaveBeenCalledTimes(1);
    expect(await credential?.authorization()).toBe('Bearer sk-ready');
  });

  it('resolves the Account cookie control when the binding was still loading', async () => {
    const accountFetch = vi.fn(async () => jsonResponse({
      controls: { account: { clientCredentials: COLLECTION } },
    }));
    const createCredential = vi.fn(() => holder('sk-cookie'));

    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: accountFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
      createCredential,
    });

    expect(accountFetch).toHaveBeenCalledTimes(1);
    expect(createCredential).toHaveBeenCalledWith({
      capability: expect.anything(),
      webId: `${ORIGIN}/alice/profile/card#me`,
    });
    const capability = createCredential.mock.calls[0]![0].capability as AiClientCredentialsCapability;
    expect(capability).toBeTruthy();
    expect(await credential?.authorization()).toBe('Bearer sk-cookie');
  });

  it('falls back to the session path when the cookie page advertises no control', async () => {
    const accountFetch = vi.fn(async () => jsonResponse({ controls: { account: { create: `${ORIGIN}/.account/account/` } } }));
    const sessionFetch = vi.fn(async () => jsonResponse({
      controls: { account: { clientCredentials: COLLECTION } },
    }));
    const createCredential = vi.fn(() => holder('sk-session'));

    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: accountFetch as unknown as typeof fetch,
      sessionFetch: sessionFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
      createCredential,
    });

    expect(accountFetch).toHaveBeenCalledTimes(1);
    expect(sessionFetch).toHaveBeenCalledTimes(1);
    expect(await credential?.authorization()).toBe('Bearer sk-session');
  });

  it('returns nothing when neither path resolves a control', async () => {
    const accountFetch = vi.fn(async () => jsonResponse({ controls: { account: { create: `${ORIGIN}/.account/account/` } } }));
    const createCredential = vi.fn(() => holder('sk-unused'));

    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: accountFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
      createCredential,
    });

    expect(credential).toBeUndefined();
    expect(createCredential).not.toHaveBeenCalled();
  });

  it('stays inert without a session WebID or an account authority', async () => {
    const accountFetch = vi.fn();
    expect(await resolveOnDemandSessionCredential({
      accountFetch: accountFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
    })).toBeUndefined();
    expect(accountFetch).not.toHaveBeenCalled();
  });
});
