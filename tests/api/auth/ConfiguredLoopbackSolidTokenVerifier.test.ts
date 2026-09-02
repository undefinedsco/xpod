import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JSONWebKeySet,
  type KeyLike,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RetrieveIssuerKeySetFunction } from '@solid/access-token-verifier/dist/type';
import {
  configuredHttpLoopbackOrigin,
  createConfiguredLoopbackSolidTokenVerifier,
} from '../../../src/api/auth/ConfiguredLoopbackSolidTokenVerifier';

const issuer = 'http://127.0.0.1:3000/';
const webId = 'http://127.0.0.1:3000/test/profile/card#me';
let privateKey: KeyLike;
let publicKeySet: Awaited<ReturnType<RetrieveIssuerKeySetFunction>>;

beforeAll(async() => {
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey) as JWK;
  publicJwk.kid = 'issuer-key';
  publicJwk.alg = 'ES256';
  publicKeySet = createLocalJWKSet({ keys: [ publicJwk ] } as JSONWebKeySet) as unknown as Awaited<ReturnType<RetrieveIssuerKeySetFunction>>;
});

describe('ConfiguredLoopbackSolidTokenVerifier', () => {
  it('accepts a signed Solid token only for the configured HTTP loopback origin', async() => {
    const getIssuers = vi.fn(async() => [ issuer ]);
    const getKeySet = vi.fn(async() => publicKeySet);
    const verifier = createConfiguredLoopbackSolidTokenVerifier({
      allowedHttpOrigin: issuer,
      getIssuers,
      getKeySet,
    });
    const token = await signAccessToken({ issuer, webId });

    await expect(verifier(`Bearer ${token}`)).resolves.toMatchObject({
      aud: 'solid',
      iss: issuer,
      webid: webId,
    });
    expect(getIssuers).toHaveBeenCalledWith(webId);
    expect(getKeySet).toHaveBeenCalledWith(issuer);
  });

  it('rejects another loopback origin and non-loopback HTTP claims', async() => {
    const verifier = createConfiguredLoopbackSolidTokenVerifier({
      allowedHttpOrigin: issuer,
      getIssuers: async() => [ issuer ],
      getKeySet: async() => publicKeySet,
    });
    const wrongPort = await signAccessToken({
      issuer: 'http://127.0.0.1:3001/',
      webId: 'http://127.0.0.1:3001/test/profile/card#me',
    });
    const lan = await signAccessToken({
      issuer: 'http://192.168.1.9:3000/',
      webId: 'http://192.168.1.9:3000/test/profile/card#me',
    });

    await expect(verifier(`Bearer ${wrongPort}`)).rejects.toThrow('could not be verified as secure');
    await expect(verifier(`Bearer ${lan}`)).rejects.toThrow('could not be verified as secure');
  });

  it('keeps issuer trust, signature, audience, expiry, and DPoP binding checks enabled', async() => {
    const verifier = createConfiguredLoopbackSolidTokenVerifier({
      allowedHttpOrigin: issuer,
      getIssuers: async() => [ 'http://127.0.0.1:3000/another-issuer' ],
      getKeySet: async() => publicKeySet,
    });
    const token = await signAccessToken({ issuer, webId });
    await expect(verifier(`Bearer ${token}`)).rejects.toThrow();

    const trustedVerifier = createConfiguredLoopbackSolidTokenVerifier({
      allowedHttpOrigin: issuer,
      getIssuers: async() => [ issuer ],
      getKeySet: async() => publicKeySet,
    });
    const wrongAudience = await signAccessToken({ issuer, webId, audience: 'not-solid' });
    const expired = await signAccessToken({ issuer, webId, expiresAt: Math.floor(Date.now() / 1000) - 300 });
    const dpopBound = await signAccessToken({ issuer, webId, cnf: { jkt: 'required-thumbprint' } });
    const [ header, payload, signature ] = token.split('.');
    const tampered = `${header}.${payload}.${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;

    await expect(trustedVerifier(`Bearer ${wrongAudience}`)).rejects.toThrow();
    await expect(trustedVerifier(`Bearer ${expired}`)).rejects.toThrow();
    await expect(trustedVerifier(`Bearer ${tampered}`)).rejects.toThrow();
    await expect(trustedVerifier(`Bearer ${dpopBound}`)).rejects.toThrow('DPoP options missing');
  });
});

describe('configuredHttpLoopbackOrigin', () => {
  it('returns only explicit HTTP loopback IP origins', () => {
    expect(configuredHttpLoopbackOrigin('http://127.42.1.7:3000/path')).toBe('http://127.42.1.7:3000');
    expect(configuredHttpLoopbackOrigin('http://[::1]:3000/path')).toBe('http://[::1]:3000');
    expect(configuredHttpLoopbackOrigin('http://localhost:3000/')).toBeUndefined();
    expect(configuredHttpLoopbackOrigin('http://192.168.1.2:3000/')).toBeUndefined();
    expect(configuredHttpLoopbackOrigin('https://127.0.0.1:3000/')).toBeUndefined();
  });
});

async function signAccessToken({
  issuer: tokenIssuer,
  webId: tokenWebId,
  audience = 'solid',
  expiresAt = Math.floor(Date.now() / 1000) + 300,
  cnf,
}: {
  issuer: string;
  webId: string;
  audience?: string;
  expiresAt?: number;
  cnf?: { jkt: string };
}): Promise<string> {
  return new SignJWT({ webid: tokenWebId, ...(cnf ? { cnf } : {}) })
    .setProtectedHeader({ alg: 'ES256', kid: 'issuer-key' })
    .setIssuer(tokenIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey);
}
