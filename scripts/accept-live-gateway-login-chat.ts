/**
 * Live Gateway acceptance: login, write a provider API key into the Pod, then Chat.
 *
 * Targets the currently running Xpod at http://127.0.0.1:3000/. Does not start a
 * substitute stack. Secrets stay process-local and are never printed.
 * XPOD_LIVE_MODE selects local (Cloud-managed), cloud, or standalone.
 *
 * Provider key source (never printed, never reads .env.local):
 * `.test-data/acceptance/provider-api-key` or `XPOD_LIVE_PROVIDER_KEY_FILE`.
 * Copy `scripts/live-provider-api-key.example`. Optional process env remains a
 * last-resort override. XPOD_AI_PROXY_URL is optional; there is no default proxy.
 */
import '../src/runtime/configure-drizzle-solid';
import { ensureTrailingSlash } from '../src/runtime/base-url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { createSolidLocalRouteFetch, discoverSolidLocalRoute } from '../packages/solid-sdk/src/local-route-fetch';
import { createXpodAiConnectionsClient } from '../ui/src/api/ai-connections';
import { createXpodAiConnectionsPodStore } from '../ui/src/extensions/XpodAiConnectionsPodStore';
import { checkServer } from '../src/cli/lib/css-account';
import { ProvisionCodeCodec } from '../src/provision/ProvisionCodeCodec';
import {
  discoverOidcIssuerFromWebId,
  loginWithClientCredentials,
  normalizeAccountControlUrl,
  type AccountSetup,
} from '../tests/integration/helpers/solidAccount';

const GATEWAY = ensureTrailingSlash(
  process.env.XPOD_LIVE_GATEWAY_URL?.trim() || 'http://127.0.0.1:3000/',
);
const MODE = process.env.XPOD_LIVE_MODE?.trim() || 'local';
if (!['cloud', 'local', 'standalone'].includes(MODE)) {
  throw new Error('XPOD_LIVE_MODE must be cloud, local, or standalone');
}
const CLOUD_IDP = process.env.XPOD_LIVE_CLOUD_IDP?.trim() || 'https://id.undefineds.co/';
const PROVIDER_KEY_FILE = process.env.XPOD_LIVE_PROVIDER_KEY_FILE?.trim()
  || path.join(process.cwd(), '.test-data', 'acceptance', 'provider-api-key');
const ACCEPT_ID = `login-chat-${Date.now().toString(36)}`;
const EVIDENCE_DIR = path.join(process.cwd(), '.test-data', 'acceptance');
const SECRET_PATTERN = /(sk-[A-Za-z0-9+/=_-]{8,}|Bearer\s+\S+|apiKey|client_secret|refresh_token|access_token)/giu;

type Layer = 'runtime' | 'identity' | 'podReadWrite' | 'gatewayAuth' | 'aiConnections' | 'models' | 'chat';

const report: {
  mode: string;
  startedAt: string;
  gateway: string;
  layers: Record<Layer, { ok: boolean; detail: string }>;
  webId?: string;
  podUrl?: string;
  probeUrl?: string;
  localRoute?: { canonicalBaseUrl: string; localBaseUrl: string; verifiedTarget?: string };
  provider?: string;
  offeringId?: string;
  modelIds?: string[];
  chatModel?: string;
  chatStatus?: number;
  keyCleanup?: { ok: boolean; detail: string };
} = {
  mode: MODE,
  startedAt: new Date().toISOString(),
  gateway: GATEWAY,
  layers: {
    runtime: { ok: false, detail: 'not run' },
    identity: { ok: false, detail: 'not run' },
    podReadWrite: { ok: false, detail: 'not run' },
    gatewayAuth: { ok: false, detail: 'not run' },
    aiConnections: { ok: false, detail: 'not run' },
    models: { ok: false, detail: 'not run' },
    chat: { ok: false, detail: 'not run' },
  },
};

function log(step: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, ...data }));
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, '<redacted>').slice(0, 400);
}

function layer(name: Layer, ok: boolean, detail: string): void {
  report.layers[name] = { ok, detail };
  log(name, { ok, detail });
}

function fail(name: Layer, detail: string): never {
  layer(name, false, detail);
  writeEvidence();
  throw new Error(detail);
}

