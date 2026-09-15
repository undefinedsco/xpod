import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { XpodSolidRuntimeProvider } from '../../ui/src/solid/XpodSolidRuntimeProvider';
import { useXpodSolidRuntime } from '../../ui/src/solid/useXpodSolidRuntime';
import {
  createXpodSolidRuntimeValue,
  type XpodSolidRuntimeValue,
} from '../../ui/src/solid/XpodSolidRuntime';
import { completeXpodOidcCallback } from '../../ui/src/solid/XpodOidcCallbackApp';

const INRUPT_CURRENT_SESSION_STORAGE_KEY = 'solidClientAuthn:currentSession';

// Uses the installed Inrupt SDK and real HTTP discovery/token/JWKS endpoints.
// The local OIDC fixture signs tokens; it is not a live Xpod deployment.
describe('Xpod Inrupt session restore integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('completes a redirect with the SDK-generated session and fixed desktop client', async () => {
    await withOidcFixture(async ({ oidc, providerLogin, clientId }) => {
      const authorization = await providerLogin(createXpodSolidRuntimeValue());
      const sessionId = sessionIdForAuthorization(authorization);
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(window.localStorage.getItem(`xpod.inrupt.insecure:solidClientAuthenticationUser:${sessionId}`)!))
        .toMatchObject({ clientId, issuer: oidc.issuer, redirectUrl: 'https://app.example/auth/callback', dpop: 'true' });
      await completeAuthorization(authorization, oidc.webId);
      expect(window.localStorage.getItem(INRUPT_CURRENT_SESSION_STORAGE_KEY)).toBe(sessionId);
      expect(oidc.tokenRequests[0].get('client_id')).toBe(clientId);
      expect(oidc.registrationRequests).toHaveLength(0);
    });
  });

  test('supports explicit SDK silent restoration without dynamically registering a client', async () => {
    await withOidcFixture(async ({ oidc, providerLogin, silentAuthorizations, clientId }) => {
      const original = await providerLogin(createXpodSolidRuntimeValue());
      await completeAuthorization(original, oidc.webId);
      window.history.replaceState(null, '', 'https://app.example/ai-connections');
      const restore = createXpodSolidRuntimeValue().session.initialize({ restorePreviousSession: true });
      await waitFor(() => silentAuthorizations.length === 1, 'silent authorization redirect');
      await expectPending(restore);
      expect(silentAuthorizations[0].searchParams.get('prompt')).toBe('none');
      expect(silentAuthorizations[0].searchParams.get('client_id')).toBe(clientId);
      await completeAuthorization(silentAuthorizations[0], oidc.webId);
      expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBeNull();
      expect(oidc.registrationRequests).toHaveLength(0);
    });
  });

  test('returns a rejected silent restoration to the application without authenticating', async () => {
    await withOidcFixture(async ({ oidc, providerLogin, silentAuthorizations }) => {
      await completeAuthorization(await providerLogin(createXpodSolidRuntimeValue()), oidc.webId);
      window.history.replaceState(null, '', 'https://app.example/ai-connections');
      void createXpodSolidRuntimeValue().session.initialize({ restorePreviousSession: true });
      await waitFor(() => silentAuthorizations.length === 1, 'silent authorization redirect');
      const failureRuntime = createXpodSolidRuntimeValue();
      const state = silentAuthorizations[0].searchParams.get('state');
      const recovered = await completeXpodOidcCallback({
        href: `https://app.example/auth/callback?error=login_required&state=${state}`,
        runtime: failureRuntime,
        storage: window.sessionStorage,
      });
      expect(recovered).toEqual({ status: 'redirected', destination: 'https://app.example/ai-connections' });
      expect(failureRuntime.session.getSnapshot().status).not.toBe('authenticated');
    });
  });

  test('can log in again after SDK logout and browser storage clearing', async () => {
    await withOidcFixture(async ({ oidc, providerLogin }) => {
      const loggedIn = await completeAuthorization(await providerLogin(createXpodSolidRuntimeValue()), oidc.webId);
      await loggedIn.session.logout();
      expect(loggedIn.session.getSnapshot().status).toBe('anonymous');
      expect(window.localStorage.getItem(INRUPT_CURRENT_SESSION_STORAGE_KEY)).toBeNull();
      window.localStorage.clear();
      window.sessionStorage.clear();
      await completeAuthorization(await providerLogin(createXpodSolidRuntimeValue(), 'select_account'), oidc.webId);
    });
  });

  test('completes two overlapping logins with independent SDK session IDs', async () => {
    await withOidcFixture(async ({ oidc, providerLogin }) => {
      const first = await providerLogin(createXpodSolidRuntimeValue());
      const second = await providerLogin(createXpodSolidRuntimeValue());
      const state1 = first.searchParams.get('state')!;
      const state2 = second.searchParams.get('state')!;
      const readRecord = (state: string) => JSON.parse(window.localStorage.getItem(
        `xpod.inrupt.insecure:solidClientAuthenticationUser:${state}`,
      )!);
      expect(state1).not.toBe(state2);
      expect(readRecord(state1).sessionId).not.toBe(readRecord(state2).sessionId);
      // Both authorizations are outstanding before either callback completes.
      // The token endpoint checks each transaction's own PKCE challenge.
      await completeAuthorization(first, oidc.webId);
      await completeAuthorization(second, oidc.webId);
      expect(oidc.tokenRequests).toHaveLength(2);
    });
  });
});

