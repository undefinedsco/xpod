import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { ClientCredentialsAuthenticator } from '../../../src/api/auth/ClientCredentialsAuthenticator';
import { SolidSessionFactory } from '../../../src/api/auth/SolidSessionFactory';
import {
  OwnerPodAccess,
  POD_INTERFACE_KEY_MISSING,
} from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import type {
  PodInterfaceCredential,
  PodInterfaceKeyAccess,
} from '../../../src/api/ai-gateway/pod/PodInterfaceKeyStore';

const OWNER = 'https://pod.example/alice/profile/card#me';
const TOKEN_ENDPOINT = 'https://pod.example/.oidc/token';
const POD_RESOURCE = 'https://pod.example/alice/settings/ai/models.ttl';
const CLIENT_ID = 'agent-client';
const CLIENT_SECRET = 'agent-secret';
const SK_KEY = `sk-${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

function dpopPayload(proof: string): { htu: string; htm: string } {
  const encoded = proof.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { htu: string; htm: string };
}

/** One credential, one inbound request, one outbound Pod read - and one token exchange. */
describe('Solid credential session sharing', () => {
  it('opens the Pod with the session the request was authenticated with, exchanging once', async () => {
    const tokenRequests: { authorization: string | null; dpop: string | null }[] = [];
    const podRequests: { url: string; authorization: string | null; dpop: string | null }[] = [];
    let issued = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (url === TOKEN_ENDPOINT) {
        issued += 1;
        tokenRequests.push({ authorization: headers.get('authorization'), dpop: headers.get('dpop') });
        return Response.json({ access_token: `token-${issued}`, token_type: 'DPoP', expires_in: 300, webid: OWNER });
      }
      podRequests.push({ url, authorization: headers.get('authorization'), dpop: headers.get('dpop') });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const sessions = new SolidSessionFactory({
      tokenEndpoint: TOKEN_ENDPOINT,
      publicBaseUrl: 'https://pod.example',
      fetch: fetchImpl,
    });
    const authenticator = new ClientCredentialsAuthenticator({ sessions });
    const keys: PodInterfaceKeyAccess = {
      read: async (): Promise<PodInterfaceCredential | undefined> => undefined,
      saveKey: async () => undefined,
      forgetKey: async () => undefined,
      hasKey: async () => false,
    };
    const access = new OwnerPodAccess({ keys, sessions, fetch: fetchImpl });

    const request = { headers: { authorization: `Bearer ${SK_KEY}` } } as IncomingMessage;
    const result = await authenticator.authenticate(request);
    expect(result).toMatchObject({ success: true, context: { webId: OWNER, accessToken: 'token-1' } });
    const auth = result.success && result.context.type === 'solid' ? result.context : undefined;

    const podFetch = await access.getPodFetch(OWNER, { auth });
    await podFetch!(POD_RESOURCE);

    expect(tokenRequests).toHaveLength(1);
    expect(podRequests).toHaveLength(1);
    // The Pod sees the DPoP-bound token, and the proof is made with the key that exchange kept.
    expect(podRequests[0].authorization).toBe('DPoP token-1');
    expect(dpopPayload(podRequests[0].dpop!).htu).toBe(POD_RESOURCE);
    expect(dpopPayload(tokenRequests[0].dpop!).htu).toBe(TOKEN_ENDPOINT);
  });

  it('does not fall back to an owner key the caller never granted', async () => {
    const keys: PodInterfaceKeyAccess = {
      read: async () => undefined,
      saveKey: async () => undefined,
      forgetKey: async () => undefined,
      hasKey: async () => false,
    };
    const access = new OwnerPodAccess({
      keys,
      sessions: new SolidSessionFactory({ tokenEndpoint: TOKEN_ENDPOINT, fetch: vi.fn() as unknown as typeof fetch }),
    });

    // A caller that presented a gateway credential is not a Pod principal, so there is nothing
    // to open the Pod with and the caller hears about it instead of a silent fallback.
    await expect(access.getPodFetch(OWNER, {
      auth: { type: 'solid', webId: OWNER, viaGatewayApiKey: true, accessToken: 'gw-token', tokenType: 'Bearer' },
    })).resolves.toBeUndefined();
    await expect(access.getPodFetch(OWNER, {
      auth: { type: 'solid', webId: OWNER, internalInvocation: true, accessToken: 'inv-token', tokenType: 'Bearer' },
    })).resolves.toBeUndefined();
    expect(POD_INTERFACE_KEY_MISSING).toBe('pod_interface_key_missing');
  });
});
