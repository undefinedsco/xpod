#!/usr/bin/env bun
/**
 * Acceptance: which caller credentials let the API read a user's Pod?
 *
 * Verifies, against a throwaway local stack (never a running deployment), that:
 *  1. CSS issues a real Bearer access token for the account's client credentials;
 *  2. that Bearer token works on the Pod directly (so it is a genuine Pod credential);
 *  3. the API accepts it and reaches the Pod with it, although the API holds no owner key;
 *  4. a DPoP token for the same user authenticates but does not reach the Pod;
 *  5. no caller at all is rejected.
 *
 * Usage: bun scripts/accept-solid-bearer-pod-access.ts
 */
import { createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { setupAccount } from '../tests/integration/helpers/solidAccount';
import { FAKE_QLEVER_LOCAL_RUNTIME_COMMAND } from '../tests/helpers/qleverRuntime';
import { createTestDir } from '../tests/utils/sqlite';

interface TokenResult {
  tokenType: string;
  accessToken: string;
  dpopKey?: Awaited<ReturnType<typeof generateDpopKeyPair>>;
}

/** Exchange the account's client credentials, optionally with a DPoP proof. */
async function exchange(baseUrl: string, input: {
  clientId: string;
  clientSecret: string;
  dpop: boolean;
}): Promise<TokenResult> {
  const tokenEndpoint = new URL('.oidc/token', baseUrl).href;
  const dpopKey = input.dpop ? await generateDpopKeyPair() : undefined;
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString('base64')}`,
      ...(dpopKey ? { DPoP: await createDpopHeader(tokenEndpoint, 'POST', dpopKey) } : {}),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body) as { access_token?: string; token_type?: string };
  if (!parsed.access_token) {
    throw new Error(`Token exchange returned no token: ${body.slice(0, 200)}`);
  }
  return {
    accessToken: parsed.access_token,
    tokenType: parsed.token_type ?? 'Bearer',
    ...(dpopKey ? { dpopKey } : {}),
  };
}

/** A fetch that presents exactly this token, as any caller would. */
function authorizationFor(token: TokenResult, url: string, method: string, dpopKey?: Awaited<ReturnType<typeof generateDpopKeyPair>>): Promise<Record<string, string>> | Record<string, string> {
  if (token.tokenType.toUpperCase() === 'DPOP' && dpopKey) {
    return createDpopHeader(url, method, dpopKey).then((proof) => ({
      authorization: `DPoP ${token.accessToken}`,
      dpop: proof,
    }));
  }
  return { authorization: `Bearer ${token.accessToken}` };
}

async function callApi(input: {
  baseUrl: string;
  path: string;
  token?: TokenResult;
  dpopKey?: Awaited<ReturnType<typeof generateDpopKeyPair>>;
  method?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const url = new URL(input.path, input.baseUrl).href;
  const method = input.method ?? 'GET';
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(input.body ? { 'content-type': 'application/json' } : {}),
    ...(input.token ? await authorizationFor(input.token, url, method, input.dpopKey) : {}),
  };
  const response = await fetch(url, { method, headers, ...(input.body ? { body: input.body } : {}) });
  return { status: response.status, body: await response.text() };
}

const results: { step: string; detail: string; ok: boolean }[] = [];
function record(step: string, ok: boolean, detail: string): void {
  results.push({ step, detail, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}

const stack = new XpodTestStack();
try {
  await stack.start('local', {
    // Strict auth: an open stack injects the local owner for credential-less calls, which would
    // make every probe below pass for the wrong reason.
    open: false,
    transport: 'port',
    runtimeRoot: createTestDir('accept-bearer-pod-access'),
    logLevel: 'debug',
    env: { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: FAKE_QLEVER_LOCAL_RUNTIME_COMMAND },
  });
  console.log(`Stack ready on ${stack.baseUrl}`);

  const account = await setupAccount(stack.baseUrl, 'bearer');
  if (!account) {
    throw new Error('Could not create a test account');
  }
  console.log(`Account ${account.webId}`);

  // 1. CSS issues a Bearer token when no DPoP proof is presented.
  const bearer = await exchange(stack.baseUrl, { ...account, dpop: false });
  record('css-issues-bearer', bearer.tokenType.toUpperCase() === 'BEARER',
    `token_type=${bearer.tokenType}`);
  const claims = JSON.parse(Buffer.from(bearer.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  console.log(`token claims: webid=${String(claims.webid)} sub=${String(claims.sub)} aud=${JSON.stringify(claims.aud)} client_id=${String(claims.client_id ?? claims.azp)} account=${account.webId}`);

  // 2. The Bearer token is a real Pod credential.
  const podUrl = new URL('settings/accept-bearer-probe.ttl', account.podUrl).href;
  const headers = await authorizationFor(bearer, podUrl, 'PUT');
  const put = await fetch(podUrl, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'text/turtle' },
    body: '<> <http://purl.org/dc/terms/title> "bearer probe" .',
  });
  record('pod-accepts-bearer', put.status === 201 || put.status === 205 || put.status === 200,
    `PUT ${podUrl} -> ${put.status}`);

  // 3. The API reads Pod-backed data with that Bearer token, holding no owner key of its own.
  const withBearer = await callApi({ baseUrl: stack.baseUrl, path: '/api/ai/gateway/keys', token: bearer });
  record('api-reads-pod-with-caller-bearer', withBearer.status === 200,
    `GET /api/ai/gateway/keys -> ${withBearer.status} ${withBearer.body.slice(0, 120)}`);

  // 3a. The same call straight to the API, bypassing the gateway.
  const direct = await callApi({ baseUrl: `http://127.0.0.1:${stack.apiPort}/`, path: '/api/ai/gateway/keys', token: bearer });
  record('api-direct-reads-pod-with-caller-bearer', direct.status === 200,
    `GET 127.0.0.1:${stack.apiPort}/api/ai/gateway/keys -> ${direct.status} ${direct.body.slice(0, 120)}`);

  // 3b. The chatkit surface accepts the Bearer caller. Returned on its own this proves nothing:
  //     see the DPoP control below, where the same endpoint answers 200 without reading a Pod.
  const chatkit = await callApi({ baseUrl: stack.baseUrl, path: '/v1/chatkit/threads', token: bearer });
  record('chatkit-accepts-bearer-caller', chatkit.status === 200,
    `GET /v1/chatkit/threads -> ${chatkit.status} ${chatkit.body.slice(0, 120)}`);

  // 3c. The SPARQL extension is the surface the Pod-backed repositories use.
  const sparqlUrl = new URL('settings/accept-probe/-/sparql', account.podUrl).href;
  const sparqlHeaders = await authorizationFor(bearer, sparqlUrl, 'POST');
  const sparql = await fetch(sparqlUrl, {
    method: 'POST',
    headers: {
      ...sparqlHeaders,
      'content-type': 'application/sparql-query',
      accept: 'application/sparql-results+json',
    },
    body: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
  });
  record('sparql-accepts-bearer', sparql.ok,
    `POST ${sparqlUrl} -> ${sparql.status} ${(await sparql.text()).slice(0, 120)}`);

  // 3d. The exact surface the gateway-key repository reads.
  const keySparqlUrl = new URL('settings/ai/gateway/access-keys.ttl/-/sparql', account.podUrl).href;
  const keyHeaders = await authorizationFor(bearer, keySparqlUrl, 'POST');
  const keySparql = await fetch(keySparqlUrl, {
    method: 'POST',
    headers: {
      ...keyHeaders,
      'content-type': 'application/sparql-query',
      accept: 'application/sparql-results+json',
    },
    body: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
  });
  record('gateway-key-sparql-accepts-bearer', keySparql.ok,
    `POST ${keySparqlUrl} -> ${keySparql.status} ${(await keySparql.text()).slice(0, 160)}`);

  // 3e. The same chatkit read with a real DPoP request, as the browser session would send it.
  const dpopForChatkit = await exchange(stack.baseUrl, { ...account, dpop: true });
  const chatkitDpop = await callApi({
    baseUrl: stack.baseUrl,
    path: '/v1/chatkit/threads',
    token: dpopForChatkit,
    dpopKey: dpopForChatkit.dpopKey,
  });
  // A caller the API cannot use for the Pod gets an empty list instead of the reason, while the
  // key surface returns 403 for the same caller and token. Documented here, not endorsed.
  record('chatkit-masks-dpop-caller', chatkitDpop.status === 200 && chatkitDpop.body.includes('"data":[]'),
    `GET /v1/chatkit/threads (DPoP) -> ${chatkitDpop.status} ${chatkitDpop.body.slice(0, 80)} (Pod reads are refused, see the key surface)`);

  // 4. The same user's DPoP token authenticates but must not be replayed to the Pod.
  const dpop = await exchange(stack.baseUrl, { ...account, dpop: true });
  const withDpop = await callApi({
    baseUrl: stack.baseUrl,
    path: '/api/ai/gateway/keys',
    token: dpop,
    dpopKey: dpop.dpopKey,
  });
  record('dpop-token-does-not-reach-pod', withDpop.status === 403,
    `token_type=${dpop.tokenType} -> ${withDpop.status} ${withDpop.body.slice(0, 140)}`);

  // 5. No credential is still rejected.
  const anonymous = await callApi({ baseUrl: stack.baseUrl, path: '/api/ai/gateway/keys' });
  record('anonymous-rejected', anonymous.status === 401 || anonymous.status === 403,
    `GET /api/ai/gateway/keys -> ${anonymous.status}`);
} finally {
  await stack.stop();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
