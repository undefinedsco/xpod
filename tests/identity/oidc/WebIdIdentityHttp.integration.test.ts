import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import Provider, { type Configuration } from 'oidc-provider';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Parser, Store, Writer, DataFactory } from 'n3';
import { expect, it } from 'vitest';
import {
  BaseLoginAccountStorage, BaseWebIdStore, BasePodStore, ConsentHandler, ExpiringAdapterFactory,
  FoundHttpError, BadRequestHttpError, MemoryMapStorage, RepresentationMetadata,
  type IdentityProviderFactoryArgs, type AccountLoginStorage,
} from '@solid/community-server';
import { RdfHandlebarsTemplateEngine } from '../../../src/util/templates/RdfHandlebarsTemplateEngine';
import { DrizzleIndexedStorage } from '../../../src/identity/drizzle/DrizzleIndexedStorage';
import { closeAllIdentityConnections } from '../../../src/identity/drizzle/db';
import { SessionBoundIdentityProviderFactory } from '../../../src/identity/oidc/SessionBoundIdentityProviderFactory';
import { ScopedPickWebIdHandler } from '../../../src/identity/oidc/ScopedPickWebIdHandler';
import { CssPodOwnershipResolver } from '../../../src/identity/oidc/PodOwnershipResolver';

// Independent HTTP protocol acceptance, not the deployed Gateway/browser lane.
// Real CSS account/owner stores, picker, claims hook and Profile template are used.
// Account sign-in is the fixture boundary; the PodManager serves the production
// template's RDF over HTTP instead of constructing a complete CSS server stack.
interface CookieJar {
  getCookieStringSync(url: string): string;
  setCookieSync(cookie: string, url: string): unknown;
}
const require = createRequire(import.meta.url);
const { CookieJar: Jar } = require('jsdom') as { CookieJar: new () => CookieJar };
const clientId = 'raw-webid-protocol-client';
const redirectUri = 'https://client.example/auth/callback';
const verifier = 'raw-webid-protocol-pkce-verifier-more-than-forty-three-characters';