async function withOidcFixture(run: (fixture: {
  oidc: Awaited<ReturnType<typeof startOidcStubServer>>;
  providerLogin: (runtime: ReturnType<typeof createXpodSolidRuntimeValue>, prompt?: 'consent' | 'select_account') => Promise<URL>;
  silentAuthorizations: URL[];
  clientId: string;
}) => Promise<void>): Promise<void> {
  const clientId = 'https://id.undefineds.co/app/xpod-desktop-client.json';
  const clientSecret = 'dynamic-client-secret';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'inrupt-restore-test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const oidc = await startOidcStubServer({
    clientId,
    clientSecret,
    publicJwk,
    privateKey,
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const previousXhr = globalThis.XMLHttpRequest;
  const previousFetch = globalThis.fetch;
  const previousBridge = globalThis.xpodDesktop;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    if (!error.message.includes('Not implemented: navigation')) {
      throw error;
    }
  });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://app.example/ai-connections',
    virtualConsole,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.XMLHttpRequest = dom.window.XMLHttpRequest;

  let authorizationUrl: string | undefined;
  const silentAuthorizations: URL[] = [];
  const providerWindow = Object.create(dom.window) as Window & typeof globalThis;
  Object.defineProperty(providerWindow, 'location', { value: {
    get href() { return dom.window.location.href; },
    set href(url: string) {
        const authorization = new URL(url);
        oidc.authorize(authorization);
        silentAuthorizations.push(authorization);
      },
    get origin() { return dom.window.location.origin; },
    assign: (url: string) => { authorizationUrl = url; },
  } });
  globalThis.window = providerWindow;
  globalThis.xpodDesktop = { setIdentity: () => undefined };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (input, init) => String(input) === '/provision/status'
    ? Promise.resolve(new Response(JSON.stringify({
      managed: true, oidcIssuer: oidc.issuer, provisionCode: 'current-provision-scope',
    }), { headers: { 'content-type': 'application/json' } }))
    : previousFetch(input, init);
  const providerLogin = async (runtime: ReturnType<typeof createXpodSolidRuntimeValue>, prompt?: 'consent' | 'select_account') => {
    let exposed: XpodSolidRuntimeValue | undefined;
    function CaptureRuntime() {
      exposed = useXpodSolidRuntime();
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(XpodSolidRuntimeProvider, { value: runtime }, createElement(CaptureRuntime)));
    });
    authorizationUrl = undefined;
    try {
      await act(async () => {
        void exposed!.login({
          id: 'desktop-login',
          route: {
            id: 'xpod-current-origin', label: 'Xpod',
            identityProvider: { url: window.location.origin, label: 'Xpod' },
            storageProvider: { url: window.location.origin, label: 'Xpod' }, availability: 'ready',
          },
          authorizationSurface: 'redirect', discovery: 'strict',
          ...(prompt ? { prompt } : {}),
        });
        await waitFor(() => authorizationUrl !== undefined, 'provider authorization redirect');
      });
      const authorization = new URL(authorizationUrl!);
      oidc.authorize(authorization);
      expect(authorization.searchParams.get('client_id')).toBe(clientId);
      expect(authorization.searchParams.get('prompt')).toBe(prompt ?? null);
      expect(authorization.searchParams.get('provisionCode')).toBe('current-provision-scope');
      expect(oidc.registrationRequests).toHaveLength(0);
      return authorization;
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  };
  try {
    await run({ oidc, providerLogin, silentAuthorizations, clientId });
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.Event = previousEvent;
    globalThis.localStorage = previousLocalStorage;
    globalThis.sessionStorage = previousSessionStorage;
    globalThis.XMLHttpRequest = previousXhr;
    globalThis.fetch = previousFetch;
    globalThis.xpodDesktop = previousBridge;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
    await oidc.close();
  }
}

