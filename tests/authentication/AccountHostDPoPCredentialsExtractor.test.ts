import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  AuthorizingHttpHandler,
  BasicRepresentation,
  RepresentationMetadata,
  OriginalUrlExtractor,
  SingleRootIdentifierStrategy,
  type Credentials,
  type CredentialsExtractor,
  type HttpRequest,
  type JwkGenerator,
  type TargetExtractor,
} from '@solid/community-server';
import { CachedHandler } from 'asynchronous-handlers';
import { createDpopHeader } from '@inrupt/solid-client-authn-core';
import { calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountHostDPoPCredentialsExtractor } from '../../src/authentication/AccountHostDPoPCredentialsExtractor';
import { XPOD_DESKTOP_CLIENT_ID } from '../../src/identity/oidc/RememberedClientGrantStore';
import { ValidatingIdentityProviderHttpHandler } from '../../src/identity/ValidatingIdentityProviderHttpHandler';

const ISSUER = 'https://identity.example/';
const WEB_ID = 'https://private-node.example/alice/profile/card#me';
const ACCOUNT_URL = `${ISSUER}.account/`;
let issuerKey: KeyLike;
let issuerJwk: JWK;
let proofKey: KeyLike;
let proofJwk: JWK;
let proofThumbprint: string;

beforeAll(async () => {
  const signer = await generateKeyPair('ES256');
  issuerKey = signer.privateKey;
  // CSS's JwkGenerator omits kid; oidc-provider derives the RFC 7638 thumbprint.
  issuerJwk = { ...await exportJWK(signer.publicKey), alg: 'ES256' };
  const proof = await generateKeyPair('ES256');
  proofKey = proof.privateKey;
  proofJwk = await exportJWK(proof.publicKey);
  proofThumbprint = await calculateJwkThumbprint(proofJwk);
});

afterEach(() => { vi.unstubAllGlobals(); });

async function accessToken(claims: Record<string, unknown> = {}, key = issuerKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: ISSUER, sub: WEB_ID, webid: WEB_ID, aud: 'solid', iat: now, exp: now + 300,
    client_id: XPOD_DESKTOP_CLIENT_ID, cnf: { jkt: proofThumbprint }, ...claims,
  };
  // An undefined override removes the claim from the signed fixture.
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: await calculateJwkThumbprint(issuerJwk) })
    .sign(key);
}

async function proof(token: string, claims: Record<string, unknown> = {}, key = proofKey): Promise<string> {
  return new SignJWT({
    htm: 'GET', htu: ACCOUNT_URL, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
    ath: createHash('sha256').update(token).digest('base64url'), ...claims,
  }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: proofJwk }).sign(key);
}

function request(token: string, dpop?: string): HttpRequest {
  return { method: 'GET', headers: { authorization: `DPoP ${token}`, ...(dpop ? { dpop } : {}) } } as HttpRequest;
}

function fixture(baseUrl = ISSUER, hostClientIds?: string[]) {
  const originalUrlExtractor = {
    handleSafe: vi.fn(async () => ({ path: new URL('.account/', baseUrl).href })),
  } as unknown as TargetExtractor;
  const jwkGenerator = { getPublicKey: vi.fn(async () => issuerJwk) } as unknown as JwkGenerator;
  const extractor = new AccountHostDPoPCredentialsExtractor(originalUrlExtractor, jwkGenerator, baseUrl, hostClientIds);
  return { extractor, originalUrlExtractor, jwkGenerator, hostClientIds };
}

function accountChain(extractor: CredentialsExtractor) {
  const cached = new CachedHandler(extractor as any) as unknown as CredentialsExtractor;
  const interactionHandler = { handleSafe: vi.fn(async () => new BasicRepresentation('', new RepresentationMetadata())) };
  const validating = new ValidatingIdentityProviderHttpHandler({
    providerFactory: { getProvider: async () => ({ interactionDetails: async () => { throw new Error('no interaction'); } }) },
    cookieStore: { get: async (token: string) => token === 'valid-cookie' ? 'cookie-account' : undefined },
    accountStorage: {
      has: async (_type: string, id: string) => ['cookie-account', 'session-account'].includes(id),
      find: async () => [{ accountId: 'session-account' }],
    },
    handler: interactionHandler,
    sessionExtractor: cached,
  } as any);
  const authorizing = new AuthorizingHttpHandler({
    credentialsExtractor: cached,
    modesExtractor: { handleSafe: vi.fn(async () => ({ entrySets: () => [] })) },
    permissionReader: { handleSafe: vi.fn(async () => new Map()) },
    authorizer: { handleSafe: vi.fn(async () => undefined) },
    operationHandler: validating,
  } as any);
  const run = (input: HttpRequest) => authorizing.handleSafe({
    request: input,
    response: {} as any,
    operation: {
      method: 'GET', target: { path: ACCOUNT_URL }, preferences: {},
      body: new BasicRepresentation('', new RepresentationMetadata({ path: ACCOUNT_URL })),
    },
  });
  return { cached, run, interactionHandler };
}

