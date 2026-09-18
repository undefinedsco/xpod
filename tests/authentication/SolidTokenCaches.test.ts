import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose';
import { createRoutedSolidTokenCaches } from '../../src/authentication/SolidTokenCaches';

const TTL_MS = 15 * 60 * 1_000;
const ISSUER = 'https://issuer.example/';
const WEB_ID = 'https://pod.example/profile/card#me';
const kinds = [ 'WebID', 'issuer' ] as const;
type CacheKind = typeof kinds[number];
type Caches = ReturnType<typeof createRoutedSolidTokenCaches>;

function read(caches: Caches, kind: CacheKind, id: string): Promise<unknown> {
  return kind === 'WebID' ? caches.webIdIssuersCache.getIssuers(id) : caches.issuerKeySetCache.getKeySet(id);
}

function profile(webId: string, issuer = ISSUER): Response {
  return new Response(`<${webId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${issuer}> .`);
}

describe('routed Solid token caches', () => {
  let now: number;
  let fetchMock: ReturnType<typeof vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>>;

  beforeEach(() => {
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(async(input) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ jwks_uri: url.replace('.well-known/openid-configuration', 'jwks') });
      }
      if (url.endsWith('/jwks')) {
        return Response.json({ keys: [] });
      }
      return profile(url);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(kinds)('%s expires exactly at the default TTL without extending it on reads', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const id = kind === 'WebID' ? WEB_ID : ISSUER;
    const first = await read(caches, kind, id);
    const calls = fetchMock.mock.calls.length;
    now += TTL_MS - 1;
    expect(await read(caches, kind, id)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    now += 1;
    expect(await read(caches, kind, id)).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(calls * 2);
  });

  it.each(kinds)('%s respects an explicit TTL, including disabled caching', async(kind) => {
    const id = kind === 'WebID' ? WEB_ID : ISSUER;
    const caches = createRoutedSolidTokenCaches({ cacheTtlMs: 25 });
    const first = await read(caches, kind, id);
    now += 24;
    expect(await read(caches, kind, id)).toBe(first);
    now += 1;
    expect(await read(caches, kind, id)).not.toBe(first);
    const uncached = createRoutedSolidTokenCaches({ cacheTtlMs: 0 });
    expect(await read(uncached, kind, id)).not.toBe(await read(uncached, kind, id));
  });

  it.each(kinds)('%s does not use expired trust when the upstream rejects access', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const id = kind === 'WebID' ? WEB_ID : ISSUER;
    await read(caches, kind, id);
    now += TTL_MS;
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(read(caches, kind, id)).rejects.toThrow('HTTP 403');
    await expect(read(caches, kind, id)).resolves.toBeDefined();
  });

  it.each(kinds)('%s separates identifiers and cache instances', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const firstId = kind === 'WebID' ? WEB_ID : ISSUER;
    const secondId = kind === 'WebID' ? 'https://pod.example/profile/card#other' : 'https://other.example/';
    const first = await read(caches, kind, firstId);
    const second = await read(caches, kind, secondId);
    expect(second).not.toBe(first);
    expect(await read(caches, kind, firstId)).toBe(first);
    expect(await read(caches, kind, secondId)).toBe(second);
    const calls = fetchMock.mock.calls.length;
    expect(await read(createRoutedSolidTokenCaches(), kind, firstId)).not.toBe(first);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it.each(kinds)('%s fails closed after expiry and retries after the network recovers', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const id = kind === 'WebID' ? WEB_ID : ISSUER;
    const first = await read(caches, kind, id);
    now += TTL_MS;
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(read(caches, kind, id)).rejects.toThrow('offline');
    expect(await read(caches, kind, id)).not.toBe(first);
  });

  it.each(kinds)('%s evicts the oldest entry at 1,001 identifiers', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const id = (index: number): string => `https://entry-${index}.example/`;
    const first = await read(caches, kind, id(0));
    const second = await read(caches, kind, id(1));
    for (let index = 2; index < 1_001; index += 1) {
      await read(caches, kind, id(index));
    }
    expect(await read(caches, kind, id(1))).toBe(second);
    expect(await read(caches, kind, id(0))).not.toBe(first);
  });

  it.each(kinds)('%s clears expired entries before evicting fresh entries', async(kind) => {
    const caches = createRoutedSolidTokenCaches();
    const id = (index: number): string => `https://entry-${index}.example/`;
    await read(caches, kind, id(0));
    now += 1;
    const fresh = await read(caches, kind, id(1));
    for (let index = 2; index < 1_000; index += 1) {
      await read(caches, kind, id(index));
    }
    now += TTL_MS - 1;
    await read(caches, kind, id(1_000));
    expect(await read(caches, kind, id(1))).toBe(fresh);
  });

  it('stops trusting an issuer removed from the WebID profile after expiry', async() => {
    const cache = createRoutedSolidTokenCaches().webIdIssuersCache;
    expect(await cache.getIssuers(WEB_ID)).toEqual([ ISSUER ]);
    fetchMock.mockImplementation(async() => new Response(`<${WEB_ID}> <https://example.org/name> "Alice" .`));
    now += TTL_MS - 1;
    expect(await cache.getIssuers(WEB_ID)).toEqual([ ISSUER ]);
    now += 1;
    expect(await cache.getIssuers(WEB_ID)).toEqual([]);
    expect(await cache.getIssuers(WEB_ID)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the refreshed JWKS for real signatures after key rotation', async() => {
    const oldKeys = await generateKeyPair('ES256');
    const newKeys = await generateKeyPair('ES256');
    const oldJwk = { ...await exportJWK(oldKeys.publicKey), kid: 'old', alg: 'ES256' };
    const newJwk = { ...await exportJWK(newKeys.publicKey), kid: 'new', alg: 'ES256' };
    let publishedKeys: JWK[] = [ oldJwk ];
    fetchMock.mockImplementation(async(input) => String(input).endsWith('/jwks') ?
      Response.json({ keys: publishedKeys }) : Response.json({ jwks_uri: `${ISSUER}jwks` }));
    const oldToken = await new SignJWT({ sub: WEB_ID }).setIssuer(ISSUER)
      .setProtectedHeader({ alg: 'ES256', kid: 'old' }).sign(oldKeys.privateKey);
    const newToken = await new SignJWT({ sub: WEB_ID }).setIssuer(ISSUER)
      .setProtectedHeader({ alg: 'ES256', kid: 'new' }).sign(newKeys.privateKey);
    const cache = createRoutedSolidTokenCaches().issuerKeySetCache;
    const initial = await cache.getKeySet(ISSUER);
    await expect(jwtVerify(oldToken, initial, { issuer: ISSUER })).resolves.toMatchObject({ payload: { sub: WEB_ID } });
    publishedKeys = [ newJwk ];
    now += TTL_MS - 1;
    const withinTtl = await cache.getKeySet(ISSUER);
    await expect(jwtVerify(oldToken, withinTtl)).resolves.toBeDefined();
    await expect(jwtVerify(newToken, withinTtl)).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    now += 1;
    const refreshed = await cache.getKeySet(ISSUER);
    await expect(jwtVerify(newToken, refreshed, { issuer: ISSUER })).resolves.toMatchObject({ payload: { sub: WEB_ID } });
    await expect(jwtVerify(oldToken, refreshed)).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not reuse expired JWKS if refreshing the key endpoint fails', async() => {
    const cache = createRoutedSolidTokenCaches().issuerKeySetCache;
    await cache.getKeySet(ISSUER);
    now += TTL_MS;
    fetchMock.mockResolvedValueOnce(Response.json({ jwks_uri: `${ISSUER}jwks` }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(cache.getKeySet(ISSUER)).rejects.toThrow('OIDC issuer JWKS failed: HTTP 503');
    await expect(cache.getKeySet(ISSUER)).resolves.toBeTypeOf('function');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('preserves canonical forwarding on refresh and never routes an external issuer internally', async() => {
    const caches = createRoutedSolidTokenCaches({
      publicBaseUrl: ISSUER,
      internalBaseUrl: 'http://127.0.0.1:3001/',
    });
    const webId = `${ISSUER}profile/card#me`;
    fetchMock.mockImplementation(async(input) => {
      const url = String(input);
      if (url.endsWith('openid-configuration')) {
        return Response.json({ jwks_uri: `${ISSUER}jwks` });
      }
      return url.endsWith('/jwks') ? Response.json({ keys: [] }) : profile(webId);
    });
    await caches.webIdIssuersCache.getIssuers(webId);
    await caches.issuerKeySetCache.getKeySet(ISSUER);
    now += TTL_MS;
    await caches.webIdIssuersCache.getIssuers(webId);
    await caches.issuerKeySetCache.getKeySet(ISSUER);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [ input, init ] of fetchMock.mock.calls) {
      expect(String(input)).toMatch(/^http:\/\/127\.0\.0\.1:3001\//u);
      expect(init?.headers).toMatchObject({ 'X-Forwarded-Host': 'issuer.example', 'X-Forwarded-Proto': 'https' });
    }
    fetchMock.mockClear();
    await caches.webIdIssuersCache.getIssuers(WEB_ID);
    expect(fetchMock).toHaveBeenCalledWith(WEB_ID, expect.objectContaining({ headers: { Accept: 'text/turtle' } }));
    fetchMock.mockClear();
    await caches.issuerKeySetCache.getKeySet('https://external.example/');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://external.example/.well-known/openid-configuration');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
  });
});
