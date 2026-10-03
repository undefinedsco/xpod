// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';
import { createSessionRequestCredential } from './session-request-credential';
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
    const accountFetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/bindings/')
      ? jsonResponse({ bindings: [{ webId: `${ORIGIN}/alice/profile/card#me`, storageUrl: `${ORIGIN}/alice/` }] })
      : jsonResponse({ controls: { account: { clientCredentials: COLLECTION, bindings: `${ORIGIN}/.account/account/account-1/bindings/` } } }));
    const createCredential = vi.fn<[{ capability: AiClientCredentialsCapability; webId: string }], SessionRequestCredential>(() => holder('sk-cookie'));

    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: accountFetch as unknown as typeof fetch,
      assertCurrent: () => undefined,
      createCredential,
    });

    expect(accountFetch).toHaveBeenCalledTimes(2);
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
  it('does not issue for another WebID supplied by a stale Account binding', async () => {
    const createCredential = vi.fn(() => holder('wrong-user'));
    const result = await resolveOnDemandSessionCredential({
      accountIndex: INDEX,
      webId: `${ORIGIN}/bob/profile/card#me`,
      binding: { collection: COLLECTION, webId: `${ORIGIN}/alice/profile/card#me`, assertCurrent: vi.fn() },
      accountFetch: vi.fn(), assertCurrent: vi.fn(), createCredential,
    });
    expect(result).toBeUndefined();
    expect(createCredential).not.toHaveBeenCalled();
  });

  it('rejects delayed discovery after the captured session ends', async () => {
    let active = true;
    const createCredential = vi.fn(() => holder('stale'));
    await expect(resolveOnDemandSessionCredential({
      accountIndex: INDEX, webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: vi.fn(async () => {
        active = false;
        return jsonResponse({ controls: { account: { clientCredentials: COLLECTION } } });
      }),
      assertCurrent: () => { if (!active) throw new Error('session changed'); }, createCredential,
    })).rejects.toThrow('session changed');
    expect(createCredential).not.toHaveBeenCalled();
  });

  it('issues and revokes for SDK Alice while the independent Cookie Account belongs to Bob', async () => {
    const alice = `${ORIGIN}/alice/profile/card#me`;
    const bob = `${ORIGIN}/bob/profile/card#me`;
    const bobCollection = `${ORIGIN}/.account/account/bob/client-credentials/`;
    const aliceCollection = `${ORIGIN}/.account/account/alice/client-credentials/`;
    let capability: AiClientCredentialsCapability | undefined;
    const calls: { actor: string; url: string; method: string; credentials?: RequestCredentials }[] = [];
    const serve = async (sdk: boolean, input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      // Match the actual CSS handler: a Cookie Account wins over DPoP.
      const actor = sdk && init?.credentials === 'omit'
        && !headers.get('authorization')?.toLowerCase().startsWith('css-account-token ') ? 'alice' : 'bob';
      const webId = actor === 'alice' ? alice : bob;
      const collection = actor === 'alice' ? aliceCollection : bobCollection;
      const method = init?.method ?? 'GET';
      calls.push({ actor, url, method, credentials: init?.credentials });
      if (url === INDEX) return jsonResponse({ controls: { account: {
        clientCredentials: collection, bindings: `${ORIGIN}/.account/account/${actor}/bindings/`,
      } } });
      if (url.endsWith('/bindings/')) return jsonResponse({ bindings: [{ webId, storageUrl: `${ORIGIN}/${actor}/` }] });
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { webId: string };
        if (body.webId !== webId || url !== collection) return new Response('', { status: 400 });
        return jsonResponse({ id: 'alice-session', secret: 'test-secret', resource: `${collection}alice-session` });
      }
      if (url === collection) return jsonResponse({ clientCredentials: { 'alice-session': `${collection}alice-session` } });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({ id: 'alice-session', webId });
    };
    const credential = await resolveOnDemandSessionCredential({
      accountIndex: INDEX, webId: alice,
      accountFetch: vi.fn((input, init) => serve(false, input, init)),
      sessionFetch: vi.fn((input, init) => serve(true, input, init)),
      assertCurrent: () => undefined,
      createCredential: (input) => { capability = input.capability; return createSessionRequestCredential(input); },
    });
    expect(await credential?.authorization()).toMatch(/^Bearer sk-/u);
    expect(await capability?.list()).toHaveLength(1);
    await credential?.release();
    expect(calls.filter(({ method }) => method === 'POST')).toEqual([
      { actor: 'alice', url: aliceCollection, method: 'POST', credentials: 'omit' },
    ]);
    expect(calls.filter(({ method }) => method === 'DELETE')).toEqual([
      { actor: 'alice', url: `${aliceCollection}alice-session`, method: 'DELETE', credentials: 'omit' },
    ]);
  });

  it('does not infer Cookie ownership from a credential control alone', async () => {
    const createCredential = vi.fn(() => holder('unproven'));
    expect(await resolveOnDemandSessionCredential({
      accountIndex: INDEX, webId: `${ORIGIN}/alice/profile/card#me`,
      accountFetch: vi.fn(async () => jsonResponse({ controls: { account: { clientCredentials: COLLECTION } } })),
      assertCurrent: () => undefined, createCredential,
    })).toBeUndefined();
    expect(createCredential).not.toHaveBeenCalled();
  });

  it.each([
    { clientCredentials: `${ORIGIN}/api/client-credentials/`, bindings: `${ORIGIN}/.account/account/account-1/bindings/` },
    { clientCredentials: COLLECTION, bindings: 'https://evil.example/.account/bindings/' },
    { clientCredentials: COLLECTION, bindings: `${ORIGIN}/api/bindings/` },
  ])('refuses untrusted Cookie ownership controls %j', async (controls) => {
    const accountFetch = vi.fn(async () => jsonResponse({ controls: { account: controls } }));
    const createCredential = vi.fn(() => holder('untrusted'));
    expect(await resolveOnDemandSessionCredential({
      accountIndex: INDEX, webId: `${ORIGIN}/alice/profile/card#me`, accountFetch,
      assertCurrent: () => undefined, createCredential,
    })).toBeUndefined();
    expect(accountFetch).toHaveBeenCalledTimes(1);
    expect(createCredential).not.toHaveBeenCalled();
  });

});
