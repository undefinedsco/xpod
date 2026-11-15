import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';

/**
 * Real-crypto regression for the Local managed auth wiring.
 *
 * A Local managed runtime serves Cloud-issued canonical Pods while its own
 * loopback `solidBaseUrl` stays http://127.0.0.1:<port>/. Once a `publicUrl` has
 * been issued, the authenticator's canonical resource origin must be that same
 * verified authority; without one it must keep `solidBaseUrl` exactly.
 *
 * The issuer is deliberately DISTINCT from the resource origin: DPoP `htu` binds
 * to the resource request URI, not to the OIDC issuer.
 *
 * Only OIDC metadata/profile HTTP is stubbed; ES256 keys, the cnf-bound token and
 * the DPoP proof are genuinely signed and verified.
 */
const ISSUER = 'https://issuer.example/';
const CANONICAL = 'https://canonical.example/';
const LOOPBACK = 'http://127.0.0.1:39995/';
const ENDPOINT = 'api/applets/service-access/ai-connections';

let issuerKeys: { privateKey: KeyLike; publicJwk: JWK };

beforeAll(async () => {
  const keys = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(keys.publicKey) as JWK;
  publicJwk.kid = 'issuer-key';
  publicJwk.alg = 'ES256';
  issuerKeys = { privateKey: keys.privateKey, publicJwk };
});

afterEach(() => { vi.unstubAllGlobals(); });

function stubMetadata(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('openid-configuration')) {
      return new Response(JSON.stringify({ jwks_uri: `${ISSUER}.oidc/jwks` }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('jwks')) {
      return new Response(JSON.stringify({ keys: [issuerKeys.publicJwk] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      `<${ISSUER}alice/profile/card#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISSUER}> .`,
      { status: 200, headers: { 'content-type': 'text/turtle' } });
  }));
}

async function tokenAndProof(htu: string) {
  const webId = `${ISSUER}alice/profile/card#me`;
  const proofKeys = await generateKeyPair('ES256');
  const jkt = await calculateJwkThumbprint(await exportJWK(proofKeys.publicKey));
  const token = await new SignJWT({ webid: webId, client_id: 'c1', cnf: { jkt } })
    .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
    .setIssuer(ISSUER).setSubject(webId).setAudience('solid')
    .setIssuedAt().setExpirationTime('1h').sign(issuerKeys.privateKey);
  const proof = await new SignJWT({ htu, htm: 'GET', ath: createHash('sha256').update(token).digest('base64url') })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(proofKeys.publicKey) })
    .setJti(randomUUID()).setIssuedAt().sign(proofKeys.privateKey);
  return { token, proof, webId };
}

/** Canonical route headers pointing at `canonicalUrl`; physical request stays loopback. */
function headersFor(token: string, proof: string, canonicalUrl: string, localUrl: string) {
  const canonical = new URL(canonicalUrl);
  return {
    authorization: `DPoP ${token}`,
    dpop: proof,
    host: '127.0.0.1:39995',
    'x-forwarded-host': '127.0.0.1:39995',
    'x-forwarded-proto': 'http',
    'x-xpod-canonical-host': canonical.host,
    'x-xpod-canonical-origin': canonical.origin,
    'x-xpod-canonical-url': canonicalUrl,
    'x-xpod-local-route-url': localUrl,
  };
}

async function authenticatorFor(overrides: Partial<ApiContainerConfig>) {
  const config: ApiContainerConfig = {
    edition: 'local', port: 39995, host: '127.0.0.1', authMode: 'acp',
    databaseUrl: 'sqlite::memory:', corsOrigins: ['*'],
    solidBaseUrl: LOOPBACK,
    oidcIssuer: ISSUER,
    publicUrl: CANONICAL,
    cssTokenEndpoint: `${ISSUER}.oidc/token`,
    ...overrides,
  } as ApiContainerConfig;
  const container = createApiContainer(config);
  return await container.resolve('authenticator') as unknown as {
    authenticate(request: unknown): Promise<{ success: boolean; error?: string }>;
  };
}

const canonicalResource = `${CANONICAL}${ENDPOINT}`;
const loopbackResource = `${LOOPBACK}${ENDPOINT}`;

describe('Local managed canonical auth authority', () => {
  it('accepts a canonical-resource DPoP proof once the Cloud-issued publicUrl is present', async () => {
    stubMetadata();
    const { token, proof } = await tokenAndProof(canonicalResource);
    const authenticators = await authenticatorFor({});
    const result = await authenticators.authenticate({
      method: 'GET', url: `/${ENDPOINT}`,
      headers: headersFor(token, proof, canonicalResource, loopbackResource),
    });
    expect(result.success).toBe(true);
  });

  it('keeps solidBaseUrl authority for local standalone when publicUrl is undefined', async () => {
    stubMetadata();
    const { token, proof } = await tokenAndProof(loopbackResource);
    const authenticators = await authenticatorFor({ edition: 'local', publicUrl: undefined });
    const result = await authenticators.authenticate({
      method: 'GET', url: `/${ENDPOINT}`,
      headers: { authorization: `DPoP ${token}`, dpop: proof, host: '127.0.0.1:39995' },
    });
    expect(result.success).toBe(true);
  });

  it('uses solidBaseUrl for cloud edition even when publicUrl differs', async () => {
    stubMetadata();
    // Cloud publishes its canonical identity origin AS solidBaseUrl; a divergent
    // publicUrl must not move the authenticator's authority.
    const cloudSolid = CANONICAL;
    const { token, proof } = await tokenAndProof(canonicalResource);
    const authenticators = await authenticatorFor({
      edition: 'cloud', solidBaseUrl: cloudSolid, publicUrl: 'https://other.example/',
    });
    const result = await authenticators.authenticate({
      method: 'GET', url: `/${ENDPOINT}`,
      headers: headersFor(token, proof, canonicalResource, canonicalResource),
    });
    expect(result.success).toBe(true);
  });

  it('rejects when no authority is configured (helper default must not be invented)', async () => {
    stubMetadata();
    const { token, proof } = await tokenAndProof('http://localhost:3000/' + ENDPOINT);
    const authenticators = await authenticatorFor({ edition: 'local', publicUrl: undefined, solidBaseUrl: undefined });
    const result = await authenticators.authenticate({
      method: 'GET', url: `/${ENDPOINT}`,
      headers: headersFor(token, proof, 'http://localhost:3000/' + ENDPOINT, loopbackResource),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a foreign proof AND foreign canonical headers', async () => {
    stubMetadata();
    const foreign = 'https://foreign.example/' + ENDPOINT;
    const { token, proof } = await tokenAndProof(foreign);
    const authenticators = await authenticatorFor({});
    const result = await authenticators.authenticate({
      method: 'GET', url: `/${ENDPOINT}`,
      headers: headersFor(token, proof, foreign, `${LOOPBACK}${ENDPOINT}`),
    });
    expect(result.success).toBe(false);
  });
});
