#!/usr/bin/env bun
/**
 * Post-deploy RC user-flow acceptance.
 *
 * This runner proves four facts against the already deployed RC only:
 *   1. a fresh browser DPoP session reaches the seed Pod's SPARQL root and a
 *      unique, nonexistent descendant scope is empty (ASK false, SELECT empty);
 *   2. the same browser DPoP session lists both deployment built-in models and
 *      gets a real chat completion matching a unique nonce for each, without a
 *      manual `sk` or provider key;
 *   3. two seed identities receive normal Account-issued Matrix client
 *      credentials and complete whoami/createRoom/invite/join/sync with exact
 *      sender/body both ways;
 *   4. each fresh browser login paints exactly one Consent screen offering
 *      exactly one matching WebID/storage binding.
 *
 * It never starts a local server, never uses a mock, never reads a provider
 * key, and never prints or persists credential material. The four check names
 * are the only release-gate facts this runner adds.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startBrowserExternalRp } from '../tests/helpers/browserExternalRp';
import {
  RcEvidenceError,
  authorizeRcSession,
  readRcAccountToken,
  verifyRcConsentBinding,
  type RcSession,
} from '../tests/helpers/rcLightWeb';
import { loadRcSeedAccounts, type RcSeedAccount } from './prepare-rc-authenticated-smoke';

export const RC_USER_FLOW_CHECKS = [
  'rc-pod-sparql',
  'rc-builtin-models-chat',
  'rc-matrix-collaboration',
  'rc-browser-consent',
] as const;

export type RcUserFlowCheckName = typeof RC_USER_FLOW_CHECKS[number];

export interface RcUserFlowCheck {
  ok: boolean;
  detail: string;
  facts?: Record<string, unknown>;
}

export interface RcUserFlowsEvidence {
  schemaVersion: 1;
  kind: 'xpod-rc-user-flows';
  baseUrl: string;
  startedAt: string;
  completedAt: string;
  checks: Record<RcUserFlowCheckName, RcUserFlowCheck>;
  evidenceScope: string;
}

export interface RcUserFlowsOptions {
  baseUrl: string;
  seedConfigPath: string;
  outputDir: string;
  timeoutMs?: number;
  issueCredential?: IssueCredential;
}

export class AcceptanceError extends Error {
  override name = 'AcceptanceError';
}

interface Login {
  context: BrowserContext;
  page: Page;
  session: RcSession;
  accountToken: string;
}

interface IssuedCredential {
  id: string;
  secret: string;
  resource: string;
}

export type IssueCredential = (options: {
  baseUrl: string;
  authorization: string;
  controls: { account: { clientCredentials: string } };
  webId: string;
  name: string;
}) => Promise<IssuedCredential>;

interface MatrixEvent {
  event_id?: unknown;
  sender?: unknown;
  content?: { body?: unknown };
}

const RC_ORIGIN = 'https://id-rc.undefineds.cn';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_DIR = '.test-data/rc-user-flows';
const SECRET_PATTERN = /(sk-[A-Za-z0-9+/=_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*|CSS-Account-Token\s+\S+|DPoP\s+[A-Za-z0-9._~+/-]+=*)/iu;
const SECRET_PATTERN_GLOBAL = new RegExp(SECRET_PATTERN.source, 'giu');
const MAX_FIXED_DETAIL_CHARS = 300;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Fixed, reviewable categories for failures at the Account client-credential
 * boundary. The helper's free-form message is never published; only a fixed
 * category and, when the helper's anchored prefix carries one, an HTTP status. */
export type CredentialFailureCategory =
  | 'account-credential-unauthorized'
  | 'account-credential-forbidden'
  | 'account-credential-control-missing'
  | 'account-credential-rejected'
  | 'account-credential-rate-limited'
  | 'account-credential-server-error'
  | 'account-credential-http-error'
  | 'account-credential-invalid-json'
  | 'account-credential-incomplete'
  | 'account-credential-invalid-resource'
  | 'account-credential-transport-error'
  | 'account-credential-error';

export interface CredentialFailure {
  category: CredentialFailureCategory;
  status?: number;
}