function writeEvidence(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    path.join(EVIDENCE_DIR, `live-gateway-login-chat-${MODE}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function proxyUrl(): Promise<string | undefined> {
  const configured = process.env.XPOD_AI_PROXY_URL?.trim();
  if (configured) return configured;
  return undefined;
}

type ProviderChoice = {
  id: 'deepseek' | 'kimi' | 'openai' | 'custom';
  offeringId: string;
  apiKey: string;
  expected: string[];
  baseUrl?: string;
  source: 'file' | 'env';
};

type SelectionStateDb = {
  select(): {
    from(resource: typeof aiProviderResource | typeof aiModelResource): {
      execute(): Promise<Record<string, unknown>[]>;
    };
  };
};

function providerSpec(id: string, apiKey: string, source: ProviderChoice['source']): ProviderChoice | undefined {
  const key = apiKey.trim();
  if (!key) return undefined;
  switch (id.trim().toLowerCase()) {
    case 'deepseek':
      return {
        id: 'deepseek',
        offeringId: 'api-platform',
        apiKey: key,
        expected: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-v4-pro'],
        source,
      };
    case 'kimi':
    case 'moonshot':
      return {
        id: 'kimi',
        offeringId: 'subscription-key',
        apiKey: key,
        expected: ['kimi-for-coding', 'kimi-k2.5', 'kimi-for-coding-highspeed'],
        source,
      };
    case 'openai':
      return {
        id: 'openai',
        offeringId: 'api-platform',
        apiKey: key,
        expected: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1'],
        source,
      };
    case 'google':
    case 'gemini':
    case 'custom':
      return {
        id: 'custom',
        offeringId: 'openai-compatible',
        apiKey: key,
        expected: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-flash-latest'],
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        source,
      };
    default:
      return undefined;
  }
}

function parseKeyFile(contents: string): ProviderChoice | undefined {
  const values = new Map<string, string>();
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const named = [
    ['deepseek', values.get('DEEPSEEK_API_KEY')],
    ['kimi', values.get('KIMI_API_KEY') ?? values.get('MOONSHOT_API_KEY')],
    ['openai', values.get('OPENAI_API_KEY')],
    ['google', values.get('GOOGLE_API_KEY') ?? values.get('GEMINI_API_KEY')],
  ] as const;
  for (const [id, apiKey] of named) {
    const spec = apiKey ? providerSpec(id, apiKey, 'file') : undefined;
    if (spec) return spec;
  }
  const provider = values.get('provider') ?? values.get('PROVIDER');
  const apiKey = values.get('apiKey') ?? values.get('API_KEY') ?? values.get('key');
  const spec = provider && apiKey ? providerSpec(provider, apiKey, 'file') : undefined;
  if (!spec) return undefined;

  const configuredBaseUrl = values.get('baseUrl') ?? values.get('BASE_URL');
  const configuredModels = (values.get('expectedModels') ?? values.get('EXPECTED_MODELS'))
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    ...spec,
    ...(configuredBaseUrl?.trim() ? { baseUrl: configuredBaseUrl.trim() } : {}),
    ...(configuredModels?.length ? { expected: configuredModels } : {}),
  };
}

function providerFromFile(): { spec?: ProviderChoice; present: boolean; empty: boolean } {
  if (!existsSync(PROVIDER_KEY_FILE)) return { present: false, empty: false };
  const contents = readFileSync(PROVIDER_KEY_FILE, 'utf8');
  const spec = parseKeyFile(contents);
  return { spec, present: true, empty: !spec };
}

function providerFromEnv(): ProviderChoice | undefined {
  return providerSpec('deepseek', process.env.DEEPSEEK_API_KEY ?? '', 'env')
    ?? providerSpec('kimi', process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? '', 'env')
    ?? providerSpec('openai', process.env.OPENAI_API_KEY ?? '', 'env')
    ?? providerSpec('google', process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '', 'env');
}


async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${redact(text)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON: ${redact(text)}`);
  }
}

function inputUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

type AccountControls = {
  password?: { create?: string };
  account?: {
    pod?: string;
    bindings?: string;
    clientCredentials?: string;
  };
};

type CloudAccountPassword = {
  authorization: string;
  controls: AccountControls;
  email: string;
  password: string;
};

type StorageBinding = {
  webId: string;
  storageUrl: string;
};

let gatewayKeyCleanup: {
  client: ReturnType<typeof createXpodAiConnectionsClient>;
  id: string;
  plaintext: string;
} | undefined;

