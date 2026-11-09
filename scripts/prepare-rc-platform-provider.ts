#!/usr/bin/env bun
/**
 * Issues one normal RC Account client credential (the existing `sk-<id:secret>`
 * wrapper) and turns it into the existing OpenAI-compatible provider fixture
 * for release acceptance.
 *
 * This is not a product auth path and it is not model seeding: the credential is
 * a normal Account client credential, and `GET /v1/models` below is a real
 * request through the deployed RC Gateway. The downstream canaries perform the
 * real Chat call.
 *
 * Only the issued private key file and the private receipt are written. Neither
 * the secret nor any upstream body is printed.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadRcSeedAccounts, type RcSeedAccount } from './prepare-rc-authenticated-smoke';

/** The one deployed RC Account/Gateway origin; kept identical to the user-flow canary. */
const RC_ORIGIN = 'https://id-rc.undefineds.cn';
/** The RC origin plus the production stable origin WorkerC already owns. */
const PLATFORM_ORIGINS = [RC_ORIGIN, 'https://id.undefineds.co'] as const;

const REQUEST_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_KIND = 'rc-platform-provider';
const NONCE_PREFIX = 'rc-platform-provider-';
const PROVIDER_ID = 'custom';
const EXPECTED_MODEL = 'linx-lite';
const REQUIRED_MODELS = ['linx', 'linx-lite'] as const;

export type PlatformProviderPhase = 'create' | 'cleanup';

export type PlatformProviderReason =
  | 'invalid-arguments'
  | 'base-url'
  | 'seed'
  | 'output-exists'
  | 'account-login'
  | 'account-controls'
  | 'binding'
  | 'issue'
  | 'resource'
  | 'receipt-write'
  | 'models'
  | 'config-write'
  | 'revoke-failed'
  | 'no-receipt'
  | 'invalid-receipt'
  | 'ownership-mismatch'
  | 'revoke'
  | 'cleanup'
  | 'unexpected';

export class PlatformProviderError extends Error {
  public constructor(
    public readonly reason: PlatformProviderReason,
    public readonly status?: number,
  ) {
    super(reason);
    this.name = 'PlatformProviderError';
  }
}

export interface PlatformProviderSummary {
  phase: PlatformProviderPhase;
  ok: boolean;
  reason: PlatformProviderReason | 'issued' | 'revoked' | 'already-revoked';
  status?: number;
}

interface PlatformProviderReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  kind: typeof RECEIPT_KIND;
  phase: 'issued';
  id: string;
  nonce: string;
  resource: string;
  createdAt: string;
}

export interface PlatformAccountControls {
  account?: {
    id?: string;
    pod?: string;
    profile?: string;
    bindings?: string;
    clientCredentials?: string;
  };
}

type AccountControls = PlatformAccountControls;

interface AccountBinding {
  webId: string;
  storageUrl: string;
}

export interface PlatformProviderDescriptor {
  id: 'custom';
  offeringId: 'openai-compatible';
  apiKey: string;
  baseUrl: string;
  expected: string[];
  source: 'file';
}

export interface PlatformProviderHandle {
  provider: PlatformProviderDescriptor;
  revoke(): Promise<void>;
}

interface IssuedPlatformProvider extends PlatformProviderHandle {
  issued: { id: string; nonce: string; resource: string };
}

export interface PlatformProviderForAccountOptions {
  baseUrl: string;
  authorization: string;
  controls: PlatformAccountControls;
  webId: string;
  fetchImpl?: typeof fetch;
  /** Called once immediately after issuance and before the models proof. Used
   * by the CLI to persist its private receipt so a later failure is recoverable. */
  onIssued?: (issued: { id: string; nonce: string; resource: string }) => void | Promise<void>;
  /** Deterministic label for tests/fixtures; normal callers omit it. */
  nonce?: string;
}

