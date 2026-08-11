import { createServer, type Server } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { XpodTestStack } from './XpodTestStack';
import {
  discoverOidcIssuerFromWebId,
  setupAccount,
  type AccountSetup,
} from '../integration/helpers/solidAccount';

const readyPrefix = 'XPOD_SETTINGS_FIXTURE_READY ';
const failurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';
const runtimeParent = path.resolve('.test-data/acceptance');
const runtimeRoot = path.join(runtimeParent, `runtime-${process.pid}-${randomUUID()}`);
const fixtureBearerLabels = new Map<string, string>([
  ['Bearer sk-xpod-acceptance-fixture-key', 'primary'],
  ['Bearer sk-xpod-acceptance-fixture-sibling', 'sibling'],
]);

type FixtureModel = { id: string; display_name?: string };

type FixtureAccount = AccountSetup & {
  email: string;
  password: string;
};

type FixtureCredentials = Pick<FixtureAccount, 'email' | 'password'>;
type FixturePodBinding = {
  podUrl: string;
  webId: string;
};
type FixtureMultiPodAccount = FixtureAccount & {
  podUrls: string[];
  podBindings: FixturePodBinding[];
  deletePod: (podUrl: string) => Promise<boolean>;
};

type FixtureReady = {
  type: 'ready';
  baseUrl: string;
  fixtureBaseUrl: string;
  controlUrl: string;
  accounts: {
    alice: FixtureAccount;
    bob: FixtureAccount & {
      podUrls: string[];
      podBindings: FixturePodBinding[];
    };
    /** A fresh browser account intentionally has no Pod binding yet. */
    newAccount: FixtureCredentials;
  };
};

class OpenAiCompatibleFixture {
  private server?: Server;
  private models: FixtureModel[] = [{
    id: 'fixture-gpt-acceptance',
    display_name: 'Fixture GPT Acceptance',
  }];
  readonly requests: string[] = [];
  readonly authorizedDiscoveries: string[] = [];
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      this.requests.push(`${request.method ?? 'GET'} ${pathname}`);
      if (request.method === 'GET' && pathname === '/v1/models') {
        const credentialLabel = fixtureBearerLabels.get(request.headers.authorization ?? '');
        if (!credentialLabel) {
          this.writeJson(response, 401, { error: 'missing or invalid fixture bearer credential' });
          return;
        }
        this.authorizedDiscoveries.push(credentialLabel);
        this.writeJson(response, 200, {
          object: 'list',
          data: this.models.map((model) => ({
            object: 'model',
            owned_by: 'xpod-acceptance',
            ...model,
          })),
        });
        return;
      }
      if (pathname === '/control/status' && request.method === 'GET') {
        this.writeJson(response, 200, {
          requests: this.requests,
          modelCount: this.models.length,
          authorizedDiscoveries: this.authorizedDiscoveries,
        });
        return;
      }
      if (pathname === '/control/models' && request.method === 'POST') {
        void this.readJson(request).then((body) => {
          const models = body?.models;
          if (!Array.isArray(models)) {
            this.writeJson(response, 400, { error: 'models must be an array' });
            return;
          }
          this.models = models.flatMap((model): FixtureModel[] => {
            if (!model || typeof model !== 'object' || typeof (model as { id?: unknown }).id !== 'string') return [];
            const displayName = (model as { display_name?: unknown }).display_name;
            return [{
              id: (model as { id: string }).id,
              ...(typeof displayName === 'string' ? { display_name: displayName } : {}),
            }];
          });
          this.writeJson(response, 204, undefined);
        }).catch(() => this.writeJson(response, 400, { error: 'invalid JSON' }));
        return;
      }
      if (pathname === '/control/delete-pod' && request.method === 'POST') {
        void this.readJson(request).then(async (body) => {
          const podUrl = body?.podUrl;
          if (typeof podUrl !== 'string' || !podUrl) {
            this.writeJson(response, 400, { error: 'podUrl is required' });
            return;
          }
          if (!deletePodControl) {
            this.writeJson(response, 503, { error: 'pod deletion control is unavailable' });
            return;
          }
          const deleted = await deletePodControl(podUrl);
          this.writeJson(response, deleted ? 204 : 404, deleted ? undefined : { error: 'pod not found' });
        }).catch(() => this.writeJson(response, 400, { error: 'invalid JSON' }));
        return;
      }
      if (pathname === '/control/shutdown' && request.method === 'POST') {
        this.writeJson(response, 204, undefined);
        void shutdown(0);
        return;
      }
      this.writeJson(response, 404, { error: 'fixture route not found' });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not expose a TCP port');
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private writeJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, body === undefined ? undefined : { 'content-type': 'application/json' });
    if (body !== undefined) response.end(JSON.stringify(body));
    else response.end();
  }

  private async readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown> | undefined> {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    if (!text) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  }
}

