#!/usr/bin/env bun
/**
 * Acceptance: can a host-owned browser session hand the API a Pod credential?
 *
 * The browser logs in with a WebID, never with the Account password, and the Account cookie is
 * issued on the account authority's own origin where that page can never read it. This script
 * proves the whole delegation chain against a throwaway local stack (never a running deployment):
 *
 *  1. the Account API answers the host's own Solid session as its own Account, and advertises the
 *     client-credential control that a cookie-less page cannot otherwise see;
 *  2. a client the host does not ship is refused the same control with the same WebID;
 *  3. the session can create a CSS client credential for that WebID and wrap it as `sk-*`;
 *  4. the API opens the user's Pod with that credential (`/api/ai/gateway/keys` -> 200);
 *  5. the session's own DPoP token still cannot reach the Pod, so nothing was loosened for the
 *     principal the API could never replay.
 *
 * Usage: bun scripts/accept-host-session-delegation.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { setupAccount } from '../tests/integration/helpers/solidAccount';
import { FAKE_QLEVER_LOCAL_RUNTIME_COMMAND } from '../tests/helpers/qleverRuntime';
import { createTestDir } from '../tests/utils/sqlite';
import { XPOD_DESKTOP_CLIENT_ID } from '../src/identity/oidc/RememberedClientGrantStore';

type DpopKey = Awaited<ReturnType<typeof generateDpopKeyPair>>;

const results: { step: string; detail: string; ok: boolean }[] = [];
function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, detail, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}

/** A browser-like cookie jar: the OIDC interaction only continues with its own session cookie. */
class Session {
  private readonly cookies = new Map<string, string>();

  public constructor(private readonly baseUrl: string) {}