export function classifyCredentialIssuanceFailure(error: unknown): CredentialFailure {
  const message = error instanceof Error ? error.message : '';
  const statusMatch = /^POST Cloud controls\.account\.clientCredentials HTTP ([1-5][0-9]{2})(?::|$)/u.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401) return { category: 'account-credential-unauthorized', status };
    if (status === 403) return { category: 'account-credential-forbidden', status };
    if (status === 404) return { category: 'account-credential-control-missing', status };
    if (status === 429) return { category: 'account-credential-rate-limited', status };
    if (status === 400 || status === 409 || status === 422) return { category: 'account-credential-rejected', status };
    if (status >= 500) return { category: 'account-credential-server-error', status };
    return { category: 'account-credential-http-error', status };
  }
  if (/^POST Cloud controls\.account\.clientCredentials returned non-JSON(?::|$)/u.test(message)) {
    return { category: 'account-credential-invalid-json' };
  }
  if (message === 'Cloud client credentials response did not include id, secret and resource') {
    return { category: 'account-credential-incomplete' };
  }
  if (message === 'Cloud client credential resource is outside the trusted Account endpoint') {
    return { category: 'account-credential-invalid-resource' };
  }
  if (error instanceof TypeError) return { category: 'account-credential-transport-error' };
  return { category: 'account-credential-error' };
}

export function formatCredentialFailure(failure: CredentialFailure): string {
  return `account-client-credential ${failure.category}${failure.status === undefined ? '' : ` (HTTP ${failure.status})`}`;
}

/** Only our fixed acceptance/evidence errors may publish their own text. Any
 * arbitrary helper/server/native error is collapsed to a fixed token. */
export function describeAcceptanceFailure(error: unknown): string {
  if (error instanceof AcceptanceError) return error.message.slice(0, MAX_FIXED_DETAIL_CHARS);
  if (error instanceof RcEvidenceError) return error.message.slice(0, MAX_FIXED_DETAIL_CHARS);
  return 'unexpected-error';
}

/** Reject any target other than the one RC HTTPS origin. The CLI never points
 * at production or a local substitute by accident. */
export function normalizeRcBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new AcceptanceError(`--base-url must be ${RC_ORIGIN}/`);
  }
  if (url.protocol !== 'https:' || url.origin !== RC_ORIGIN || url.pathname !== '/'
    || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new AcceptanceError(`--base-url must be the deployed RC origin ${RC_ORIGIN}/`);
  }
  return url;
}

export function assertBuiltinModels(status: number, payload: unknown): string[] {
  if (status !== 200) throw new AcceptanceError(`GET /v1/models returned HTTP ${status}; expected 200`);
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(data)) throw new AcceptanceError('GET /v1/models returned a malformed model list');
  const ids = data.flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
    ? [(entry as { id: string }).id]
    : []);
  for (const required of ['linx', 'linx-lite']) {
    if (!ids.includes(required)) throw new AcceptanceError(`GET /v1/models did not include ${required}`);
  }
  return ids;
}

function sparqlBindings(payload: unknown): unknown[] {
  const results = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { results?: unknown }).results
    : undefined;
  const bindings = results && typeof results === 'object' && !Array.isArray(results)
    ? (results as { bindings?: unknown }).bindings
    : undefined;
  if (!Array.isArray(bindings)) throw new AcceptanceError('SPARQL response did not include a result binding array');
  return bindings;
}

/** The root query only proves the endpoint answered; the seed profile already
 * has triples, so emptiness is deliberately not asserted here. */
export function assertSparqlRoot(status: number, payload: unknown): number {
  if (status !== 200) throw new AcceptanceError(`Pod SPARQL root returned HTTP ${status}; expected 200`);
  return sparqlBindings(payload).length;
}

export function assertEmptyScopeAsk(status: number, payload: unknown): false {
  if (status !== 200) throw new AcceptanceError(`Empty descendant SPARQL ASK returned HTTP ${status}; expected 200`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload as { boolean?: unknown }).boolean !== false) {
    throw new AcceptanceError('Empty descendant SPARQL ASK was not false');
  }
  return false;
}