const stack = new XpodTestStack();
const providerFixture = new OpenAiCompatibleFixture();
let shuttingDown = false;
let deletePodControl: ((podUrl: string) => Promise<boolean>) | undefined;

async function main(): Promise<void> {
  await mkdir(runtimeParent, { recursive: true });
  await providerFixture.start();
  await stack.start('local', {
    transport: 'port',
    open: false,
    apiOpen: false,
    envFile: undefined,
    runtimeRoot,
    logLevel: 'error',
    env: {
      XPOD_ACCEPTANCE_ENDPOINTS_ENABLED: 'true',
      XPOD_ACCEPTANCE_PROVIDER_ORIGIN: new URL(providerFixture.baseUrl).origin,
      XPOD_AI_GATEWAY_OPENAI_BASE_URL: providerFixture.baseUrl,
    },
  });
  const alice = await setupAccount(stack.baseUrl, 'alice');
  const bob = await setupMultiPodAccount(stack.baseUrl, 'bob');
  const newAccount = await setupBrowserOnlyAccount(stack.baseUrl, 'new-account');
  if (!alice?.email || !alice.password || !bob?.email || !bob.password || !newAccount) {
    throw new Error('fixture accounts were not created');
  }
  deletePodControl = bob.deletePod;
  const bobReady = { ...bob };
  delete (bobReady as Partial<FixtureMultiPodAccount>).deletePod;
  const address = providerFixture.baseUrl.replace(/\/v1$/u, '');
  const ready: FixtureReady = {
    type: 'ready',
    baseUrl: stack.baseUrl,
    fixtureBaseUrl: providerFixture.baseUrl,
    controlUrl: address,
    accounts: {
      alice: alice as FixtureAccount,
      bob: bobReady,
      newAccount,
    },
  };
  process.stdout.write(`${readyPrefix}${JSON.stringify(ready)}\n`);
}

/**
 * Create only the CSS Account/password credential needed by the browser.
 * Deliberately do not create a Pod here: the first-storage acceptance path
 * must exercise the real Account/consent bootstrap UI instead of receiving a
 * preselected binding from the fixture.
 */