  public async fetch(input: {
    url: string;
    method?: string;
    json?: unknown;
    token?: string;
    accept?: string;
  }): Promise<Response> {
    const headers: Record<string, string> = { accept: input.accept ?? 'application/json' };
    if (this.cookies.size > 0) {
      headers.cookie = [ ...this.cookies ].map(([ name, value ]) => `${name}=${value}`).join('; ');
    }
    if (input.token) {
      headers.authorization = `CSS-Account-Token ${input.token}`;
    }
    if (input.json !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(new URL(input.url, this.baseUrl).href, {
      method: input.method ?? 'GET',
      headers,
      redirect: 'manual',
      ...(input.json === undefined ? {} : { body: JSON.stringify(input.json) }),
    });
    for (const cookie of readSetCookies(response)) {
      const [ pair ] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
    return response;
  }
}

function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [ single ] : [];
}

interface InteractionPage {
  prompt?: string;
  controls?: { oidc?: { webId?: string; consent?: string } };
}

/** Keep only the interaction's own base, so a prompt sub-route never nests inside another. */
function interactionBase(url: URL): string | undefined {
  return /^(.*\/\.account\/interaction\/[^/]+\/)/u.exec(url.href)?.[1];
}

function locationOf(response: Response, base: string): URL {
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Interaction step at ${base} returned ${response.status} without a location`);
  }
  return new URL(location, base);
}

/**
 * The URL a completed prompt points at.
 *
 * A prompt answered over JSON carries its next step as `location` in the body - CSS keeps it there
 * so the login cookie it just issued is not lost with a redirect - so both shapes are accepted.
 */
async function nextLocation(response: Response, base: string): Promise<URL> {
  const header = response.headers.get('location');
  if (header) {
    return new URL(header, base);
  }
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { location?: unknown };
    if (typeof body.location === 'string' && body.location) {
      return new URL(body.location, base);
    }
  } catch {
    // Fall through to the failure below with the raw body.
  }
  throw new Error(`Interaction step at ${base} returned ${response.status} without a next step: ${text.slice(0, 160)}`);
}

type PendingStep = { kind: 'callback'; url: URL } | { kind: 'interaction'; base: string };

/**
 * Follow the locations the IdP issues until the flow is either back at the callback or waiting on
 * the interaction page again. The IdP answers a prompt with its own resume URL, not the callback.
 */
async function settle(start: URL, session: Session, accountToken: string, redirectUri: string): Promise<PendingStep> {
  let current = start;
  for (let hop = 0; hop < 8; hop += 1) {
    if (`${current.origin}${current.pathname}` === redirectUri) {
      return { kind: 'callback', url: current };
    }
    const base = interactionBase(current);
    if (base) {
      return { kind: 'interaction', base };
    }
    const response = await session.fetch({ url: current.href, token: accountToken });
    if (response.status < 300 || response.status >= 400) {
      throw new Error(`Following ${current.href} failed: ${response.status} ${(await response.text()).slice(0, 160)}`);
    }
    current = locationOf(response, current.href);
  }
  throw new Error(`The authorization flow did not settle after ${start.href}`);
}

/** Read the authorization code out of the callback redirect. */
function authorizationCode(callback: URL, redirectUri: string, state: string): string {
  if (`${callback.origin}${callback.pathname}` !== redirectUri) {
    throw new Error(`Unexpected callback ${callback.href}`);
  }
  if (callback.searchParams.get('state') !== state) {
    throw new Error(`Authorization returned a foreign state: ${callback.search}`);
  }
  const code = callback.searchParams.get('code');
  if (!code) {
    throw new Error(`Authorization failed: ${callback.search}`);
  }
  return code;
}

/**
 * Run the real authorization-code flow as the client the Xpod desktop shell logs in with, and
 * return the resulting DPoP-bound access token. Nothing is injected: every prompt is answered
 * through the route the IdP itself advertises.
 */
async function loginAsHostClient(input: {
  baseUrl: string;
  session: Session;
  accountToken: string;
  webId: string;
}): Promise<{ accessToken: string; dpopKey: DpopKey; claims: Record<string, unknown> }> {
  const discovery = await (await fetch(new URL('/.well-known/openid-configuration', input.baseUrl))).json() as {
    authorization_endpoint: string;
    token_endpoint: string;
  };
  const redirectUri = 'http://localhost/auth/callback';
  const verifier = `xpod-host-session-${randomUUID()}-pkce-verifier-value`;
  const state = randomUUID();
  const dpopKey = await generateDpopKeyPair();

  const start = new URL(discovery.authorization_endpoint);
  start.search = new URLSearchParams({
    client_id: XPOD_DESKTOP_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid webid offline_access',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  // The IdP answers the authorization request by sending the browser to its interaction page.
  // Every prompt is then answered through that page's own sub-routes, exactly as the account app
  // does: `oidc/pick-webid/` names the WebID, `oidc/consent/` approves the grant. Which one is
  // pending is read from the consent view itself - it reports the WebID the session already holds.
  const landing = await input.session.fetch({ url: start.href, token: input.accountToken });
  if (landing.status < 300 || landing.status >= 400) {
    throw new Error(`Authorization did not start an interaction: ${landing.status}`);
  }
  let pending = await settle(new URL(landing.headers.get('location') ?? '', start.href), input.session, input.accountToken, redirectUri);
  let code: string | undefined;
  for (let step = 0; step < 12 && code === undefined; step += 1) {
    if (pending.kind === 'callback') {
      code = authorizationCode(pending.url, redirectUri, state);
      break;
    }

    const interaction = pending.base;
    const consentUrl = new URL('oidc/consent/', interaction).href;
    const view = await input.session.fetch({ url: consentUrl, token: input.accountToken });
    if (!view.ok) {
      throw new Error(`Consent view ${consentUrl} failed: ${view.status} ${(await view.text()).slice(0, 200)}`);
    }
    const consentView = JSON.parse(await view.text()) as { webId?: string; client?: unknown };
    if (process.env.XPOD_ACCEPT_VERBOSE === '1') {
      console.log(`  consent view -> webId=${String(consentView.webId)} client=${Boolean(consentView.client)}`);
    }

    const prompt = consentView.webId
      ? { url: consentUrl, json: { remember: false } }
      : { url: new URL('oidc/pick-webid/', interaction).href, json: { webId: input.webId, remember: false } };
    const answered = await input.session.fetch({
      url: prompt.url,
      method: 'POST',
      json: prompt.json,
      token: input.accountToken,
    });
    pending = await settle(await nextLocation(answered, interaction), input.session, input.accountToken, redirectUri);
  }
  if (code === undefined) {
    throw new Error('The authorization flow never returned a code');
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      dpop: await createDpopHeader(discovery.token_endpoint, 'POST', dpopKey),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: XPOD_DESKTOP_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const tokenBody = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenBody.slice(0, 200)}`);
  }
  const token = JSON.parse(tokenBody) as { access_token?: string };
  if (!token.access_token) {
    throw new Error(`Token response had no access token: ${tokenBody.slice(0, 200)}`);
  }
  const claims = JSON.parse(
    Buffer.from(token.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return { accessToken: token.access_token, dpopKey, claims };
}

/** Present exactly that DPoP-bound token, as the browser's own fetch would. */
async function dpopHeaders(token: string, dpopKey: DpopKey, url: string, method: string): Promise<Record<string, string>> {
  return { authorization: `DPoP ${token}`, dpop: await createDpopHeader(url, method, dpopKey) };
}

function accountControls(body: string): Record<string, string> {
  return (JSON.parse(body || '{}') as { controls?: { account?: Record<string, string> } }).controls?.account ?? {};
}

const stack = new XpodTestStack();
const runtimeRoot = createTestDir('accept-host-session-delegation');
let failed = false;
try {
  await stack.start('local', {
    // Strict auth: an open stack injects the local owner for credential-less calls, which would
    // make the Pod probes below pass for the wrong reason.
    open: false,
    transport: 'port',
    runtimeRoot,
    logLevel: (process.env.XPOD_ACCEPT_LOG_LEVEL ?? 'warn') as 'debug' | 'info' | 'warn' | 'error',
    env: {
      XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: FAKE_QLEVER_LOCAL_RUNTIME_COMMAND,
      XPOD_SECRET_CELL_KEY_ID: 'accept-host-session-delegation',
      XPOD_SECRET_CELL_KEY: Buffer.alloc(32, 9).toString('base64'),
    },
  });
  console.log(`Stack ready on ${stack.baseUrl}`);

  const account = await setupAccount(stack.baseUrl, 'delegation');
  if (!account?.email || !account.password) {
    throw new Error('Could not create a test account with a password login');
  }
  console.log(`Account ${account.webId}`);

  const session = new Session(stack.baseUrl);
  const passwordLogin = await session.fetch({
    url: '/.account/login/password/',
    method: 'POST',
    json: { email: account.email, password: account.password, remember: true },
  });
  const loginBody = await passwordLogin.text();
  if (!passwordLogin.ok) {
    throw new Error(`Password login failed: ${passwordLogin.status} ${loginBody.slice(0, 200)}`);
  }
  const accountToken = (JSON.parse(loginBody) as { authorization?: string }).authorization;
  if (!accountToken) {
    throw new Error('Password login returned no account token');
  }

  const host = await loginAsHostClient({
    baseUrl: stack.baseUrl,
    session,
    accountToken,
    webId: account.webId,
  });
  record('authorization-code-as-host-client', host.claims.client_id === XPOD_DESKTOP_CLIENT_ID,
    `client_id=${String(host.claims.client_id)} webid=${String(host.claims.webid)} token_type=DPoP`);

  // 1. The Account API answers the host session as its own Account.
  const accountIndexUrl = new URL('/.account/', stack.baseUrl).href;
  const sessionControls = await fetch(accountIndexUrl, {
    headers: { accept: 'application/json', ...await dpopHeaders(host.accessToken, host.dpopKey, accountIndexUrl, 'GET') },
  });
  const sessionControlBody = await sessionControls.text();
  const sessionAccount = accountControls(sessionControlBody);
  const collection = sessionAccount.clientCredentials;
  record('session-resolves-own-account', sessionControls.status === 200 && typeof collection === 'string',
    `GET /.account/ (DPoP, host client) -> ${sessionControls.status} account controls=${Object.keys(sessionAccount).join(',')}`);

  // 2. The same WebID through a client the host does not ship gets no Account.
  const foreign = await loginAsClientWithCredentials({ baseUrl: stack.baseUrl, account });
  const foreignIndexUrl = new URL('/.account/', stack.baseUrl).href;
  const foreignControls = await fetch(foreignIndexUrl, {
    headers: { accept: 'application/json', ...await dpopHeaders(foreign.accessToken, foreign.dpopKey, foreignIndexUrl, 'GET') },
  });
  const foreignAccount = accountControls(await foreignControls.text());
  record('foreign-client-stays-anonymous', foreignAccount.clientCredentials === undefined,
    `GET /.account/ (DPoP, client credentials client) -> ${foreignControls.status} account controls=${Object.keys(foreignAccount).join(',') || '(none)'}`);

  if (typeof collection !== 'string') {
    throw new Error('The host session never reached the client-credential control');
  }

  // 3. The host session creates the credential it hands to the API.
  const created = await fetch(collection, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...await dpopHeaders(host.accessToken, host.dpopKey, collection, 'POST'),
    },
    body: JSON.stringify({ name: 'acceptance', webId: account.webId }),
  });
  const createdBody = await created.text();
  const credential = JSON.parse(createdBody || '{}') as { id?: string; secret?: string; resource?: string };
  const wrapped = credential.id && credential.secret
    ? `sk-${Buffer.from(`${credential.id}:${credential.secret}`, 'utf8').toString('base64')}`
    : undefined;
  record('session-creates-client-credential', created.ok && Boolean(wrapped),
    `POST client-credentials -> ${created.status} id=${credential.id?.slice(0, 12)}…`);

  // 4. The API opens the Pod with that credential.
  const gatewayKeys = await fetch(new URL('/api/ai/gateway/keys', stack.baseUrl), {
    headers: { accept: 'application/json', ...(wrapped ? { authorization: `Bearer ${wrapped}` } : {}) },
  });
  const gatewayKeysBody = await gatewayKeys.text();
  record('api-reads-pod-with-session-credential', gatewayKeys.status === 200,
    `GET /api/ai/gateway/keys -> ${gatewayKeys.status} ${gatewayKeysBody.slice(0, 120)}`);

  const models = await fetch(new URL('/v1/models', stack.baseUrl), {
    headers: { accept: 'application/json', ...(wrapped ? { authorization: `Bearer ${wrapped}` } : {}) },
  });
  record('models-endpoint-accepts-session-credential', models.status === 200,
    `GET /v1/models -> ${models.status} ${(await models.text()).slice(0, 120)}`);

  // 5. The browser session itself is still not a Pod credential the API can spend.
  const withSession = await fetch(new URL('/api/ai/gateway/keys', stack.baseUrl), {
    headers: { accept: 'application/json', ...await dpopHeaders(host.accessToken, host.dpopKey, new URL('/api/ai/gateway/keys', stack.baseUrl).href, 'GET') },
  });
  const withSessionBody = await withSession.text();
  record('session-token-alone-still-refused',
    withSession.status === 403 && withSessionBody.includes('service_access_missing'),
    `GET /api/ai/gateway/keys (session DPoP) -> ${withSession.status} ${withSessionBody.slice(0, 80)}`);
} catch (error: unknown) {
  failed = true;
  record('acceptance-run', false, error instanceof Error ? error.message : String(error));
} finally {
  await stack.stop().catch(() => undefined);
}

/** A DPoP token for the same WebID, issued to the account's own client credentials. */
async function loginAsClientWithCredentials(input: {
  baseUrl: string;
  account: { clientId: string; clientSecret: string };
}): Promise<{ accessToken: string; dpopKey: DpopKey }> {
  const discovery = await (await fetch(new URL('/.well-known/openid-configuration', input.baseUrl))).json() as {
    token_endpoint: string;
  };
  const dpopKey = await generateDpopKeyPair();
  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${input.account.clientId}:${input.account.clientSecret}`, 'utf8').toString('base64')}`,
      dpop: await createDpopHeader(discovery.token_endpoint, 'POST', dpopKey),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Client credentials exchange failed: ${response.status} ${body.slice(0, 160)}`);
  }
  const token = JSON.parse(body) as { access_token?: string };
  if (!token.access_token) {
    throw new Error('Client credentials exchange returned no token');
  }
  return { accessToken: token.access_token, dpopKey };
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(failed || passed !== results.length ? 1 : 0);