export function assertEmptyScopeSelect(status: number, payload: unknown): 0 {
  if (status !== 200) throw new AcceptanceError(`Empty descendant SPARQL SELECT returned HTTP ${status}; expected 200`);
  const rows = sparqlBindings(payload).length;
  if (rows !== 0) throw new AcceptanceError(`Empty descendant SPARQL SELECT returned ${rows} row(s); expected 0`);
  return 0;
}

function chatContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some((part) => !part || typeof part !== 'object'
    || typeof (part as { text?: unknown }).text !== 'string')) return undefined;
  return value.map((part) => (part as { text: string }).text).join('');
}

/** A valid chat answer is one choice that stopped normally and contains the
 * unique nonce. HTTP 200 alone is never sufficient. */
export function assertChatNonce(status: number, payload: unknown, model: string, nonce: string): {
  contentChars: number;
  contentSha256: string;
  nonceSha256: string;
} {
  if (status !== 200) throw new AcceptanceError(`POST /v1/chat/completions (${model}) returned HTTP ${status}; expected 200`);
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { error?: unknown; choices?: unknown }
    : undefined;
  if (body?.error) throw new AcceptanceError(`POST /v1/chat/completions (${model}) returned an error`);
  if (!Array.isArray(body?.choices) || body.choices.length !== 1) {
    throw new AcceptanceError(`POST /v1/chat/completions (${model}) did not return exactly one choice`);
  }
  const choice = body.choices[0] as { finish_reason?: unknown; message?: { content?: unknown } } | undefined;
  if (choice?.finish_reason !== 'stop') {
    throw new AcceptanceError(`POST /v1/chat/completions (${model}) did not stop normally`);
  }
  const content = chatContent(choice.message?.content);
  if (!content || !content.includes(nonce)) {
    throw new AcceptanceError(`POST /v1/chat/completions (${model}) did not match the unique nonce`);
  }
  return {
    contentChars: content.length,
    contentSha256: sha256(content),
    nonceSha256: sha256(nonce),
  };
}

export function matrixSk(clientId: string, clientSecret: string): string {
  if (!clientId || !clientSecret) throw new AcceptanceError('Matrix credential is incomplete');
  return `sk-${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

export function assertNoSecretMaterial(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      throw new AcceptanceError('Acceptance evidence contained credential material');
    }
  }
  SECRET_PATTERN_GLOBAL.lastIndex = 0;
  const matched = SECRET_PATTERN_GLOBAL.test(serialized);
  SECRET_PATTERN_GLOBAL.lastIndex = 0;
  if (matched) throw new AcceptanceError('Acceptance evidence contained credential material');
}

export interface BoundedPollResult<T> {
  done: boolean;
  value?: T;
  status: string;
}

export interface BoundedPollOptions<T> {
  label: string;
  timeoutMs: number;
  intervalMs?: number;
  probe: (attempt: number) => Promise<BoundedPollResult<T>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Poll with a hard deadline and a last-status string that is safe to publish. */
export async function boundedPoll<T>(options: BoundedPollOptions<T>): Promise<{ value: T; attempts: number }> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempts = 0;
  let lastStatus = 'not attempted';
  for (;;) {
    attempts += 1;
    try {
      const result = await options.probe(attempts);
      lastStatus = result.status;
      if (result.done) return { value: result.value as T, attempts };
    } catch (error) {
      lastStatus = describeAcceptanceFailure(error);
    }
    if (now() - startedAt >= options.timeoutMs) {
      throw new AcceptanceError(`${options.label} timed out after ${options.timeoutMs}ms after ${attempts} attempt(s); last status: ${lastStatus}`);
    }
    await sleep(options.intervalMs ?? 500);
  }
}

function initialEvidence(baseUrl: URL): RcUserFlowsEvidence {
  const checks = Object.fromEntries(RC_USER_FLOW_CHECKS.map((name) => [name, { ok: false, detail: 'not run' }])) as
    Record<RcUserFlowCheckName, RcUserFlowCheck>;
  return {
    schemaVersion: 1,
    kind: 'xpod-rc-user-flows',
    baseUrl: baseUrl.href,
    startedAt: new Date().toISOString(),
    completedAt: '',
    checks,
    evidenceScope: 'Real HTTPS against the deployed RC only. Browser OIDC/PKCE/DPoP-based protocol evidence is reported separately from HTTP facts. No desktop, LinX, mock, local server, manual sk, or provider key is claimed.',
  };
}

export async function writeEvidenceFile(outputDir: string, evidence: RcUserFlowsEvidence,
  secrets: readonly string[] = []): Promise<string> {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  assertNoSecretMaterial(serialized, secrets);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  const file = path.join(outputDir, 'evidence.json');
  await writeFile(file, serialized, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

async function loginSeed(browser: Browser, rp: Awaited<ReturnType<typeof startBrowserExternalRp>>,
  baseUrl: URL, account: RcSeedAccount, label: string): Promise<Login> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const session = await authorizeRcSession(page, rp, baseUrl.href, {
      email: account.email,
      password: account.password,
    });
    const accountToken = await readRcAccountToken(page, baseUrl.href);
    return { context, page, session, accountToken };
  } catch {
    await context.close().catch(() => undefined);
    throw new AcceptanceError(`RC ${label} fresh browser login failed (browser-login-error)`);
  }
}

async function readJson(fetchImpl: typeof fetch, url: URL, init: RequestInit, label: string,
  timeoutMs = 30_000): Promise<{
  status: number;
  payload: unknown;
}> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new AcceptanceError(`${label} transport failed (transport-error)`);
  }
  const text = await response.text();
  if (!text) throw new AcceptanceError(`${label} returned an empty body (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch {
    throw new AcceptanceError(`${label} returned non-JSON (HTTP ${response.status})`);
  }
  return { status: response.status, payload };
}

async function sparql(fetchImpl: typeof fetch, url: URL, query: string): Promise<{ status: number; payload: unknown }> {
  return readJson(fetchImpl, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: query,
  }, `POST ${url.pathname}`);
}

