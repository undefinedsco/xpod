import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';

const WEB_ID = 'https://storage.example/alice/profile/card#me';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API container Solid client credential issuer', () => {
  it.each([
    {
      name: 'managed Local with a distinct loopback Cloud issuer',
      edition: 'local' as const,
      solidBaseUrl: 'http://localhost:39995/',
      oidcIssuer: 'http://localhost:39005/',
      cssTokenEndpoint: 'http://localhost:39005/.oidc/token',
      proofUrl: 'http://localhost:39005/.oidc/token',
      forwardedHost: null,
    },
    {
      name: 'Cloud reaching its canonical identity interface through an internal alias',
      edition: 'cloud' as const,
      solidBaseUrl: 'https://id.example/',
      oidcIssuer: 'https://id.example/',
      cssTokenEndpoint: 'http://127.0.0.1:6401/.oidc/token',
      proofUrl: 'https://id.example/.oidc/token',
      forwardedHost: 'id.example',
    },
    {
      name: 'standalone without an external issuer reaching its own internal CSS alias',
      edition: 'local' as const,
      solidBaseUrl: 'https://pod.example/',
      cssTokenEndpoint: 'http://127.0.0.1:6501/.oidc/token',
      proofUrl: 'https://pod.example/.oidc/token',
      forwardedHost: 'pod.example',
    },
    {
      name: 'managed Local with a remote HTTPS Cloud issuer',
      edition: 'local' as const,
      solidBaseUrl: 'https://storage.example/',
      oidcIssuer: 'https://id.example/',
      cssTokenEndpoint: 'https://id.example/.oidc/token',
      proofUrl: 'https://id.example/.oidc/token',
      forwardedHost: null,
    },
  ])('binds the credential proof to its issuer for $name', async (deployment) => {
    const request = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'unit-test-token', token_type: 'DPoP', expires_in: 3600, webid: WEB_ID,
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const config: ApiContainerConfig = {
      edition: deployment.edition, port: 3001, host: '127.0.0.1', authMode: 'acp',
      databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
      cssTokenEndpoint: deployment.cssTokenEndpoint, solidBaseUrl: deployment.solidBaseUrl,
      ...('oidcIssuer' in deployment ? { oidcIssuer: deployment.oidcIssuer } : {}),
    };
    const container = createApiContainer(config);
    try {
      const session = await container.resolve('solidSessions').session({
        clientId: 'test-client', clientSecret: 'test-secret',
      });
      expect(session.webId).toBe(WEB_ID);
      expect(request).toHaveBeenCalledOnce();
      const [url, init] = request.mock.calls[0]!;
      expect(url).toBe(deployment.cssTokenEndpoint);
      const headers = new Headers(init?.headers);
      const proof = JSON.parse(Buffer.from(headers.get('dpop')!.split('.')[1]!, 'base64url').toString('utf8'));
      expect(proof.htu).toBe(deployment.proofUrl);
      expect(headers.get('x-forwarded-host')).toBe(deployment.forwardedHost);
      expect(headers.get('x-forwarded-proto')).toBe(deployment.forwardedHost ? 'https' : null);
    } finally {
      await container.dispose();
    }
  });
});

describe('API container internal WebID/JWKS origin', () => {
  let privateKey: KeyLike;
  let publicJwk: JWK;

  beforeAll(async() => {
    const keys = await generateKeyPair('ES256');
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'issuer-key';
    publicJwk.alg = 'ES256';
  });

  it.each([
    // Socket transport sets no gateway port: the runtime maps its canonical origin onto the
    // owned gateway socket, so WebID/JWKS dereference must resolve through that canonical
    // origin, never a foreign loopback port.
    { name: 'socket', edition: 'local' as const, base: 'http://localhost/', mainPort: undefined, expected: 'http://localhost' },
    // A gateway port keeps the internal service alias unchanged.
    { name: 'port', edition: 'local' as const, base: 'http://localhost:63200/', mainPort: '43127', expected: 'http://127.0.0.1:43127' },
    // Cloud keeps its canonical public URL while the internal hop stays on the gateway port.
    { name: 'cloud', edition: 'cloud' as const, base: 'https://node.example/', mainPort: '43127', expected: 'http://127.0.0.1:43127' },
  ])('resolves internal dereference through $expected in $name mode', async({ edition, base, mainPort, expected }) => {
    const savedMainPort = process.env.XPOD_MAIN_PORT;
    if (mainPort === undefined) {
      delete process.env.XPOD_MAIN_PORT;
    } else {
      process.env.XPOD_MAIN_PORT = mainPort;
    }

    const origins: string[] = [];
    const webId = `${base}test/profile/card#me`;
    vi.stubGlobal('fetch', vi.fn(async(input: RequestInfo | URL) => {
      const url = String(input);
      origins.push(new URL(url).origin);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ issuer: base, jwks_uri: `${base}jwks` });
      }
      if (url.endsWith('/jwks')) {
        return Response.json({ keys: [ publicJwk ] });
      }
      return new Response(`<${webId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${base}> .`, {
        headers: { 'content-type': 'text/turtle' },
      });
    }));

    const config: ApiContainerConfig = {
      edition, port: 3001, host: '127.0.0.1', authMode: 'acp',
      databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
      cssTokenEndpoint: `${base}.oidc/token`, solidBaseUrl: base,
      gatewayLocatorSecret: 'unit-test-locator-secret-000000000000',
    };
    const container = createApiContainer(config);
    try {
      const token = await new SignJWT({ webid: webId, client_id: 'probe-client' })
        .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
        .setIssuer(base).setSubject(webId).setAudience('solid')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      const authenticator = container.resolve('authenticator') as unknown as {
        authenticate: (request: unknown) => Promise<{ success: boolean }>;
      };
      const result = await authenticator.authenticate({
        headers: { authorization: `Bearer ${token}`, host: new URL(base).host },
        method: 'PUT', url: '/test/profile/card', socket: { remoteAddress: '127.0.0.1' },
      });

      expect(result.success).toBe(true);
      expect(new Set(origins)).toEqual(new Set([ expected ]));
      expect(origins).not.toContain('http://127.0.0.1:3000');
    } finally {
      await container.dispose();
      if (savedMainPort === undefined) {
        delete process.env.XPOD_MAIN_PORT;
      } else {
        process.env.XPOD_MAIN_PORT = savedMainPort;
      }
    }
  });
});
