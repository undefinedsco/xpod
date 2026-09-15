import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Provider, { type AdapterPayload } from 'oidc-provider';
import { Session } from '@inrupt/solid-client-authn-browser';
import { EVENTS } from '@inrupt/solid-client-authn-core';
import { importJWK, jwtVerify, type JWK } from 'jose';
import { CookieJar, JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// Real issuer HTTP/code/token/JWT and installed Inrupt SDK. Only account and
// consent selection are fixtures. The ID-token substitution is fault injection.
// Both issuers deliberately share a signing key to isolate issuer validation
// from signature, client, nonce, redirect URI, and PKCE validation.
const clientId = 'issuer-isolation-client';
const callbackUrl = 'https://app.example/auth/callback';

function isolatedAdapter() {
  // oidc-provider's default MemoryAdapter shares module-global storage. Each
  // issuer needs its own persistence boundary, just like independent servers.
  const records = new Map<string, { payload: AdapterPayload; expires: number }>();
  return class {
    constructor(private readonly model: string) {}
    async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
      records.set(`${this.model}:${id}`, { payload: { ...payload }, expires: Date.now() + expiresIn * 1000 });
    }
    async find(id: string) {
      const record = records.get(`${this.model}:${id}`);
      return record && record.expires > Date.now() ? { ...record.payload } : undefined;
    }
    private async findBy(field: 'uid' | 'userCode', value: string) {
      for (const [key, record] of records) {
        if (key.startsWith(`${this.model}:`) && record.payload[field] === value) return this.find(key.slice(this.model.length + 1));
      }
      return undefined;
    }
    async findByUid(uid: string) { return this.findBy('uid', uid); }
    async findByUserCode(code: string) { return this.findBy('userCode', code); }
    async consume(id: string) {
      const record = records.get(`${this.model}:${id}`);
      if (record) record.payload.consumed = Math.floor(Date.now() / 1000);
    }
    async destroy(id: string) { records.delete(`${this.model}:${id}`); }
    async revokeByGrantId(grantId: string) {
      for (const [key, record] of records) if (record.payload.grantId === grantId) records.delete(key);
    }
  };
}

type Issuer = {
  origin: string;
  webId: string;
  server: Server;
  tokenStatuses: number[];
  tokenErrors: string[];
  replaceIdToken?: (body: Record<string, unknown>, parameters: Record<string, string>) => Promise<string>;
};

async function startIssuer(jwk: Record<string, unknown>, name: string): Promise<Issuer> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture: Issuer = { origin, webId: `https://pods.example/${name}/profile/card#me`, server,
    tokenStatuses: [], tokenErrors: [] };
  const provider = new Provider(origin, {
    adapter: isolatedAdapter(),
    jwks: { keys: [jwk] },
    clients: [{ client_id: clientId, redirect_uris: [callbackUrl], response_types: ['code'],
      grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
    cookies: { keys: [`issuer-isolation-${name}`] },
    features: { devInteractions: { enabled: false } },
    scopes: ['openid', 'webid'], claims: { webid: ['webid'] }, conformIdTokenClaims: false,
    findAccount: async (_ctx, accountId) => ({ accountId,
      claims: async () => ({ sub: accountId, webid: accountId }) }),
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  });
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.path !== '/token') return;
    fixture.tokenStatuses.push(ctx.status);
    const body = ctx.body as Record<string, unknown>;
    if (typeof body?.error === 'string') fixture.tokenErrors.push(body.error);
    if (ctx.status === 200 && fixture.replaceIdToken) {
      body.id_token = await fixture.replaceIdToken(body, ctx.oidc.params as Record<string, string>);
    }
  });
  const handler = provider.callback();
  server.on('request', (request, response) => {
    // Inrupt's browser transport makes genuine HTTP requests through JSDOM XHR.
    response.setHeader('access-control-allow-origin', 'https://app.example');
    response.setHeader('access-control-allow-headers', 'content-type,dpop');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (!request.url?.startsWith('/interaction/')) { handler(request, response); return; }
    void (async () => {
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name === 'login') {
        await provider.interactionFinished(request, response, { login: { accountId: fixture.webId } },
          { mergeWithLastSubmission: false });
      } else if (details.prompt.name === 'consent') {
        const grant = new provider.Grant({ accountId: fixture.webId, clientId });
        grant.addOIDCScope('openid webid');
        await provider.interactionFinished(request, response, { consent: { grantId: await grant.save() } },
          { mergeWithLastSubmission: true });
      } else throw new Error(`Unexpected interaction: ${details.prompt.name}`);
    })().catch(() => { response.statusCode = 500; response.end('Fixture interaction failed'); });
  });
  return fixture;
}

async function authorize(issuer: Issuer, parameters: URLSearchParams): Promise<URL> {
  const jar = new CookieJar();
  let url = `${issuer.origin}/auth?${parameters}`;
  for (let step = 0; step < 12; step++) {
    const response = await fetch(url, { redirect: 'manual', headers: { cookie: jar.getCookieStringSync(url) } });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url);
    expect([302, 303]).toContain(response.status);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const next = new URL(location!, url);
    if (next.origin === new URL(callbackUrl).origin) {
      expect(next.searchParams.get('error')).toBeNull();
      expect(next.searchParams.get('code')).toBeTruthy();
      return next;
    }
    url = next.href;
  }
  throw new Error('Issuer authorization exceeded redirect limit');
}