function consentCheck(alice: Login, bob: Login): RcUserFlowCheck {
  const aliceConsent = verifyRcConsentBinding(alice.session);
  const bobConsent = verifyRcConsentBinding(bob.session);
  return {
    ok: true,
    detail: 'Alice and Bob each completed a fresh browser OIDC/PKCE/DPoP-based login with exactly one visible Consent screen and exactly one matching WebID/storage binding.',
    facts: {
      protocol: 'browser-oidc-pkce-dpop',
      authorizationRequestSeen: true,
      pkceS256: true,
      callbackCodeAndState: true,
      tokenExchange: 'external-rp-dpop',
      alice: aliceConsent,
      bob: bobConsent,
      runtimeBinding: 'authenticated',
      desktopClaimed: false,
      linxClaimed: false,
    },
  };
}

async function sparqlCheck(alice: Login): Promise<RcUserFlowCheck> {
  const storageUrl = new URL(alice.session.identity.storageUrl);
  const rootUrl = new URL('-/sparql', storageUrl);
  const root = await sparql(alice.session.authenticatedFetch, rootUrl, 'SELECT * WHERE { ?s ?p ?o } LIMIT 1');
  const rootRows = assertSparqlRoot(root.status, root.payload);

  const scopePath = `accept-empty-${randomUUID()}/-/sparql`;
  const scopeUrl = new URL(scopePath, storageUrl);
  const ask = await sparql(alice.session.authenticatedFetch, scopeUrl, 'ASK { ?s ?p ?o }');
  const askFalse = assertEmptyScopeAsk(ask.status, ask.payload);
  const select = await sparql(alice.session.authenticatedFetch, scopeUrl, 'SELECT * WHERE { ?s ?p ?o }');
  const selectRows = assertEmptyScopeSelect(select.status, select.payload);

  return {
    ok: true,
    detail: `Pod SPARQL (DPoP) root HTTP 200; unique descendant scope HTTP 200 with ASK=${askFalse} and SELECT rows=${selectRows}.`,
    facts: {
      credential: 'browser-dpop-session',
      rootStatus: root.status,
      rootRowCount: rootRows,
      rootEmpty: rootRows === 0,
      scopePath,
      askStatus: ask.status,
      askBoolean: askFalse,
      selectStatus: select.status,
      selectRowCount: selectRows,
      datasetOverride: 'none',
    },
  };
}

