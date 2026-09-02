import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SolidTokenAuthenticator } from '../../../src/api/auth/SolidTokenAuthenticator';
import { GatewayProxy, getFreePort } from '../../../src/runtime';
import { Supervisor } from '../../../src/supervisor/Supervisor';

const issuer = 'http://127.0.0.1:3000/';
const webId = 'http://127.0.0.1:3000/test/profile/card#me';
const profileUrl = 'http://127.0.0.1:3000/test/profile/card';
const internalOrigin = 'http://127.0.0.1:5737';
const canonicalIssuer = 'https://acceptance-local.nodes.acceptance.test/';
const canonicalWebId = `${canonicalIssuer}test/profile/card#me`;

let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async() => {
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey) as JWK;
  publicJwk.kid = 'issuer-key';
  publicJwk.alg = 'ES256';
});

function signAccessToken(options: {
  issuer?: string;
  webId?: string;
  dpopJkt?: string;
} = {}): Promise<string> {
  const tokenIssuer = options.issuer ?? issuer;
  const tokenWebId = options.webId ?? webId;
  return new SignJWT({
    webid: tokenWebId,
    client_id: 'client-1',
    ...(options.dpopJkt ? { cnf: { jkt: options.dpopJkt } } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
    .setIssuer(tokenIssuer)
    .setSubject(tokenWebId)
    .setAudience('solid')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function signDpopProof(input: {
  accessToken: string;
  htu: string;
  htm: string;
  publicKey: KeyLike;
  privateKey: KeyLike;
}): Promise<string> {
  return new SignJWT({
    htu: input.htu,
    htm: input.htm,
    ath: createHash('sha256').update(input.accessToken).digest('base64url'),
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: await exportJWK(input.publicKey),
    })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(input.privateKey);
}

function profileTurtle(input: { webId?: string; issuer?: string } = {}): string {
  return `<${input.webId ?? webId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${input.issuer ?? issuer}> .`;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SolidTokenAuthenticator internal dereference', () => {
  it('rewrites dereference to the internal origin while forwarding the public host', async() => {
    const calls: { url: string; host?: string; proto?: string }[] = [];
    const fetchMock = vi.fn(async(input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        host: headers.get('x-forwarded-host') ?? undefined,
        proto: headers.get('x-forwarded-proto') ?? undefined,
      });
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse({ jwks_uri: `${issuer}.oidc/jwks` });
      }
      if (url.includes('/.oidc/jwks')) {
        return jsonResponse({ keys: [ publicJwk ] } satisfies JSONWebKeySet);
      }
      return new Response(profileTurtle(), { status: 200, headers: { 'content-type': 'text/turtle' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: issuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const token = await signAccessToken();
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/api/ai/client-configuration/capability',
        headers: {
          authorization: `Bearer ${token}`,
          host: '127.0.0.1:3000',
        },
      } as never);

      expect(result.success).toBe(true);
      // Every dereference/discovery request must hit the internal origin while
      // carrying the public host so CSS keeps identifiers inside its space.
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.url.startsWith(internalOrigin)).toBe(true);
        expect(call.host).toBe('127.0.0.1:3000');
        expect(call.proto).toBe('http');
      }
      expect(calls.some((call) => call.url === `${internalOrigin}/test/profile/card`)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries a transient WebID ACL miss during first-login bootstrap', async() => {
    let profileAttempts = 0;
    const fetchMock = vi.fn(async(input: unknown) => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse({ jwks_uri: `${issuer}.oidc/jwks` });
      }
      if (url.includes('/.oidc/jwks')) {
        return jsonResponse({ keys: [ publicJwk ] } satisfies JSONWebKeySet);
      }
      profileAttempts += 1;
      if (profileAttempts === 1) {
        return new Response('ACL not visible yet', { status: 401 });
      }
      return new Response(profileTurtle(), { status: 200, headers: { 'content-type': 'text/turtle' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: issuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `Bearer ${await signAccessToken()}`,
          host: '127.0.0.1:3000',
        },
      } as never);

      expect(result.success).toBe(true);
      expect(profileAttempts).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('dereferences the public origin directly when no internal base URL is configured', async() => {
    const calls: { url: string; host?: string }[] = [];
    const fetchMock = vi.fn(async(input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, host: headers.get('x-forwarded-host') ?? undefined });
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse({ jwks_uri: `${issuer}.oidc/jwks` });
      }
      if (url.includes('/.oidc/jwks')) {
        return jsonResponse({ keys: [ publicJwk ] } satisfies JSONWebKeySet);
      }
      return new Response(profileTurtle(), { status: 200, headers: { 'content-type': 'text/turtle' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const authenticator = new SolidTokenAuthenticator({ publicBaseUrl: issuer });
      const token = await signAccessToken();
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `Bearer ${token}`,
          host: '127.0.0.1:3000',
        },
      } as never);

      expect(result.success).toBe(true);
      for (const call of calls) {
        expect(call.url.startsWith(issuer)).toBe(true);
        expect(call.host).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifies a canonical DPoP signature for a request transported over a local route', async() => {
    stubCanonicalFetch();
    const proofKeys = await generateKeyPair('ES256');
    const accessToken = await signAccessToken({
      issuer: canonicalIssuer,
      webId: canonicalWebId,
      dpopJkt: await calculateJwkThumbprint(await exportJWK(proofKeys.publicKey)),
    });
    const canonicalUrl = `${canonicalIssuer}v1/models`;
    const proof = await signDpopProof({
      accessToken,
      htu: canonicalUrl,
      htm: 'GET',
      publicKey: proofKeys.publicKey,
      privateKey: proofKeys.privateKey,
    });

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          host: '127.0.0.1:16310',
          'x-forwarded-host': '127.0.0.1:16310',
          'x-forwarded-proto': 'http',
          'x-xpod-canonical-host': 'acceptance-local.nodes.acceptance.test',
          'x-xpod-canonical-origin': 'https://acceptance-local.nodes.acceptance.test',
          'x-xpod-canonical-url': canonicalUrl,
          'x-xpod-local-route-url': 'http://127.0.0.1:16310/v1/models',
        },
      } as never);

      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects canonical DPoP local route proofs with a mismatched request path', async() => {
    stubCanonicalFetch();
    const { accessToken, proof } = await signedCanonicalRequest('GET', `${canonicalIssuer}v1/models`);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: canonicalRouteHeaders({
          accessToken,
          proof,
          canonicalUrl: `${canonicalIssuer}v1/other`,
          localRouteUrl: 'http://127.0.0.1:16310/v1/models',
        }),
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects canonical DPoP local route proofs signed for a different method', async() => {
    stubCanonicalFetch();
    const canonicalUrl = `${canonicalIssuer}v1/models`;
    const { accessToken, proof } = await signedCanonicalRequest('POST', canonicalUrl);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: canonicalRouteHeaders({ accessToken, proof, canonicalUrl }),
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects canonical DPoP local route proofs signed for a foreign origin', async() => {
    stubCanonicalFetch();
    const foreignUrl = 'https://foreign.nodes.acceptance.test/v1/models';
    const { accessToken, proof } = await signedCanonicalRequest('GET', foreignUrl);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: canonicalRouteHeaders({
          accessToken,
          proof,
          canonicalUrl: foreignUrl,
          canonicalHost: 'foreign.nodes.acceptance.test',
          canonicalOrigin: 'https://foreign.nodes.acceptance.test',
        }),
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves HTTPS API ingress as the primary DPoP verification target when CSS publicBaseUrl differs', async() => {
    stubCanonicalFetch();
    const apiUrl = 'https://api.acceptance-local.nodes.acceptance.test/v1/models';
    const { accessToken, proof } = await signedCanonicalRequest('GET', apiUrl);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          host: 'api.acceptance-local.nodes.acceptance.test',
          'x-forwarded-host': 'api.acceptance-local.nodes.acceptance.test',
          'x-forwarded-proto': 'https',
        },
      } as never);

      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects no-hint configured canonical alias proofs with a mismatched request path', async() => {
    stubCanonicalFetch();
    const { accessToken, proof } = await signedCanonicalRequest('GET', `${canonicalIssuer}v1/other`);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          host: '127.0.0.1:5173',
          'x-forwarded-host': '127.0.0.1:5173',
          'x-forwarded-proto': 'http',
        },
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects no-hint configured canonical alias proofs signed for a different method', async() => {
    stubCanonicalFetch();
    const { accessToken, proof } = await signedCanonicalRequest('POST', `${canonicalIssuer}v1/models`);

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          host: '127.0.0.1:5173',
          'x-forwarded-host': '127.0.0.1:5173',
          'x-forwarded-proto': 'http',
        },
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects no-hint configured canonical alias proofs signed for a foreign origin', async() => {
    stubCanonicalFetch();
    const { accessToken, proof } = await signedCanonicalRequest(
      'GET',
      'https://foreign.nodes.acceptance.test/v1/models',
    );

    try {
      const authenticator = new SolidTokenAuthenticator({
        publicBaseUrl: canonicalIssuer,
        internalBaseUrl: `${internalOrigin}/.oidc/token`,
      });
      const result = await authenticator.authenticate({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `DPoP ${accessToken}`,
          dpop: proof,
          host: '127.0.0.1:5173',
          'x-forwarded-host': '127.0.0.1:5173',
          'x-forwarded-proto': 'http',
        },
      } as never);

      expect(result.success).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    '/api/ai/client-configuration/capability',
    '/v1/models',
  ])('verifies canonical DPoP through GatewayProxy after Docker bridge ingress strips local-route hints: %s', async(pathname) => {
    const realFetch = globalThis.fetch;
    stubCanonicalFetch();
    const gatewayPort = await getFreePort(48000, '127.0.0.1');
    const apiPort = await getFreePort(gatewayPort + 1, '127.0.0.1');
    const authenticator = new SolidTokenAuthenticator({
      publicBaseUrl: canonicalIssuer,
      internalBaseUrl: `${internalOrigin}/.oidc/token`,
    });
    const seenHeaders: http.IncomingHttpHeaders[] = [];
    const apiServer = http.createServer(async(request, response) => {
      seenHeaders.push(request.headers);
      const result = await authenticator.authenticate(request);
      response.statusCode = result.success ? 200 : 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ authenticated: result.success }));
    });
    const gateway = new GatewayProxy(gatewayPort, new Supervisor(), '127.0.0.1', {
      baseUrl: canonicalIssuer,
      clientRemoteAddressResolver: () => '172.17.0.1',
    });

    try {
      await listen(apiServer, apiPort);
      gateway.setTargets({ api: `http://127.0.0.1:${apiPort}` });
      await gateway.start();
      const canonicalUrl = new URL(pathname, canonicalIssuer).href;
      const { accessToken, proof } = await signedCanonicalRequest('GET', canonicalUrl);
      const response = await realFetch(`http://127.0.0.1:${gatewayPort}${pathname}`, {
        headers: canonicalRouteHeaders({
          accessToken,
          proof,
          canonicalUrl,
          forwardedHost: '127.0.0.1:5173',
          localRouteUrl: `http://127.0.0.1:5173${pathname}`,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ authenticated: true });
      expect(seenHeaders).toHaveLength(1);
      expect(seenHeaders[0]['x-xpod-canonical-url']).toBeUndefined();
      expect(seenHeaders[0]['x-xpod-local-route-url']).toBeUndefined();
      expect(seenHeaders[0]['x-forwarded-host']).toBe('127.0.0.1:5173');
    } finally {
      await gateway.stop().catch(() => undefined);
      await close(apiServer).catch(() => undefined);
      vi.unstubAllGlobals();
    }
  });
});