async function deleteAcceptanceGatewayKey(): Promise<void> {
  if (!gatewayKeyCleanup) return;
  const { client, id, plaintext } = gatewayKeyCleanup;
  try {
    await client.deleteGatewayKey(id);
    if ((await client.listGatewayKeys()).some((record) => record.id === id)) {
      throw new Error('Deleted acceptance API Key is still listed');
    }
    const response = await fetch(new URL('v1/models', GATEWAY), {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    await response.arrayBuffer();
    if (response.status !== 401) {
      throw new Error(`Deleted API Key expected HTTP 401, got ${response.status}`);
    }
    report.keyCleanup = { ok: true, detail: 'Deleted test key is absent from the list and authentication rejects it' };
  } catch (error) {
    report.keyCleanup = {
      ok: false,
      detail: error instanceof Error ? redact(error.message) : 'unknown cleanup error',
    };
    process.exitCode = 1;
  } finally {
    log('gatewayAuthCleanup', report.keyCleanup!);
    writeEvidence();
  }
}

function accountTokenHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `CSS-Account-Token ${token}`,
  };
}

function requiredAccountControl(rawUrl: string | undefined, baseUrl: string, label: string): string {
  if (!rawUrl) {
    throw new Error(`Cloud account controls did not expose ${label}`);
  }
  return normalizeAccountControlUrl(rawUrl, baseUrl);
}

function normalizeAcceptanceName(prefix: string): string {
  return prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'accept';
}

async function readLocalProvisionCode(): Promise<string> {
  const status = await readJson(
    await fetch(new URL('provision/status', GATEWAY)),
    'GET /provision/status',
  ) as { registered?: boolean; provisionCode?: unknown };
  if (status.registered !== true || typeof status.provisionCode !== 'string' || status.provisionCode.trim() === '') {
    throw new Error('Local Xpod has no active Cloud provision code');
  }
  return status.provisionCode;
}