async function modelsChatCheck(alice: Login, baseUrl: URL): Promise<RcUserFlowCheck> {
  const models = await readJson(alice.session.authenticatedFetch, new URL('v1/models', baseUrl), {
    headers: { Accept: 'application/json' },
  }, 'GET /v1/models');
  const modelIds = assertBuiltinModels(models.status, models.payload);

  const chat: Array<Record<string, unknown>> = [];
  for (const model of ['linx', 'linx-lite'] as const) {
    const nonce = `XPOD_RC_${randomUUID().replace(/-/gu, '').toUpperCase()}`;
    const result = await readJson(alice.session.authenticatedFetch, new URL('v1/chat/completions', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `Reply with exactly this token and nothing else: ${nonce}` }],
        max_tokens: 512,
        temperature: 0,
        stream: false,
      }),
    }, `POST /v1/chat/completions (${model})`, 90_000);
    const matched = assertChatNonce(result.status, result.payload, model, nonce);
    chat.push({ model, status: result.status, ...matched });
  }

  return {
    ok: true,
    detail: `Browser session over DPoP: /v1/models HTTP 200 includes ${modelIds.join(', ')}; real /v1/chat/completions responses matched unique nonces for linx and linx-lite.`,
    facts: {
      credential: 'browser-dpop-session',
      manualSkSupplied: false,
      providerKeySupplied: false,
      mock: false,
      modelsStatus: models.status,
      modelIds,
      chat,
    },
  };
}

class MatrixFlowError extends AcceptanceError {
  override readonly name = 'MatrixFlowError';
}

