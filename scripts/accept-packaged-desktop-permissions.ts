import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { getSolidDataset, getThing, getPodUrlAllFrom } from '@inrupt/solid-client';
import { AI_CONNECTIONS_SERVICE_RESOURCE_IDS } from '@undefineds.co/ai-connections/service-access-resources';
import { discoverSolidLocalRoute } from '@undefineds.co/solid-sdk/local-route-fetch';
import { createCloudAccountPassword, prepareManagedLocalAcceptancePods, parseKeyFile } from './accept-live-gateway-login-chat';
import { launchOwnedPackagedDesktop, type OwnedPackagedDesktop } from './helpers/packaged-desktop-fixture';
import { acceptMountedPodPermissions, observeOwnedPodTraffic, type MountedPodPermissionPhase } from './helpers/packaged-desktop-permissions';
import { createConfirmedMountedProvider, createMountedKeyInUi, acceptMountedFirstChat, acceptHeldPodInvocation } from './helpers/packaged-desktop-operations';
import { verifyPackagedSourceCheckout } from './helpers/packaged-desktop-source';
import { acceptLiveTaskApproval, type LiveTaskEvidence } from './helpers/live-task-approval';
import { completeOidcLogin, consentBindingProven, type BrowserOidcTrace } from '../tests/helpers/browserSolidOidc';
import { readBrowserXpodRuntime } from '../tests/helpers/browserXpodRuntime';

const { verifyEvidence } = createRequire(import.meta.url)('./desktop-permission-acceptance.cjs') as {
  verifyEvidence(record: unknown, expected: unknown): { valid: boolean; errors: unknown[] };
};

type Stage = 'input' | 'launch' | 'provision' | 'pod-a' | 'operations-a' | 'switch' | 'pod-b' | 'operations-b' | 'cleanup' | 'verify';
export interface PackagedPermissionOptions {
  archive: string; version: string; sourceSha: string; issuer: string; keyFile: string;
  privateDirectory: string; evidenceFile: string;
}

/** HTTP document location loses its fragment; subject identity never does.
 * The ecosystem profile helper owns pim:storage semantics and RDF resolution.
 */
export async function verifyPublicCloudCard(webId: string, storageUrls: string[]): Promise<void> {
  const document = new URL(webId);
  document.hash = '';
  const profile = await getSolidDataset(document.href, { fetch: (input, init) => fetch(input, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(20_000),
  }) });
  if (!getThing(profile, webId)) throw new Error('Public Cloud card has no exact WebID Thing');
  const advertised = getPodUrlAllFrom({ webIdProfile: profile, altProfileAll: [] }, webId);
  if (storageUrls.some(url => !advertised.includes(url))) throw new Error('Public Cloud card is missing an authoritative storage binding');
}

export function assertOwnedTaskRows(body: unknown, required: string[], expectEmpty = false): void {
  const tasks = (body as { tasks?: Array<{ id?: unknown }> } | null)?.tasks;
  if (!Array.isArray(tasks) || tasks.some(task => typeof task.id !== 'string')
    || required.some(id => !tasks.some(task => task.id === id)) || (expectEmpty && tasks.length !== 0)) {
    throw new Error('Independent task row isolation readback failed');
  }
}

