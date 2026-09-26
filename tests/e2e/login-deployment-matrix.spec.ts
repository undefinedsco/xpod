import { armDelayedProviders, cleanupDelayedProviders, delayedProvidersState, releaseDelayedProviders } from '../helpers/browserDelayedProviders';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { completeOidcLogin } from '../helpers/browserSolidOidc';
import { completeOfflineProductLogout, verifyOfflinePodRecovery } from '../helpers/browserLoginNetwork';
import { fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

type Deployment = {
  mode: 'cloud' | 'managed-local' | 'standalone';
  runnerBunVersion?: string;
  baseUrl: string;
  issuer: string;
  account: { email: string; password: string; username: string };
};
const manifestPath = process.env.XPOD_E2E_LOGIN_MATRIX_MANIFEST;
const deployments = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Deployment[] : [];

// Browser product evidence, not a claim of three-mode Electron lifecycle
// coverage. The runner owns the disposable deployments and their accounts.
if (!manifestPath) test('deployment matrix requires its isolated runner', () => {
  test.skip(true, 'Run bun --no-env-file tests/helpers/runLoginDeploymentMatrix.ts');
});

for (const deployment of deployments) {
  test.describe(`${deployment.mode} real product login`, () => {
    test.describe.configure({ mode: 'serial', timeout: 240_000 });
    let accountControl: string | undefined;
    for (const [index, route] of ['/ai-connections', '/ai-config/model-assignments'].entries()) {
      test(`${route}: identity, private Pod, refresh, network recovery, Status Account and offline logout`, async ({ page, context }, testInfo) => {
        const origin = new URL(deployment.baseUrl).origin;
        const original = `${origin}${route}?login-matrix=${deployment.mode}`;
        const expectedPod = `${origin}/${deployment.account.username}/`;
        const expectedWebId = `${expectedPod}profile/card#me`;
        const tokenStatuses: number[] = [];
        const issuerOrigins = new Set<string>();
        let provisionScopeSeen = false;
        let callbackHasCode = false;
        let callbackHasState = false;
        page.on('framenavigated', frame => {
          if (frame !== page.mainFrame()) return;
          const url = new URL(frame.url());
          if (url.origin === origin && url.pathname === '/auth/callback') {
            callbackHasCode ||= url.searchParams.has('code');
            callbackHasState ||= url.searchParams.has('state');
          }
        });
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.searchParams.get('response_type') === 'code') {
            issuerOrigins.add(url.origin);
            provisionScopeSeen ||= url.searchParams.has('provisionCode');
          }
        });
        page.on('response', response => {
          if (response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/token')) tokenStatuses.push(response.status());
        });
        const discovery = await page.request.get(new URL('/.well-known/openid-configuration', deployment.issuer).href);
        expect(discovery.ok()).toBe(true);
        expect(new URL((await discovery.json()).issuer).origin).toBe(new URL(deployment.issuer).origin);
        if (deployment.mode === 'managed-local') {
          expect(origin).not.toBe(new URL(deployment.issuer).origin);
          const provision = await page.request.get(`${origin}/provision/status`);
          expect(await provision.json()).toMatchObject({ managed: true, registered: true, oidcIssuer: deployment.issuer });
        }

        if (index === 0) await registerFromProduct(page, deployment, original);
        const trace = await completeOidcLogin(page, { ...deployment.account, podUrl: expectedPod, webId: expectedWebId }, {
          baseUrl: origin,
          ...(index === 0 ? {} : { startUrl: original }),
          ready: productReady,
          requireCallbackEvidence: true,
          timeoutMs: 120_000,
        });
        expect(callbackHasCode && callbackHasState).toBe(true);
        expect(trace.callbackHasCode && trace.callbackHasState).toBe(true);
        expect(tokenStatuses).toContain(200);
        expect([...issuerOrigins]).toEqual([new URL(deployment.issuer).origin]);
        if (deployment.mode === 'managed-local') expect(provisionScopeSeen).toBe(true);
        await expect(page).toHaveURL(original);
        const binding = await runtimeProbe(page, { operation: 'identity' });
        expect(binding).toMatchObject({ webId: expectedWebId, podUrl: expectedPod, issuer: deployment.issuer });

        const resource = new URL(`matrix-private-${randomUUID()}.txt`, expectedPod).href;
        const body = `private-matrix-${randomUUID()}`;
        const write = await runtimeProbe(page, { operation: 'write-read', url: resource, body });
        expect(write).toMatchObject({ writeStatus: 201, readStatus: 200, matches: true, anonymousDenied: true });
        await verifyOfflinePodRecovery(page, context, resource.slice(expectedPod.length), body);
        await page.reload();
        await expect.poll(() => productReady(page), { timeout: 60_000 }).toBe(true);
        await expect(page).toHaveURL(original);
        expect(await runtimeProbe(page, { operation: 'read', url: resource, body })).toMatchObject({ readStatus: 200, matches: true, webId: expectedWebId, podUrl: expectedPod });

        // The formal Status route additionally requires native Account controls.
        // Preserve the product's own router navigation when it is available.
        await page.goto(`${origin}/status/overview`, { waitUntil: 'domcontentloaded' });
        await expect.poll(() => accountProbe(page, expectedWebId), { timeout: 45_000 }).toMatchObject({ authenticated: true, ownsWebId: true });
        const account = await accountProbe(page, expectedWebId);
        expect(new URL(account.authority!).origin).toBe(new URL(deployment.issuer).origin);
        if (accountControl) expect(account.webIdControl).toBe(accountControl);
        accountControl = account.webIdControl;
        expect(accountControl).toBeTruthy();
        const authenticatedWebIdControl = account.webIdControl!;

        await completeOfflineProductLogout(page, context);
        await expect.poll(async () => {
          const state = await accountProbe(page, expectedWebId);
          return state.anonymous === true && await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession') === null);
        }, { timeout: 45_000 }).toBe(true);
        const revokedAccountStatus = await page.evaluate(async url => {
          const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          return response.status;
        }, authenticatedWebIdControl);
        expect([401, 403]).toContain(revokedAccountStatus);
        const anonymousRead = await page.request.get(resource);
        expect([401, 403]).toContain(anonymousRead.status());
        await testInfo.attach('deployment-evidence', {
          contentType: 'application/json',
          body: JSON.stringify({ mode: deployment.mode, runnerBunVersion: deployment.runnerBunVersion, entry: route, origin, issuer: deployment.issuer,
            topology: { productHostname: new URL(origin).hostname, issuerHostname: new URL(deployment.issuer).hostname, distinctOrigin: origin !== new URL(deployment.issuer).origin },
            selected: binding, tokenStatuses, accountControl, privateWriteRead: true, refreshRead: true, offlineRecovery: true, offlineLogoutRetry: true, revokedAccountStatus, signedOut: true }),
        });
      });
    }
    test('delayed real Pod providers cannot continue Gateway reads after product logout', async ({ page }, testInfo) => {
      const origin = new URL(deployment.baseUrl).origin;
      const expectedPod = `${origin}/${deployment.account.username}/`;
      const calls: Array<{ origin: string; phase: string }> = [];
      let phase = 'login';
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/ai/connections/authorization-methods') calls.push({ origin: url.origin, phase });
      });
      try {
        await completeOidcLogin(page, { ...deployment.account, podUrl: expectedPod, webId: `${expectedPod}profile/card#me` }, {
          baseUrl: origin, startUrl: `${origin}/ai-connections`, ready: productReady, requireCallbackEvidence: true,
        });
        phase = 'positive';
        await armDelayedProviders(page);
        phase = 'positive-release';
        await releaseDelayedProviders(page);
        expect(await delayedProvidersState(page)).toMatchObject({ resultReady: true, statusAtRelease: 'authenticated', settled: true, rejected: false });
        expect(calls.filter(call => call.phase === 'positive-release').length).toBeGreaterThan(0);
        expect(calls.filter(call => call.phase === 'positive-release').every(call => call.origin === origin)).toBe(true);
        await cleanupDelayedProviders(page);

        phase = 'delayed';
        await armDelayedProviders(page);
        const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
        if (!await signOut.isVisible()) await page.getByTestId('xpod-user-card-trigger').click();
        await signOut.click();
        await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
        await expect(page.getByText('退出未完成', { exact: true })).toHaveCount(0);
        await expect.poll(async () => (await readBrowserXpodAccount(page)).isAnonymous, { timeout: 30_000 }).toBe(true);
        expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
        expect(await delayedProvidersState(page)).toMatchObject({ resultReady: true, released: false, settled: false });
        phase = 'after-logout';
        await releaseDelayedProviders(page);
        const operation = await delayedProvidersState(page);
        await testInfo.attach('delayed-provider-logout', { contentType: 'application/json',
          body: JSON.stringify({ mode: deployment.mode, calls, operation }) });
        expect(operation).toMatchObject({ statusAtRelease: 'anonymous', settled: true, rejected: true });
        expect(calls.filter(call => call.phase === 'after-logout')).toEqual([]);
      } finally {
        try {
          await cleanupDelayedProviders(page);
        } catch (error) {
          await testInfo.attach('delayed-provider-cleanup-failed', { contentType: 'application/json',
            body: JSON.stringify({ mode: deployment.mode, cleanupFailed: true }) });
          throw error;
        }
      }
    });
  });
}