export interface PreparePlatformProviderOptions {
  baseUrl: string;
  seedConfigPath: string;
  keyFile: string;
  receiptFile: string;
  fetchImpl?: typeof fetch;
  nonce?: string;
  now?: () => Date;
}

export interface CleanupPlatformProviderOptions {
  baseUrl: string;
  seedConfigPath: string;
  keyFile: string;
  receiptFile: string;
  fetchImpl?: typeof fetch;
}

export interface PreparedPlatformProvider {
  keyFile: string;
  receiptFile: string;
}

/** Same exact-origin rule as the deployed user-flow canary (duplicated as a pure
 * predicate so this CLI never imports that executable script). */
export function requireRcBaseUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new PlatformProviderError('base-url');
  }
  if (url.protocol !== 'https:' || url.origin !== RC_ORIGIN || url.pathname !== '/'
    || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new PlatformProviderError('base-url');
  }
  return url;
}

/** Generic account-based issuance accepts only the known platform origins. The
 * RC CLI keeps its stricter RC-only guard below. */
export function requirePlatformOrigin(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new PlatformProviderError('base-url');
  }
  if (url.protocol !== 'https:' || !(PLATFORM_ORIGINS as readonly string[]).includes(url.origin)
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new PlatformProviderError('base-url');
  }
  return url;
}

/**
 * The credential resource must stay on the exact RC Account origin, beneath
 * `/.account/`, and identify the exact issued id. Anything else is a foreign
 * resource and must never be DELETEd.
 */
export function assertOwnedCredentialResource(raw: string, base: URL, id: string): string {
  if (!id || /[/\\]/u.test(id)) {
    throw new PlatformProviderError('resource');
  }
  let resource: URL;
  try {
    resource = new URL(raw, base);
  } catch {
    throw new PlatformProviderError('resource');
  }
  const segments = resource.pathname.split('/').filter(Boolean);
  if (resource.origin !== base.origin || !resource.pathname.startsWith('/.account/')
    || resource.search !== '' || resource.hash !== '' || resource.username !== '' || resource.password !== ''
    || !segments.includes(id)) {
    throw new PlatformProviderError('resource');
  }
  return resource.href;
}

export async function createPlatformProvider(
  options: PreparePlatformProviderOptions,
): Promise<PreparedPlatformProvider> {
  const base = requireRcBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const nonce = options.nonce ?? `${NONCE_PREFIX}${randomUUID().replace(/-/gu, '').slice(0, 16)}`;
  if (!nonce.startsWith(NONCE_PREFIX)) {
    throw new PlatformProviderError('invalid-arguments');
  }
  if (path.resolve(options.keyFile) === path.resolve(options.receiptFile)) {
    throw new PlatformProviderError('invalid-arguments');
  }
  const alice = await loadAlice(options.seedConfigPath);
  await ensureParent(options.keyFile);
  await ensureParent(options.receiptFile);
  await assertAbsent(options.keyFile);
  await assertAbsent(options.receiptFile);

  const authorization = await login(base, alice, fetchImpl);
  const controls = await readControls(base, authorization, fetchImpl);
  const bindings = await readBindings(base, authorization, controls, fetchImpl);
  const binding = chooseBinding(bindings, alice.podName);
  const receipt: PlatformProviderReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    phase: 'issued',
    id: '',
    nonce: '',
    resource: '',
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  let receiptWritten = false;
  let created: IssuedPlatformProvider | undefined;
  try {
    created = await issuePlatformProviderForAccount({
      baseUrl: base.href,
      authorization,
      controls,
      webId: binding.webId,
      fetchImpl,
      nonce,
      onIssued: async (issued) => {
        Object.assign(receipt, issued);
        await writePrivateExclusive(options.receiptFile, `${JSON.stringify(receipt)}\n`, 'receipt-write');
        receiptWritten = true;
      },
    });
    await writePrivateExclusive(options.keyFile, providerConfig(base, created.provider.apiKey), 'config-write');
    return { keyFile: options.keyFile, receiptFile: options.receiptFile };
  } catch (error) {
    if (!created) {
      // The shared lifecycle already attempted revocation on its own failure.
      // Keep the receipt when revocation itself failed so `cleanup` can retry.
      const revokeFailed = error instanceof PlatformProviderError && error.reason === 'revoke-failed';
      if (receiptWritten && !revokeFailed) await removeQuietly(options.receiptFile);
      throw error;
    }
    try {
      await created.revoke();
      await removeQuietly(options.keyFile);
      await removeQuietly(options.receiptFile);
    } catch (revokeError) {
      await removeQuietly(options.keyFile);
      throw revokeError;
    }
    throw error;
  }
}