it('preserves distinct raw WebIDs through real owner selection, signed tokens and Profile RDF HTTP', async () => {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  expect([3000, 5737]).not.toContain(port);
  const origin = `http://127.0.0.1:${port}`;
  const profileOrigin = `http://localhost:${port}`;
  const webIds = [
    `http://LOCALHOST:${port}/profile/card#me`,
    `${profileOrigin}/profile/card#me`,
    `${profileOrigin}/profile/card?version=2&view=full#other`,
  ];
  // The first two share a fetch URL, but are deliberately distinct identities.
  expect(new URL(webIds[0]).href).toBe(webIds[1]);
  const errors: unknown[] = [];
  const rawStorage = new DrizzleIndexedStorage(`sqlite::memory:webid-http-${randomUUID()}`);
  const storage = new BaseLoginAccountStorage<{ account: Record<string, never>; 'fixture-login': { accountId: 'id:account' } }>(rawStorage);
  // CSS deliberately erases the concrete type registry at component boundaries.
  const cssStorage = storage as unknown as AccountLoginStorage<Record<string, never>>;
  const links = new BaseWebIdStore(cssStorage);
  const profiles = new Map<string, string[]>();
  const engine = new RdfHandlebarsTemplateEngine(`${origin}/`);
  const profileTemplate = path.join(path.dirname(require.resolve('@solid/community-server/package.json')),
    'templates/pod/base/profile/card$.ttl.hbs');
  const pods = new BasePodStore(cssStorage, {
    createPod: async (settings) => {
      const turtle = await engine.handle({ template: { templateFile: profileTemplate }, contents: settings });
      const document = new URL(settings.webId);
      document.hash = '';
      const existing = profiles.get(document.pathname + document.search) ?? [];
      profiles.set(document.pathname + document.search, [...existing, turtle]);
    },
  });
  try {
    await storage.defineType('account', {}, false);
    await storage.defineType('fixture-login', { accountId: 'id:account' }, true);
    await links.handle();
    await pods.handle();
    const accounts: string[] = [];
    const podIds: string[] = [];
    for (const [index, webId] of webIds.entries()) {
      const account = await storage.create('account', {});
      accounts.push(account.id);
      await storage.create('fixture-login', { accountId: account.id });
      await links.create(webId, account.id);
      podIds.push(await pods.create(account.id, {
        base: { path: `${origin}/pod-${index}/` }, webId, oidcIssuer: `${origin}/`,
      }, false));
    }
    const ownership = new CssPodOwnershipResolver({ webIdStore: links, podStore: pods });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { ...privateKey.export({ format: 'jwk' }), kid: 'raw-webid-test', alg: 'RS256', use: 'sig' };
    const factory = new SessionBoundIdentityProviderFactory({
      clients: [{ client_id: clientId, redirect_uris: [redirectUri], grant_types: ['authorization_code'],
        response_types: ['code'], token_endpoint_auth_method: 'none' }],
      features: { devInteractions: { enabled: false } }, scopes: ['openid', 'webid'],
      claims: { webid: ['webid'] }, conformIdTokenClaims: false,
    }, {
      storage: new MemoryMapStorage(), adapterFactory: new ExpiringAdapterFactory(new MemoryMapStorage()),
    } as unknown as IdentityProviderFactoryArgs);
    // CSS keeps these hooks private; invoke the installed implementation rather
    // than duplicating its claim mapping in the fixture.
    const hooks = factory as unknown as {
      initConfig(key: Record<string, unknown>): Promise<Configuration>;
      configureClaims(config: Configuration, algorithm: string): void;
    };
    const config = await hooks.initConfig(key);
    hooks.configureClaims(config, 'RS256');
    const provider = new Provider(origin, {
      ...config, interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    });
    provider.on('server_error', (error: unknown) => errors.push(error));
    const providerFactory = { getProvider: async () => provider };
    const picker = new ScopedPickWebIdHandler({ providerFactory, ownershipResolver: ownership, storageBaseUrl: `${origin}/` });
    const consent = new ConsentHandler(providerFactory);
    const callback = provider.callback();
    server.on('request', (request, response) => {
      if (request.url?.startsWith('/profile/card')) {
        const graphs = profiles.get(request.url);
        if (!graphs) { response.writeHead(404).end(); return; }
        // Exercise RDF parsing/serialization as well as CSS template rendering.
        const graph = new Store(graphs.flatMap((turtle) => new Parser({ baseIRI: `${profileOrigin}${request.url}` }).parse(turtle)));
        const writer = new Writer({ format: 'text/turtle' });
        writer.addQuads(graph.getQuads(null, null, null, null));
        writer.end((error, turtle) => {
          if (error) { errors.push(error); response.writeHead(500).end(); return; }
          response.setHeader('content-type', 'text/turtle'); response.end(turtle);
        });
        return;
      }
      if (!request.url?.startsWith('/interaction/')) { callback(request, response); return; }
      void (async () => {
        const interaction = await provider.interactionDetails(request, response);
        if (request.method === 'GET') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ prompt: interaction.prompt.name }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const json = JSON.parse(Buffer.concat(chunks).toString()) as { accountId: string; webId: string };
        // The fixture supplies the signed-in Account; the real picker independently
        // resolves its links and Pod ownership before persisting the OIDC login.
        if (!accounts.includes(json.accountId)) { response.writeHead(401).end(); return; }
        const input = { method: 'POST', accountId: json.accountId, oidcInteraction: interaction,
          metadata: new RepresentationMetadata(), target: { path: new URL(request.url!, origin).href },
          json: interaction.prompt.name === 'login' ? { webId: json.webId, remember: false } : {} };
        if (interaction.prompt.name === 'login') await picker.handleSafe(input);
        else if (interaction.prompt.name === 'consent') await consent.handleSafe(input);
        else throw new Error(`Unexpected interaction ${interaction.prompt.name}`);
      })().catch((error: unknown) => {
        if (error instanceof FoundHttpError) response.writeHead(302, { location: error.location }).end();
        else if (error instanceof BadRequestHttpError) response.writeHead(400).end();
        else { errors.push(error); response.writeHead(500).end(); }
      });
    });
    const jwks = createRemoteJWKSet(new URL('/jwks', origin));
    for (const [index, webId] of webIds.entries()) {
      const jar = new Jar();
      const request = async (url: string, body?: object) => {
        const result = await fetch(url, { redirect: 'manual', headers: {
          cookie: jar.getCookieStringSync(url), ...(body ? { 'content-type': 'application/json' } : {}),
        }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
        for (const cookie of result.headers.getSetCookie()) jar.setCookieSync(cookie, url);
        return result;
      };
      const start = new URL('/auth', origin);
      const state = randomUUID();
      start.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
        response_type: 'code', scope: 'openid webid', state, resource: `${origin}/`,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      let url = start.href;
      let result = await request(url);
      let code: string | null = null;
      let rejectedOtherIdentity = false;
      for (let step = 0; step < 15; step += 1) {
        if (result.status === 200) {
          const page = await result.json() as { prompt: string };
          if (page.prompt === 'login') {
            const other = webIds[(index + 1) % webIds.length];
            const denied = await request(url, { accountId: accounts[index], webId: other });
            expect(denied.status).toBe(400);
            expect(denied.headers.get('location')).toBeNull();
            rejectedOtherIdentity = true;
          }
          result = await request(url, { accountId: accounts[index], webId });
        } else {
          expect([302, 303]).toContain(result.status);
          const next = new URL(result.headers.get('location')!, url);
          if (next.origin !== origin) {
            expect(next.origin + next.pathname).toBe(redirectUri);
            expect(next.searchParams.get('error')).toBeNull();
            expect(next.searchParams.get('state')).toBe(state);
            code = next.searchParams.get('code');
            break;
          }
          url = next.href; result = await request(url);
        }
      }
      expect(rejectedOtherIdentity).toBe(true);
      expect(code).toBeTruthy();
      const token = await fetch(`${origin}/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource: `${origin}/`,
        }) });
      expect(token.status).toBe(200);
      const tokens = await token.json() as { id_token: string; access_token: string };
      const id = await jwtVerify(tokens.id_token, jwks, { issuer: origin, audience: clientId });
      const access = await jwtVerify(tokens.access_token, jwks, { issuer: origin, audience: 'solid' });
      expect(id.payload.sub).toBe(webId);
      expect(id.payload.webid).toBe(webId);
      expect(access.payload.webid).toBe(webId);
      expect(await pods.getOwners(podIds[index])).toEqual([{ webId, visible: false }]);
      await expect(ownership.resolveOwnedWebIds({ accountId: accounts[index], candidateWebIds: webIds,
        target: { storageUrl: `${origin}/` } })).resolves.toEqual([expect.objectContaining({ webId })]);
      const document = new URL(webId); document.hash = '';
      const profile = await fetch(document);
      expect(profile.status).toBe(200);
      const graph = new Store(new Parser({ baseIRI: document.href }).parse(await profile.text()));
      expect(graph.getQuads(DataFactory.namedNode(webId), DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer'),
        DataFactory.namedNode(`${origin}/`), null)).toHaveLength(1);
      const topics = graph.getObjects(null, DataFactory.namedNode('http://xmlns.com/foaf/0.1/primaryTopic'), null).map((term) => term.value);
      expect(topics).toContain(webId);
      if (index < 2) expect(topics.sort()).toEqual(webIds.slice(0, 2).sort());
      else expect(topics).toEqual([webId]);
    }
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeAllIdentityConnections();
  }
});