/** Only stage identifiers go to stdout; all failure/callback/account state stays private. */
async function privateJson(directory: string, name: string, record: unknown): Promise<void> {
  await writeFile(path.join(directory, name), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

const SAFE_FAILURE_FILE = 'failure-safe.json';

/** CI-visible failure detail: the stage and our own error text with tokens,
 * credentials, query strings and callback URLs removed, so a failed run is
 * diagnosable from the log alone without publishing private evidence. */
export function safeFailureDetail(raw: string): string {
  return raw
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/gu, '<redacted-jwt>')
    .replace(/sk-[A-Za-z0-9._-]+/gu, 'sk-<redacted>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, '<redacted-email>')
    .replace(/https?:\/\/[^\s"']+/gu, (value) => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '<redacted-url>'; }
    })
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

function privateError(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
    ...(error instanceof AggregateError ? { errors: error.errors.map(privateError) } : {}) } : { name: 'unknown', message: String(error) };
}

/** Adapt actual renderer responses for the existing Node ORM/task acceptance helper.
 * Browser SDK still creates authentication and transport; no headers are copied from a different request.
 */
function mountedPodFetch(phase: MountedPodPermissionPhase, podUrl: string): typeof fetch {
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
    if (Object.keys(headers).some(key => ['authorization', 'dpop', 'cookie'].includes(key))) throw new Error('Unexpected second Pod credential source');
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request && method !== 'GET' && method !== 'HEAD' ? await input.text() : undefined;
    if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Unsupported acceptance Pod body');
    const result = await phase.handle.evaluate(async ({ host }, input) => {
      const target = new URL(input.url), pod = new URL(input.podUrl);
      if (target.origin !== pod.origin || !target.pathname.startsWith(pod.pathname) || target.username || target.password
        || host.solid.pod?.status !== 'ready' || host.solid.pod.current.podUrl !== input.podUrl) throw new Error('Task acceptance escaped the retained Pod');
      const response = await host.solid.session.fetch(input.url, { method: input.method, headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() };
    }, { url, podUrl, method, headers, body });
    const response = new Response(method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status, headers: result.headers });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }) as typeof fetch;
}