export async function cleanupPlatformProvider(
  options: CleanupPlatformProviderOptions,
): Promise<PlatformProviderSummary> {
  const base = requireRcBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const receipt = await readReceipt(options.receiptFile);
  if (!receipt) {
    // No receipt means no proof that any key was issued by this tool. Never
    // delete an unowned private file.
    return { phase: 'cleanup', ok: true, reason: 'no-receipt' };
  }
  const resource = assertOwnedCredentialResource(receipt.resource, base, receipt.id);
  const alice = await loadAlice(options.seedConfigPath);
  const authorization = await login(base, alice, fetchImpl);
  await readControls(base, authorization, fetchImpl);

  const details = await boundedFetch(fetchImpl, resource, {
    method: 'GET',
    headers: accountHeaders(authorization),
  }, REQUEST_TIMEOUT_MS);
  if (details.status === 404) {
    await removeOwnedOutputs(options, receipt);
    return { phase: 'cleanup', ok: true, reason: 'already-revoked' };
  }
  if (details.status !== 200) {
    throw new PlatformProviderError('cleanup', details.status);
  }
  const payload = await readBoundedJson(details);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload as { id?: unknown }).id !== receipt.id) {
    throw new PlatformProviderError('ownership-mismatch');
  }
  const name = (payload as { name?: unknown }).name;
  if (name !== undefined && name !== receipt.nonce) {
    throw new PlatformProviderError('ownership-mismatch');
  }

  const revoked = await deleteCredential(base, authorization, resource, receipt.id, fetchImpl);
  if (!revoked.ok) {
    throw new PlatformProviderError('revoke-failed', revoked.status);
  }
  await removeOwnedOutputs(options, receipt);
  return { phase: 'cleanup', ok: true, reason: 'revoked' };
}

