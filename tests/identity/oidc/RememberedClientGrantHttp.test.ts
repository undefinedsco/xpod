import { createHash, randomUUID } from 'node:crypto';
import https from 'node:https';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import Provider, { interactionPolicy, type Configuration } from 'oidc-provider';
import { Session } from '@inrupt/solid-client-authn-node';
import { InMemoryStorage } from '@inrupt/solid-client-authn-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountPromptFactory, ClientIdAdapterFactory, ExpiringAdapterFactory, ConsentHandler, FoundHttpError, MemoryMapStorage,
  RepresentationMetadata, WrappedExpiringStorage, finishInteraction,
  type CookieStore, type WebIdStore,
} from '@solid/community-server';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedClientPromptFactory } from '../../../src/identity/oidc/RememberedClientPromptFactory';
import { RememberedConsentHandler } from '../../../src/identity/oidc/RememberedConsentHandler';
import { SessionBoundIdentityProviderFactory } from '../../../src/identity/oidc/SessionBoundIdentityProviderFactory';
import { ScopedPickWebIdHandler } from '../../../src/identity/oidc/ScopedPickWebIdHandler';

// This is an isolated protocol fixture, not evidence of public IdP deployment.
const webIds = { alice: 'https://pods.example/alice/profile/card#me', bob: 'https://pods.example/bob/profile/card#me' };
// jsdom is already a test dependency; its bundled cookie jar enforces cookie
// paths and expiry like a browser. The repository does not install @types/jsdom.
interface HttpCookieJar {
  getCookieStringSync(url: string): string;
  setCookieSync(cookie: string, url: string): unknown;
}
const { CookieJar } = createRequire(import.meta.url)('jsdom') as { CookieJar: new () => HttpCookieJar };
type User = keyof typeof webIds;
interface InteractionPage { uid: string; prompt: string; details: Record<string, unknown> }
interface Journey { code: string; prompts: string[]; callback: URL; tokens: Record<string, unknown>; grantId: string; sessionUid: string }