function rendererOwnerFetch(page: Page, gateway: string, podUrl: string, key: string): typeof fetch {
  return (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('Unsupported acceptance API body');
    const result = await page.evaluate(async input => {
      const target = new URL(input.url), gateway = new URL(input.gateway);
      if (target.origin !== window.location.origin || target.origin !== gateway.origin || target.username || target.password || target.hash
        || !(target.pathname === '/api/tasks' || target.pathname.startsWith('/api/tasks/')
          || target.pathname === '/api/ai/task-credentials' || target.pathname.startsWith('/api/ai/task-credentials/'))) {
        throw new Error('Task acceptance API is outside the owned Gateway');
      }
      const response = await fetch(target.href, { method: input.method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${input.key}`, 'X-Xpod-Pod-Url': input.podUrl, 'Content-Type': 'application/json' },
        ...(input.body === undefined ? {} : { body: input.body }) });
      return { status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers.entries()) };
    }, { url, gateway, podUrl, key, method, body: init?.body as string | undefined });
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
  }) as typeof fetch;
}

export async function acceptPackagedDesktopPermissions(options: PackagedPermissionOptions): Promise<void> {
  let stage: Stage = 'input';
  let failedStage: Stage | undefined;
  const failures: unknown[] = [];
  let fixture: OwnedPackagedDesktop | undefined;
  let phase: MountedPodPermissionPhase | undefined;
  let provider: Awaited<ReturnType<typeof createConfirmedMountedProvider>> | undefined;
  let key: Awaited<ReturnType<typeof createMountedKeyInUi>> | undefined;
  let fixtureCleanup: Awaited<ReturnType<OwnedPackagedDesktop['close']>> | undefined;
  let record: Record<string, unknown> | undefined;
  let taskSnapshot: LiveTaskEvidence | undefined;
  const advance = (next: Stage): void => { stage = next; console.log(JSON.stringify({ stage })); };
  await mkdir(options.privateDirectory, { recursive: true, mode: 0o700 });
  try {
    if (!/^[a-f0-9]{40}$/u.test(options.sourceSha)) throw new Error('Invalid source SHA');
    await verifyPackagedSourceCheckout({ cwd: process.cwd(), sourceSha: options.sourceSha, version: options.version });
    if ((await stat(options.keyFile)).mode & 0o077) throw new Error('Provider key file is not private');
    const configuration = parseKeyFile(await readFile(options.keyFile, 'utf8'));
    if (!configuration?.apiKey || !configuration.expected.length) throw new Error('Missing declared provider acceptance input');
    advance('launch');
    fixture = await launchOwnedPackagedDesktop({ archive: options.archive, version: options.version,
      issuer: options.issuer, evidenceDirectory: options.privateDirectory });
    const { page, gateway } = fixture;
    advance('provision');
    const status = await (await fetch(new URL('provision/status', gateway), { signal: AbortSignal.timeout(35_000) })).json() as {
      registered?: boolean; managed?: boolean; provisionCode?: string; publicRoute?: { configured?: boolean; available?: boolean };
    };
    if (status.registered !== true || status.managed !== true || !status.provisionCode
      || status.publicRoute?.configured !== false || status.publicRoute.available !== false) throw new Error('Fresh packaged Local authority or no-public-route proof is missing');
    const route = await discoverSolidLocalRoute({ fetch, localBaseUrl: gateway, statusUrl: new URL('provision/status', gateway).href });
    if (!route || route.localBaseUrl !== gateway) throw new Error('Packaged runtime did not verify its own Local transport');
    const account = await createCloudAccountPassword(options.issuer, 'desktop-permission');
    await privateJson(options.privateDirectory, 'account-private.json', account);
    const unique = randomUUID().slice(0, 8);
    const bindings = await prepareManagedLocalAcceptancePods({ baseUrl: options.issuer, localBaseUrl: gateway,
      canonicalBaseUrl: route.canonicalBaseUrl, authorization: account.authorization, controls: account.controls,
      usernames: [`desktop-a-${unique}`, `desktop-b-${unique}`], provisionCode: status.provisionCode });
    await privateJson(options.privateDirectory, 'bindings-private.json', bindings);
    if (bindings.length !== 2 || bindings[0].webId !== bindings[1].webId || bindings[0].storageUrl === bindings[1].storageUrl
      || new URL(bindings[0].webId).origin !== new URL(options.issuer).origin) throw new Error('Managed identity/storage binding proof failed');
    await verifyPublicCloudCard(bindings[0].webId, bindings.map(binding => binding.storageUrl));
    const podEvidence = [];
    let firstInvocation: string | undefined;
    let originalRun: string | undefined;
    let originalTaskIds: string[] = [];
    let allCallbacks = true;
    const configurationHome = path.join(fixture.directory, 'profile', 'client-config-home');
    for (const [index, binding] of bindings.entries()) {
      advance(index === 0 ? 'pod-a' : 'pod-b');
      const trace: BrowserOidcTrace = await completeOidcLogin(page, { email: account.email, password: account.password,
        webId: binding.webId, podUrl: binding.storageUrl }, { baseUrl: gateway, startUrl: index === 0 ? new URL('ai-connections', gateway).href : undefined,
        requireCallbackEvidence: true, rememberAccount: true, rememberClient: true, timeoutMs: 90_000,
        ready: async page => {
          const runtime = await readBrowserXpodRuntime(page).catch(() => undefined);
          return runtime?.status === 'authenticated' && runtime.webId === binding.webId && runtime.podUrl === binding.storageUrl;
        } });
      await privateJson(options.privateDirectory, `oidc-${index}-private.json`, trace);
      // The product auto-consents one exact binding and renders no chooser, so
      // the exact binding is proven by the observed selection or by that
      // rendered auto-consent plus the authenticated runtime binding.
      const bindingProven = consentBindingProven(trace, binding,
        await readBrowserXpodRuntime(page).catch(() => undefined));
      allCallbacks &&= bindingProven;
      if (!bindingProven) throw new Error('Actual browser callback or exact Consent binding proof is missing');
      if (trace.rememberClientRequested !== true || trace.rememberClientObserved !== true || trace.consentRememberPosted !== true) {
        throw new Error('The remembered-grant bootstrap did not set and retain the explicit remember-client choice: '
          + `requested=${String(trace.rememberClientRequested)} observed=${String(trace.rememberClientObserved)} `
          + `posted=${String(trace.consentRememberPosted)}`);
      }
      phase = await acceptMountedPodPermissions(page, { webId: binding.webId, podUrl: binding.storageUrl });
      const descriptor = await phase.handle.evaluate(({ controller }) => controller.client!.getServiceAccess()) as { invocation?: { token?: string } };
      const invocation = descriptor.invocation?.token;
      if (!invocation) throw new Error('Authoritative current-Pod invocation is absent');
      if (index === 0) firstInvocation = invocation;
      advance(index === 0 ? 'operations-a' : 'operations-b');
      provider = await createConfirmedMountedProvider(phase, { provider: configuration.id,
        credential: { apiKey: configuration.apiKey, offeringId: configuration.offeringId,
          baseUrl: configuration.baseUrl, proxyUrl: process.env.XPOD_AI_PROXY_URL?.trim() || undefined,
          label: `desktop-${unique}-${index}` }, expectedModels: configuration.expected });
      key = await createMountedKeyInUi(page, phase, { name: `desktop-${unique}-${index}`, configurationHome, gateway,
        accountCredentialControl: account.controls.account?.clientCredentials ?? '' });
      const samePodReuse = await acceptHeldPodInvocation(page, { gateway, podUrl: binding.storageUrl, invocation, model: provider.model });
      const chat = await acceptMountedFirstChat(page, { gateway, podUrl: binding.storageUrl, key: key.key,
        model: provider.model, marker: `XPOD_${unique}_${index}` });
      await privateJson(options.privateDirectory, `operations-${index}-private.json`, {
        credentialId: provider.credentialId, model: provider.model, quotaObserved: provider.quotaObserved,
        keyId: key.id, accountActor: key.accountActor, samePodReuse, chat,
      });
      if (index === 0) {
        const podFetch = mountedPodFetch(phase, binding.storageUrl);
        const task = await acceptLiveTaskApproval({ gateway, podUrl: binding.storageUrl, webId: binding.webId,
          ownerInterfaceKey: key.key, ownerFetch: rendererOwnerFetch(page, gateway, binding.storageUrl, key.key),
          session: { info: { webId: binding.webId, isLoggedIn: true }, fetch: podFetch },
          onEvidence: evidence => { taskSnapshot = evidence; } });
        if (!task.ok || !task.cleanup.ok || task.cases.length !== 3) throw new Error('Actual packaged task approval/Stop cleanup failed');
        originalRun = task.cases[0].runId;
        originalTaskIds = task.cases.flatMap(row => row.taskId ? [row.taskId] : []);
        if (new Set(originalTaskIds).size !== 3) throw new Error('Actual first-Pod task IDs are incomplete');
        const rows = await rendererOwnerFetch(page, gateway, binding.storageUrl, key.key)(new URL('/api/tasks', gateway));
        if (rows.status !== 200) throw new Error('Cannot independently read first-Pod task rows');
        assertOwnedTaskRows(await rows.json(), originalTaskIds);
      } else {
        if (!firstInvocation || !originalRun) throw new Error('Missing actual first-Pod capability/Run');
        const rows = await rendererOwnerFetch(page, gateway, binding.storageUrl, key.key)(new URL('/api/tasks', gateway));
        if (rows.status !== 200 || originalTaskIds.length !== 3) throw new Error('Cannot independently read second-Pod task rows');
        assertOwnedTaskRows(await rows.json(), [], true);
        const writes = observeOwnedPodTraffic(page, binding.storageUrl);
        try {
          const foreign = await page.evaluate(async input => {
            const response = await fetch(new URL('/api/ai/gateway/keys', window.location.origin), {
              headers: { Authorization: `Bearer ${input.token}`, 'X-Xpod-Pod-Url': input.podUrl },
              redirect: 'error', signal: AbortSignal.timeout(20_000) });
            await response.arrayBuffer(); return response.status;
          }, { token: firstInvocation, podUrl: binding.storageUrl });
          const resumed = await rendererOwnerFetch(page, gateway, binding.storageUrl, key.key)(
            new URL(`/api/tasks/resume?id=${encodeURIComponent(originalRun)}`, gateway), { method: 'POST', body: '{}' });
          const resumeBody = await resumed.text();
          await privateJson(options.privateDirectory, 'cross-pod-private.json', { foreign, status: resumed.status, body: resumeBody });
          const traffic = writes.snapshot();
          if (foreign !== 403 || resumed.status !== 400 || traffic.writes !== 0 || !/not found|找不到|不存在/iu.test(resumeBody)) {
            throw new Error('Actual cross-Pod capability or old Run rejection failed');
          }
        } finally { writes.stop(); }
      }
      podEvidence.push({ ...phase.evidence, selectedInUi: true,
        management: { configuration: true, models: true, quota: true } });
      await key.remove(); key = undefined;
      await provider.remove(); provider = undefined;
      await phase.restore(); await phase.handle.dispose(); phase = undefined;
      if (index === 0) {
        advance('switch');
        await page.getByRole('button', { name: /打开 .* 的个人卡片/u }).click();
        await page.getByRole('button', { name: '切换账号', exact: true }).click();
      }
    }
    record = { schemaVersion: 1, kind: 'desktop-permission-acceptance', ok: true,
      sourceSha: options.sourceSha, version: options.version, archive: fixture.archive, runtime: fixture.runtime,
      identity: { cloudCard: true, sameWebId: true, independentStorage: true, noPublicRoute: true, browserCallback: allCallbacks },
      pods: podEvidence,
      operations: { accountActor: true, keyCreate: true, keyList: true, keyRevoke: true, collectionConfirmed: true,
        conflictCount: 0, chatStatus: 200, chatBodyMatches: true, chatDispatches: 1,
        samePodReuse: true, crossPodRejected: true, isolatedRows: true, oldRunRejected: true } };
  } catch (error) { failedStage = stage; failures.push(error); }
  finally {
    advance('cleanup');
    try { if (taskSnapshot) await privateJson(options.privateDirectory, 'tasks-private.json', taskSnapshot); }
    catch (error) { failures.push(error); }
    for (const cleanup of [async () => { if (key) await key.remove(); }, async () => { if (provider) await provider.remove(); },
      async () => { if (phase) await phase.restore(); }]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    try { if (phase) await phase.handle.dispose(); } catch (error) { failures.push(error); }
    try { if (fixture) fixtureCleanup = await fixture.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length || !record || !fixtureCleanup || !fixture) {
    const failed = failedStage ?? stage;
    await privateJson(options.privateDirectory, 'failure-private.json', { stage: failed, errors: failures.map(privateError) });
    // A failed run must stay diagnosable even when the workflow skips the
    // private upload: this record is redacted for CI logs and artifacts.
    await writeFile(path.join(options.privateDirectory, SAFE_FAILURE_FILE), JSON.stringify({ schemaVersion: 1,
      kind: 'desktop-permission-failure', sourceSha: options.sourceSha, version: options.version, stage: failed,
      errors: failures.map(error => error instanceof Error
        ? { name: error.name, message: safeFailureDetail(error.message) }
        : { name: 'unknown', message: safeFailureDetail(String(error)) }) }, null, 2) + '\n', { mode: 0o644 });
    throw new Error(`Packaged desktop permission acceptance failed at stage=${failed}; private evidence retained`);
  }
  advance('verify');
  record.cleanup = { ...fixtureCleanup, providerRemoved: true, keyRemoved: true, attributedGrantsRestored: true };
  record.completedAt = new Date().toISOString();
  const result = verifyEvidence(record, { sourceSha: options.sourceSha, version: options.version, archive: fixture.archive,
    runtimeBinarySha256: fixture.runtime.binarySha256, resourceIds: AI_CONNECTIONS_SERVICE_RESOURCE_IDS });
  if (!result.valid) {
    await privateJson(options.privateDirectory, 'verification-private.json', { result, record });
    throw new Error('Produced desktop evidence failed the strict contract');
  }
  await writeFile(options.evidenceFile, JSON.stringify(record, null, 2) + '\n');
}

async function main(argv: string[]): Promise<void> {
  const keys = ['--archive', '--version', '--source-sha', '--issuer', '--key-file', '--private-directory', '--evidence'];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!keys.includes(argv[index]) || !argv[index + 1] || values.has(argv[index])) throw new Error('Invalid packaged runner argument');
    values.set(argv[index], argv[index + 1]);
  }
  if (keys.some(key => !values.has(key))) throw new Error('Missing packaged runner argument');
  await acceptPackagedDesktopPermissions({ archive: values.get('--archive')!, version: values.get('--version')!,
    sourceSha: values.get('--source-sha')!, issuer: values.get('--issuer')!, keyFile: values.get('--key-file')!,
    privateDirectory: values.get('--private-directory')!, evidenceFile: values.get('--evidence')! });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(JSON.stringify({ runner: 'desktop-permission-acceptance', failed: true,
      name: error instanceof Error ? error.name : 'unknown',
      reason: safeFailureDetail(error instanceof Error ? error.message : String(error)) }));
    process.exitCode = 1;
  });
}