/** The existing Account client-credentials `sk-` wrapper used by Tasks/Pi. */
export function encodeClientCredentialsApiKey(clientId: string, clientSecret: string): string {
  return `sk-${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

async function loadAlice(seedConfigPath: string): Promise<RcSeedAccount> {
  try {
    return (await loadRcSeedAccounts(seedConfigPath)).alice;
  } catch {
    throw new PlatformProviderError('seed');
  }
}

async function login(base: URL, account: RcSeedAccount, fetchImpl: typeof fetch): Promise<string> {
  const response = await boundedFetch(fetchImpl, new URL('.account/login/password/', base), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  }, REQUEST_TIMEOUT_MS);
  if (response.status !== 200) {
    throw new PlatformProviderError('account-login', response.status);
  }
  const payload = await readBoundedJson(response);
  const authorization = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { authorization?: unknown }).authorization
    : undefined;
  if (typeof authorization !== 'string' || !authorization.trim()) {
    throw new PlatformProviderError('account-login');
  }
  return authorization;
}

async function readControls(base: URL, authorization: string, fetchImpl: typeof fetch): Promise<AccountControls> {
  const response = await boundedFetch(fetchImpl, new URL('.account/', base), {
    method: 'GET',
    headers: accountHeaders(authorization),
  }, REQUEST_TIMEOUT_MS);
  if (response.status !== 200) {
    throw new PlatformProviderError('account-controls', response.status);
  }
  const payload = await readBoundedJson(response);
  const controls = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { controls?: AccountControls }).controls
    : undefined;
  if (!controls || typeof controls !== 'object') {
    throw new PlatformProviderError('account-controls');
  }
  // Validate every control this tool will use before it is followed.
  requireAccountControl(controls.account?.clientCredentials, base, 'account-controls');
  requireAccountControl(controls.account?.bindings, base, 'account-controls');
  return controls;
}

async function readBindings(
  base: URL,
  authorization: string,
  controls: AccountControls,
  fetchImpl: typeof fetch,
): Promise<AccountBinding[]> {
  const target = requireAccountControl(controls.account?.bindings, base, 'account-controls');
  const response = await boundedFetch(fetchImpl, target, {
    method: 'GET',
    headers: accountHeaders(authorization),
  }, REQUEST_TIMEOUT_MS);
  if (response.status !== 200) {
    throw new PlatformProviderError('binding', response.status);
  }
  const payload = await readBoundedJson(response);
  const rows = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { bindings?: unknown }).bindings
    : undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PlatformProviderError('binding');
  }
  const bindings = rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const webId = (row as { webId?: unknown }).webId;
    const storageUrl = (row as { storageUrl?: unknown }).storageUrl;
    return typeof webId === 'string' && typeof storageUrl === 'string' && webId.trim() && storageUrl.trim()
      ? [{ webId: webId.trim(), storageUrl: storageUrl.trim() }]
      : [];
  });
  if (bindings.length !== rows.length) {
    throw new PlatformProviderError('binding');
  }
  return bindings;
}

function chooseBinding(bindings: AccountBinding[], podName: string): AccountBinding {
  const normalizedPod = podName.trim().replace(/^\/+|\/+$/gu, '');
  const matching = bindings.filter((binding) => {
    try {
      return new URL(binding.storageUrl).pathname.split('/').filter(Boolean).includes(normalizedPod);
    } catch {
      return false;
    }
  });
  if (matching.length === 1) return matching[0];
  if (bindings.length === 1) return bindings[0];
  throw new PlatformProviderError('binding');
}

/**
 * Normal Account lifecycle shared by the RC CLI and by an already-authenticated
 * caller (WorkerC desktop). It issues exactly one client credential via the
 * existing normal Account POST, proves real `GET /v1/models`, and returns the
 * provider plus an owned revoke. The secret never leaves this process.
 */
async function issuePlatformProviderForAccount(
  options: PlatformProviderForAccountOptions,
): Promise<IssuedPlatformProvider> {
  const base = requirePlatformOrigin(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const nonce = options.nonce ?? `${NONCE_PREFIX}${randomUUID().replace(/-/gu, '').slice(0, 16)}`;
  if (!nonce.startsWith(NONCE_PREFIX)) {
    throw new PlatformProviderError('invalid-arguments');
  }
  let issued: { id: string; secret: string; resource: string };
  try {
    // Lazy: cleanup/argument failures never load the executable canary module.
    const { createCloudClientCredentials } = await import('./accept-live-gateway-login-chat');
    issued = await createCloudClientCredentials({
      baseUrl: base.href,
      authorization: options.authorization,
      controls: options.controls,
      webId: options.webId,
      name: nonce,
      fetchImpl: ((input, init) => fetchImpl(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })) as typeof fetch,
    });
  } catch {
    throw new PlatformProviderError('issue');
  }
  const resource = assertOwnedCredentialResource(issued.resource, base, issued.id);
  const apiKey = encodeClientCredentialsApiKey(issued.id, issued.secret);
  try {
    await options.onIssued?.({ id: issued.id, nonce, resource });
    await proveModels(base, apiKey, fetchImpl);
  } catch (error) {
    const revoked = await deleteCredential(base, options.authorization, resource, issued.id, fetchImpl);
    throw revoked.ok
      ? error
      : new PlatformProviderError('revoke-failed', revoked.status);
  }
  let revoked = false;
  return {
    provider: {
      id: PROVIDER_ID,
      offeringId: 'openai-compatible',
      apiKey,
      baseUrl: new URL('v1', base).href.replace(/\/$/u, ''),
      expected: [EXPECTED_MODEL],
      source: 'file',
    },
    async revoke(): Promise<void> {
      if (revoked) return;
      const result = await deleteCredential(base, options.authorization, resource, issued.id, fetchImpl);
      if (!result.ok) {
        throw new PlatformProviderError('revoke-failed', result.status);
      }
      revoked = true;
    },
    issued: { id: issued.id, nonce, resource },
  };
}

/**
 * Process-local API for a caller that already owns an authenticated Cloud
 * Account (WorkerC desktop). No seed file, no password, no key file.
 */
export async function createPlatformProviderForAccount(
  options: PlatformProviderForAccountOptions,
): Promise<PlatformProviderHandle> {
  const created = await issuePlatformProviderForAccount(options);
  return { provider: created.provider, revoke: created.revoke };
}

async function proveModels(base: URL, apiKey: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await boundedFetch(fetchImpl, new URL('v1/models', base), {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
  }, MODELS_TIMEOUT_MS);
  if (response.status !== 200) {
    throw new PlatformProviderError('models', response.status);
  }
  const payload = await readBoundedJson(response);
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : undefined;
  const ids = Array.isArray(data)
    ? data.flatMap((row) => row && typeof row === 'object' && !Array.isArray(row)
      && typeof (row as { id?: unknown }).id === 'string'
      ? [(row as { id: string }).id]
      : [])
    : [];
  for (const required of REQUIRED_MODELS) {
    if (!ids.includes(required)) {
      throw new PlatformProviderError('models', response.status);
    }
  }
}

async function deleteCredential(
  base: URL,
  authorization: string,
  resource: string,
  id: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number }> {
  const owned = assertOwnedCredentialResource(resource, base, id);
  try {
    const response = await boundedFetch(fetchImpl, owned, {
      method: 'DELETE',
      headers: accountHeaders(authorization),
    }, REQUEST_TIMEOUT_MS);
    return { ok: response.ok || response.status === 404, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function readReceipt(file: string): Promise<PlatformProviderReceipt | undefined> {
  let contents: string;
  try {
    const info = await stat(file);
    if ((info.mode & 0o077) !== 0) {
      throw new PlatformProviderError('invalid-receipt');
    }
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof PlatformProviderError) throw error;
    throw new PlatformProviderError('invalid-receipt');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new PlatformProviderError('invalid-receipt');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlatformProviderError('invalid-receipt');
  }
  const record = parsed as Partial<PlatformProviderReceipt>;
  if (record.schemaVersion !== RECEIPT_SCHEMA_VERSION || record.kind !== RECEIPT_KIND
    || record.phase !== 'issued' || typeof record.id !== 'string' || !record.id
    || typeof record.nonce !== 'string' || !record.nonce.startsWith(NONCE_PREFIX)
    || typeof record.resource !== 'string' || !record.resource
    || typeof record.createdAt !== 'string') {
    throw new PlatformProviderError('invalid-receipt');
  }
  return record as PlatformProviderReceipt;
}

/** Remove only files this tool can still prove it owns. The key file must
 * carry the exact receipt id and the RC base URL; an unreadable/foreign key is
 * preserved and reported, never deleted. A missing key is already clean. */
async function removeOwnedOutputs(
  options: CleanupPlatformProviderOptions,
  receipt: PlatformProviderReceipt,
): Promise<void> {
  try {
    const key = await readFile(options.keyFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (key !== undefined) {
      const fields = parseKeyFileFields(key);
      const apiKey = fields.get('apiKey') ?? '';
      const decodedId = apiKey.startsWith('sk-')
        ? Buffer.from(apiKey.slice(3), 'base64').toString('utf8').split(':')[0]
        : undefined;
      if (decodedId !== receipt.id
        || fields.get('baseUrl') !== new URL('v1', requireRcBaseUrl(options.baseUrl)).href.replace(/\/$/u, '')) {
        throw new PlatformProviderError('ownership-mismatch');
      }
    }
    await removeQuietly(options.keyFile);
    await removeQuietly(options.receiptFile);
  } catch (error) {
    if (error instanceof PlatformProviderError) throw error;
    throw new PlatformProviderError('cleanup');
  }
}

function parseKeyFileFields(contents: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return fields;
}

function providerConfig(base: URL, apiKey: string): string {
  return [
    `provider=${PROVIDER_ID}`,
    `apiKey=${apiKey}`,
    `baseUrl=${new URL('v1', base).href.replace(/\/$/u, '')}`,
    `expectedModels=${EXPECTED_MODEL}`,
    '',
  ].join('\n');
}

async function writePrivateExclusive(
  file: string,
  contents: string,
  reason: 'receipt-write' | 'config-write',
): Promise<void> {
  try {
    await writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    throw new PlatformProviderError(reason);
  }
}

async function ensureParent(file: string): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw new PlatformProviderError('invalid-arguments');
  }
}

async function assertAbsent(file: string): Promise<void> {
  try {
    await lstat(file);
    throw new PlatformProviderError('output-exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function requireAccountControl(raw: string | undefined, base: URL, reason: PlatformProviderReason): string {
  if (!raw?.trim()) {
    throw new PlatformProviderError(reason);
  }
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new PlatformProviderError(reason);
  }
  if (url.origin !== base.origin || !url.pathname.startsWith('/.account/')
    || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new PlatformProviderError(reason);
  }
  return url.href;
}

function accountHeaders(authorization: string): Record<string, string> {
  return { accept: 'application/json', authorization: `CSS-Account-Token ${authorization}` };
}

async function boundedFetch(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(input, { ...init, redirect: 'error', signal });
  } catch {
    throw new PlatformProviderError('unexpected');
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof PlatformProviderError) throw error;
    throw new PlatformProviderError('unexpected');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PlatformProviderError('unexpected', response.status);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new PlatformProviderError('unexpected', response.status);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PlatformProviderError('unexpected', response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function safeSummary(error: unknown, phase: PlatformProviderPhase): PlatformProviderSummary {
  if (error instanceof PlatformProviderError) {
    return {
      phase,
      ok: false,
      reason: error.reason,
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    };
  }
  return { phase, ok: false, reason: 'unexpected' };
}

interface CliOptions {
  command: 'create' | 'cleanup';
  baseUrl: string;
  seedConfigPath: string;
  keyFile: string;
  receiptFile: string;
}

function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'base-url': { type: 'string' },
      'seed-config': { type: 'string' },
      'key-file': { type: 'string' },
      receipt: { type: 'string' },
    },
  });
  const command = positionals[0];
  if ((command !== 'create' && command !== 'cleanup') || positionals.length !== 1
    || !values['base-url'] || !values['seed-config'] || !values['key-file'] || !values.receipt) {
    throw new PlatformProviderError('invalid-arguments');
  }
  return {
    command,
    baseUrl: values['base-url'],
    seedConfigPath: values['seed-config'],
    keyFile: values['key-file'],
    receiptFile: values.receipt,
  };
}

if (import.meta.main) {
  let phase: PlatformProviderPhase = 'create';
  try {
    let options: CliOptions;
    try {
      options = parseCli(process.argv.slice(2));
    } catch (error) {
      throw error instanceof PlatformProviderError ? error : new PlatformProviderError('invalid-arguments');
    }
    phase = options.command;
    if (options.command === 'create') {
      await createPlatformProvider(options);
      console.log(JSON.stringify({ phase, ok: true, reason: 'issued', status: 200 } satisfies PlatformProviderSummary));
    } else {
      const summary = await cleanupPlatformProvider(options);
      console.log(JSON.stringify(summary));
    }
  } catch (error) {
    console.log(JSON.stringify(safeSummary(error, phase)));
    process.exitCode = 1;
  }
}
