import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { decodeJwt } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

it('real browser Session redirect factory and fetch bind the dispatched token', async () => {
  const browserEntry = createRequire(import.meta.url).resolve('@inrupt/solid-client-authn-browser');
  const require = createRequire(browserEntry);
  const dpopKey = await generateDpopKeyPair();
  const tokens = { accessToken: 'browser-session-fixture', dpopKey, webId: 'https://pod.example/alice#me', clientId: 'fixture-client' };
  const location = { href: 'https://app.example/callback?code=fixture&state=fixture-state' };
  const entries = new Map<string, string>();
  vi.stubGlobal('window', {
    location,
    history: { replaceState: (_state: unknown, _unused: string, url: string) => { location.href = url; } },
    localStorage: { setItem: (key: string, value: string) => entries.set(key, value), getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => entries.delete(key) },
  });
  const module = { exports: {} as any };
  // Only the token-exchange response is a fixture. The installed browser
  // Session, redirect handler, authenticated-fetch factory and signer are real.
  const packageRequire = (id: string) => id === '@inrupt/oidc-client-ext'
    ? { ...require(id), getTokens: async () => tokens } : require(id);
  new Function('require', 'module', 'exports', readFileSync(browserEntry, 'utf8'))(packageRequire, module, module.exports);
  const { Session, InMemoryStorage } = module.exports;
  let dispatched = false;
  const session = new Session({
    secureStorage: new InMemoryStorage(), insecureStorage: new InMemoryStorage(),
    fetch: async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`DPoP ${tokens.accessToken}`);
      const proof = decodeJwt(headers.get('dpop')!);
      expect(proof.ath).toBe(createHash('sha256').update(tokens.accessToken).digest('base64url'));
      expect(proof).toMatchObject({ htm: 'GET', htu: 'https://identity.example/.account/' });
      dispatched = true;
      return new Response(null, { status: 200 });
    },
  }, 'fixture-session');
  const redirect = session.clientAuthentication.redirectHandler.handleables.find((handler: any) => handler.constructor.name === 'AuthCodeRedirectHandler');
  expect(redirect).toBeDefined();
  await redirect.storageUtility.setForUser('fixture-state', { sessionId: 'fixture-session' });
  await redirect.storageUtility.setForUser('fixture-session', { issuer: 'https://identity.example/', codeVerifier: 'fixture', redirectUrl: 'https://app.example/callback', dpop: 'true' });
  redirect.issuerConfigFetcher.fetchConfig = async () => ({ issuer: 'https://identity.example/' });
  redirect.clientRegistrar.getClient = async () => ({ clientId: 'fixture-client' });
  expect(await session.handleIncomingRedirect({ url: location.href })).toMatchObject({ isLoggedIn: true, webId: tokens.webId });
  await session.fetch('https://identity.example/.account/');
  expect(dispatched).toBe(true);
});
