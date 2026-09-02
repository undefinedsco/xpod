import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, TargetExtractor } from '@solid/community-server';
import {
  ConfiguredLoopbackDPoPWebIdExtractor,
  deriveCssLoopbackBaseUrl,
} from '../../src/authentication/ConfiguredLoopbackDPoPWebIdExtractor';
import { createGatewayAdminProxyHeaders } from '../../src/runtime/GatewayAdminProxyAuth';

let server: Server;
let origin: string;
let issuer: string;
let webId: string;
let requestUrl: string;
let issuerPrivateKey: KeyLike;
let issuerPublicJwk: JWK;
let dpopPrivateKey: KeyLike;
let dpopPublicJwk: JWK;

const gatewayAdminProxyAuthSecret = 'configured-loopback-dpop-proxy-secret';
const canonicalIssuer = 'https://identity.example/';

beforeAll(async() => {
  const issuerKeys = await generateKeyPair('ES256');
  issuerPrivateKey = issuerKeys.privateKey;
  issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
  issuerPublicJwk.kid = 'issuer-key';
  issuerPublicJwk.alg = 'ES256';

  const dpopKeys = await generateKeyPair('ES256');
  dpopPrivateKey = dpopKeys.privateKey;
  dpopPublicJwk = await exportJWK(dpopKeys.publicKey);

  server = createServer((request, response) => {
    if (request.url === '/test/profile/card') {
      const forwardedHost = request.headers['x-forwarded-host'];
      const forwardedProto = request.headers['x-forwarded-proto'];
      const profileWebId = typeof forwardedHost === 'string'
        ? `${typeof forwardedProto === 'string' ? forwardedProto : 'https'}://${forwardedHost}/test/profile/card#me`
        : webId;
      const profileIssuer = typeof forwardedHost === 'string' ? canonicalIssuer : issuer;
      response.setHeader('content-type', 'text/turtle');
      response.end(`<${profileWebId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${profileIssuer}> .`);
      return;
    }
    if (request.url === '/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer, jwks_uri: `${origin}/jwks` }));
      return;
    }
    if (request.url === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [ issuerPublicJwk ] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP test server address');
  }
  origin = `http://127.0.0.1:${address.port}`;
  issuer = `${origin}/`;
  webId = `${origin}/test/profile/card#me`;
  requestUrl = `${origin}/test/settings/-/sparql`;
});

afterAll(async() => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ConfiguredLoopbackDPoPWebIdExtractor', () => {
  it('extracts credentials from a fully verified DPoP token on the configured 127/8 origin', async() => {
    const { accessToken, dpopProof } = await createDpopCredentials();
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: requestUrl })),
    } as unknown as TargetExtractor;
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);
    const request = createRequest(accessToken, dpopProof);

    await expect(extractor.handleSafe(request)).resolves.toEqual({
      agent: { webId },
      client: { clientId: 'desktop-client' },
      issuer: { url: issuer },
    });
    expect(targetExtractor.handleSafe).toHaveBeenCalledWith({ request });

    await expect(extractor.handleSafe(request)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a DPoP request URL from any origin other than the configured CSS origin', async() => {
    const { accessToken, dpopProof } = await createDpopCredentials();
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: requestUrl.replace('127.0.0.1', '127.0.0.2') })),
    } as unknown as TargetExtractor;
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createRequest(accessToken, dpopProof))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('does not match the configured HTTP loopback origin'),
    });
  });

  it('accepts a loopback local route DPoP proof for a matching Cloud canonical target', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
    }))).resolves.toMatchObject({
      agent: { webId },
      client: { clientId: 'desktop-client' },
    });
  });

  it('dereferences a managed canonical WebID through the internal CSS origin', async() => {
    const canonicalOrigin = 'https://managed-node.example';
    const canonicalWebId = `${canonicalOrigin}/test/profile/card#me`;
    const canonicalRequestUrl = `${canonicalOrigin}/test/settings/-/sparql`;
    const { accessToken, dpopProof } = await createDpopCredentials(
      canonicalRequestUrl,
      canonicalWebId,
      canonicalIssuer,
    );
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalRequestUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('CSS_PORT', new URL(origin).port);
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async(input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === `${canonicalIssuer}.well-known/openid-configuration`) {
        return new Response(JSON.stringify({ issuer: canonicalIssuer, jwks_uri: `${canonicalIssuer}jwks` }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === `${canonicalIssuer}jwks`) {
        return new Response(JSON.stringify({ keys: [ issuerPublicJwk ] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return nativeFetch(input, init);
    }));
    try {
      const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, `${canonicalOrigin}/`);

      await expect(extractor.handleSafe(createRequest(accessToken, dpopProof))).resolves.toEqual({
        agent: { webId: canonicalWebId },
        client: { clientId: 'desktop-client' },
        issuer: { url: canonicalIssuer },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('derives the private CSS route only from the allocated CSS port', () => {
    expect(deriveCssLoopbackBaseUrl('3001')).toBe('http://127.0.0.1:3001/');
    expect(deriveCssLoopbackBaseUrl(undefined)).toBeUndefined();
    expect(deriveCssLoopbackBaseUrl('not-a-port')).toBeUndefined();
    expect(deriveCssLoopbackBaseUrl('70000')).toBeUndefined();
  });

  it('accepts a signed loopback proxy marker when the Unix socket peer has no remoteAddress', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', gatewayAdminProxyAuthSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createTrustedProxyHeaders(requestPath()),
    }))).resolves.toMatchObject({
      agent: { webId },
      client: { clientId: 'desktop-client' },
    });
  });

  it('rejects Unix socket local-route fallback without a valid signed loopback proxy marker', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', gatewayAdminProxyAuthSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
    }))).rejects.toMatchObject({ statusCode: 400 });

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createGatewayAdminProxyHeaders({
        secret: 'wrong-secret',
        method: 'POST',
        url: requestPath(),
        originalClientLoopback: true,
      }),
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a signed proxy marker when the original client was not loopback', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', gatewayAdminProxyAuthSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createTrustedProxyHeaders(requestPath(), { originalClientLoopback: false }),
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects signed proxy markers bound to a different path or method', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', gatewayAdminProxyAuthSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createTrustedProxyHeaders('/tampered'),
    }))).rejects.toMatchObject({ statusCode: 400 });

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createTrustedProxyHeaders(requestPath(), { method: 'GET' }),
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('still rejects an invalid DPoP proof even with a valid signed loopback proxy marker', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(`${origin}/tampered`);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    vi.stubEnv('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET', gatewayAdminProxyAuthSecret);
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createUnixSocketRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': canonicalUrl,
      'x-xpod-local-route-url': localRouteUrl,
      ...createTrustedProxyHeaders(requestPath()),
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('does not trust a local route DPoP proof when the canonical route header does not match the CSS target', async() => {
    const canonicalUrl = 'https://node.example/test/settings/-/sparql';
    const localRouteUrl = requestUrl;
    const { accessToken, dpopProof } = await createDpopCredentials(localRouteUrl);
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: canonicalUrl })),
    } as unknown as TargetExtractor;
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe(createRequest(accessToken, dpopProof, {
      'x-xpod-canonical-url': 'https://other.example/test/settings/-/sparql',
      'x-xpod-local-route-url': localRouteUrl,
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps the CSS extractor contract for unsupported schemes and missing DPoP proofs', async() => {
    const targetExtractor = {
      handleSafe: vi.fn(async() => ({ path: requestUrl })),
    } as unknown as TargetExtractor;
    const extractor = new ConfiguredLoopbackDPoPWebIdExtractor(targetExtractor, issuer);

    await expect(extractor.handleSafe({
      headers: { authorization: 'Bearer token' },
      method: 'GET',
    } as HttpRequest)).rejects.toMatchObject({ statusCode: 501 });
    await expect(extractor.handleSafe({
      headers: { authorization: 'DPoP token' },
      method: 'GET',
    } as HttpRequest)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('configured loopback DPoP component wiring', () => {
  it('overrides only the default CSS DPoP extractor and injects the current base URL', async() => {
    const config = JSON.parse(await readFile('config/xpod.base.json', 'utf8')) as {
      '@graph': Array<Record<string, unknown>>;
    };
    const override = config['@graph'].find((entry) => {
      const instance = entry.overrideInstance as { '@id'?: string } | undefined;
      return instance?.['@id'] === 'urn:solid-server:default:DPoPWebIdExtractor';
    });

    expect(override).toMatchObject({
      '@type': 'Override',
      overrideParameters: {
        '@type': 'ConfiguredLoopbackDPoPWebIdExtractor',
        originalUrlExtractor: { '@id': 'urn:solid-server:default:DPoPUrlExtractor' },
        baseUrl: {
          '@id': 'urn:solid-server:default:variable:baseUrl',
          '@type': 'Variable',
        },
      },
    });
  });
});

async function createDpopCredentials(
  htu = requestUrl,
  tokenWebId = webId,
  tokenIssuer = issuer,
): Promise<{ accessToken: string; dpopProof: string }> {
  const thumbprint = await calculateJwkThumbprint(dpopPublicJwk);
  const accessToken = await new SignJWT({
    webid: tokenWebId,
    client_id: 'desktop-client',
    cnf: { jkt: thumbprint },
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
    .setIssuer(tokenIssuer)
    .setAudience('solid')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(issuerPrivateKey);
  const dpopProof = await new SignJWT({
    htm: 'POST',
    htu,
    jti: `jti-${crypto.randomUUID()}`,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: dpopPublicJwk })
    .setIssuedAt()
    .sign(dpopPrivateKey);
  return { accessToken, dpopProof };
}

function createRequest(
  accessToken: string,
  dpopProof: string,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): HttpRequest {
  return {
    headers: {
      authorization: `DPoP ${accessToken}`,
      dpop: dpopProof,
      ...headers,
    },
    method: 'POST',
    url: requestPath(),
    socket: { remoteAddress },
  } as unknown as HttpRequest;
}

function createUnixSocketRequest(
  accessToken: string,
  dpopProof: string,
  headers: Record<string, string> = {},
): HttpRequest {
  return {
    ...createRequest(accessToken, dpopProof, headers),
    socket: {},
  } as unknown as HttpRequest;
}

function createTrustedProxyHeaders(
  url: string,
  options: { method?: string; originalClientLoopback?: boolean } = {},
): Record<string, string> {
  return createGatewayAdminProxyHeaders({
    secret: gatewayAdminProxyAuthSecret,
    method: options.method ?? 'POST',
    url,
    originalClientLoopback: options.originalClientLoopback ?? true,
  }) as Record<string, string>;
}

function requestPath(): string {
  return new URL(requestUrl).pathname;
}
