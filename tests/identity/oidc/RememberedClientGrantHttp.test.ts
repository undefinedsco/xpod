import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import Provider, { interactionPolicy, type ClientMetadata } from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountPromptFactory, ConsentHandler, FoundHttpError, MemoryMapStorage,
  RepresentationMetadata, WrappedExpiringStorage, finishInteraction,
  type CookieStore, type WebIdStore,
} from '@solid/community-server';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedClientPromptFactory } from '../../../src/identity/oidc/RememberedClientPromptFactory';
import { RememberedConsentHandler } from '../../../src/identity/oidc/RememberedConsentHandler';
import { ScopedPickWebIdHandler } from '../../../src/identity/oidc/ScopedPickWebIdHandler';

// This is an isolated protocol fixture, not evidence of public IdP deployment.
const metadata = JSON.parse(readFileSync(new URL('../../../ui/public/xpod-desktop-client.json', import.meta.url), 'utf8')) as ClientMetadata;
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
interface Journey { code: string; prompts: string[]; callback: URL }

describe('remembered desktop consent over real OIDC HTTP interactions', () => {
  let server: Server;
  let origin: string;
  let provider: Provider;
  let jar: HttpCookieJar;
  let errors: unknown[];

  beforeEach(async () => {
    jar = new CookieJar();
    errors = [];
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    const policy = interactionPolicy.base();
    // Only the external account persistence boundary is a fixture; all prompt
    // ordering, ownership checks, interaction state and grants run real code.
    const accountCookies = new Map<string, string>([['alice-cookie', 'alice'], ['bob-cookie', 'bob']]);
    const accounts = { get: async (cookie: string) => accountCookies.get(cookie) } as CookieStore;
    const links = { isLinked: async (webId: string, account: string) => webIds[account as User] === webId } as WebIdStore;
    await new RememberedClientPromptFactory(new AccountPromptFactory(links, accounts, 'account-cookie'), store).handleSafe(policy);
    provider = new Provider(origin, {
      clients: [metadata],
      cookies: { keys: ['isolated-http-consent-test-key'] },
      features: { devInteractions: { enabled: false } },
      scopes: ['openid', 'webid', 'offline_access', 'email'],
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
        const json = JSON.parse(Buffer.concat(chunks).toString()) as { user?: User; remember?: boolean };
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

  async function journey(extra: Record<string, string> = {}, user: User = 'alice', remember = true): Promise<Journey> {
    const start = authorization(extra);
    const state = new URL(start).searchParams.get('state');
    let url = start;
    let response = await request(url);
    const prompts: string[] = [];
    for (let step = 0; step < 20; step += 1) {
      if (response.status === 200) {
        const page = await response.json() as InteractionPage;
        expect(['account', 'login', 'consent']).toContain(page.prompt);
        prompts.push(page.prompt);
        response = await request(url, { user, remember });
      } else {
        const details = await response.text();
        expect([302, 303], details).toContain(response.status);
        const location = response.headers.get('location');
        expect(location, details).toBeTruthy();
        const next = new URL(location!, url);
        if (next.origin !== origin) {
          expect(next.searchParams.get('error'), next.href).toBeNull();
          expect(next.searchParams.get('state')).toBe(state);
          const code = next.searchParams.get('code');
          expect(code).toBeTruthy();
          // Validate the actual authorization code through the token endpoint,
          // including native public client authentication and PKCE binding.
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
          return { code: code!, prompts, callback: next };
        }
        url = next.href;
        response = await request(url);
      }
    }
    throw new Error(`OIDC redirect loop: ${prompts.join(', ')}`);
  }

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