describe('remembered desktop consent over real OIDC HTTP interactions', () => {
  let server: Server;
  let origin: string;
  let provider: Provider;
  let jar: HttpCookieJar;
  let errors: unknown[];
  let store: RememberedClientGrantStore;
  let accessTokenTtl: number;
  let tokenRequests: number;
  let authorizationRequests: number;
  let metadataAdapter: ReturnType<ClientIdAdapterFactory['createStorageAdapter']>;

  beforeEach(async () => {
    jar = new CookieJar();
    errors = [];
    accessTokenTtl = 3600;
    tokenRequests = 0;
    authorizationRequests = 0;
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    const policy = interactionPolicy.base();
    // Only the external account persistence boundary is a fixture; all prompt
    // ordering, ownership checks, interaction state and grants run real code.
    const accountCookies = new Map<string, string>([['alice-cookie', 'alice'], ['bob-cookie', 'bob']]);
    const accounts = { get: async (cookie: string) => accountCookies.get(cookie) } as CookieStore;
    const links = { isLinked: async (webId: string, account: string) => webIds[account as User] === webId } as WebIdStore;
    await new RememberedClientPromptFactory(new AccountPromptFactory(links, accounts, 'account-cookie'), store).handleSafe(policy);
    // Use the production hook after CSS's configuration-cloning boundary.
    const adapterFactory = new ClientIdAdapterFactory(
      // Retain expired payloads so the Provider itself exercises its clock-
      // tolerance boundary; production storage TTL is tested separately.
      new ExpiringAdapterFactory(new MemoryMapStorage()),
      { handleSafe: async () => { throw new Error('Unexpected RDF client metadata'); } } as any,
    );
    metadataAdapter = adapterFactory.createStorageAdapter('Client');
    const factoryConfig = new SessionBoundIdentityProviderFactory({}, {
      storage: { get: async () => ['isolated-http-consent-test-key'] }, adapterFactory,
    } as any);
    const cloned = await (factoryConfig as any).initConfig({ alg: 'RS256' }) as Configuration;
    provider = new Provider(origin, {
      issueRefreshToken: cloned.issueRefreshToken,
      ttl: { AccessToken: () => accessTokenTtl },
      clients: cloned.clients,
      adapter: cloned.adapter,
      cookies: { keys: ['isolated-http-consent-test-key'] },
      features: { devInteractions: { enabled: false } },
      scopes: ['openid', 'webid', 'offline_access', 'email'],
      conformIdTokenClaims: false,
      claims: { webid: ['webid'], email: ['email'] },
      findAccount: async (_ctx, accountId) => ({ accountId, claims: async () => ({ sub: accountId, webid: accountId }) }),
      interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    });
    provider.on('server_error', (error: unknown) => errors.push(error));
    const factory = { getProvider: async () => provider };
    const consent = new RememberedConsentHandler(factory, new ConsentHandler(factory), store);
    const picker = new ScopedPickWebIdHandler({
      providerFactory: factory,
      rememberedClientGrantStore: store,
      ownershipResolver: {
        listAccountWebIds: async (accountId) => [webIds[accountId as User]].filter(Boolean),
        resolveOwnedWebIds: async ({ accountId, candidateWebIds, target }) => candidateWebIds
          .filter((webId) => webIds[accountId as User] === webId)
          .map((webId) => ({ webId, storageUrl: target.storageUrl, storageMode: 'cloud' as const })),
      },
    });
    const callback = provider.callback();
    server.on('request', (request, response) => {
      if (request.url === '/token') tokenRequests += 1;
      if (request.url?.startsWith('/auth?')) authorizationRequests += 1;
      if (!request.url?.startsWith('/interaction/')) {
        callback(request, response);
        return;
      }
      void (async () => {
        const interaction = await provider.interactionDetails(request, response);
        if (request.method === 'GET') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ uid: interaction.uid, prompt: interaction.prompt.name, details: interaction.prompt.details }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const json = JSON.parse(Buffer.concat(chunks).toString()) as { user?: User; remember?: boolean; deny?: boolean };
        if (interaction.prompt.name === 'consent' && json.deny) {
          await provider.interactionFinished(request, response, { error: 'access_denied' }, { mergeWithLastSubmission: false });
          return;
        }
        if (interaction.prompt.name === 'account') {
          if (!json.user || !webIds[json.user]) throw new Error('Unknown fixture account');
          response.setHeader('set-cookie', `account-cookie=${json.user}-cookie; Path=/; HttpOnly; SameSite=Lax`);
          // Account login is the fixture boundary; resume the real policy so
          // it separately verifies the cookie and then requests WebID login.
          const location = await finishInteraction(interaction, {}, true);
          response.writeHead(302, { location });
          response.end();
          return;
        }
        const accountCookie = /(?:^|;\s*)account-cookie=([^;]+)/u.exec(request.headers.cookie ?? '')?.[1];
        const accountId = accountCookie ? await accounts.get(accountCookie) : undefined;
        const input = {
          method: 'POST', target: { path: new URL(request.url!, origin).href },
          metadata: new RepresentationMetadata(), oidcInteraction: interaction, accountId,
          json: interaction.prompt.name === 'login'
            ? { webId: webIds[accountId as User], remember: true }
            : { remember: json.remember ?? true },
        };
        if (interaction.prompt.name === 'login') await picker.handleSafe(input);
        else if (interaction.prompt.name === 'consent') await consent.handleSafe(input);
        else throw new Error(`Unexpected prompt ${interaction.prompt.name}`);
      })().catch((error: unknown) => {
        if (error instanceof FoundHttpError) {
          response.writeHead(302, { location: error.location });
          response.end();
        } else {
          errors.push(error);
          response.statusCode = 500;
          response.end(String(error));
        }
      });
    });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    expect(errors).toEqual([]);
  });

  async function request(url: string, body?: unknown): Promise<Response> {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { cookie: jar.getCookieStringSync(url), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url);
    return response;
  }

  function authorization(extra: Record<string, string> = {}): string {
    const url = new URL('/auth', origin);
    url.search = new URLSearchParams({
      client_id: XPOD_DESKTOP_CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:43111/auth/callback',
      response_type: 'code', scope: 'openid webid', state: randomUUID(),
      code_challenge: createHash('sha256').update('http-fixture-pkce-verifier-at-least-forty-three-characters').digest('base64url'),
      code_challenge_method: 'S256', ...extra,
    }).toString();
    return url.href;
  }

  async function journey(extra: Record<string, string> = {}, user: User = 'alice', remember = true, beforeConsent?: (page: InteractionPage) => Promise<void>, denyConsent = 0): Promise<Journey> {
    const start = authorization(extra);
    const state = new URL(start).searchParams.get('state');
    let url = start;
    let response = await request(url);
    const prompts: string[] = [];
    let consentSubmissions = 0;
    for (let step = 0; step < 20; step += 1) {
      if (response.status === 200) {
        const page = await response.json() as InteractionPage;
        expect(['account', 'login', 'consent']).toContain(page.prompt);
        prompts.push(page.prompt);
        if (page.prompt === 'consent') {
          consentSubmissions += 1;
          await beforeConsent?.(page);
        }
        response = await request(url, { user, remember, deny: denyConsent > 0 && consentSubmissions === denyConsent });
      } else {
        const details = await response.text();
        expect([302, 303], details).toContain(response.status);
        const location = response.headers.get('location');
        expect(location, details).toBeTruthy();
        const next = new URL(location!, url);
        if (next.origin !== origin) {
          if (denyConsent > 0 && consentSubmissions === denyConsent) {
            expect(next.searchParams.get('error')).toBe('access_denied');
            expect(next.searchParams.get('code')).toBeNull();
            expect(next.searchParams.get('state')).toBe(state);
            return { code: '', tokens: {}, grantId: '', sessionUid: '', prompts, callback: next };
          }
          expect(next.searchParams.get('error'), next.href).toBeNull();
          expect(next.searchParams.get('state')).toBe(state);
          const code = next.searchParams.get('code');
          expect(code).toBeTruthy();
          // Validate the actual authorization code through the token endpoint,
          // including native public client authentication and PKCE binding.
          const issuedCode = await provider.AuthorizationCode.find(code!);
          expect(issuedCode?.expiresWithSession).toBe(true);
          expect(issuedCode?.grantId).toBeTypeOf('string');
          expect(issuedCode?.sessionUid).toBeTypeOf('string');
          const token = await fetch(`${origin}/token`, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code: code!,
              client_id: XPOD_DESKTOP_CLIENT_ID, redirect_uri: new URL(start).searchParams.get('redirect_uri')!,
              code_verifier: 'http-fixture-pkce-verifier-at-least-forty-three-characters' }),
          });
          const tokens = await token.json() as Record<string, unknown>;
          expect(token.status, JSON.stringify(tokens)).toBe(200);
          expect(tokens.access_token).toBeTypeOf('string');
          expect(tokens.id_token).toBeTypeOf('string');
          const claims = JSON.parse(Buffer.from((tokens.id_token as string).split('.')[1], 'base64url').toString());
          expect(claims.sub).toBe(webIds[user]);
          return { code: code!, prompts, callback: next, tokens, grantId: issuedCode!.grantId!, sessionUid: issuedCode!.sessionUid! };
        }
        url = next.href;
        response = await request(url);
      }
    }
    throw new Error(`OIDC redirect loop: ${prompts.join(', ')}`);
  }


  async function refresh(token: unknown): Promise<{ status: number; tokens: Record<string, unknown> }> {
    expect(token).toBeTypeOf('string');
    const response = await fetch(`${origin}/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token as string,
        client_id: XPOD_DESKTOP_CLIENT_ID }),
    });
    return { status: response.status, tokens: await response.json() as Record<string, unknown> };
  }

  it.each(['revoked', 'just expired', 'expired beyond clock tolerance'] as const)('requires new consent after the remembered grant is %s', async (reason) => {
    const first = await journey();
    const grant = await store.find(provider, webIds.alice, XPOD_DESKTOP_CLIENT_ID);
    expect(grant?.jti).toBe(first.grantId);
    if (reason === 'revoked') await grant!.destroy();
    else {
      grant!.exp = Math.floor(Date.now() / 1000) - (reason === 'just expired' ? 1 : 60);
      await grant!.save();
    }
    expect(await store.find(provider, webIds.alice, XPOD_DESKTOP_CLIENT_ID)).toBeUndefined();
    const next = await journey();
    expect(next.prompts).toContain('consent');
    expect(next.grantId).not.toBe(first.grantId);
  });

  it.each([1, 60])('renews consent when its displayed grant expires %s seconds before submission', async (seconds) => {
    const first = await journey();
    const old = await provider.Grant.find(first.grantId);
    expect(old).toBeDefined();
    let submissions = 0;
    const next = await journey({ prompt: 'consent', scope: 'openid webid email' }, 'alice', true, async (page) => {
      submissions += 1;
      if (submissions > 1) {
        expect(page.details.missingOIDCScope).toEqual(expect.arrayContaining(['openid', 'webid', 'email']));
        expect(await store.find(provider, webIds.alice, XPOD_DESKTOP_CLIENT_ID)).toBeUndefined();
        return;
      }
      old!.exp = Math.floor(Date.now() / 1000) - seconds;
      await old!.save();
    });
    expect(next.prompts).toEqual(['consent', 'consent']);
    expect(submissions).toBe(2);
    expect(next.grantId).not.toBe(first.grantId);
    const grant = await provider.Grant.find(next.grantId);
    expect(grant?.accountId).toBe(webIds.alice);
    expect(grant?.getOIDCScope().split(' ').sort()).toEqual(['email', 'openid', 'webid']);
    expect(old!.isExpired).toBe(true);
  });

  it('does not remember a new grant when renewed consent is denied after the old grant expires', async () => {
    const first = await journey();
    const old = await provider.Grant.find(first.grantId);
    const tokensBeforeDenial = tokenRequests;
    let submissions = 0;
    const denied = await journey({ prompt: 'consent', scope: 'openid webid email' }, 'alice', true, async (page) => {
      submissions += 1;
      if (submissions === 1) {
        old!.exp = Math.floor(Date.now() / 1000) - 1;
        await old!.save();
      } else {
        expect(page.details.missingOIDCScope).toEqual(expect.arrayContaining(['openid', 'webid', 'email']));
      }
    }, 2);
    expect(denied.prompts).toEqual(['consent', 'consent']);
    expect(denied.callback.searchParams.get('error')).toBe('access_denied');
    expect(tokenRequests).toBe(tokensBeforeDenial);
    expect(await store.find(provider, webIds.alice, XPOD_DESKTOP_CLIENT_ID)).toBeUndefined();
  });

  it('refreshes online tokens after remembered consent restores a lost OIDC session', async () => {
    await journey();
    jar = new CookieJar();
    jar.setCookieSync('account-cookie=alice-cookie; Path=/', origin);
    const restored = await journey();
    expect(restored.prompts).toEqual(['login']);
    expect(String(restored.tokens.scope).split(' ')).not.toContain('offline_access');
    const renewed = await refresh(restored.tokens.refresh_token);
    expect(renewed.status, JSON.stringify(renewed.tokens)).toBe(200);
    expect(renewed.tokens.access_token).toBeTypeOf('string');
    expect(renewed.tokens.access_token).not.toBe(restored.tokens.access_token);
    expect(renewed.tokens.refresh_token).toBeTypeOf('string');
    const token = await provider.AccessToken.find(renewed.tokens.access_token as string);
    expect(token?.accountId).toBe(webIds.alice);
    expect(token?.grantId).toBe(restored.grantId);
  });

  it('restores a real Inrupt SDK session, renews while idle, and accesses UserInfo after token expiry', async () => {
    accessTokenTtl = 2;
    const login = await journey();
    const session = new Session({ storage: new InMemoryStorage(), keepAlive: true });
    try {
      await session.login({ oidcIssuer: origin, clientId: XPOD_DESKTOP_CLIENT_ID,
        refreshToken: login.tokens.refresh_token as string, tokenType: 'Bearer' });
      expect(session.info.isLoggedIn).toBe(true);
      expect(session.info.webId).toBe(webIds.alice);
      const requestsAfterRestore = tokenRequests;
      const authRequestsAfterRestore = authorizationRequests;
      // The SDK's real timer must renew without an app fetch or authorization.
      await vi.waitFor(() => expect(tokenRequests).toBeGreaterThan(requestsAfterRestore), { timeout: 4000 });
      expect(authorizationRequests).toBe(authRequestsAfterRestore);
      const response = await session.fetch(`${origin}/me`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ sub: webIds.alice, webid: webIds.alice });
    } finally {
      await session.logout();
    }
  });

  it.each(['session', 'grant'] as const)('rejects online refresh after its %s is revoked', async (boundary) => {
    const login = await journey();
    if (boundary === 'session') {
      const session = await provider.Session.findByUid(login.sessionUid);
      expect(session).toBeDefined();
      await session!.destroy();
    } else {
      const grant = await provider.Grant.find(login.grantId);
      expect(grant).toBeDefined();
      await grant!.destroy();
    }
    const renewed = await refresh(login.tokens.refresh_token);
    expect(renewed.status).toBe(400);
    expect(renewed.tokens.error).toBe('invalid_grant');
    expect(renewed.tokens).not.toHaveProperty('access_token');
    expect(renewed.tokens).not.toHaveProperty('id_token');
    expect(renewed.tokens).not.toHaveProperty('refresh_token');
  });

  it('authorizes the bundled desktop application while public metadata requests are offline', async () => {
    const network = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('Public network unavailable');
    });
    try {
      // The real CSS adapter still resolves other client documents over HTTP.
      await expect(metadataAdapter.find('https://other-client.example/client.json')).rejects.toThrow('Public network unavailable');
      expect(network).toHaveBeenCalledTimes(1);
      network.mockClear();
      const login = await journey();
      expect(login.prompts).toEqual(['account', 'login', 'consent']);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('remembers the native application across fresh authorizations and lost OIDC cookies', async () => {
    expect((await journey()).prompts).toEqual(['account', 'login', 'consent']);
    expect((await journey()).prompts).toEqual([]);
    jar = new CookieJar();
    jar.setCookieSync('account-cookie=alice-cookie; Path=/', origin);
    expect((await journey()).prompts).toEqual(['login']);
    jar = new CookieJar();
    expect((await journey()).prompts).toEqual(['account', 'login']);
  });

  it('requires consent again when remember is unchecked, including after remembered consent is withdrawn', async () => {
    expect((await journey({}, 'alice', false)).prompts).toEqual(['account', 'login', 'consent']);
    expect((await journey({}, 'alice', true)).prompts).toEqual(['consent']);
    expect((await journey({ prompt: 'consent' }, 'alice', false)).prompts).toEqual(['consent']);
    expect((await journey()).prompts).toEqual(['consent']);
  });

  it('retains explicit consent and additional scope requirements', async () => {
    await journey();
    expect((await journey({ prompt: 'consent' })).prompts).toEqual(['consent']);
    expect((await journey({ scope: 'openid webid email' })).prompts).toEqual(['consent']);
    expect((await journey({ scope: 'openid webid email' })).prompts).toEqual([]);
  });

  it('checks account ownership before grant reuse when switching from Alice to Bob and back', async () => {
    await journey();
    jar.setCookieSync('account-cookie=bob-cookie; Path=/', origin);
    expect((await journey({}, 'bob')).prompts).toEqual(['login', 'consent']);
    jar.setCookieSync('account-cookie=alice-cookie; Path=/', origin);
    expect((await journey()).prompts).toEqual(['login']);
  });

  it('accepts changing native loopback ports but rejects an unregistered callback origin', async () => {
    await journey();
    const changed = await journey({ redirect_uri: 'http://127.0.0.1:43222/auth/callback' });
    expect(changed.prompts).toEqual([]);
    expect(changed.callback.origin).toBe('http://127.0.0.1:43222');
    const invalid = await request(authorization({ redirect_uri: 'https://wrong-origin.example/auth/callback' }));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('location')).toBeNull();
    expect(await invalid.text()).toContain('redirect_uri');
  });
});
