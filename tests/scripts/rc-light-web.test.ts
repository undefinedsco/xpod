import { describe, expect, it, vi } from 'vitest';
import { authorizeRcSession, verifyRcIdentity, verifyRcPrivateIsolation } from '../helpers/rcLightWeb';

import * as browserOidc from '../helpers/browserSolidOidc';

const issuer = 'https://id.example/';
const alice = { accountId: 'alice-account', webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pods.example/alice/' };
const bob = { accountId: 'bob-account', webId: 'https://id.example/bob/profile/card#me', storageUrl: 'https://pods.example/bob/' };
const profile = (storage = alice.storageUrl) => vi.fn(async () => new Response(
  `<${alice.webId}> <http://www.w3.org/ns/pim/space#storage> <${storage}> .`,
  { headers: { 'content-type': 'text/turtle' } },
));

describe('deployed lightweight Web evidence (synthetic regression, not deployed proof)', () => {
  it('uses token identity and authoritative Account bindings, allowing canonical external storage', async () => {
    await expect(verifyRcIdentity(issuer, { accountId: alice.accountId, bindings: [alice] },
      { webId: alice.webId, issuer }, profile())).resolves.toEqual(alice);
  });
  it.each(['token', 'issuer', 'binding', 'profile', 'loopback'])('rejects mismatched %s evidence', async mismatch => {
    const bindings = [{ ...alice, ...(mismatch === 'binding' ? { webId: bob.webId } : {}),
      ...(mismatch === 'loopback' ? { storageUrl: 'https://127.0.0.1/alice/' } : {}) }];
    await expect(verifyRcIdentity(issuer, { accountId: alice.accountId, bindings }, {
      webId: mismatch === 'token' ? bob.webId : alice.webId,
      issuer: mismatch === 'issuer' ? 'https://wrong.example/' : issuer,
    }, profile(mismatch === 'profile' ? bob.storageUrl : alice.storageUrl))).rejects.toThrow();
  });
  it('reports only a closed token stage when the RP exchange fails with sensitive text', async () => {
    const driver = vi.spyOn(browserOidc, 'completeOidcLogin').mockResolvedValue({
      authorizationRequestSeen: true, authCodeChallengeMethodS256: true, callbackHasCode: true, callbackHasState: true,
    } as any);
    const transaction = { url: 'https://id.example/authorize', tokenRequests: 0,
      exchange: vi.fn(async () => { throw new Error('Bearer SYNTHETIC_SECRET body=private'); }) };
    const rp = { callbackUrl: 'http://127.0.0.1:1234/auth/callback', authorization: () => transaction } as any;
    const page = { on: vi.fn(), off: vi.fn(), url: () => `${rp.callbackUrl}?code=synthetic&state=synthetic` } as any;
    try {
      await expect(authorizeRcSession(page, rp, issuer)).rejects.toThrow(/^RC reused OIDC failed at token$/u);
      expect(page.off).toHaveBeenCalledOnce();
    } finally { driver.mockRestore(); }
  });
  function fixture(leak = false) {
    const files = new Map<string, string>();
    const removed: string[] = [];
    const request = (owner?: string): typeof fetch => vi.fn(async (input, init) => {
      const url = String(input);
      if (!owner || !url.startsWith(owner)) return new Response(leak ? 'leak' : '', { status: leak ? 200 : 403 });
      if (init?.method === 'PUT') { files.set(url, String(init.body)); return new Response(null, { status: 201 }); }
      if (init?.method === 'DELETE') { files.delete(url); removed.push(url); return new Response(null, { status: 204 }); }
      return new Response(files.get(url), { status: files.has(url) ? 200 : 404 });
    }) as typeof fetch;
    return { files, removed, sessions: [
      { identity: alice, authenticatedFetch: request(alice.storageUrl) },
      { identity: bob, authenticatedFetch: request(bob.storageUrl) },
    ], anonymous: request() };
  }
  it('requires exact owner PUT/GET and rejects cross-owner/anonymous GET and PUT, then cleans both resources', async () => {
    const f = fixture();
    await verifyRcPrivateIsolation(f.sessions, f.anonymous);
    expect(f.files.size).toBe(0);
    expect(f.removed).toHaveLength(2);
    expect(f.anonymous).toHaveBeenCalledTimes(4);
  });
  it('cleans an interrupted PUT that committed and emits no transport credential text', async () => {
    const f = fixture();
    const original = f.sessions[0].authenticatedFetch;
    f.sessions[0].authenticatedFetch = (async (input, init) => {
      const response = await original(input, init);
      if (init?.method === 'PUT') throw new Error('Bearer SYNTHETIC_SECRET');
      return response;
    }) as typeof fetch;
    await expect(verifyRcPrivateIsolation(f.sessions, f.anonymous)).rejects.toThrow(/^RC private isolation transport failed$/u);
    expect(f.files.size).toBe(0);
    expect(f.removed).toHaveLength(1);
  });
  it('fails public/cross-owner leaks and still cleans every created resource', async () => {
    const f = fixture(true);
    await expect(verifyRcPrivateIsolation(f.sessions, f.anonymous)).rejects.toThrow('denied');
    expect(f.files.size).toBe(0);
    expect(f.removed.length).toBeGreaterThan(0);
  });
});