async function setupBrowserOnlyAccount(baseUrl: string, prefix: string): Promise<FixtureCredentials | null> {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const email = `${prefix}-${suffix}@test.com`;
  const password = 'test123456';
  const createRes = await fetch(`${baseUrl}/.account/account/`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!createRes.ok) return null;
  const created = await createRes.json() as { authorization?: string };
  if (typeof created.authorization !== 'string' || !created.authorization) return null;
  const accountHeaders = {
    Accept: 'application/json',
    Authorization: `CSS-Account-Token ${created.authorization}`,
  };
  const controlsRes = await fetch(`${baseUrl}/.account/`, { headers: accountHeaders });
  if (!controlsRes.ok) return null;
  const controls = await controlsRes.json() as {
    controls?: { password?: { create?: string } };
  };
  const passwordUrl = controls.controls?.password?.create;
  if (!passwordUrl) return null;
  const passwordRes = await fetch(passwordUrl, {
    method: 'POST',
    headers: { ...accountHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return passwordRes.ok ? { email, password } : null;
}

/**
 * Build the multi-Pod account used by the explicit binding scenarios.
 *
 * This is intentionally server-side fixture setup: the browser still signs in
 * through the real Account/OIDC/PKCE flow and chooses one exact binding in the
 * consent page. The account token remains in this process so the test control
 * route can delete a Pod when exercising stale-binding recovery.
 */
async function setupMultiPodAccount(baseUrl: string, prefix: string): Promise<FixtureMultiPodAccount | null> {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const email = `${prefix}-${suffix}@test.com`;
  const password = 'test123456';
  const accountResponse = await fetch(`${baseUrl}/.account/account/`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!accountResponse.ok) return null;
  const created = await accountResponse.json() as { authorization?: string };
  const authorization = created.authorization;
  if (!authorization) return null;

  const accountHeaders = {
    Accept: 'application/json',
    Authorization: `CSS-Account-Token ${authorization}`,
  };
  const controlsResponse = await fetch(`${baseUrl}/.account/`, { headers: accountHeaders });
  if (!controlsResponse.ok) return null;
  const controls = await controlsResponse.json() as {
    controls?: {
      password?: { create?: string };
      account?: { pod?: string; clientCredentials?: string };
    };
  };
  const passwordUrl = controls.controls?.password?.create;
  const podUrl = controls.controls?.account?.pod;
  const clientCredentialsUrl = controls.controls?.account?.clientCredentials;
  if (!passwordUrl || !podUrl || !clientCredentialsUrl) return null;

  const passwordResponse = await fetch(passwordUrl, {
    method: 'POST',
    headers: { ...accountHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!passwordResponse.ok) return null;

  const podBindings: FixturePodBinding[] = [];
  for (const podName of [`${prefix}-${suffix}-primary`, `${prefix}-${suffix}-secondary`]) {
    const podResponse = await fetch(podUrl, {
      method: 'POST',
      headers: { ...accountHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: podName }),
    });
    if (!podResponse.ok) return null;
    const podInfo = await podResponse.json() as { webId?: string; pod?: string };
    const webId = podInfo.webId ?? new URL(`/${podName}/profile/card#me`, baseUrl).toString();
    const storageUrl = podInfo.pod ?? new URL(`/${podName}/`, baseUrl).toString();
    podBindings.push({
      webId,
      podUrl: storageUrl.endsWith('/') ? storageUrl : `${storageUrl}/`,
    });
  }

  const firstBinding = podBindings[0];
  if (!firstBinding) return null;
  const credentialsResponse = await fetch(clientCredentialsUrl, {
    method: 'POST',
    headers: { ...accountHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${prefix}-browser-client`, webId: firstBinding.webId }),
  });
  if (!credentialsResponse.ok) return null;
  const credentials = await credentialsResponse.json() as { id?: string; secret?: string };
  if (!credentials.id || !credentials.secret) return null;

  const deletePod = async (requestedPodUrl: string): Promise<boolean> => {
    const podsResponse = await fetch(podUrl, { headers: accountHeaders });
    if (!podsResponse.ok) return false;
    const podsData = await podsResponse.json() as { pods?: Record<string, string> };
    const requested = requestedPodUrl.replace(/\/$/u, '');
    const resourceUrl = Object.entries(podsData.pods ?? {})
      .find(([candidate]) => candidate.replace(/\/$/u, '') === requested)?.[1];
    if (!resourceUrl) {
      console.error('fixture delete pod not found', requestedPodUrl, Object.keys(podsData.pods ?? {}));
      return false;
    }
    const deleteResponse = await fetch(resourceUrl, {
      method: 'DELETE',
      headers: accountHeaders,
    });
    if (deleteResponse.ok || deleteResponse.status === 404) return true;

    // CSS 8 exposes Pod ownership removal but not a DELETE method on the
    // account Pod resource. Remove every owner through that supported API so
    // the exact Account storage binding disappears for stale-binding tests.
    const detailsResponse = await fetch(resourceUrl, { headers: accountHeaders });
    if (!detailsResponse.ok) {
      return false;
    }
    const details = await detailsResponse.json() as { owners?: Array<{ webId?: string }> };
    const owners = (details.owners ?? [])
      .map((owner) => owner.webId)
      .filter((webId): webId is string => typeof webId === 'string' && webId.length > 0);
    // CSS prevents removing the last owner. Add a disposable non-Account
    // owner first, then remove every Account owner so this Pod no longer has
    // an exact binding for the browser identity under test.
    const disposableOwner = `https://stale-owner.invalid/${randomUUID()}#me`;
    const addOwnerResponse = await fetch(resourceUrl, {
      method: 'POST',
      headers: { ...accountHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webId: disposableOwner, visible: false }),
    });
    if (!addOwnerResponse.ok) return false;
    for (const webId of owners) {
      const removeResponse = await fetch(resourceUrl, {
        method: 'POST',
        headers: { ...accountHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webId, remove: true }),
      });
      if (!removeResponse.ok) {
        return false;
      }
    }
    return true;
  };

  return {
    clientId: credentials.id,
    clientSecret: credentials.secret,
    webId: firstBinding.webId,
    podUrl: firstBinding.podUrl,
    issuer: await discoverOidcIssuerFromWebId(firstBinding.webId, baseUrl),
    email,
    password,
    podUrls: podBindings.map((binding) => binding.podUrl),
    podBindings,
    deletePod,
  };
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stack.stop();
  } finally {
    try {
      await providerFixture.stop();
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Keep startup diagnostics off stdout: the parent treats stdout as a one-line
// control protocol and retains no credential-bearing logs.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.warn = (...args: unknown[]) => console.error(...args);

try {
  await main();
} catch {
  process.stdout.write(`${failurePrefix}{"error":"startup_failed"}\n`);
  await shutdown(1).catch(() => {
    process.exitCode = 1;
  });
}