describe('Account host DPoP credentials', () => {
  it('accepts its own host session while the linked external WebID has no public route', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline WebID profile'); });
    vi.stubGlobal('fetch', fetchMock);
    const { extractor, jwkGenerator } = fixture();
    const token = await accessToken();
    expect(await extractor.handleSafe(request(token, await proof(token)))).toEqual({
      agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID }, issuer: { url: ISSUER },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jwkGenerator.getPublicKey).toHaveBeenCalledOnce();
  });

  it('keeps a legacy real Inrupt resource proof without ath usable through Account controls', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('offline WebID profile'); });
    vi.stubGlobal('fetch', fetchMock);
    // This is the original Inrupt 3.1.1 resource signing call: no fourth token
    // argument. New SDK dispatch passes that token, but existing hosts did not.
    const legacy = await createDpopHeader(ACCOUNT_URL, 'get', { privateKey: proofKey, publicKey: proofJwk });
    expect(decodeJwt(legacy).ath).toBeUndefined();
    const { run, interactionHandler } = accountChain(fixture().extractor);
    expect((await run(request(await accessToken(), legacy))).statusCode).toBe(200);
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'session-account' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the real CSS original URL extractor contract behind a Gateway', async () => {
    const originalUrlExtractor = new OriginalUrlExtractor({ identifierStrategy: new SingleRootIdentifierStrategy(ISSUER) });
    const extractor = new AccountHostDPoPCredentialsExtractor(originalUrlExtractor, {
      getPublicKey: async () => issuerJwk,
    } as JwkGenerator, ISSUER);
    const token = await accessToken();
    const input = request(token, await proof(token));
    input.url = '/.account/?details=true';
    Object.assign(input.headers, { host: 'localhost:9000', 'x-forwarded-host': 'identity.example', 'x-forwarded-proto': 'https' });
    expect(await extractor.handleSafe(input)).toMatchObject({ agent: { webId: WEB_ID } });
  });

  it('refuses a valid own-token proof for an Account path on a foreign original origin', async () => {
    const { extractor, originalUrlExtractor } = fixture();
    const foreignAccount = 'https://foreign.example/.account/';
    vi.mocked(originalUrlExtractor.handleSafe).mockResolvedValue({ path: foreignAccount });
    const token = await accessToken();
    await expect(extractor.handleSafe(request(token, await proof(token, { htu: foreignAccount }))))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('logs only the fixed refusal stage and implementation class, never claims or tokens', async () => {
    const { extractor } = fixture();
    const warn = vi.fn();
    (extractor as any).logger = { warn };
    const token = await accessToken({ iss: 'https://untrusted-issuer.example/' });
    await expect(extractor.handleSafe(request(token, await proof(token)))).rejects.toMatchObject({ statusCode: 400 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Rejected Account host session at access-token-signature (JWTClaimValidationFailed)');
  });

  it.each([ {}, { authorization: 'CSS-Account-Token account-token' }, { authorization: 'Bearer token' } ])(
    'leaves anonymous and native Account authorization headers to CSS: %j', async (headers) => {
      const { extractor, jwkGenerator, originalUrlExtractor } = fixture();
      expect(await extractor.handleSafe({ headers } as HttpRequest)).toEqual({});
      expect(jwkGenerator.getPublicKey).not.toHaveBeenCalled();
      expect(originalUrlExtractor.handleSafe).not.toHaveBeenCalled();
    },
  );

  it('keeps a correctly verified third-party client anonymous', async () => {
    const token = await accessToken({ client_id: 'https://other-app.example/client' });
    expect(await fixture().extractor.handleSafe(request(token, await proof(token)))).toEqual({});
  });

  it('supports an explicitly declared host client', async () => {
    const clientId = 'https://host.example/client';
    const token = await accessToken({ client_id: clientId });
    expect(await fixture(ISSUER, [clientId]).extractor.handleSafe(request(token, await proof(token))))
      .toMatchObject({ client: { clientId } });
  });

  it.each([
    ['foreign issuer even when signed locally', { iss: 'https://foreign.example/' }],
    ['issuer alias', { iss: 'https://identity.example' }],
    ['wrong audience', { aud: 'other-api' }],
    ['expired token', { exp: 1 }],
    ['future token', { iat: Math.floor(Date.now() / 1000) + 600 }],
    ['missing expiration', { exp: undefined }],
    ['missing WebID', { webid: undefined }],
    ['empty WebID', { webid: '' }],
    ['invalid WebID', { webid: 'not-a-url' }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['missing client', { client_id: undefined }],
    ['missing binding', { cnf: undefined }],
    ['wrong binding', { cnf: { jkt: 'wrong-thumbprint' } }],
  ])('rejects %s', async (_name, claims) => {
    const token = await accessToken(claims);
    await expect(fixture().extractor.handleSafe(request(token, await proof(token))))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('uses only its configured public key, never a key chosen by the unverified issuer', async () => {
    const other = await generateKeyPair('ES256');
    const token = await accessToken({}, other.privateKey);
    const fetchMock = vi.fn(async () => { throw new Error('must not fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fixture().extractor.handleSafe(request(token, await proof(token))))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the issuer\'s pairwise subject while authorizing the signed WebID through live Account links', async () => {
    // oidc-provider's JWT formatter transforms accountId for a pairwise client,
    // while CSS extraTokenClaims retains the original WebID in webid.
    const token = await accessToken({ sub: 'issuer-generated-pairwise-subject' });
    const { run, interactionHandler } = accountChain(fixture().extractor);
    expect((await run(request(token, await proof(token)))).statusCode).toBe(200);
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'session-account' }));
  });

  it('accepts a persisted issuer key whose custom kid was dropped by CSS public-key derivation', async () => {
    const original = await accessToken();
    const payload = JSON.parse(Buffer.from(original.split('.')[1], 'base64url').toString('utf8'));
    const token = await new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: 'persisted-custom-id' }).sign(issuerKey);
    expect(await fixture().extractor.handleSafe(request(token, await proof(token))))
      .toMatchObject({ agent: { webId: WEB_ID } });
  });

  it('supports Account controls under the issuer base-path prefix', async () => {
    const issuer = `${ISSUER}solid/`;
    const token = await accessToken({ iss: issuer });
    expect(await fixture(issuer).extractor.handleSafe(request(token, await proof(token, { htu: `${issuer}.account/` }))))
      .toMatchObject({ issuer: { url: issuer }, agent: { webId: WEB_ID } });
  });

  it('retries public-key loading after a temporary generator failure', async () => {
    const { extractor, jwkGenerator } = fixture();
    vi.mocked(jwkGenerator.getPublicKey).mockRejectedValueOnce(new Error('temporary key storage failure'));
    const token = await accessToken();
    await expect(extractor.handleSafe(request(token, await proof(token))))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(await extractor.handleSafe(request(token, await proof(token)))).toMatchObject({ agent: { webId: WEB_ID } });
    expect(jwkGenerator.getPublicKey).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong method', { htm: 'POST' }],
    ['wrong URL', { htu: `${ISSUER}.account/other/` }],
    ['wrong ath', { ath: 'wrong-hash' }],
    ['empty ath', { ath: '' }],
    ['null ath', { ath: null }],
    ['numeric ath', { ath: 123 }],
    ['missing JTI', { jti: undefined }],
    ['old proof', { iat: 1 }],
    ['future proof', { iat: Math.floor(Date.now() / 1000) + 600 }],
  ])('rejects a proof with %s', async (_name, claims) => {
    const token = await accessToken();
    await expect(fixture().extractor.handleSafe(request(token, await proof(token, claims))))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an invalid proof signature and a missing proof', async () => {
    const token = await accessToken();
    const other = await generateKeyPair('ES256');
    await expect(fixture().extractor.handleSafe(request(token, await proof(token, {}, other.privateKey))))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(fixture().extractor.handleSafe(request(token))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects proof replay across different HTTP requests', async () => {
    const token = await accessToken();
    const dpop = await proof(token);
    const { extractor } = fixture();
    await extractor.handleSafe(request(token, dpop));
    await expect(extractor.handleSafe(request(token, dpop))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('shares verification between the Account authorizer and handler for one request', async () => {
    const token = await accessToken();
    const input = request(token, await proof(token));
    const { extractor } = fixture();
    const verify = vi.spyOn(extractor, 'handle');
    const { cached, run, interactionHandler } = accountChain(extractor);
    expect((await run(input)).statusCode).toBe(200);
    expect(await cached.handleSafe(input)).toMatchObject({
      agent: { webId: WEB_ID },
    } satisfies Partial<Credentials>);
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'session-account' }));
    expect(verify).toHaveBeenCalledOnce();
    await expect(cached.handleSafe(request(token, input.headers.dpop as string)))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(['cookie', 'token', 'verified non-host session'])(
    'preserves native Account authority with %s through the whole authorizer chain', async (mode) => {
      const { extractor, jwkGenerator } = fixture();
      const input = { method: 'GET', headers: {} } as HttpRequest;
      if (mode === 'token') {
        input.headers.authorization = 'CSS-Account-Token valid-cookie';
      } else {
        input.headers.cookie = 'css-account=valid-cookie';
      }
      if (mode === 'verified non-host session') {
        const token = await accessToken({ client_id: 'https://other-app.example/client' });
        Object.assign(input.headers, request(token, await proof(token)).headers);
      }
      const { run, interactionHandler } = accountChain(extractor);
      expect((await run(input)).statusCode).toBe(200);
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'cookie-account' }));
      if (mode !== 'verified non-host session') expect(jwkGenerator.getPublicKey).not.toHaveBeenCalled();
    },
  );

  it('retains the CSS front-authorizer refusal for a bad DPoP proof even with an Account cookie', async () => {
    const token = await accessToken();
    const input = request(token, await proof(token, { ath: 'wrong' }));
    input.headers.cookie = 'css-account=valid-cookie';
    const { run, interactionHandler } = accountChain(fixture().extractor);
    await expect(run(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it('cannot be used to authorize a Pod resource instead of an Account operation', async () => {
    const token = await accessToken();
    const { extractor, originalUrlExtractor } = fixture();
    vi.mocked(originalUrlExtractor.handleSafe).mockResolvedValue({ path: `${ISSUER}alice/settings/` });
    await expect(extractor.handleSafe(request(token, await proof(token, { htu: `${ISSUER}alice/settings/` }))))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns a stable refusal without exposing token or proof details', async () => {
    const token = await accessToken({ webid: 'private-invalid-webid' });
    await expect(fixture().extractor.handleSafe(request(token, await proof(token))))
      .rejects.toMatchObject({ message: 'Invalid Account host session' });
  });
});

describe('Account issuer mode', () => {
  it('preserves managed Local external-issuer verification with one shared request result', async () => {
    const generic = { handleSafe: vi.fn(async () => ({
      agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID }, issuer: { url: ISSUER },
    })) } as unknown as CredentialsExtractor;
    const { originalUrlExtractor, jwkGenerator } = fixture();
    const extractor = new AccountHostDPoPCredentialsExtractor(
      originalUrlExtractor, jwkGenerator, 'https://local-node.example/', undefined, ISSUER, generic,
    );
    const { run, cached, interactionHandler } = accountChain(extractor);
    const input = request('external-token', 'external-proof');
    expect((await run(input)).statusCode).toBe(200);
    await cached.handleSafe(input);
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'session-account' }));
    expect(generic.handleSafe).toHaveBeenCalledOnce();
    expect(generic.handleSafe).toHaveBeenCalledWith(input);
    expect(jwkGenerator.getPublicKey).not.toHaveBeenCalled();
    expect(originalUrlExtractor.handleSafe).not.toHaveBeenCalled();
    await cached.handleSafe({ ...input } as HttpRequest);
    expect(generic.handleSafe).toHaveBeenCalledTimes(2);
  });

  it('uses its own signing authority when the declared issuer is this same service', async () => {
    const generic = { handleSafe: vi.fn(async () => { throw new Error('do not dereference profile'); }) } as unknown as CredentialsExtractor;
    const { originalUrlExtractor, jwkGenerator } = fixture();
    const extractor = new AccountHostDPoPCredentialsExtractor(
      originalUrlExtractor, jwkGenerator, ISSUER, undefined, 'https://identity.example', generic,
    );
    const token = await accessToken();
    expect(await extractor.handleSafe(request(token, await proof(token))))
      .toMatchObject({ agent: { webId: WEB_ID } });
    expect(generic.handleSafe).not.toHaveBeenCalled();
  });

  it('propagates the external verifier refusal instead of trusting the local signer', async () => {
    const refusal = new Error('external verifier refused the request');
    const generic = { handleSafe: vi.fn(async () => { throw refusal; }) } as unknown as CredentialsExtractor;
    const { originalUrlExtractor, jwkGenerator } = fixture();
    const extractor = new AccountHostDPoPCredentialsExtractor(
      originalUrlExtractor, jwkGenerator, 'https://local-node.example/', undefined, ISSUER, generic,
    );
    await expect(extractor.handleSafe(request('external-token', 'proof'))).rejects.toBe(refusal);
    expect(jwkGenerator.getPublicKey).not.toHaveBeenCalled();
  });
});

describe('Account extractor configuration', () => {
  it('wires one request cache into both Account checks and preserves the resource extractor', async () => {
    const config = JSON.parse(await readFile('config/xpod.base.json', 'utf8'));
    const graph = config['@graph'] as Array<Record<string, any>>;
    const validating = graph.find((entry) => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:IdentityProviderHttpHandler');
    const authorizing = graph.find((entry) => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:IdentityProviderAuthorizingHandler');
    expect(authorizing).toBeDefined();
    const id = validating!.overrideParameters.sessionExtractor['@id'];
    expect(authorizing!.overrideParameters.credentialsExtractor).toEqual({ '@id': id });
    expect(id).not.toBe('urn:solid-server:default:CredentialsExtractor');
    const cache = graph.find((entry) => entry['@id'] === id)!;
    expect(cache['@type']).toBe('CachedHandler');
    expect(cache.source['@type']).toBe('AccountHostDPoPCredentialsExtractor');
    expect(graph.find((entry) => entry.overrideInstance?.['@id'] === 'urn:solid-server:default:DPoPWebIdExtractor')!
      .overrideParameters['@type']).toBe('ConfiguredLoopbackDPoPWebIdExtractor');
  });

  it.each(['local', 'cloud'])('loads the real %s component graph with shared Account cache', async (mode) => {
    const { ComponentsManager } = await import('componentsjs');
    const { DataFactory } = await import('rdf-data-factory');
    const { createCssChildRuntimeConfig } = await import('../../src/runtime/css-process');
    const manager = await ComponentsManager.build({
      mainModulePath: process.cwd(), logLevel: 'error', typeChecking: false,
    });
    const parent = path.resolve('.test-data/account-host-component-config');
    fs.mkdirSync(parent, { recursive: true });
    const runtimeRoot = fs.mkdtempSync(path.join(parent, `${mode}-`));
    try {
      const runtimeConfig = createCssChildRuntimeConfig({
        configPath: path.resolve(`config/${mode}.json`), runtimeRoot, authMode: 'acp',
      });
      await manager.configRegistry.register(runtimeConfig.configPath);
      const get = (id: string) => {
        const resource = manager.configRegistry.getInstantiatedResource(new DataFactory().namedNode(id));
        expect(resource, id).toBeDefined();
        (manager.configConstructorPool as any).getRawConfig(resource);
        return resource!;
      };
      const cache = get('urn:undefineds:xpod:AccountHostCredentialsExtractor');
      const source = cache.properties[`${cache.property.type.value}_source`][0];
      expect(source.property.type.value).toContain('#AccountHostDPoPCredentialsExtractor');
      (manager.configConstructorPool as any).getRawConfig(source);
      const type = source.property.type.value;
      expect(source.properties[`${type}_jwkGenerator`]).toHaveLength(1);
      expect(source.properties[`${type}_externalIssuerExtractor`][0].value)
        .toBe('urn:solid-server:default:CredentialsExtractor');
      const authorizing = get('urn:solid-server:default:IdentityProviderAuthorizingHandler');
      const validating = get('urn:solid-server:default:IdentityProviderHttpHandler');
      expect(authorizing.properties[`${authorizing.property.type.value}_args_credentialsExtractor`][0].value).toBe(cache.value);
      expect(validating.properties[`${validating.property.type.value}_args_sessionExtractor`][0].value).toBe(cache.value);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