async function productReady(page: Page): Promise<boolean> {
  return page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible().catch(() => false);
}

async function registerFromProduct(page: Page, deployment: Deployment, startUrl: string): Promise<void> {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => url.origin === new URL(deployment.issuer).origin && url.pathname.startsWith('/.account/'), { timeout: 60_000 });
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.locator('input[name="username"]').fill(deployment.account.username);
  await page.locator('input[name="email"]').fill(deployment.account.email);
  await page.locator('input[name="password"]').fill(deployment.account.password);
  await page.locator('input[name="confirmation"]').fill(deployment.account.password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.waitForURL(url => !url.pathname.includes('/register/'), { timeout: 120_000, waitUntil: 'domcontentloaded' });
}

type ProbeRequest = { operation: 'identity' | 'write-read' | 'read'; url?: string; body?: string };
async function runtimeProbe(page: Page, request: ProbeRequest): Promise<Record<string, unknown>> {
  const identity = await readBrowserXpodRuntime(page);
  if (request.operation === 'identity') return { ...identity };
  if (!identity.podUrl || !request.url?.startsWith(identity.podUrl)) {
    throw new Error('Probe resource must be inside the selected Pod');
  }
  const resourcePath = request.url.slice(identity.podUrl.length);
  const write = request.operation === 'write-read'
    ? await fetchBrowserXpodPod(page, resourcePath, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: request.body })
    : undefined;
  const read = await fetchBrowserXpodPod(page, resourcePath);
  const anonymousStatus = await page.evaluate(async url => (await fetch(url, { credentials: 'omit' })).status, request.url);
  return { ...identity, writeStatus: write?.status, readStatus: read.status, matches: read.body === request.body,
    anonymousDenied: [401, 403].includes(anonymousStatus) };
}

async function accountProbe(page: Page, expectedWebId: string): Promise<{
  authenticated?: boolean; anonymous?: boolean; authority?: string; webIdControl?: string; ownsWebId?: boolean;
}> {
  try {
    const account = await readBrowserXpodAccount(page);
    const webIdControl = account.controls.account?.webId;
    const ownsWebId = account.status === 'authenticated' && Boolean(webIdControl) && await page.evaluate(async ({ url, webId }) => {
      const response = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
      return response.ok && Object.prototype.hasOwnProperty.call((await response.json()).webIdLinks ?? {}, webId);
    }, { url: webIdControl!, webId: expectedWebId });
    return { authenticated: account.status === 'authenticated', anonymous: account.isAnonymous,
      authority: account.authority, webIdControl, ownsWebId };
  } catch {
    return {};
  }
}
