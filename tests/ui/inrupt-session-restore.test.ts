import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  INRUPT_CURRENT_SESSION_STORAGE_KEY,
  XPOD_SOLID_SESSION_ID_STORAGE_KEY,
  createXpodSolidRuntimeValue,
} from '../../ui/src/solid/XpodSolidRuntime';

describe('Xpod Inrupt session restore integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('runs real Inrupt login, callback, and fresh-runtime hard-reload restore through Xpod storage', async () => {
    const sessionId = 'stable-xpod-session';
    const clientId = 'dynamic-client-id';
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
    window.localStorage.setItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY, sessionId);

    try {
      const redirectUrl = 'https://app.example/auth/callback';
      const loginRuntime = createXpodSolidRuntimeValue();
      loginRuntime.setIssuer(oidc.issuer);
      let authorizationUrl: string | undefined;
      const loginAttempt = loginRuntime.session.login({
        oidcIssuer: oidc.issuer,
        redirectUrl,
        handleRedirect: (url) => {
          authorizationUrl = url;
        },
      });
      await waitFor(() => authorizationUrl !== undefined, 'authorization redirect');
      await expectPending(loginAttempt);
      expect(authorizationUrl).toContain(`${oidc.issuer}authorize?`);
      const oauthState = new URL(authorizationUrl!).searchParams.get('state');
      expect(oauthState).toEqual(expect.any(String));
      expect(JSON.parse(window.localStorage.getItem(`xpod.inrupt.insecure:solidClientAuthenticationUser:${sessionId}`)!))
        .toMatchObject({
          clientId,
          clientSecret,
          issuer: oidc.issuer,
          redirectUrl,
          dpop: 'true',
        });

      // Simulate the stale URL marker left by a previous restore attempt. With
      // upstream Inrupt alone this makes the callback emit SESSION_RESTORED
      // instead of LOGIN, so it does not refresh currentSession.
      window.localStorage.setItem('solidClientAuthn:currentUrl', 'https://app.example/ai-connections');
      expect(window.localStorage.getItem(INRUPT_CURRENT_SESSION_STORAGE_KEY)).toBeNull();
      const callbackRuntime = createXpodSolidRuntimeValue();
      const callbackSnapshot = await withTimeout(
        callbackRuntime.session.handleIncomingRedirect(`${redirectUrl}?code=code-1&state=${oauthState}`),
        'callback redirect handling',
      );
      if (callbackSnapshot.status === 'error') {
        throw callbackSnapshot.error;
      }
      expect(callbackSnapshot).toMatchObject({
        status: 'authenticated',
        webId: oidc.webId,
      });
      expect(oidc.tokenRequests.at(0)?.get('grant_type')).toBe('authorization_code');
      expect(window.localStorage.getItem(INRUPT_CURRENT_SESSION_STORAGE_KEY)).toBe(sessionId);
      expect(JSON.parse(window.localStorage.getItem(`xpod.inrupt.secure:solidClientAuthenticationUser:${sessionId}`)!))
        .toMatchObject({
          isLoggedIn: 'true',
          webId: oidc.webId,
        });

      window.history.replaceState(null, '', 'https://app.example/ai-connections');
      const restoreRuntime = createXpodSolidRuntimeValue();
      const restoreAttempt = restoreRuntime.session.initialize({ restorePreviousSession: true });
      await tick();

      expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBe('https://app.example/ai-connections');
      await expectPending(restoreAttempt);
      expect(oidc.tokenRequests).toHaveLength(1);

      const silentOauthState = await waitForValue(
        () => findOauthStateForSession(window.localStorage, sessionId, oauthState!),
        'silent restore oauth state',
      );
      const silentCallbackRuntime = createXpodSolidRuntimeValue();
      const silentCallbackSnapshot = await withTimeout(
        silentCallbackRuntime.session.handleIncomingRedirect(`${redirectUrl}?code=silent-code&state=${silentOauthState}`),
        'silent restore callback handling',
      );
      if (silentCallbackSnapshot.status === 'error') {
        throw silentCallbackSnapshot.error;
      }
      expect(silentCallbackSnapshot).toMatchObject({
        status: 'authenticated',
        webId: oidc.webId,
      });
      expect(oidc.tokenRequests.at(1)?.get('grant_type')).toBe('authorization_code');
      expect(window.localStorage.getItem('solidClientAuthn:currentUrl')).toBeNull();
      expect(window.localStorage.getItem(INRUPT_CURRENT_SESSION_STORAGE_KEY)).toBe(sessionId);
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.Event = previousEvent;
      globalThis.localStorage = previousLocalStorage;
      globalThis.sessionStorage = previousSessionStorage;
      globalThis.XMLHttpRequest = previousXhr;
      dom.window.close();
      await oidc.close();
    }
  });
});

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
  close: () => Promise<void>;
}> {
  const tokenRequests: URLSearchParams[] = [];
  let issuer = '';
  let webId = '';
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
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/register') {
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

async function waitForValue<T>(read: () => T | undefined, label: string): Promise<T> {
  let value = read();
  await waitFor(() => {
    value = read();
    return value !== undefined;
  }, label);
  return value!;
}

function findOauthStateForSession(storage: Storage, sessionId: string, excludeState: string): string | undefined {
  const prefix = 'xpod.inrupt.insecure:solidClientAuthenticationUser:';
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const state = key.slice(prefix.length);
    if (state === sessionId || state === excludeState) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as { sessionId?: unknown };
      if (record.sessionId === sessionId) return state;
    } catch {
      // Ignore unrelated or corrupt storage records while looking for Inrupt's
      // OAuth state indirection.
    }
  }
  return undefined;
}