async function createCloudAccountPassword(baseUrl: string, prefix: string): Promise<CloudAccountPassword> {
  const normalizedPrefix = normalizeAcceptanceName(prefix);
  const suffix = Date.now().toString(36);
  const email = `${normalizedPrefix}-${suffix}@test.com`;
  const password = 'test123456';
  const createAccountUrl = new URL('.account/account/', baseUrl).toString();

  const createAccount = await fetch(createAccountUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const createAccountBody = await readJson(createAccount, 'POST Cloud /.account/account') as { authorization?: string };
  if (!createAccountBody.authorization) {
    throw new Error('Cloud account creation did not return an account token');
  }

  const accountIndexUrl = new URL('.account/', baseUrl).toString();
  const accountIndex = await readJson(await fetch(accountIndexUrl, {
    headers: accountTokenHeaders(createAccountBody.authorization),
    credentials: 'include',
  }), 'GET Cloud account controls') as { controls?: AccountControls };
  const controls = accountIndex.controls ?? {};
  const passwordCreateUrl = requiredAccountControl(controls.password?.create, baseUrl, 'controls.password.create');
  const createPassword = await fetch(passwordCreateUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(createAccountBody.authorization),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  if (!createPassword.ok) {
    throw new Error(`Cloud password creation failed: ${createPassword.status} ${redact(await createPassword.text().catch(() => ''))}`);
  }

  return {
    authorization: createAccountBody.authorization,
    controls,
    email,
    password,
  };
}

function parseBindingCandidates(value: unknown): StorageBinding[] {
  const candidates: StorageBinding[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    const webId = typeof record.webId === 'string'
      ? record.webId
      : typeof record.webid === 'string'
        ? record.webid
        : undefined;
    const storageUrl = typeof record.storageUrl === 'string'
      ? record.storageUrl
      : typeof record.podUrl === 'string'
        ? record.podUrl
        : typeof record.pod === 'string'
          ? record.pod
          : undefined;
    if (webId && storageUrl) {
      candidates.push({ webId, storageUrl });
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(value);
  return candidates;
}

function normalizeStorageUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function chooseLocalBinding(candidates: StorageBinding[], canonicalBaseUrl: string): StorageBinding | undefined {
  const normalizedCanonical = normalizeStorageUrl(canonicalBaseUrl);
  return candidates.find((candidate) => normalizeStorageUrl(candidate.storageUrl).startsWith(normalizedCanonical));
}

async function fetchCloudAccountBindings(
  baseUrl: string,
  controls: AccountControls,
  authorization: string,
): Promise<StorageBinding[]> {
  if (!controls.account?.bindings) return [];
  const url = requiredAccountControl(controls.account.bindings, baseUrl, 'controls.account.bindings');
  const response = await fetch(url, {
    headers: accountTokenHeaders(authorization),
    credentials: 'include',
  });
  if (!response.ok) return [];
  return parseBindingCandidates(await response.json().catch(() => undefined));
}

async function createCloudManagedLocalPod(options: {
  baseUrl: string;
  authorization: string;
  controls: AccountControls;
  canonicalBaseUrl: string;
  provisionCode: string;
  provisionReceipt: string;
  username: string;
}): Promise<StorageBinding> {
  const createPodUrl = requiredAccountControl(options.controls.account?.pod, options.baseUrl, 'controls.account.pod');
  const response = await fetch(createPodUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(options.authorization),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      name: options.username,
      settings: {
        provisionCode: options.provisionCode,
        provisionReceipt: options.provisionReceipt,
      },
    }),
  });
  const body = await readJson(response, 'POST Cloud controls.account.pod');
  const immediate = chooseLocalBinding(parseBindingCandidates(body), options.canonicalBaseUrl);
  if (immediate) return immediate;

  for (let attempt = 0; attempt < 20; attempt++) {
    const bindings = await fetchCloudAccountBindings(options.baseUrl, options.controls, options.authorization);
    const binding = chooseLocalBinding(bindings, options.canonicalBaseUrl);
    if (binding) return binding;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Cloud account did not publish the Local-managed WebID/storage binding');
}

async function prepareLocalProvisionedPod(options: {
  cloudBaseUrl: string;
  localBaseUrl: string;
  provisionCode: string;
  username: string;
}): Promise<{ provisionReceipt: string; podUrl: string }> {
  const payload = new ProvisionCodeCodec(options.cloudBaseUrl).decode(options.provisionCode);
  const callbackToken = payload?.serviceAccessToken ?? payload?.serviceToken;
  if (!payload || !callbackToken) {
    throw new Error('Local provisionCode did not expose a valid Local callback token');
  }

  const response = await fetch(new URL('provision/pods', options.localBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callbackToken}`,
    },
    body: JSON.stringify({
      podName: options.username,
    }),
  });
  const body = await readJson(response, 'POST Local /provision/pods') as {
    podUrl?: unknown;
    provisionReceipt?: unknown;
  };
  if (typeof body.podUrl !== 'string' || typeof body.provisionReceipt !== 'string') {
    throw new Error('POST Local /provision/pods did not return podUrl and provisionReceipt');
  }
  return { provisionReceipt: body.provisionReceipt, podUrl: body.podUrl };
}

async function createHostedPod(options: {
  baseUrl: string;
  authorization: string;
  controls: AccountControls;
  username: string;
}): Promise<StorageBinding> {
  const createPodUrl = requiredAccountControl(options.controls.account?.pod, options.baseUrl, 'controls.account.pod');
  const response = await fetch(createPodUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(options.authorization),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: options.username }),
  });
  const body = await readJson(response, 'POST hosted controls.account.pod');
  const bindings = parseBindingCandidates(body);
  const binding = chooseLocalBinding(bindings, options.baseUrl);
  if (!binding) {
    throw new Error(`${MODE} account did not return a WebID/Pod hosted by ${options.baseUrl}`);
  }
  return binding;
}

async function createCloudClientCredentials(options: {
  baseUrl: string;
  authorization: string;
  controls: AccountControls;
  webId: string;
  name: string;
}): Promise<{ id: string; secret: string }> {
  const clientCredentialsUrl = requiredAccountControl(
    options.controls.account?.clientCredentials,
    options.baseUrl,
    'controls.account.clientCredentials',
  );
  const response = await fetch(clientCredentialsUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(options.authorization),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ name: options.name, webId: options.webId }),
  });
  const body = await readJson(response, 'POST Cloud controls.account.clientCredentials') as {
    id?: string;
    secret?: string;
  };
  if (!body.id || !body.secret) {
    throw new Error('Cloud client credentials response did not include id and secret');
  }
  return { id: body.id, secret: body.secret };
}

async function main(): Promise<void> {
  if (!(await checkServer(GATEWAY))) {
    fail('runtime', `Gateway unreachable at ${GATEWAY}`);
  }
  const statusResponse = await fetch(new URL('service/status', GATEWAY));
  const statusPayload = await readJson(statusResponse, 'GET /service/status') as Array<{ name?: string; status?: string; pid?: number }>;
  const css = statusPayload.find((item) => item.name === 'css');
  const api = statusPayload.find((item) => item.name === 'api');
  if (css?.status !== 'running' || api?.status !== 'running') {
    fail('runtime', `CSS/API not running: css=${css?.status ?? 'missing'} api=${api?.status ?? 'missing'}`);
  }
  layer('runtime', true, `css pid ${css.pid} api pid ${api.pid}`);
  const localSolidTargets: Array<{ url: string; method: string }> = [];
  const observedTransportFetch: typeof fetch = async(input, init) => {
    localSolidTargets.push({ url: inputUrl(input), method: init?.method ?? (input instanceof Request ? input.method : 'GET') });
    return fetch(input, init);
  };
  let localSolidTransport = observedTransportFetch;
  let identityBaseUrl = GATEWAY;
  let account: AccountSetup;
  let session: Awaited<ReturnType<typeof loginWithClientCredentials>>;
  try {
    let localRoute: Awaited<ReturnType<typeof discoverSolidLocalRoute>>;
    if (MODE === 'local') {
      localRoute = await discoverSolidLocalRoute({
        fetch,
        localBaseUrl: GATEWAY,
        statusUrl: new URL('provision/status', GATEWAY).toString(),
      });
      if (!localRoute) {
        throw new Error('Gateway did not expose a canonical-to-local Solid route');
      }
      if (new URL(localRoute.localBaseUrl).origin !== new URL(GATEWAY).origin) {
        throw new Error(`Local route points at ${localRoute.localBaseUrl}, expected ${GATEWAY}`);
      }
      const canonicalPodUrl = new URL(localRoute.canonicalBaseUrl);
      if (canonicalPodUrl.protocol !== 'https:') {
        throw new Error(`Canonical Pod route must use HTTPS, got ${canonicalPodUrl.protocol}`);
      }
      if (canonicalPodUrl.origin === new URL(GATEWAY).origin
        || [ 'localhost', '127.0.0.1', '::1' ].includes(canonicalPodUrl.hostname)) {
        throw new Error(`Canonical Pod route is not a Cloud-assigned protocol address: ${canonicalPodUrl.origin}`);
      }
      const verifiedRoute = localRoute;
      report.localRoute = {
        canonicalBaseUrl: verifiedRoute.canonicalBaseUrl,
        localBaseUrl: verifiedRoute.localBaseUrl,
      };
      localSolidTransport = createSolidLocalRouteFetch({
        fetch: observedTransportFetch,
        routes: () => [verifiedRoute],
      });
      identityBaseUrl = CLOUD_IDP;
    } else {
      const discovery = await readJson(
        await fetch(new URL('.well-known/openid-configuration', GATEWAY)),
        'GET hosted OIDC discovery',
      ) as { issuer?: string };
      if (!discovery.issuer || new URL(discovery.issuer).origin !== new URL(GATEWAY).origin) {
        throw new Error(`${MODE} must use its own IdP, got ${discovery.issuer ?? 'no issuer'}`);
      }
      identityBaseUrl = discovery.issuer;
    }
    const cloudAccount = await createCloudAccountPassword(identityBaseUrl, `accept-${MODE}`);
    const username = normalizeAcceptanceName(`a-${MODE}-${randomUUID().slice(0, 8)}`);
    const podOptions = {
      baseUrl: identityBaseUrl,
      authorization: cloudAccount.authorization,
      controls: cloudAccount.controls,
      username,
    };
    const binding = MODE === 'local' && localRoute
      ? await (async() => {
        const provisionCode = await readLocalProvisionCode();
        const preparedPod = await prepareLocalProvisionedPod({
          cloudBaseUrl: identityBaseUrl,
          localBaseUrl: localRoute.localBaseUrl,
          provisionCode,
          username,
        });
        return createCloudManagedLocalPod({
          ...podOptions,
          canonicalBaseUrl: localRoute.canonicalBaseUrl,
          provisionCode,
          provisionReceipt: preparedPod.provisionReceipt,
        });
      })()
      : await createHostedPod(podOptions);
    const credentials = await createCloudClientCredentials({
      baseUrl: identityBaseUrl,
      authorization: cloudAccount.authorization,
      controls: cloudAccount.controls,
      webId: binding.webId,
      name: `accept-client-${ACCEPT_ID}`,
    });
    account = {
      clientId: credentials.id,
      clientSecret: credentials.secret,
      webId: binding.webId,
      podUrl: normalizeStorageUrl(binding.storageUrl),
      issuer: await discoverOidcIssuerFromWebId(binding.webId, identityBaseUrl),
      email: cloudAccount.email,
      password: cloudAccount.password,
    };
    if (new URL(account.issuer).origin !== new URL(identityBaseUrl).origin) {
      throw new Error(`OIDC issuer ${account.issuer} does not match acceptance Cloud/standalone ${identityBaseUrl}`);
    }
    report.webId = account.webId;
    report.podUrl = account.podUrl;
    log('auth', { phase: 'client-credentials-login', issuer: account.issuer, webId: account.webId });
    session = await loginWithClientCredentials(account, localSolidTransport);
    log('auth', { phase: 'client-credentials-login-complete', isLoggedIn: session.info.isLoggedIn });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown identity setup error';
    fail('identity', redact(message));
  }
  layer('identity', true, `mode=${MODE} issuer=${account.issuer} webId=${account.webId} pod=${account.podUrl}`);
  const authenticatedFetch = session.fetch;
  const probePath = `acceptance/${ACCEPT_ID}.ttl`;
  const probeUrl = new URL(probePath, account.podUrl).toString();
  const probeBody = [
    '@prefix xpod: <https://undefineds.co/ns#> .',
    '<> a xpod:AcceptanceProbe ;',
    `  xpod:id "${ACCEPT_ID}" .`,
    '',
  ].join('\n');
  log('podReadWrite', { phase: 'put-probe', canonical: probeUrl });
  const put = await authenticatedFetch(probeUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle' },
    body: probeBody,
  });
  if (!put.ok) {
    const challenge = put.headers.get('www-authenticate');
    const body = await put.text().catch(() => '');
    fail('podReadWrite', `PUT ${probePath} HTTP ${put.status}${challenge ? ` challenge=${redact(challenge)}` : ''}${body ? ` body=${redact(body)}` : ''}`);
  }
  log('podReadWrite', { phase: 'get-probe', canonical: probeUrl });
  const got = await authenticatedFetch(probeUrl, { headers: { accept: 'text/turtle' } });
  const gotBody = await got.text();
  if (!got.ok || !gotBody.includes(ACCEPT_ID)) {
    fail('podReadWrite', `GET ${probePath} HTTP ${got.status} mismatch`);
  }
  const expectedProbeTarget = report.localRoute
    ? new URL(probeUrl.slice(report.localRoute.canonicalBaseUrl.length), report.localRoute.localBaseUrl).toString()
    : probeUrl;
  for (const method of ['PUT', 'GET']) {
    if (!localSolidTargets.some((target) => target.url === expectedProbeTarget && target.method === method)) {
      fail('podReadWrite', `${method} canonical Pod request was not observed at ${expectedProbeTarget}`);
    }
  }
  report.probeUrl = probeUrl;
  if (report.localRoute) report.localRoute.verifiedTarget = expectedProbeTarget;
  layer('podReadWrite', true, `canonical=${probeUrl} networkTarget=${expectedProbeTarget}`);

  const authSession: SolidAuthSession = {
    info: session.info,
    fetch: authenticatedFetch,
  };
  const database = drizzle(authSession, {
    podUrl: account.podUrl,
    schema: {
      aiModel: aiModelResource,
      aiProvider: aiProviderResource,
      credential: credentialResource,
    },
    autoConnect: false,
    resourcePreparation: 'off',
  }) as unknown as SolidDatabase;
  const podStore = createXpodAiConnectionsPodStore({
    database,
    authenticatedFetch,
    webId: account.webId,
    podUrl: account.podUrl,
  });
  const client = createXpodAiConnectionsClient({
    webId: account.webId,
    podUrl: account.podUrl,
    authenticatedFetch,
  });

  const { gatewayKey, initialModelIds } = await verifyGatewayKeyLifecycle(client);

  const fileState = providerFromFile();
  if (fileState.present && !fileState.spec) {
    fail('aiConnections', `Provider key file is present but invalid: ${PROVIDER_KEY_FILE}`);
  }
  const provider = fileState.spec ?? providerFromEnv();
  if (!provider) {
    const missing = fileState.present
      ? `key file present but empty: ${PROVIDER_KEY_FILE}`
      : `write provider=deepseek and apiKey=... to ${PROVIDER_KEY_FILE}`;
    try {
      const credential = await client.createLocalCredential('openai', {
        offeringId: 'official-subscription',
        label: `Live acceptance ${ACCEPT_ID}`,
      });
      const discovery = await client.discoverModels('openai');
      const selected = discovery.models.slice(0, 3);
      if (selected.length === 0) {
        fail('aiConnections', `Imported the local OpenAI subscription, but model discovery returned no models; ${missing}`);
      }
      await podStore.saveDiscoveredModels('openai', credential.id, discovery.models);
      await podStore.saveModelSelection('openai', selected, credential.id);
      const selectedIds = selected.map((model: { id: string }) => model.id);
      report.provider = 'openai';
      report.offeringId = 'official-subscription';
      report.modelIds = selectedIds;
      layer(
        'aiConnections',
        true,
        `imported the existing local OpenAI subscription into the Pod; discovered ${discovery.models.length}; selected ${selectedIds.join(', ')}; ${missing}`,
      );
      await projectModelsAndChat(gatewayKey, selectedIds);
      writeEvidence();
      return;
    } catch (error) {
      const detail = error instanceof Error ? redact(error.message) : 'unknown local subscription import error';
      layer('aiConnections', false, `${missing}; local OpenAI subscription import failed: ${detail}`);
      layer('models', false, initialModelIds.length === 0
        ? 'data: [] — auth/route only, Chat not proven'
        : `${initialModelIds.length} existing model(s) — Provider persistence not verified`);
      layer('chat', false, 'Skipped: no verified provider credential');
      writeEvidence();
      process.exitCode = 2;
      return;
    }
  }
  report.provider = provider.id;
  report.offeringId = provider.offeringId;
  const proxy = await proxyUrl();
  const credential = await podStore.createApiKeyCredential(provider.id, {
    offeringId: provider.offeringId,
    apiKey: provider.apiKey,
    label: `Live acceptance ${ACCEPT_ID}`,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(proxy ? { proxyUrl: proxy } : {}),
  });
  const discovery = await client.discoverModels(provider.id, {
    credentialId: credential.id,
    offeringId: provider.offeringId,
    apiKey: provider.apiKey,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(proxy ? { proxyUrl: proxy } : {}),
  });
  const discoveredIds = discovery.models.map((model: { id: string }) => model.id);
  const selected = discovery.models.filter((model: { id: string }) => provider.expected.includes(model.id));
  const toSave = selected.length > 0 ? selected : discovery.models.slice(0, 3);
  if (toSave.length === 0) {
    fail('aiConnections', `${provider.id} discovery returned no models`);
  }
  await podStore.saveDiscoveredModels(provider.id, credential.id, discovery.models);
  await podStore.saveModelSelection(provider.id, toSave, credential.id);
  const selectedIds = toSave.map((model: { id: string }) => model.id);
  const selectionDb = database as unknown as SelectionStateDb;
  const providerRows = await selectionDb.select().from(aiProviderResource).execute();
  const modelRows = await selectionDb.select().from(aiModelResource).execute();
  const providerSummary = (await client.listProviders()).find((item) => item.id === provider.id);
  log('aiConnectionsState', {
    providerRows: providerRows.map((row) => ({
      id: row.id,
      hasModel: Array.isArray(row.hasModel) ? row.hasModel : row.hasModel ? [row.hasModel] : [],
    })),
    modelRows: modelRows.map((row) => ({
      id: row.id,
      isProvidedBy: row.isProvidedBy,
      status: row.status,
    })),
    gatewayCredentialCount: providerSummary?.credentials.length ?? 0,
    gatewaySelectedModels: providerSummary?.selectedModels.map((model) => model.id) ?? [],
  });
  report.modelIds = selectedIds;
  layer(
    'aiConnections',
    true,
    `wrote ${provider.id}/${provider.offeringId} credential; discovered ${discoveredIds.length}; selected ${selectedIds.join(', ')}${proxy ? '; proxy used' : ''}`,
  );

  await projectModelsAndChat(gatewayKey, selectedIds);
  writeEvidence();
}

async function verifyGatewayKeyLifecycle(client: ReturnType<typeof createXpodAiConnectionsClient>): Promise<{
  gatewayKey: string;
  initialModelIds: string[];
}> {
  let phase = 'unauthenticated rejection';
  try {
    for (const route of ['v1/models', 'api/ai/gateway/keys']) {
      const response = await fetch(new URL(route, GATEWAY));
      await response.arrayBuffer();
      if (response.status !== 401) throw new Error(`Unauthenticated /${route} expected 401, got ${response.status}`);
    }
    phase = 'create';
    const issuedGatewayKey = await client.createGatewayKey({
      name: `Login-to-chat acceptance ${ACCEPT_ID}`,
      scopes: ['models:read', 'inference:write'],
    });
    const id = issuedGatewayKey.record.id;
    const gatewayKey = issuedGatewayKey.plaintext;
    gatewayKeyCleanup = { client, id, plaintext: gatewayKey };
    phase = 'list';
    if (!(await client.listGatewayKeys()).some((record) => record.id === id)) {
      throw new Error('Created Xpod Gateway API Key was not returned by the Pod-backed list API');
    }
    phase = 'recover plaintext';
    if (await client.revealGatewayKey(id) !== gatewayKey) {
      throw new Error('Created Xpod Gateway API Key could not be recovered from its Pod companion resource');
    }
    const headers = { Authorization: `Bearer ${gatewayKey}`, Accept: 'application/json' };
    const modelUrl = new URL('v1/models', GATEWAY);
    phase = 'active key authentication';
    await readJson(await fetch(modelUrl, { headers }), 'GET /v1/models with active key');
    phase = 'pause';
    const disabled = await client.updateGatewayKey(id, { enabled: false });
    if (!disabled.disabledAt || disabled.revokedAt) throw new Error('Pausing an API Key must be reversible');
    const denied = await fetch(modelUrl, { headers });
    await denied.arrayBuffer();
    if (denied.status !== 401) throw new Error(`Disabled API Key expected 401, got ${denied.status}`);
    phase = 'resume';
    const resumed = await client.updateGatewayKey(id, { enabled: true });
    if (resumed.disabledAt || resumed.revokedAt) throw new Error('Resumed API Key is still disabled or revoked');
    const modelsPayload = await readJson(await fetch(modelUrl, { headers }), 'GET /v1/models with resumed key') as {
      data?: Array<{ id?: string }>;
    };
    const initialModelIds = (modelsPayload.data ?? []).flatMap((model) => model.id ? [model.id] : []);
    layer('gatewayAuth', true, `API Key created/listed/revealed/paused/resumed; unauthenticated and disabled calls rejected; ${initialModelIds.length} model(s), not Chat proof`);
    return { gatewayKey, initialModelIds };
  } catch (error) {
    fail('gatewayAuth', `${phase}: ${error instanceof Error ? redact(error.message) : 'Unknown Gateway API Key error'}`);
  }
}

async function projectModelsAndChat(gatewayKey: string, selectedIds: string[]): Promise<void> {
  const modelsAfter = await fetch(new URL('v1/models', GATEWAY), {
    headers: { Authorization: `Bearer ${gatewayKey}`, Accept: 'application/json' },
  });
  const modelsAfterPayload = await readJson(modelsAfter, 'GET /v1/models after key') as { data?: Array<{ id?: string }> };
  const projected = (modelsAfterPayload.data ?? []).flatMap((model) => model.id ? [model.id] : []);
  if (projected.length === 0) {
    fail('models', 'data: [] after writing provider credential — Chat not proven');
  }
  layer('models', true, `HTTP ${modelsAfter.status}; ${projected.length} model(s): ${projected.join(', ')}`);

  const chatModel = selectedIds.find((id) => projected.includes(id)) ?? projected[0];
  await chatOnce(gatewayKey, chatModel);
}

async function chatOnce(gatewayKey: string, chatModel: string): Promise<void> {
  report.chatModel = chatModel;
  const chatResponse = await fetch(new URL('v1/chat/completions', GATEWAY), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gatewayKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: 'user', content: 'Reply with exactly: XPOD_OK' }],
      max_tokens: 64,
      temperature: 0,
    }),
  });
  report.chatStatus = chatResponse.status;
  const chatPayload = await readJson(chatResponse, 'POST /v1/chat/completions') as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string; code?: string };
  };
  if (chatPayload.error) {
    fail('chat', `Chat error ${chatPayload.error.code ?? ''}: ${redact(chatPayload.error.message ?? 'unknown')}`);
  }
  const content = chatPayload.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : '')).join('')
      : '';
  if (chatResponse.status < 200 || chatResponse.status >= 300 || text.trim() !== 'XPOD_OK') {
    const observed = text.trim().slice(0, 160);
    const payloadShape = redact(JSON.stringify(chatPayload).slice(0, 500));
    fail('chat', `Chat HTTP ${chatResponse.status} did not return the exact acceptance marker${observed ? `; observed=${redact(observed)}` : '; observed=<empty>'}; payload=${payloadShape}`);
  }
  layer('chat', true, `HTTP ${chatResponse.status} model=${chatModel} contentChars=${text.trim().length}`);
}

main()
  .catch((error) => {
    const message = error instanceof Error ? redact(error.message) : 'unknown error';
    log('fatal', { message });
    writeEvidence();
    process.exitCode = 1;
  })
  .finally(deleteAcceptanceGatewayKey);
