import { describe, expect, it, vi } from 'vitest';
import { PodSolidFsHttpClient } from '../../src/solidfs/PodSolidFsHttpClient';
import { OwnerPodAccess } from '../../src/api/ai-gateway/pod/OwnerPodAccess';
import { SolidSessionFactory } from '../../src/api/auth/SolidSessionFactory';

describe('SolidFS shared Pod authority', () => {
  const auth = { type: 'solid' as const, webId: 'https://identity.example/alice/card#me',
    clientId: 'fixture-client', clientSecret: 'fixture-secret' };
  it('uses the shared provider for each request, including the exact task grant binding', async () => {
    const authenticated = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const podAccess = { getPodFetch: vi.fn().mockResolvedValue(authenticated) };
    const upstream = vi.fn();
    const client = new PodSolidFsHttpClient({ podAccess, fetch: upstream });
    const taskCredential = { credentialRef: 'task-grant', version: 3 };
    const context = { auth, taskCredential };
    const init = { method: 'PUT', headers: new Headers({ 'if-match': '"version"' }), body: 'bytes' };
    await client.request('https://storage.example/alice/file', init, context);
    await client.request('https://storage.example/alice/file', { method: 'GET' }, context);
    expect(podAccess.getPodFetch).toHaveBeenCalledTimes(2);
    expect(podAccess.getPodFetch).toHaveBeenCalledWith(auth.webId, { auth, taskCredential });
    expect(authenticated).toHaveBeenNthCalledWith(1, 'https://storage.example/alice/file', init);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('returns a rejected write without replaying or exchanging credentials privately', async () => {
    const rejected = new Response(null, { status: 401 });
    const authenticated = vi.fn().mockResolvedValue(rejected);
    const client = new PodSolidFsHttpClient({ podAccess: { getPodFetch: async () => authenticated } });
    expect(await client.request('https://storage.example/alice/file', { method: 'PUT', body: 'bytes' }, { auth })).toBe(rejected);
    expect(authenticated).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the bound grant is unavailable', async () => {
    const upstream = vi.fn();
    const client = new PodSolidFsHttpClient({ fetch: upstream, podAccess: { getPodFetch: async () => undefined } });
    await expect(client.request('https://storage.example/alice/file', { method: 'DELETE' }, { auth,
      taskCredential: { credentialRef: 'revoked-grant', version: 1 } })).rejects.toThrow('Pod access');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('does not replay an incoming DPoP token without its private key', async () => {
    const upstream = vi.fn();
    const client = new PodSolidFsHttpClient({ fetch: upstream });
    await expect(client.request('https://storage.example/alice/file', { method: 'GET' }, {
      auth: { type: 'solid', webId: auth.webId, accessToken: 'fixture-token', tokenType: 'DPoP' },
    })).rejects.toThrow('Pod access');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('keeps canonical DPoP through the shared held fetch after expiry and rejects revocation', async () => {
    let now = Date.now();
    let exchanges = 0;
    let revoked = false;
    const proofs: Array<{ htu: string; htm: string }> = [];
    const authorizations: string[] = [];
    const tokenEndpoint = 'http://localhost:41001/.oidc/token';
    const canonical = 'https://storage.example/';
    const resource = `${canonical}alice/file`;
    const credential = { clientId: auth.clientId, clientSecret: auth.clientSecret, credentialRef: 'grant', version: 3 };
    const wire: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const proof = JSON.parse(Buffer.from(headers.get('dpop')!.split('.')[1], 'base64url').toString());
      if (url === tokenEndpoint) {
        expect(proof.htu).toBe(`${canonical}.oidc/token`);
        expect(headers.get('x-forwarded-host')).toBe('storage.example');
        return Response.json({ access_token: `token-${++exchanges}`, token_type: 'DPoP', expires_in: 60, webid: auth.webId });
      }
      expect(url).toBe('http://127.0.0.1:41000/alice/file');
      proofs.push(proof);
      authorizations.push(headers.get('authorization')!);
      return new Response('verified bytes');
    };
    const access = new OwnerPodAccess({ fetch: wire,
      route: { canonicalBaseUrl: canonical, localBaseUrl: 'http://127.0.0.1:41000/' },
      sessions: new SolidSessionFactory({ tokenEndpoint, publicBaseUrl: canonical, fetch: wire, now: () => now }),
      taskCredentials: { activeFor: async () => credential, forRef: async () => revoked ? undefined : credential },
    });
    const context = { auth, taskCredential: { credentialRef: 'grant', version: 3 } };
    const held = (await access.getPodFetch(auth.webId, context))!;
    const client = new PodSolidFsHttpClient({ podAccess: { getPodFetch: async () => held } });
    expect(await (await client.request(resource, { method: 'GET' }, context)).text()).toBe('verified bytes');
    now += 181_000; // Beyond both expiry and the server verifier's 120-second grace.
    expect(await (await client.request(resource, { method: 'GET' }, context)).text()).toBe('verified bytes');
    expect(exchanges).toBe(2);
    expect(proofs.map(({ htu, htm }) => ({ htu, htm }))).toEqual([{ htu: resource, htm: 'GET' }, { htu: resource, htm: 'GET' }]);
    expect(authorizations).toEqual(['DPoP token-1', 'DPoP token-2']);
    revoked = true;
    await expect(client.request(resource, { method: 'PUT', body: 'never dispatched' }, context)).rejects.toThrow('task_grant_unusable');
    expect(proofs).toHaveLength(2);
  });
});