async function signedCanonicalRequest(method: string, htu: string): Promise<{ accessToken: string; proof: string }> {
  const proofKeys = await generateKeyPair('ES256');
  const accessToken = await signAccessToken({
    issuer: canonicalIssuer,
    webId: canonicalWebId,
    dpopJkt: await calculateJwkThumbprint(await exportJWK(proofKeys.publicKey)),
  });
  const proof = await signDpopProof({
    accessToken,
    htu,
    htm: method,
    publicKey: proofKeys.publicKey,
    privateKey: proofKeys.privateKey,
  });
  return { accessToken, proof };
}

function canonicalRouteHeaders(input: {
  accessToken: string;
  proof: string;
  canonicalUrl: string;
  canonicalHost?: string;
  canonicalOrigin?: string;
  forwardedHost?: string;
  localRouteUrl?: string;
}): Record<string, string> {
  return {
    authorization: `DPoP ${input.accessToken}`,
    dpop: input.proof,
    host: '127.0.0.1:16310',
    'x-forwarded-host': input.forwardedHost ?? '127.0.0.1:16310',
    'x-forwarded-proto': 'http',
    'x-xpod-canonical-host': input.canonicalHost ?? 'acceptance-local.nodes.acceptance.test',
    'x-xpod-canonical-origin': input.canonicalOrigin ?? 'https://acceptance-local.nodes.acceptance.test',
    'x-xpod-canonical-url': input.canonicalUrl,
    'x-xpod-local-route-url': input.localRouteUrl ?? 'http://127.0.0.1:16310/v1/models',
  };
}

function stubCanonicalFetch(): void {
  const fetchMock = vi.fn(async(input: unknown) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return jsonResponse({ jwks_uri: `${canonicalIssuer}.oidc/jwks` });
    }
    if (url.includes('/.oidc/jwks')) {
      return jsonResponse({ keys: [ publicJwk ] } satisfies JSONWebKeySet);
    }
    return new Response(profileTurtle({ webId: canonicalWebId, issuer: canonicalIssuer }), {
      status: 200,
      headers: { 'content-type': 'text/turtle' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