async function withIssuers(run: (a: Issuer, b: Issuer, session: Session,
  authorization: URL, publicJwk: JWK) => Promise<void>): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...privateKey.export({ format: 'jwk' }), kid: 'shared-test-key', alg: 'RS256', use: 'sig' };
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: key.kid, alg: key.alg, use: key.use } as JWK;
  const a = await startIssuer(key, 'alice');
  const b = await startIssuer(key, 'bob');
  const dom = new JSDOM('<!doctype html>', { url: callbackUrl });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('sessionStorage', dom.window.sessionStorage);
  vi.stubGlobal('XMLHttpRequest', dom.window.XMLHttpRequest);
  const session = new Session();
  try {
    const authorization = await new Promise<URL>((resolve, reject) => {
      // Successful SDK login intentionally never settles: the redirect is its completion signal.
      void session.login({ oidcIssuer: a.origin, clientId, redirectUrl: callbackUrl,
        tokenType: 'Bearer', handleRedirect: (url) => resolve(new URL(url)) }).catch(reject);
    });
    expect(authorization).toBeDefined();
    expect(authorization!.searchParams.get('state')).toBeTruthy();
    expect(authorization!.searchParams.get('code_challenge')).toBeTruthy();
    await run(a, b, session, authorization!, publicJwk);
  } finally {
    if (session.info.isLoggedIn) await session.logout();
    vi.unstubAllGlobals();
    dom.window.close();
    for (const issuer of [a, b]) {
      issuer.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => issuer.server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

describe('real issuer isolation at the Inrupt callback boundary', () => {
  it('accepts the matching issuer as a positive control', async () => {
    await withIssuers(async (a, _b, session, authorization) => {
      const callback = await authorize(a, authorization.searchParams);
      await session.handleIncomingRedirect({ url: callback.href });
      expect(session.info).toMatchObject({ isLoggedIn: true, webId: a.webId });
      expect(a.tokenStatuses).toEqual([200]);
    });
  });

  it('rejects a real B code paired with the pending A state at the A token endpoint', async () => {
    await withIssuers(async (a, b, session, authorization) => {
      const errors: string[] = [];
      const login = vi.fn();
      session.events.on(EVENTS.ERROR, (_code, detail) => { errors.push(String(detail)); });
      session.events.on(EVENTS.LOGIN, login);
      const callback = await authorize(b, authorization.searchParams);
      expect(callback.searchParams.get('state')).toBe(authorization.searchParams.get('state'));
      // Model code substitution into A's callback, not an unchanged B response:
      // keep A's response issuer so RFC 9207 does not reject before token exchange.
      callback.searchParams.set('iss', a.origin);
      await session.handleIncomingRedirect({ url: callback.href });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/invalid_grant/);
      expect(login).not.toHaveBeenCalled();
      expect(a.tokenStatuses).toEqual([400]);
      expect(a.tokenErrors).toEqual(['invalid_grant']);
      expect(b.tokenStatuses).toEqual([]);
      expect(session.info.isLoggedIn).toBe(false);
      expect(session.info.webId).toBeUndefined();
    });
  });

  it('rejects a genuine B ID token even with matching signing key, audience, nonce and PKCE', async () => {
    await withIssuers(async (a, b, session, authorization, publicJwk) => {
      const errors: string[] = [];
      const login = vi.fn();
      session.events.on(EVENTS.ERROR, (_code, detail) => { errors.push(String(detail)); });
      session.events.on(EVENTS.LOGIN, login);
      const callbackB = await authorize(b, authorization.searchParams);
      const callbackA = await authorize(a, authorization.searchParams);
      let verifiedForeignToken = false;
      a.replaceIdToken = async (_body, parameters) => {
        const response = await fetch(`${b.origin}/token`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: callbackB.searchParams.get('code')!,
            client_id: clientId, redirect_uri: callbackUrl, code_verifier: parameters.code_verifier }),
        });
        expect(response.status).toBe(200);
        const tokens = await response.json() as { id_token: string };
        const verified = await jwtVerify(tokens.id_token, await importJWK(publicJwk, 'RS256'),
          { issuer: b.origin, audience: clientId });
        expect(verified.payload.iss).not.toBe(a.origin);
        expect(verified.payload.sub).toBe(b.webId);
        // This SDK's code flow may omit nonce; both providers receive precisely
        // the same SDK-generated request, including nonce when one is present.
        expect(verified.payload.nonce ?? null).toBe(authorization.searchParams.get('nonce'));
        verifiedForeignToken = true;
        return tokens.id_token;
      };
      await session.handleIncomingRedirect({ url: callbackA.href });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('unexpected "iss" claim value');
      expect(login).not.toHaveBeenCalled();
      expect(verifiedForeignToken).toBe(true);
      expect(a.tokenStatuses).toEqual([200]);
      expect(b.tokenStatuses).toEqual([200]);
      expect(session.info.isLoggedIn).toBe(false);
      expect(session.info.webId).toBeUndefined();
    });
  });
});
