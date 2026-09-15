import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import Provider from 'oidc-provider';
import { FoundHttpError, RepresentationMetadata } from '@solid/community-server';
import { ScopedPickWebIdHandler } from '../../src/identity/oidc/ScopedPickWebIdHandler';

// Isolated protocol integration: Chromium, HTTP, OIDC transactions and the
// product WebID picker are real. Account/ownership and the tiny consent HTML
// are fixtures. This is not an acceptance claim for the deployed Cloud UI.
test.describe('WebID selection resumes across the native callback origin', () => {
  let issuerServer: Server;
  let callbackServer: Server;
  let issuer: string;
  let callbackOrigin: string;
  let provider: Provider;
  let pickPosts: number;
  let staleConsentPosts: number;
  let callbackRequests: number;
  let errors: unknown[];
  const webId = 'https://pod.example/alice/profile/card#me';
  const verifier = 'cross-origin-browser-protocol-verifier-at-least-43-characters';

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test.beforeEach(async () => {
    pickPosts = 0;
    staleConsentPosts = 0;
    callbackRequests = 0;
    errors = [];
    callbackServer = createServer((request, response) => {
      // Deliberately no Access-Control-Allow-Origin: native SDK callbacks are
      // document destinations, not APIs callable by an external issuer page.
      if (request.url?.startsWith('/auth/callback')) callbackRequests += 1;
      response.setHeader('content-type', 'text/html');
      response.end('<h1>Native callback</h1>');
    });
    callbackOrigin = await listen(callbackServer);
    issuerServer = createServer();
    issuer = await listen(issuerServer);
    provider = new Provider(issuer, {
      clients: [{ client_id: 'browser-native-fixture', redirect_uris: [`${callbackOrigin}/auth/callback`],
        response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
      cookies: { keys: ['cross-origin-protocol-fixture-cookie-key'] },
      features: { devInteractions: { enabled: false } },
      interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
      findAccount: async (_ctx, accountId) => ({ accountId, claims: async () => ({ sub: accountId }) }),
      // Reproduce the remembered-client path: selecting WebID can resume all
      // the way to callback without a second consent prompt.
      loadExistingGrant: async () => {
        const grant = new provider.Grant({ accountId: webId, clientId: 'browser-native-fixture' });
        grant.addOIDCScope('openid');
        await grant.save();
        return grant;
      },
    });
    provider.on('server_error', (error: unknown) => errors.push(error));
    const picker = new ScopedPickWebIdHandler({
      providerFactory: { getProvider: async () => provider },
      ownershipResolver: {
        listAccountWebIds: async () => [webId],
        resolveOwnedWebIds: async ({ target }) => [{ webId, storageUrl: target.storageUrl, storageMode: 'cloud' as const }],
      },
    });
    const oidc = provider.callback();
    issuerServer.on('request', (request, response) => {
      if (request.url === '/stale-consent') {
        staleConsentPosts += 1;
        response.end('{}');
        return;
      }
      if (!request.url?.startsWith('/interaction/')) {
        oidc(request, response);
        return;
      }
      void (async () => {
        const interaction = await provider.interactionDetails(request, response);
        if (request.method === 'GET') {
          response.setHeader('content-type', 'text/html');
          if (interaction.prompt.name === 'consent') {
            response.end('<h1>Additional consent required</h1>');
            return;
          }
          response.end(`<button id="legacy">Legacy fetch</button><button id="native">Native navigation</button>
            <output id="result"></output><script>
            async function pick(native) {
              try {
                const response = await fetch(location.pathname, {method:'POST'});
                const selected = await response.json();
                if (native) { location.assign(selected.location); return; }
                await fetch(selected.location);
                await fetch('/stale-consent', {method:'POST'});
              } catch (error) { document.querySelector('#result').textContent = error.name; }
            }
            document.querySelector('#legacy').onclick = () => pick(false);
            document.querySelector('#native').onclick = () => pick(true);
            </script>`);
          return;
        }
        pickPosts += 1;
        await picker.handleSafe({ method: 'POST', target: { path: new URL(request.url!, issuer).href },
          metadata: new RepresentationMetadata(), oidcInteraction: interaction,
          accountId: 'fixture-account', json: { webId, remember: true } });
      })().catch((error: unknown) => {
        if (error instanceof FoundHttpError) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ location: error.location }));
        } else {
          errors.push(error);
          response.statusCode = 500;
          response.end('Fixture failed');
        }
      });
    });
  });

  test.afterEach(async () => {
    for (const server of [issuerServer, callbackServer]) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    expect(errors).toEqual([]);
  });

  function authorization(extra: Record<string, string> = {}): string {
    return `${issuer}/auth?${new URLSearchParams({ client_id: 'browser-native-fixture',
      redirect_uri: `${callbackOrigin}/auth/callback`, response_type: 'code', scope: 'openid',
      state: 'browser-cross-origin-state', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...extra })}`;
  }

  test('legacy fetch follows the redirect but CORS rejects delivery to the SDK document', async ({ page }) => {
    await page.goto(authorization());
    await page.locator('#legacy').click();
    await expect(page.locator('#result')).toHaveText('TypeError');
    expect(new URL(page.url()).origin).toBe(issuer);
    expect(callbackRequests).toBe(1);
    expect(pickPosts).toBe(1);
    expect(staleConsentPosts).toBe(0);
  });

  test('native navigation delivers a usable code/state without a second consent POST', async ({ page }) => {
    await page.goto(authorization());
    await page.locator('#native').click();
    await expect(page.getByRole('heading', { name: 'Native callback' })).toBeVisible();
    const callback = new URL(page.url());
    expect(callback.origin).toBe(callbackOrigin);
    expect(callback.searchParams.get('state')).toBe('browser-cross-origin-state');
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();
    const token = await fetch(`${issuer}/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!,
        client_id: 'browser-native-fixture', redirect_uri: `${callbackOrigin}/auth/callback`, code_verifier: verifier }) });
    expect(token.status).toBe(200);
    const tokens = await token.json() as { access_token?: string; id_token?: string };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();
    expect(pickPosts).toBe(1);
    expect(callbackRequests).toBe(1);
    expect(staleConsentPosts).toBe(0);
  });

  test('native navigation stops at a new issuer consent prompt without approving it', async ({ page }) => {
    await page.goto(authorization({ prompt: 'consent' }));
    await page.locator('#native').click();
    await expect(page.getByRole('heading', { name: 'Additional consent required' })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(issuer);
    expect(pickPosts).toBe(1);
    expect(callbackRequests).toBe(0);
    expect(staleConsentPosts).toBe(0);
  });

});