async function startOidcStubServer({
  clientId,
  clientSecret,
  publicJwk,
  privateKey,
}: {
  clientId: string;
  clientSecret: string;
  publicJwk: JsonWebKey;
  privateKey: KeyObject;
}): Promise<{
  issuer: string;
  webId: string;
  tokenRequests: URLSearchParams[];
  registrationRequests: string[];
  authorize: (authorization: URL) => void;
  close: () => Promise<void>;
}> {
  const tokenRequests: URLSearchParams[] = [];
  const authorizedCodes = new Map<string, { challenge: string; redirectUrl: string }>();
  let issuer = '';
  let webId = '';
  const registrationRequests: string[] = [];
  const server = createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 404, { error: 'missing-url' });
      return;
    }
    const url = new URL(request.url, issuer);
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        registration_endpoint: `${issuer}register`,
        scopes_supported: ['openid', 'webid', 'offline_access'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/register') {
      registrationRequests.push(request.url);
      const payload = JSON.parse(await readBody(request)) as { redirect_uris?: string[] };
      sendJson(response, 200, {
        client_id: clientId,
        client_secret: clientSecret,
        client_secret_expires_at: 0,
        id_token_signed_response_alg: 'RS256',
        redirect_uris: payload.redirect_uris,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(request));
      tokenRequests.push(body);
      const code = body.get('code') ?? '';
      const authorization = authorizedCodes.get(code);
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (!authorization || authorization.challenge !== challenge
        || body.get('client_id') !== clientId || body.get('redirect_uri') !== authorization.redirectUrl) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      authorizedCodes.delete(code);
      sendJson(response, 200, {
        access_token: 'controlled-access-token',
        id_token: createSignedTestJwt({
          webid: webId,
          azp: clientId,
          iss: issuer,
          aud: clientId,
          sub: webId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        }, { alg: 'RS256', kid: publicJwk.kid }, privateKey),
        refresh_token: 'controlled-refresh-token',
        token_type: 'DPoP',
        expires_in: 300,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [publicJwk] });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    sendJson(response, 404, { error: `Unhandled ${request.method} ${url.pathname}` });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  webId = `${issuer}alice/profile/card#me`;
  return {
    issuer,
    webId,
    tokenRequests,
    registrationRequests,
    // This fixture replaces consent only; real SDK discovery, PKCE token
    // exchange and signed-ID-token validation still run over HTTP.
    authorize: (authorization) => {
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      authorizedCodes.set(`code-${authorization.searchParams.get('state')}`, {
        challenge: authorization.searchParams.get('code_challenge')!,
        redirectUrl: authorization.searchParams.get('redirect_uri')!,
      });
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(value));
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,dpop',
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createSignedTestJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .end()
    .sign(privateKey);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('=', '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function expectPending<T>(promise: Promise<T>): Promise<void> {
  await expect(Promise.race([
    promise.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ])).resolves.toBe('pending');
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
    }),
  ]);
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`${label} timed out`);
    }
    await tick();
  }
}

function sessionIdForAuthorization(authorization: URL): string {
  return JSON.parse(window.localStorage.getItem(
    `xpod.inrupt.insecure:solidClientAuthenticationUser:${authorization.searchParams.get('state')}`,
  )!).sessionId as string;
}

async function completeAuthorization(authorization: URL, webId: string) {
  const runtime = createXpodSolidRuntimeValue();
  const state = authorization.searchParams.get('state');
  const snapshot = await withTimeout(runtime.session.handleIncomingRedirect(
    `https://app.example/auth/callback?code=code-${state}&state=${state}`,
  ), 'callback redirect handling');
  if (snapshot.status === 'error') throw snapshot.error;
  expect(snapshot).toMatchObject({ status: 'authenticated', webId });
  return runtime;
}
