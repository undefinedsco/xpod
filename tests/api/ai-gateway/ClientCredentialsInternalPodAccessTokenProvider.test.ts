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
  it('exchanges internal service client credentials for one stable Bearer service principal', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: 'internal-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          webid: SERVICE_WEB_ID,
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
    await expect(provider.getServicePrincipal()).resolves.toEqual({ webId: SERVICE_WEB_ID });
    await trustedFetch('https://pod.example/alice/.data/ai/gateway/access-keys.ttl');

    const tokenBody = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('internal-client');
    expect(tokenBody.get('client_secret')).toBe('internal-secret');
    expect(tokenBody.get('scope')).toBe('webid');
    expect(tokenBody.has('webid')).toBe(false);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual(expect.any(Headers));
    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer internal-access-token');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches the service token independently from requested owners', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: 'internal-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          webid: SERVICE_WEB_ID,
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

    const aliceFetch = await provider.getTrustedFetch(WEB_ID);
    const bobFetch = await provider.getTrustedFetch('https://id.example/bob/profile/card#me');
    await aliceFetch('https://pod.example/alice/private.ttl');
    await bobFetch('https://pod.example/bob/private.ttl');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer internal-access-token');
    expect((fetchImpl.mock.calls[2]?.[1]?.headers as Headers).get('Authorization')).toBe('Bearer internal-access-token');
  });

  it('uses the authoritative JWT WebID when the body omits webid', async () => {
    const accessToken = jwtWithPayload({ webid: SERVICE_WEB_ID });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
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

    await expect(provider.getServicePrincipal()).resolves.toEqual({ webId: SERVICE_WEB_ID });
  });

  it('fails closed when a refreshed service token changes authoritative WebID', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        const webid = fetchImpl.mock.calls.length === 1
          ? SERVICE_WEB_ID
          : 'https://id.example/other-service/profile/card#me';
        return new Response(JSON.stringify({
          access_token: `internal-token-${fetchImpl.mock.calls.length}`,
          token_type: 'Bearer',
          expires_in: 31,
          webid,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('ok');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
      now: () => now,
    });

    await expect(provider.getServicePrincipal()).resolves.toEqual({ webId: SERVICE_WEB_ID });
    now += 2_000;

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/Gateway internal service WebID changed/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects and does not cache a token response without access_token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          token_type: 'Bearer',
          webid: SERVICE_WEB_ID,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run without an access token');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/missing access_token/);
    await expect(provider.getServicePrincipal()).rejects.toThrow(/missing access_token/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects and does not cache a token response without authoritative service WebID', async () => {
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
    await expect(provider.getServicePrincipal()).rejects.toThrow(/missing authoritative WebID/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the internal service token response omits token_type', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: jwtWithPayload({ webid: SERVICE_WEB_ID }),
          webid: SERVICE_WEB_ID,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run without an explicit Bearer token type');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/Gateway internal service token must be Bearer/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent first token requests across trusted fetch and service principal calls', async () => {
    let resolveToken!: () => void;
    const tokenReady = new Promise<void>((resolve) => {
      resolveToken = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        await tokenReady;
        return new Response(JSON.stringify({
          access_token: 'internal-token',
          token_type: 'Bearer',
          webid: SERVICE_WEB_ID,
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

    const results = Promise.all([
      provider.getTrustedFetch(WEB_ID),
      provider.getServicePrincipal(),
      provider.getTrustedFetch('https://id.example/bob/profile/card#me'),
    ]);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveToken();

    const [aliceFetch, servicePrincipal, bobFetch] = await results;
    expect(servicePrincipal).toEqual({ webId: SERVICE_WEB_ID });
    await aliceFetch('https://pod.example/alice/private.ttl');
    await bobFetch('https://pod.example/bob/private.ttl');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the internal service token is DPoP because no proof can be generated', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://issuer.example/.oidc/token') {
        return new Response(JSON.stringify({
          access_token: jwtWithPayload({ webid: SERVICE_WEB_ID }),
          token_type: 'DPoP',
          webid: SERVICE_WEB_ID,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('Pod fetch must not run with a bare DPoP token');
    }) as typeof fetch;
    const provider = new ClientCredentialsInternalPodAccessTokenProvider({
      tokenEndpoint: 'https://issuer.example/.oidc/token',
      clientId: 'internal-client',
      clientSecret: 'internal-secret',
      fetchImpl,
    });

    await expect(provider.getTrustedFetch(WEB_ID)).rejects.toThrow(/Gateway internal service token must be Bearer/);
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
        return new Response(JSON.stringify({
          access_token: 'internal-token',
          token_type: 'Bearer',
          webid: SERVICE_WEB_ID,
        }), {
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
          findById: vi.fn(async () => structuredClone([...podRows.values()][0])),
          findByIri: vi.fn(),
          updateById: vi.fn(async (_resource, _id: string, patch: any) => {
            const row = [...podRows.values()][0];
            Object.assign(row, patch);
            return structuredClone(row);
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
