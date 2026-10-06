import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { Parser } from 'n3';
import { deriveProvisionReceiptSecret, verifyProvisionReceipt } from '../../src/provision/ProvisionReceiptCodec';
import { normalizeAccountPath } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodGateway, fetchBrowserXpodPod, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

type Manifest = {
  baseUrl: string; canonical: string; issuer: string; serviceToken: string; localRuntimeRoot: string;
  canonicalUnavailableFromStartup: boolean; runnerBunVersion: string; runnerExecPath: string; runnerCwd: string;
  account: { email: string; password: string; username: string };
};
type NativeRequestEvidence = { origin: string; path: string; method: string; dpop: boolean; cookie: boolean;
  interactionOrdinal?: number; authorizationScheme?: string; status?: number; claims?: ReturnType<typeof safeClaims> };
const manifestPath = process.env.XPOD_E2E_NO_PUBLIC_ROUTE_MANIFEST;
const fixture = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest : undefined;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('managed native Local uses a Cloud profile and private data transport without a public route from startup', async ({}, testInfo) => {
  test.skip(!fixture, 'Run runManagedLocalNoPublicRouteAcceptance.ts');
  test.setTimeout(240_000);
  const deployment = fixture!;
  const podUrl = new URL(`${deployment.account.username}/`, deployment.canonical).href;
  const provisionResponse = await fetch(new URL('/provision/status', deployment.baseUrl));
  expect(provisionResponse.status).toBe(200);
  const provision = await provisionResponse.json() as {
    managed: boolean; registered: boolean; provisionCode: string; publicUrl: string; oidcIssuer: string;
    publicRoute?: { configured: boolean; available: boolean };
  };
  expect(provision.managed && provision.registered).toBe(true);
  expect(provision.publicUrl).toBe(deployment.canonical);
  expect(provision.oidcIssuer).toBe(deployment.issuer);
  let app: ElectronApplication | undefined;
  const userData = await mkdtemp(path.resolve('.test-data/no-public-electron-'));
  const evidence: Record<string, unknown> = { isolatedFixture: true, runnerBunVersion: deployment.runnerBunVersion, realCloud: true, realNativeLocal: true, canonicalPodUrl: podUrl, realUpstreamChat: false };
  const requests: NativeRequestEvidence[] = [];
  const interactions = new Map<string, number>();
  const interactionOrdinal = (path: string): number | undefined => {
    const id = /^\/\.account\/interaction\/([^/]+)/u.exec(path)?.[1] ?? /^\/\.oidc\/auth\/([^/]+)/u.exec(path)?.[1];
    if (!id) return undefined;
    if (!interactions.has(id)) interactions.set(id, interactions.size + 1);
    return interactions.get(id);
  };
  const servedAssets: Array<{ origin: string; path: string; sha256: string; localSha256: string; matchesCurrentStatic: boolean }> = [];
  const assetReads: Promise<void>[] = [];
  evidence.servedAssets = servedAssets;
  const nativeInitiators: Array<Record<string, unknown>> = [];
  evidence.nativeAccountInitiators = nativeInitiators;
  evidence.runnerExecPath = deployment.runnerExecPath;
  evidence.runnerCwd = deployment.runnerCwd;
  evidence.desktopAssets = ['desktop/dist/main.js', 'desktop/dist/preload.cjs'].map(file => ({
    path: path.resolve(file), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    modifiedAt: statSync(file).mtime.toISOString(),
  }));
  try {
    expect(deployment.canonicalUnavailableFromStartup).toBe(true);
    evidence.canonicalUnavailableFromStartup = deployment.canonicalUnavailableFromStartup;
    expect(await connectionRefused(podUrl)).toBe(true);
    const webId = await prepareCloudIdentityAndPrivatePod(deployment, podUrl, provision.provisionCode, evidence, testInfo.outputDir);
    evidence.canonicalIdentity = webId;
    evidence.cloudProfileAvailable = true;
    const canonicalTransportRejected = await connectionRefused(podUrl);
    evidence.canonicalPodTransportRejected = canonicalTransportRejected;
    expect(canonicalTransportRejected).toBe(true);
    const routeStatus = await fetch(new URL('/provision/status', deployment.baseUrl)).then(r => r.json()) as typeof provision;
    evidence.publicRoute = routeStatus.publicRoute;
    expect(routeStatus.publicRoute?.available).toBe(false);
    expect(routeStatus.publicUrl).toBe(deployment.canonical);

    app = await electron.launch({ args: [path.resolve('desktop/dist/main.js')], timeout: 30_000,
      env: { ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_USER_DATA_DIR: userData,
        XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', deployment.baseUrl).href },
    });
    app.context().on('page', nativePage => { void captureAccountInitiators(nativePage, deployment.issuer, nativeInitiators); });
    await Promise.all(app.windows().map(nativePage => captureAccountInitiators(nativePage, deployment.issuer, nativeInitiators)));
    app.context().on('request', async request => {
      const url = new URL(request.url());
      const headers = await request.allHeaders().catch(() => ({} as Record<string, string>));
      requests.push({ origin: url.origin, path: safeNativePath(url.pathname), interactionOrdinal: interactionOrdinal(url.pathname), method: request.method(), dpop: Boolean(headers.dpop),
        cookie: Boolean(headers.cookie), authorizationScheme: headers.authorization?.split(' ')[0], claims: safeClaims(headers, webId, deployment.issuer) });
    });
    app.context().on('response', async response => {
      const url = new URL(response.url());
      if (response.status() === 200 && /^\/(?:settings|app)\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(url.pathname)) {
        assetReads.push((async () => {
          const body = await response.body();
          const sha256 = createHash('sha256').update(body).digest('hex');
          const localSha256 = createHash('sha256').update(readFileSync(path.resolve('static', url.pathname.slice(1)))).digest('hex');
          servedAssets.push({ origin: url.origin, path: url.pathname, sha256, localSha256, matchesCurrentStatic: sha256 === localSha256 });
        })().catch(() => undefined));
      }
      const request = response.request();
      const headers = await request.allHeaders().catch(() => ({} as Record<string, string>));
      requests.push({ origin: url.origin, path: safeNativePath(url.pathname), interactionOrdinal: interactionOrdinal(url.pathname), method: request.method(), dpop: Boolean(headers.dpop),
        cookie: Boolean(headers.cookie), authorizationScheme: headers.authorization?.split(' ')[0], status: response.status(), claims: safeClaims(headers, webId, deployment.issuer) });
    });
    const signedIn = await nativeLogin(app, deployment, evidence);
    await expect.poll(() => nativeAuthenticationCounts(requests).passwordPostCount).toBe(1);
    expect(nativeAuthenticationCounts(requests).authorizationStartCount).toBe(1);
    evidence.nativeBridge = await signedIn.evaluate(() => {
      const bridge = (window as unknown as { xpodDesktop?: Record<string, unknown> }).xpodDesktop;
      return { keys: Object.keys(bridge ?? {}), providesFetch: typeof bridge?.fetch === 'function', providesSession: Boolean(bridge?.session) };
    });
    const runtime = await readBrowserXpodRuntime(signedIn);
    evidence.nativeRuntime = runtime;
    expect(runtime).toMatchObject({ status: 'authenticated', webId, podUrl, issuer: deployment.issuer });

    // The already-mounted native host supplies its real authorization-code DPoP
    // token. Explicitly omit cookies for Account index and credential issuance.
    const credentials = await accountCredential(signedIn, deployment.issuer, webId);
    evidence.accountIndexStatus = credentials.indexStatus;
    evidence.accountClientCredentialsControlPresent = credentials.controlPresent;
    evidence.clientCredentialStatus = credentials.createStatus;
    expect(credentials.indexStatus).toBe(200);
    expect(credentials.controlPresent).toBe(true);
    expect(credentials.createStatus).toBe(200);
    expect(Boolean(credentials.id && credentials.secret)).toBe(true);
    const centralOrigin = new URL(deployment.issuer).origin;
    const centralAccountResponses = () => requests.filter(request => {
      const claims = request.claims;
      return request.origin === centralOrigin && request.path === '/.account/' && request.method === 'GET'
        && request.status === 200 && request.dpop && !request.cookie
        && request.authorizationScheme?.toLowerCase() === 'dpop' && claims && 'proofHasAth' in claims
        && claims.proofHasAth && claims.proofAthMatchesAccessToken && claims.webIdMatchesCloudIdentity && claims.issuerMatchesCloud;
    });
    await expect.poll(() => centralAccountResponses().length).toBeGreaterThan(0);
    evidence.accountIndexWithoutCookieDPoP = true;
    const tokenEndpoint = await fetch(new URL('/.well-known/openid-configuration', deployment.issuer))
      .then(r => r.json()).then((config: { token_endpoint: string }) => config.token_endpoint);
    const key = await generateDpopKeyPair();
    const tokenResponse = await fetch(tokenEndpoint, { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`,
      DPoP: await createDpopHeader(tokenEndpoint, 'POST', key),
    }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }) });
    evidence.centralTokenStatus = tokenResponse.status;
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token?: string; token_type?: string };
    expect(Boolean(token.access_token)).toBe(true);
    expect(token.token_type?.toLowerCase()).toBe('dpop');
    const tokenClaims = JSON.parse(Buffer.from(token.access_token!.split('.')[1], 'base64url').toString()) as { webid: string; iss: string };
    expect(tokenClaims.webid).toBe(webId);
    expect(tokenClaims.iss).toBe(deployment.issuer);
    evidence.credentialTokenHasExactCloudIdentityAndIssuer = true;

    const indexResponsesBeforeRepeat = centralAccountResponses().length;
    const firstProof = centralAccountResponses().slice(-1)[0]?.claims;
    const repeated = await accountCredential(signedIn, deployment.issuer, webId, false);
    evidence.repeatedAccountIndexStatus = repeated.indexStatus;
    expect(repeated.indexStatus).toBe(200);
    expect(repeated.controlPresent).toBe(true);
    await expect.poll(() => centralAccountResponses().length).toBeGreaterThan(indexResponsesBeforeRepeat);
    const secondProof = centralAccountResponses().slice(-1)[0]?.claims;
    expect(firstProof && 'proofFingerprint' in firstProof && secondProof && 'proofFingerprint' in secondProof &&
      firstProof.proofFingerprint !== secondProof.proofFingerprint).toBe(true);
    evidence.repeatedAccountHasFreshProofWithoutCookies = true;
    await assertNativeCloudProfileScope(signedIn, deployment.issuer, webId, requests, evidence);
    evidence.cloudCardOwnerIsLimitedToProfile = true;

    const resource = `no-public-${randomUUID()}.txt`;
    const body = `private-local-${randomUUID()}`;
    expect((await fetchBrowserXpodPod(signedIn, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).status).toBe(201);
    expect(await fetchBrowserXpodPod(signedIn, resource)).toEqual({ status: 200, body });
    evidence.canonicalPrivatePodWriteRead = true;
    const providers = await fetchBrowserXpodGateway(signedIn, webId, deployment.baseUrl, '/api/ai/providers');
    evidence.providersApiStatus = providers.status;
    expect(providers.status).toBe(200);
    const catalog = JSON.parse(providers.body) as unknown;
    expect(Boolean(catalog && typeof catalog === 'object')).toBe(true);
    expect(await connectionRefused(podUrl)).toBe(true);
    evidence.canonicalPodTransportRejectedAfterNativeDataAccess = true;
    await Promise.all(assetReads);
    expect(servedAssets.length).toBeGreaterThan(0);
    expect(servedAssets.every(asset => asset.matchesCurrentStatic)).toBe(true);
  } finally {
    await Promise.all(assetReads);
    await new Promise(resolve => setTimeout(resolve, 100));
    evidence.nativeAuthentication = nativeAuthenticationCounts(requests);
    if (app) await preserveNativeWindows(app, testInfo.outputDir, evidence);
    await testInfo.attach('safe-stage-evidence', { contentType: 'application/json', body: JSON.stringify(evidence) });
    await testInfo.attach('safe-native-request-evidence', { contentType: 'application/json', body: JSON.stringify(requests) });
    if (app) await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

async function connectionRefused(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    const pending: unknown[] = [error];
    while (pending.length) {
      const candidate = pending.shift() as { code?: string; cause?: unknown; errors?: unknown[] } | undefined;
      if (!candidate || typeof candidate !== 'object') continue;
      if (candidate.code === 'ECONNREFUSED') return true;
      if (candidate.cause) pending.push(candidate.cause);
      if (candidate.errors) pending.push(...candidate.errors);
    }
  }
  return false;
}

/** Real Account and node HTTP controls. Tokens/cookies/receipts never enter evidence. */
async function prepareCloudIdentityAndPrivatePod(
  deployment: Manifest, podUrl: string, provisionCode: string, evidence: Record<string, unknown>, diagnosticsDir: string,
): Promise<string> {
  const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const accountResponse = await fetch(new URL('.account/account/', deployment.issuer), {
    method: 'POST', headers: jsonHeaders, body: '{}', redirect: 'error',
  });
  evidence.accountCreateStatus = accountResponse.status;
  expect(accountResponse.ok).toBe(true);
  const account = await accountResponse.json() as { authorization: string };
  expect(Boolean(account.authorization)).toBe(true);
  const setupIndexResponse = await fetch(new URL('.account/', deployment.issuer), {
    headers: { Accept: 'application/json', Authorization: `CSS-Account-Token ${account.authorization}` }, redirect: 'error',
  });
  evidence.setupAccountIndexStatus = setupIndexResponse.status;
  await preserveFailedResponse(setupIndexResponse, 'setup-account-index', diagnosticsDir, evidence);
  expect(setupIndexResponse.status).toBe(200);
  const setupIndex = await setupIndexResponse.json() as { controls: { password: { create: string } } };
  const passwordResponse = await fetch(cloudControl(setupIndex.controls.password.create, deployment.issuer), {
    method: 'POST', headers: { ...jsonHeaders, Authorization: `CSS-Account-Token ${account.authorization}` },
    body: JSON.stringify({ email: deployment.account.email, password: deployment.account.password }), redirect: 'error',
  });
  evidence.passwordCreateStatus = passwordResponse.status;
  expect(passwordResponse.ok).toBe(true);
  const login = await fetch(new URL('.account/login/password/', deployment.issuer), {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ email: deployment.account.email, password: deployment.account.password }), redirect: 'error',
  });
  expect(login.ok).toBe(true);
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  expect(Boolean(cookie)).toBe(true);
  const accountHeaders = { Accept: 'application/json', Cookie: cookie };
  const indexResponse = await fetch(new URL('.account/', deployment.issuer), { headers: accountHeaders, redirect: 'error' });
  expect(indexResponse.status).toBe(200);
  const index = await indexResponse.json() as { controls: { account: { profile: string; pod: string; bindings: string } } };
  expect(Boolean(index.controls.account.profile && index.controls.account.pod && index.controls.account.bindings)).toBe(true);
  const profileResponse = await fetch(cloudControl(index.controls.account.profile, deployment.issuer), {
    method: 'POST', headers: { ...accountHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ podName: deployment.account.username }), redirect: 'error',
  });
  evidence.cloudProfilePrepareStatus = profileResponse.status;
  await preserveFailedResponse(profileResponse, 'cloud-profile-prepare', diagnosticsDir, evidence);
  expect(profileResponse.ok).toBe(true);
  const profile = await profileResponse.json() as { webId: string };
  const webId = profile.webId;
  expect(typeof webId).toBe('string');
  const identity = new URL(webId);
  expect(identity.origin).toBe(new URL(deployment.issuer).origin);
  expect(identity.pathname.startsWith(new URL(deployment.issuer).pathname)).toBe(true);
  expect(identity.origin).not.toBe(new URL(deployment.canonical).origin);
  const preparedCard = await readCloudCard(webId);
  expect(preparedCard.storage).toEqual([]);
  expect(preparedCard.pimStorage).toEqual([]);
  expect(preparedCard.issuers).toEqual([deployment.issuer]);
  expect(preparedCard.primaryTopics).toEqual([webId]);
  evidence.cloudPreparedCardAnonymousStatus = preparedCard.status;

  const localResponse = await fetch(new URL('/provision/pods', deployment.baseUrl), {
    method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${deployment.serviceToken}` },
    body: JSON.stringify({ podName: deployment.account.username, webId }), redirect: 'error',
  });
  evidence.privateLocalProvisionStatus = localResponse.status;
  await preserveFailedResponse(localResponse, 'private-local-provision', diagnosticsDir, evidence);
  expect(localResponse.status).toBe(201);
  const prepared = await localResponse.json() as { podUrl: string; webId: string; provisionReceipt: string };
  expect(prepared.podUrl).toBe(podUrl);
  expect(prepared.webId).toBe(webId);
  const receipt = verifyProvisionReceipt(prepared.provisionReceipt, { secret: deriveProvisionReceiptSecret(deployment.serviceToken) });
  expect(receipt.valid).toBe(true);
  if (!receipt.valid) throw new Error('Actual Local provisioning receipt signature did not verify');
  expect(receipt.payload.podName).toBe(deployment.account.username);
  expect(receipt.payload.podUrl).toBe(podUrl);
  expect(receipt.payload.webId).toBe(webId);
  expect(Boolean(receipt.payload.podId)).toBe(true);
  assertLocalCloudOwner(deployment, podUrl, webId, receipt.payload.podId!, diagnosticsDir, 'prepared');
  evidence.localOwnerCloudIdentity = true;
  evidence.localHasNoAuthoritativeProfile = true;
  evidence.signedReceiptBindsCloudIdentityAndLocalGeneration = true;

  const retry = await fetch(new URL('/provision/pods', deployment.baseUrl), {
    method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${deployment.serviceToken}` },
    body: JSON.stringify({ podName: deployment.account.username, webId }), redirect: 'error',
  });
  evidence.sameOwnerRetryStatus = retry.status;
  expect(retry.status).toBe(200);
  const retried = await retry.json() as { webId: string; podUrl: string; provisionReceipt: string };
  expect(retried.webId).toBe(webId);
  expect(retried.podUrl).toBe(podUrl);
  const retriedReceipt = verifyProvisionReceipt(retried.provisionReceipt, { secret: deriveProvisionReceiptSecret(deployment.serviceToken) });
  expect(retriedReceipt.valid).toBe(true);
  if (!retriedReceipt.valid) throw new Error('Actual same-owner retry receipt did not verify');
  expect(retriedReceipt.payload.webId).toBe(webId);
  expect(retriedReceipt.payload.podUrl).toBe(podUrl);
  expect(retriedReceipt.payload.podName).toBe(deployment.account.username);
  // Retry credentials must not gain deletion authority over an existing Pod.
  // Its original generation is checked against the actual SQLite records below.
  expect(retriedReceipt.payload.podId).toBeUndefined();
  const wrongOwnerRetry = await fetch(new URL('/provision/pods', deployment.baseUrl), {
    method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${deployment.serviceToken}` },
    body: JSON.stringify({ podName: deployment.account.username, webId: new URL('other/profile/card#me', deployment.issuer).href }), redirect: 'error',
  });
  evidence.differentOwnerRetryStatus = wrongOwnerRetry.status;
  expect(wrongOwnerRetry.status).toBe(409);
  const missingOwnerRetry = await fetch(new URL('/provision/pods', deployment.baseUrl), {
    method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${deployment.serviceToken}` },
    body: JSON.stringify({ podName: deployment.account.username }), redirect: 'error',
  });
  evidence.missingOwnerRetryStatus = missingOwnerRetry.status;
  expect(missingOwnerRetry.status).toBe(409);
  assertLocalCloudOwner(deployment, podUrl, webId, receipt.payload.podId!, diagnosticsDir, 'retried');
  evidence.sameOwnerRetryRetainsGenerationWithoutDeletionAuthority = true;

  const finalizeResponse = await fetch(cloudControl(index.controls.account.pod, deployment.issuer), {
    method: 'POST', headers: { ...accountHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: deployment.account.username, settings: {
      webId, provisionCode, provisionReceipt: prepared.provisionReceipt,
    } }), redirect: 'error',
  });
  evidence.cloudFinalizeStatus = finalizeResponse.status;
  await preserveFailedResponse(finalizeResponse, 'cloud-finalize', diagnosticsDir, evidence);
  expect(finalizeResponse.ok).toBe(true);
  const finalized = await finalizeResponse.json() as { pod: string; webId: string };
  expect(finalized).toMatchObject({ pod: podUrl, webId });
  const finalCard = await readCloudCard(webId);
  expect(finalCard.storage).toEqual([podUrl]);
  expect(finalCard.pimStorage).toEqual([podUrl]);
  expect(finalCard.issuers).toEqual([deployment.issuer]);
  expect(finalCard.primaryTopics).toEqual([webId]);
  evidence.cloudCardAnonymousStatus = finalCard.status;
  evidence.cloudCardExactIssuerAndLocalStorage = true;
  const inventoryResponse = await fetch(cloudControl(index.controls.account.pod, deployment.issuer), { headers: accountHeaders, redirect: 'error' });
  expect(inventoryResponse.status).toBe(200);
  const inventory = await inventoryResponse.json() as { pods: Record<string, string> };
  expect(Object.keys(inventory.pods)).toEqual([podUrl]);
  const bindingsResponse = await fetch(cloudControl(index.controls.account.bindings, deployment.issuer), { headers: accountHeaders, redirect: 'error' });
  expect(bindingsResponse.status).toBe(200);
  const bindings = await bindingsResponse.json() as { bindings: Array<{ webId: string; storageUrl: string }> };
  expect(bindings.bindings).toEqual([{ webId, storageUrl: podUrl }]);
  evidence.cloudAccountHasOnlyLocalStoragePod = true;
  evidence.provisioningTransport = 'actual-cloud-account-and-private-local-node-api';
  return webId;
}

/** Failure bodies are private diagnostics, never attached to the safe report. */
async function preserveFailedResponse(
  response: Response, stage: string, diagnosticsDir: string, evidence: Record<string, unknown>,
): Promise<void> {
  if (response.ok) return;
  await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
  const filename = `private-response-${stage}.json`;
  await writeFile(path.join(diagnosticsDir, filename), JSON.stringify({
    stage, status: response.status, contentType: response.headers.get('content-type'), body: await response.clone().text(),
  }), { mode: 0o600 });
  evidence.privateFailureResponse = { stage, status: response.status, filename };
}

function cloudControl(value: string, issuer: string): string {
  const url = new URL(value, issuer);
  if (url.origin !== new URL(issuer).origin) throw new Error('Cloud Account control escaped the actual Cloud issuer');
  return url.href;
}

async function readCloudCard(webId: string) {
  const cardUrl = new URL(webId);
  cardUrl.hash = '';
  const response = await fetch(cardUrl, { credentials: 'omit', redirect: 'error', headers: { Accept: 'text/turtle' } });
  expect(response.status).toBe(200);
  const quads = new Parser({ baseIRI: cardUrl.href }).parse(await response.text());
  const objects = (predicate: string, subject = webId) => quads
    .filter(entry => entry.subject.value === subject && entry.predicate.value === predicate).map(entry => entry.object.value);
  return { status: response.status,
    storage: objects('http://www.w3.org/ns/solid/terms#storage'),
    pimStorage: objects('http://www.w3.org/ns/pim/space#storage'),
    issuers: objects('http://www.w3.org/ns/solid/terms#oidcIssuer'),
    primaryTopics: objects('http://xmlns.com/foaf/0.1/primaryTopic', cardUrl.href),
  };
}

function assertLocalCloudOwner(
  deployment: Manifest, podUrl: string, webId: string, podId: string, diagnosticsDir: string, stage: 'prepared' | 'retried',
): void {
  // Playwright's Node loader cannot load node:sqlite through createRequire.
  // Use the same verified Bun runtime as the actual Xpod stack, without changing
  // the product driver or sending credentials through argv or stdout.
  const script = `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { getSqliteRuntime } from './src/storage/SqliteRuntime';
    import { rowToQuad } from './src/storage/quint/serialization';
    const input = await new Response(Bun.stdin.stream()).json();
    const runtime = getSqliteRuntime();
    const quadsDb = runtime.openDatabase(path.join(input.runtimeRoot, 'quadstore.sqlite'), { readonly: true });
    const identityDb = runtime.openDatabase(path.join(input.runtimeRoot, 'identity.sqlite'), { readonly: true });
    try {
      const quads = quadsDb.prepare('SELECT graph, subject, predicate, object FROM quints').all().map(rowToQuad);
      const agents = quads.filter(entry => entry.graph.value === input.podUrl + '.acr' &&
        entry.predicate.value === 'http://www.w3.org/ns/solid/acp#agent' &&
        entry.object.value !== 'http://www.w3.org/ns/solid/acp#PublicAgent').map(entry => entry.object.value);
      const profileGraphs = quads.filter(entry => entry.graph.value.includes(input.podUrl + 'profile/')).map(entry => entry.graph.value);
      const index = identityDb.prepare('SELECT value FROM internal_kv WHERE key = ?').get('accounts/index/pod/' + input.podId);
      const accountIds = index ? JSON.parse(index.value) : [];
      const accountRow = accountIds.length === 1 ? identityDb.prepare('SELECT value FROM internal_kv WHERE key = ?')
        .get('accounts/data/' + accountIds[0]) : undefined;
      const account = accountRow ? JSON.parse(accountRow.value) : undefined;
      const pod = account?.['**pod**']?.[input.podId];
      const owners = Object.values(pod?.['**owner**'] ?? {}).map(owner => owner.webId);
      const summary = {
        rootAuthorizationHasExactCloudOwner: agents.length === 1 && agents[0] === input.webId,
        noLocalProfileGraphs: profileGraphs.length === 0,
        noLocalProfileDirectory: !existsSync(path.join(input.runtimeRoot, 'data', input.podName, 'profile')),
        generationIndexedToSingleAccount: accountIds.length === 1,
        generationHasExactStorage: pod?.baseUrl === input.podUrl,
        generationHasExactCloudOwner: owners.length === 1 && owners[0] === input.webId,
      };
      mkdirSync(input.diagnosticsDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(input.diagnosticsDir, 'private-local-owner-' + input.stage + '.json'), JSON.stringify({
        expected: { podUrl: input.podUrl, webId: input.webId, podId: input.podId }, agents, profileGraphs, accountIds, pod, summary,
      }), { mode: 0o600 });
      process.stdout.write(JSON.stringify(summary));
    } finally { quadsDb.close(); identityDb.close(); }
  `;
  const result = spawnSync(deployment.runnerExecPath, ['--no-env-file', '--eval', script], {
    cwd: deployment.runnerCwd, input: JSON.stringify({ runtimeRoot: deployment.localRuntimeRoot,
      podName: deployment.account.username, podUrl, webId, podId, diagnosticsDir, stage }),
    encoding: 'utf8', timeout: 15_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    rootAuthorizationHasExactCloudOwner: true,
    noLocalProfileGraphs: true,
    noLocalProfileDirectory: true,
    generationIndexedToSingleAccount: true,
    generationHasExactStorage: true,
    generationHasExactCloudOwner: true,
  });
}

function safeNativePath(pathname: string): string {
  return normalizeAccountPath(pathname)
    .replace(/^\/\.oidc\/auth\/[^/]+/u, '/.oidc/auth/:interaction')
    .replace(/\/account\/[\da-f-]{36}(?=\/)/gu, '/account/:account')
    .replace(/^\/[^/]+\/profile\/cloud-arbitrary-[\da-f-]{36}\.txt$/u, '/:fixture/profile/:arbitrary-upload.txt');
}

function nativeAuthenticationCounts(requests: Array<{ path: string; method: string; status?: number; interactionOrdinal?: number }>) {
  const completed = requests.filter(request => typeof request.status === 'number');
  return {
    passwordPostCount: completed.filter(request => request.method === 'POST' && request.path.endsWith('/login/password/')).length,
    consentPostCount: completed.filter(request => request.method === 'POST' && request.path.endsWith('/oidc/consent/')).length,
    pickWebIdPostCount: completed.filter(request => request.method === 'POST' && request.path.endsWith('/oidc/pick-webid/')).length,
    authorizationStartCount: completed.filter(request => request.method === 'GET' && /^\/\.oidc\/auth\/?$/u.test(request.path)).length,
    authorizationContinuationCount: completed.filter(request => request.method === 'GET' && request.path === '/.oidc/auth/:interaction').length,
    callbackCount: completed.filter(request => request.method === 'GET' && request.path === '/auth/callback').length,
    distinctInteractionCount: new Set(completed.map(request => request.interactionOrdinal).filter(value => value !== undefined)).size,
  };
}

/** Private DOM and masked window captures; no request headers or storage snapshots. */
async function preserveNativeWindows(app: ElectronApplication, diagnosticsDir: string, evidence: Record<string, unknown>): Promise<void> {
  await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
  const windows: Array<Record<string, unknown>> = [];
  for (const [index, page] of app.windows().filter(page => !page.isClosed()).entries()) {
    try {
      const url = new URL(page.url());
      const runtime = await readBrowserXpodRuntime(page).catch(() => undefined);
      const dom = await page.evaluate(() => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script').forEach(element => element.remove());
        clone.querySelectorAll('input, textarea').forEach(element => {
          element.removeAttribute('value');
          if (element.tagName === 'TEXTAREA') element.textContent = '';
        });
        clone.querySelectorAll('[href], [src], [action]').forEach(element => {
          for (const attribute of ['href', 'src', 'action']) {
            const value = element.getAttribute(attribute);
            if (!value) continue;
            try {
              const target = new URL(value, window.location.href);
              element.setAttribute(attribute, target.origin + target.pathname
                .replace(/^\/\.account\/interaction\/[^/]+/u, '/.account')
                .replace(/^\/\.oidc\/auth\/[^/]+/u, '/.oidc/auth/:interaction')
                .replace(/\/account\/[\da-f-]{36}(?=\/)/gu, '/account/:account'));
            } catch { element.removeAttribute(attribute); }
          }
        });
        return { title: document.title, html: clone.outerHTML };
      });
      const screenshot = `private-native-window-${index}.png`;
      await page.screenshot({ path: path.join(diagnosticsDir, screenshot),
        mask: [page.locator('input, textarea'), page.locator('[data-testid="xpod-user-card-trigger"]')] });
      await chmod(path.join(diagnosticsDir, screenshot), 0o600);
      windows.push({ origin: url.origin, path: safeNativePath(url.pathname), runtime, dom, screenshot });
    } catch { windows.push({ captureUnavailable: true }); }
  }
  await writeFile(path.join(diagnosticsDir, 'private-native-windows.json'), JSON.stringify(windows), { mode: 0o600 });
  evidence.nativeWindowPaths = windows.filter(window => typeof window.path === 'string').map(window => window.path);
  evidence.privateNativeWindowCount = windows.length;
}

async function nativeLogin(app: ElectronApplication, deployment: Manifest, evidence: Record<string, unknown>): Promise<Page> {
  const deadline = Date.now() + 110_000;
  let submitted = false;
  const approved = new Set<string>();
  while (Date.now() < deadline) {
    const windows = app.windows().filter(p => !p.isClosed());
    for (const page of windows) {
      const url = new URL(page.url());
      const pathname = url.pathname;
      if (url.origin === new URL(deployment.baseUrl).origin && /^\/(?:pod|ai-config)(?:\/|$)/u.test(pathname)
        && await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible().catch(() => false)) {
        evidence.nativeLandingPath = pathname;
        evidence.nativeUiAllowClickCount = approved.size;
        evidence.nativeUiPasswordSubmitted = submitted;
        return page;
      }
      const email = page.getByLabel('邮箱', { exact: true });
      const password = page.locator('input[type="password"]').first();
      if (!submitted && await email.isVisible().catch(() => false) && await password.isVisible().catch(() => false)) {
        await email.fill(deployment.account.email);
        await password.fill(deployment.account.password);
        await password.press('Enter');
        submitted = true;
      }
      const allow = page.getByRole('button', { name: '允许', exact: true });
      if (!approved.has(pathname) && normalizeAccountPath(pathname) === '/.account/oidc/consent/' && await allow.isVisible().catch(() => false)) {
        approved.add(pathname);
        await allow.click();
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  evidence.nativeUiAllowClickCount = approved.size;
  evidence.nativeUiPasswordSubmitted = submitted;
  throw new Error(`Native no-public-route login did not resolve: submitted=${submitted}; consentCount=${approved.size}`);
}

async function accountCredential(page: Page, issuer: string, webId: string, create = true) {
  const index = await nativeCloudFetch(page, issuer, webId, new URL('/.account/', issuer).href);
  const controls = JSON.parse(index.body) as { controls?: { account?: { clientCredentials?: string } } };
  const control = controls.controls?.account?.clientCredentials;
  if (index.status !== 200 || !control) return { indexStatus: index.status, controlPresent: Boolean(control), createStatus: 0, id: '', secret: '' };
  if (!create) return { indexStatus: index.status, controlPresent: true, createStatus: 0, id: '', secret: '' };
  const created = await nativeCloudFetch(page, issuer, webId, cloudControl(control, issuer), {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'no-public-route-acceptance', webId }),
  });
  const credential = JSON.parse(created.body) as { id?: string; secret?: string };
  return { indexStatus: index.status, controlPresent: true, createStatus: created.status, id: credential.id ?? '', secret: credential.secret ?? '' };
}

async function assertNativeCloudProfileScope(
  page: Page, issuer: string, webId: string, requests: NativeRequestEvidence[], evidence: Record<string, unknown>,
): Promise<void> {
  const card = new URL(webId);
  card.hash = '';
  const authorizationUrl = `${card.href}.acr`;
  const authorization = await nativeCloudFetch(page, issuer, webId, authorizationUrl, { headers: { Accept: 'text/turtle' } });
  expect(authorization.status).toBe(200);
  const quads = new Parser({ baseIRI: authorizationUrl }).parse(authorization.body);
  expect(quads.filter(entry => entry.predicate.value === 'http://www.w3.org/ns/solid/acp#resource')
    .map(entry => entry.object.value)).toEqual([card.href]);
  expect(quads.some(entry => entry.predicate.value === 'http://www.w3.org/ns/solid/acp#memberAccessControl')).toBe(false);
  expect(quads.filter(entry => entry.predicate.value === 'http://www.w3.org/ns/solid/acp#agent' &&
    entry.object.value !== 'http://www.w3.org/ns/solid/acp#PublicAgent').map(entry => entry.object.value)).toEqual([webId]);
  const namespace = await nativeCloudFetch(page, issuer, webId, new URL('../', card).href, { headers: { Accept: 'text/turtle' } });
  expect(namespace.status).toBe(403);

  const upload = new URL(`cloud-arbitrary-${randomUUID()}.txt`, card);
  const ownerNamespace = new URL('./', card);
  expect(upload.origin).toBe(new URL(issuer).origin);
  expect(upload.pathname.startsWith(ownerNamespace.pathname)).toBe(true);
  expect(upload.href === card.href || upload.href === authorizationUrl).toBe(false);
  const marker = `fixture-owned-cloud-upload-${randomUUID()}`;
  const uploadEvidence: Record<string, unknown> = { path: safeNativePath(upload.pathname), method: 'PUT',
    createOnly: true, created: false, cleanupAttempted: false };
  evidence.cloudArbitraryPut = uploadEvidence;
  let created = false;
  try {
    // This unique sibling belongs to this fresh fixture, never its card or ACR.
    // If-None-Match forbids overwriting an existing file even after a collision.
    const response = await nativeCloudFetch(page, issuer, webId, upload.href, { method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'If-None-Match': '*' }, body: marker });
    created = response.status >= 200 && response.status < 300;
    Object.assign(uploadEvidence, { status: response.status, created });
    await expect.poll(() => requests.some(request => request.origin === upload.origin
      && request.path === safeNativePath(upload.pathname) && request.method === 'PUT' && request.status === response.status)).toBe(true);
    const wire = requests.find(request => request.origin === upload.origin && request.path === safeNativePath(upload.pathname)
      && request.method === 'PUT' && request.status === response.status)!;
    const claims = wire.claims;
    Object.assign(uploadEvidence, { noCookie: !wire.cookie, dpop: wire.dpop, authorizationScheme: wire.authorizationScheme,
      proofHasAth: Boolean(claims && 'proofHasAth' in claims && claims.proofHasAth),
      proofAthMatchesAccessToken: Boolean(claims && 'proofAthMatchesAccessToken' in claims && claims.proofAthMatchesAccessToken),
      exactCloudIdentity: Boolean(claims && 'webIdMatchesCloudIdentity' in claims && claims.webIdMatchesCloudIdentity),
      exactCloudIssuer: Boolean(claims && 'issuerMatchesCloud' in claims && claims.issuerMatchesCloud) });
    expect(uploadEvidence.noCookie).toBe(true);
    expect(uploadEvidence.dpop).toBe(true);
    expect(uploadEvidence.authorizationScheme).toBe('DPoP');
    expect(uploadEvidence.proofHasAth).toBe(true);
    expect(uploadEvidence.proofAthMatchesAccessToken).toBe(true);
    expect(uploadEvidence.exactCloudIdentity).toBe(true);
    expect(uploadEvidence.exactCloudIssuer).toBe(true);
    expect(response.status).toBe(403);
  } finally {
    if (created) {
      uploadEvidence.cleanupAttempted = true;
      // Reclaim only our exact create-only content and its matching version.
      const owned = await nativeCloudFetch(page, issuer, webId, upload.href, { headers: { Accept: 'text/plain' } });
      const confirmed = owned.status === 200 && owned.body === marker && Boolean(owned.etag);
      Object.assign(uploadEvidence, { cleanupOwnershipConfirmed: confirmed, cleanupReadStatus: owned.status });
      if (!confirmed) throw new Error('Unexpected Cloud upload cannot be safely reclaimed: ownership or ETag missing');
      const deleted = await nativeCloudFetch(page, issuer, webId, upload.href, { method: 'DELETE', headers: { 'If-Match': owned.etag! } });
      uploadEvidence.cleanupStatus = deleted.status;
      expect([200, 204, 205]).toContain(deleted.status);
    }
  }
}

/** Current mounted native session only; no new Session, fetch replacement or cookie fallback. */
async function nativeCloudFetch(
  page: Page, issuer: string, webId: string, url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; etag: string | null }> {
  cloudControl(url, issuer);
  return page.evaluate(async ({ issuer, webId, url, init }) => {
    type Fiber = { child?: Fiber; sibling?: Fiber; stateNode?: { current?: Fiber };
      memoizedProps?: { value?: { state?: unknown; session?: { getSnapshot(): { status: string; webId?: string } }; fetch?: typeof fetch } } };
    const root = document.getElementById('root')!;
    const key = Object.keys(root).find(key => key.startsWith('__reactContainer$'))!;
    const queue = [(root as unknown as Record<string, Fiber>)[key].stateNode?.current];
    while (queue.length) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const host = fiber.memoizedProps?.value;
      if (host?.session?.getSnapshot && host.fetch && host.state) {
        const snapshot = host.session.getSnapshot();
        if (snapshot.status !== 'authenticated' || snapshot.webId !== webId) throw new Error('Native host identity changed');
        const target = new URL(url);
        if (target.origin !== new URL(issuer).origin || target.username || target.password) throw new Error('Native request escaped the Cloud issuer');
        const response = await host.fetch(target.href, { headers: { Accept: 'application/json' }, ...init,
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
        return { status: response.status, body: await response.text(), etag: response.headers.get('etag') };
      }
      queue.push(fiber.child, fiber.sibling);
    }
    throw new Error('Missing real mounted native host session');
  }, { issuer, webId, url, init });
}

/** Never retain encoded tokens, proofs, subject values, jti, cookies or credentials. */
function safeClaims(headers: Record<string, string>, expectedWebId: string, expectedIssuer: string) {
  if (!headers.authorization?.startsWith('DPoP ')) return undefined;
  try {
    const token = headers.authorization.slice(5).split('.');
    const head = JSON.parse(Buffer.from(token[0], 'base64url').toString()) as { alg?: string; typ?: string; kid?: unknown };
    const body = JSON.parse(Buffer.from(token[1], 'base64url').toString()) as { iss?: string; aud?: unknown; sub?: string; webid?: string; client_id?: string; iat?: number; exp?: number };
    const proof = JSON.parse(Buffer.from(headers.dpop.split('.')[1], 'base64url').toString()) as { htu?: string; htm?: string; ath?: string };
    return { alg: head.alg, typ: head.typ, hasKid: Boolean(head.kid), issuer: body.iss, audience: body.aud, clientId: body.client_id,
      hasWebId: Boolean(body.webid), webIdMatchesCloudIdentity: body.webid === expectedWebId, issuerMatchesCloud: body.iss === expectedIssuer, subjectMatchesWebId: body.sub === body.webid, issuedAt: body.iat, expiresAt: body.exp,
      proofTarget: proof.htu ? new URL(proof.htu).origin + safeNativePath(new URL(proof.htu).pathname) : undefined,
      proofMethod: proof.htm, proofHasAth: Boolean(proof.ath), proofFingerprint: createHash('sha256').update(headers.dpop).digest('hex'),
      proofAthMatchesAccessToken: proof.ath === createHash('sha256').update(headers.authorization.slice(5)).digest('base64url'),
      proofHasOwnAth: Object.prototype.hasOwnProperty.call(proof, 'ath'), proofAthType: typeof proof.ath, proofAthNull: proof.ath === null, proofAthEmpty: proof.ath === '' };
  } catch { return { malformed: true }; }
}

/** Passive CDP observation; never replaces fetch, a Session, or the DPoP signer. */
async function captureAccountInitiators(page: Page, issuer: string, output: Array<Record<string, unknown>>): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url);
      if (url.origin !== new URL(issuer).origin || !['/.account/', '/.oidc/auth'].includes(url.pathname) || output.length >= 20) return;
      const frames = event.initiator.stack?.callFrames ?? [];
      output.push({ origin: url.origin, path: safeNativePath(url.pathname), method: event.request.method, initiatorType: event.initiator.type,
        frames: frames.slice(0, 15).map(frame => {
          let source = '<inline>';
          try { const script = new URL(frame.url); source = script.origin + safeNativePath(script.pathname); } catch { /* inline */ }
          return { source, line: frame.lineNumber + 1, column: frame.columnNumber + 1, function: frame.functionName };
        }),
      });
    });
  } catch { output.push({ observationUnavailable: true }); }
}