async function matrixRequest(input: {
  baseUrl: URL;
  token: string;
  podUrl: string;
  path: string;
  label: string;
  method?: string;
  body?: unknown;
  expectedStatus?: number;
}): Promise<any> {
  const expected = input.expectedStatus ?? 200;
  let response: Response;
  try {
    response = await fetch(new URL(input.path, input.baseUrl), {
      method: input.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'X-Xpod-Pod-Url': input.podUrl,
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new MatrixFlowError(`${input.label} transport failed (transport-error)`);
  }
  const text = await response.text();
  let payload: any;
  if (text) {
    try { payload = JSON.parse(text); } catch {
      throw new MatrixFlowError(`${input.label} returned non-JSON (HTTP ${response.status})`);
    }
  }
  if (response.status !== expected) {
    throw new MatrixFlowError(`${input.label} returned HTTP ${response.status}; expected ${expected}`);
  }
  return payload;
}

async function issueMatrixCredential(input: {
  baseUrl: URL;
  session: RcSession;
  accountToken: string;
  label: string;
  issueCredential: IssueCredential;
  secrets: string[];
}): Promise<{ token: string; credentialId: string; resource: string }> {
  const clientCredentials = input.session.account?.clientCredentials;
  if (!clientCredentials) {
    throw new AcceptanceError(`RC ${input.label} Account did not expose a client-credential control`);
  }
  let credential: IssuedCredential;
  try {
    credential = await input.issueCredential({
      baseUrl: input.baseUrl.href,
      authorization: input.accountToken,
      controls: { account: { clientCredentials } },
      webId: input.session.identity.webId,
      name: `rc-user-flow-${input.label}-${randomUUID().slice(0, 8)}`,
    });
  } catch (error) {
    const failure = classifyCredentialIssuanceFailure(error);
    throw new AcceptanceError(`RC ${input.label} ${formatCredentialFailure(failure)}`);
  }
  if (!credential.id || !credential.secret) {
    throw new AcceptanceError(`RC ${input.label} Account client-credential response was incomplete`);
  }
  input.secrets.push(input.accountToken, credential.secret);
  const token = matrixSk(credential.id, credential.secret);
  input.secrets.push(token);
  return { token, credentialId: credential.id, resource: credential.resource };
}

async function matrixCheck(input: {
  baseUrl: URL;
  alice: Login;
  bob: Login;
  timeoutMs: number;
  issueCredential: IssueCredential;
  secrets: string[];
}): Promise<RcUserFlowCheck> {
  const aliceCredential = await issueMatrixCredential({
    baseUrl: input.baseUrl,
    session: input.alice.session,
    accountToken: input.alice.accountToken,
    label: 'alice',
    issueCredential: input.issueCredential,
    secrets: input.secrets,
  });
  const bobCredential = await issueMatrixCredential({
    baseUrl: input.baseUrl,
    session: input.bob.session,
    accountToken: input.bob.accountToken,
    label: 'bob',
    issueCredential: input.issueCredential,
    secrets: input.secrets,
  });

  const aliceWho = (await boundedPoll<any>({
    label: 'Alice whoami',
    timeoutMs: Math.min(input.timeoutMs, 15_000),
    probe: async () => {
      const who = await matrixRequest({
        baseUrl: input.baseUrl, token: aliceCredential.token, podUrl: input.alice.session.identity.storageUrl,
        path: '/_matrix/client/v3/account/whoami', label: 'Alice whoami',
      });
      const valid = typeof who?.user_id === 'string';
      return { done: valid, value: who, status: `HTTP 200 user_id=${valid ? 'present' : 'missing'}` };
    },
  })).value;
  const bobWho = (await boundedPoll<any>({
    label: 'Bob whoami',
    timeoutMs: Math.min(input.timeoutMs, 15_000),
    probe: async () => {
      const who = await matrixRequest({
        baseUrl: input.baseUrl, token: bobCredential.token, podUrl: input.bob.session.identity.storageUrl,
        path: '/_matrix/client/v3/account/whoami', label: 'Bob whoami',
      });
      const valid = typeof who?.user_id === 'string';
      return { done: valid, value: who, status: `HTTP 200 user_id=${valid ? 'present' : 'missing'}` };
    },
  })).value;
  if (typeof aliceWho?.user_id !== 'string' || typeof bobWho?.user_id !== 'string'
    || aliceWho.user_id === bobWho.user_id) {
    throw new AcceptanceError('Matrix whoami did not return two distinct user identities');
  }
  if (aliceWho['co.undefineds.webid'] !== input.alice.session.identity.webId
    || bobWho['co.undefineds.webid'] !== input.bob.session.identity.webId) {
    throw new AcceptanceError('Matrix whoami WebID did not match the browser identity');
  }

  const room = await matrixRequest({
    baseUrl: input.baseUrl, token: aliceCredential.token, podUrl: input.alice.session.identity.storageUrl,
    path: '/_matrix/client/v3/createRoom', method: 'POST', label: 'Alice createRoom',
    body: { name: `RC user flow ${randomUUID()}`, visibility: 'private' },
  });
  if (typeof room?.room_id !== 'string' || !room.room_id) {
    throw new AcceptanceError('Matrix createRoom did not return a room ID');
  }
  const roomId: string = room.room_id;
  const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;

  await matrixRequest({
    baseUrl: input.baseUrl, token: aliceCredential.token, podUrl: input.alice.session.identity.storageUrl,
    path: `${roomPath}/invite`, method: 'POST', label: 'Alice invite Bob',
    body: { user_id: bobWho.user_id, targetWebID: input.bob.session.identity.webId },
  });

  const invitePoll = await boundedPoll({
    label: 'Bob sync invite',
    timeoutMs: Math.min(input.timeoutMs, 60_000),
    probe: async () => {
      const sync = await matrixRequest({
        baseUrl: input.baseUrl, token: bobCredential.token, podUrl: input.bob.session.identity.storageUrl,
        path: '/_matrix/client/v3/sync?limit=20', label: 'Bob sync invite',
      });
      const invited = Boolean(sync?.rooms?.invite?.[roomId]);
      return { done: invited, status: `HTTP 200 invite=${invited}` };
    },
  });

  const joined = await matrixRequest({
    baseUrl: input.baseUrl, token: bobCredential.token, podUrl: input.bob.session.identity.storageUrl,
    path: `${roomPath}/join`, method: 'POST', label: 'Bob join',
  });
  if (joined?.room_id !== roomId) throw new AcceptanceError('Matrix join did not return the invited room');

  const aliceBody = `Alice to Bob ${randomUUID()}`;
  const aliceSend = await matrixRequest({
    baseUrl: input.baseUrl, token: aliceCredential.token, podUrl: input.alice.session.identity.storageUrl,
    path: `${roomPath}/send/m.room.message/${encodeURIComponent(`alice-${randomUUID()}`)}`,
    method: 'PUT', label: 'Alice send', body: { msgtype: 'm.text', body: aliceBody },
  });
  if (typeof aliceSend?.event_id !== 'string') throw new AcceptanceError('Alice send did not return an event ID');

  const bobSees = await boundedPoll<MatrixEvent>({
    label: 'Bob sees Alice message',
    timeoutMs: Math.min(input.timeoutMs, 60_000),
    probe: async () => {
      const sync = await matrixRequest({
        baseUrl: input.baseUrl, token: bobCredential.token, podUrl: input.bob.session.identity.storageUrl,
        path: '/_matrix/client/v3/sync?limit=50', label: 'Bob sync message',
      });
      const events = sync?.rooms?.join?.[roomId]?.timeline?.events;
      const event = Array.isArray(events)
        ? events.find((candidate: MatrixEvent) => candidate?.event_id === aliceSend.event_id)
        : undefined;
      return {
        done: Boolean(event),
        value: event,
        status: `HTTP 200 joined=${Boolean(sync?.rooms?.join?.[roomId])} events=${Array.isArray(events) ? events.length : 0} matched=${Boolean(event)}`,
      };
    },
  });
  if (bobSees.value.sender !== aliceWho.user_id || bobSees.value.content?.body !== aliceBody) {
    throw new AcceptanceError('Bob did not observe Alice\'s exact sender and body');
  }

  const bobBody = `Bob to Alice ${randomUUID()}`;
  const bobSend = await matrixRequest({
    baseUrl: input.baseUrl, token: bobCredential.token, podUrl: input.bob.session.identity.storageUrl,
    path: `${roomPath}/send/m.room.message/${encodeURIComponent(`bob-${randomUUID()}`)}`,
    method: 'PUT', label: 'Bob reply', body: { msgtype: 'm.text', body: bobBody },
  });
  if (typeof bobSend?.event_id !== 'string') throw new AcceptanceError('Bob reply did not return an event ID');

  const aliceSees = await boundedPoll<MatrixEvent>({
    label: 'Alice sees Bob reply',
    timeoutMs: Math.min(input.timeoutMs, 60_000),
    probe: async () => {
      const sync = await matrixRequest({
        baseUrl: input.baseUrl, token: aliceCredential.token, podUrl: input.alice.session.identity.storageUrl,
        path: '/_matrix/client/v3/sync?limit=50', label: 'Alice sync reply',
      });
      const events = sync?.rooms?.join?.[roomId]?.timeline?.events;
      const event = Array.isArray(events)
        ? events.find((candidate: MatrixEvent) => candidate?.event_id === bobSend.event_id)
        : undefined;
      return {
        done: Boolean(event),
        value: event,
        status: `HTTP 200 joined=${Boolean(sync?.rooms?.join?.[roomId])} events=${Array.isArray(events) ? events.length : 0} matched=${Boolean(event)}`,
      };
    },
  });
  if (aliceSees.value.sender !== bobWho.user_id || aliceSees.value.content?.body !== bobBody) {
    throw new AcceptanceError('Alice did not observe Bob\'s exact sender and body');
  }

  return {
    ok: true,
    detail: 'Alice and Bob each received Account-issued Matrix sk; whoami, createRoom, invite, bounded sync/join, and exact sender/body both directions passed.',
    facts: {
      tokenIssuance: 'account-client-credentials',
      tokenCount: 2,
      credentialsPersisted: false,
      aliceUserId: aliceWho.user_id,
      bobUserId: bobWho.user_id,
      aliceWebIdMatches: true,
      bobWebIdMatches: true,
      roomId,
      invitePollAttempts: invitePoll.attempts,
      joinStatus: 200,
      aliceMessage: {
        eventId: aliceSend.event_id,
        senderMatches: true,
        bodyMatches: true,
        bodySha256: sha256(aliceBody),
      },
      bobReply: {
        eventId: bobSend.event_id,
        senderMatches: true,
        bodyMatches: true,
        bodySha256: sha256(bobBody),
      },
      bobSyncAttempts: bobSees.attempts,
      aliceSyncAttempts: aliceSees.attempts,
      transport: 'real-http-rc-only',
    },
  };
}

async function defaultIssueCredential(options: Parameters<IssueCredential>[0]): Promise<IssuedCredential> {
  const { createCloudClientCredentials } = await import('./accept-live-gateway-login-chat');
  return createCloudClientCredentials(options);
}

/** Run all four checks against the deployed RC. The returned evidence is safe
 * to publish; credential values remain in local variables and are audited out. */
export async function runRcUserFlows(options: RcUserFlowsOptions): Promise<RcUserFlowsEvidence> {
  const baseUrl = normalizeRcBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new AcceptanceError(`--timeout-ms must be an integer between 1000 and ${MAX_TIMEOUT_MS}`);
  }
  const evidence = initialEvidence(baseUrl);
  const secrets: string[] = [];
  let browser: Browser | undefined;
  let rp: Awaited<ReturnType<typeof startBrowserExternalRp>> | undefined;
  let alice: Login | undefined;
  let bob: Login | undefined;

  try {
    const seed = await loadRcSeedAccounts(options.seedConfigPath);
    browser = await chromium.launch({ headless: true });
    rp = await startBrowserExternalRp(baseUrl.href);
    alice = await loginSeed(browser, rp, baseUrl, seed.alice, 'Alice');
    bob = await loginSeed(browser, rp, baseUrl, seed.bob, 'Bob');

    const run = async (name: RcUserFlowCheckName, check: () => Promise<RcUserFlowCheck>): Promise<void> => {
      try { evidence.checks[name] = await check(); }
      catch (error) { evidence.checks[name] = { ok: false, detail: describeAcceptanceFailure(error) }; }
    };

    await run('rc-browser-consent', async () => consentCheck(alice!, bob!));
    await run('rc-pod-sparql', async () => sparqlCheck(alice!));
    await run('rc-builtin-models-chat', async () => modelsChatCheck(alice!, baseUrl));
    await run('rc-matrix-collaboration', async () => matrixCheck({
      baseUrl, alice: alice!, bob: bob!, timeoutMs,
      issueCredential: options.issueCredential ?? defaultIssueCredential,
      secrets,
    }));
  } catch (error) {
    const detail = `not run: ${describeAcceptanceFailure(error)}`;
    for (const name of RC_USER_FLOW_CHECKS) {
      if (evidence.checks[name].detail === 'not run') evidence.checks[name] = { ok: false, detail };
    }
  } finally {
    await alice?.context.close().catch(() => undefined);
    await bob?.context.close().catch(() => undefined);
    await rp?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  evidence.completedAt = new Date().toISOString();
  await writeEvidenceFile(options.outputDir, evidence, secrets);
  const failed = RC_USER_FLOW_CHECKS.filter((name) => evidence.checks[name].ok !== true);
  if (failed.length > 0) {
    throw new AcceptanceError(`RC user-flow acceptance failed: ${failed.map((name) => `${name}: ${evidence.checks[name].detail}`).join('; ')}`);
  }
  return evidence;
}

function parseCli(argv: string[]): RcUserFlowsOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'base-url': { type: 'string' },
      'seed-config': { type: 'string' },
      'output-dir': { type: 'string', default: DEFAULT_OUTPUT_DIR },
      'timeout-ms': { type: 'string' },
    },
  });
  if (!values['base-url']) throw new AcceptanceError('--base-url is required');
  if (!values['seed-config']) throw new AcceptanceError('--seed-config is required');
  return {
    baseUrl: values['base-url'],
    seedConfigPath: values['seed-config'],
    outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
    ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const evidence = await runRcUserFlows(options);
  console.log(JSON.stringify({
    status: 'passed',
    checks: Object.fromEntries(RC_USER_FLOW_CHECKS.map((name) => [name, evidence.checks[name].ok])),
    evidence: path.join(options.outputDir, 'evidence.json'),
  }));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[accept-rc-user-flows] ${describeAcceptanceFailure(error)}`);
    process.exit(1);
  });
}
