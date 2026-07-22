import { describe, expect, it, vi } from 'vitest';

import { ClientCredentialsInternalPodAccessTokenProvider } from '../../../src/api/ai-gateway/auth/ClientCredentialsInternalPodAccessTokenProvider';
import { GatewayApiKeyAuthenticator } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { createGatewayApiKey } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import { AesGatewayKeyLocatorCodec, createGatewayKeyLocator } from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import { PodGatewayAccessKeyRepository } from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const SERVICE_WEB_ID = 'https://id.example/service/profile/card#me';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer
    .from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('ClientCredentialsInternalPodAccessTokenProvider', () => {
  it('exchanges internal service client credentials for a WebID-scoped trusted fetch', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: 'internal-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          webid: WEB_ID,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('ok');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    const trustedFetch = await provider.getTrustedFetch(WEB_ID);
    await trustedFetch('https://pod.example/alice/.data/ai/gateway/access-keys.ttl');

    const tokenBody = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('internal-client');
    expect(tokenBody.get('client_secret')).toBe('internal-secret');
    expect(tokenBody.get('webid')).toBe(WEB_ID);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(expect.any(Headers));
    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer internal-access-token');
  });

  it('rejects and does not cache a token response whose body WebID does not match the requested owner', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: jwtWithPayload({ webid: WEB_ID }),
          token_type: 'Bearer',
          webid: 'https://id.example/bob/profile/card#me',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run with a mismatched internal token');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/does not match requested owner/);
    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/does not match requested owner/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('accepts a token whose JWT payload WebID matches the requested owner when the body omits webid', async () => {
    const accessToken = jwtWithPayload({ webid: WEB_ID });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: accessToken,
          token_type: 'DPoP',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('ok');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    const trustedFetch = await provider.getTrustedFetch(WEB_ID);
    await trustedFetch('https://pod.example/alice/private.ttl');

    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Headers).get('Authorization')).toBe(`DPoP ${accessToken}`);
  });

  it('rejects a token whose JWT payload subject does not match the requested owner', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: jwtWithPayload({ sub: 'https://id.example/bob/profile/card#me' }),
          token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run with a mismatched JWT subject');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/does not match requested owner/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a token response that cannot prove the requested owner identity', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: 'opaque-service-token',
          token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run without token identity');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/missing authoritative WebID/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when CSS ignores the requested owner and returns the service WebID', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: jwtWithPayload({ webid: SERVICE_WEB_ID }),
          token_type: 'Bearer',
          webid: SERVICE_WEB_ID,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run with service identity');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/does not match requested owner/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('authenticates a private Pod key through the internal provider instead of anonymous fetch', async () => {
    const codec = new AesGatewayKeyLocatorCodec('locator-secret');
    const keyId = createGatewayKeyLocator(WEB_ID, 'cloud', codec);
    const issued = await createGatewayApiKey({ deployment: 'cloud', keyId });
    const podRows = new Map<string, any>();
    podRows.set(keyId, {
      ...issued.record,
      owner: WEB_ID,
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({ access_token: 'internal-token', webid: WEB_ID }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer internal-token');
      return new Response('ok');
    }) as typeof fetch;
    const internalPodAccess = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: codec,
      internalPodAccess,
      dbFactory: async ({ fetch }) => {
        await fetch('https://issuer.example/.oidc/token-check');
        return {
          init: vi.fn(),
          insert: vi.fn(),
          select: vi.fn(),
          findById: vi.fn(async (_resource, id: string) => structuredClone(podRows.get(id))),
          findByIri: vi.fn(),
          updateById: vi.fn(async (_resource, id: string, patch: any) => {
            Object.assign(podRows.get(id), patch);
            return structuredClone(podRows.get(id));
          }),
        } as any;
      },
    });
    const authenticator = new GatewayApiKeyAuthenticator({
      repository,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T01:00:00.000Z'),
    });

    await expect(authenticator.authenticate({
      headers: { authorization: `Bearer ${issued.plaintext}` },
    } as any)).resolves.toMatchObject({
      success: true,
      context: { webId: WEB_ID },
    });
    expect(podRows.get(keyId).lastUsedAt).toEqual(new Date('2026-07-23T01:00:00.000Z'));
  });
});
