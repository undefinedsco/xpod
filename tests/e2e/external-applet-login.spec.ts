import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { completeOidcLogin, type BrowserSolidCredentials } from '../helpers/browserSolidOidc';

// A real standalone browser host, real Xpod Account/OIDC and real SDK token
// exchange. No auth interception, token injection or applet-owned auth server.
test.describe('external applet host login through Xpod', () => {
  const runtimeRoot = path.resolve('.test-data/external-applet-login', randomUUID());
  let fixture: ChildProcess | undefined;
  let issuerBaseUrl: string;
  let server: Server | undefined;
  let account: BrowserSolidCredentials;
  let bob: BrowserSolidCredentials;
  let appletOrigin: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    await mkdir(runtimeRoot, { recursive: true });
    const bundlePath = path.join(runtimeRoot, 'host.js');
    execFileSync('bun', ['build', 'tests/helpers/externalAppletHostClient.ts', '--target=browser', `--outfile=${bundlePath}`], {
      cwd: process.cwd(), stdio: 'pipe',
    });
    const bundle = await readFile(bundlePath);
    // The shared production fixture runs under Bun, matching the service's
    // SQLite runtime. Playwright's Node worker only owns this external host.
    fixture = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fixtureErrors = '';
    fixture.stderr!.on('data', (chunk: Buffer) => { fixtureErrors = `${fixtureErrors}${chunk}`.slice(-8_000); });
    const ready = await new Promise<{ baseUrl: string; accounts: { alice: BrowserSolidCredentials; bob: BrowserSolidCredentials } }>((resolve, reject) => {
      const lines = createInterface({ input: fixture!.stdout! });
      const timeout = setTimeout(() => reject(new Error('Xpod fixture startup timed out')), 150_000);
      fixture!.once('error', reject);
      fixture!.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Xpod fixture exited before ready (${code})`)); });
      lines.on('line', (line) => {
        if (line.startsWith('XPOD_SETTINGS_FIXTURE_READY ')) {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice('XPOD_SETTINGS_FIXTURE_READY '.length)));
        } else if (line.startsWith('XPOD_SETTINGS_FIXTURE_ERROR ')) {
          clearTimeout(timeout);
          reject(new Error(`Xpod fixture failed to start: ${line.slice('XPOD_SETTINGS_FIXTURE_ERROR '.length)}; ${fixtureErrors}`));
        }
      });
    });
    issuerBaseUrl = ready.baseUrl;
    account = ready.accounts.alice;
    bob = ready.accounts.bob;
    server = createServer((request, response) => {
      if (request.url === '/host.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(bundle);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><html><body><h1>Independent applet</h1>
        <button id="login">Sign in with WebID</button><button id="logout">Sign out WebID</button><output></output>
        <script id="host-config" type="application/json">${JSON.stringify({ issuer: issuerBaseUrl, bindings: [account, bob].map(({ webId, podUrl }) => ({ webId, podUrl })) })}</script>
        <script type="module" src="/host.js"></script></body></html>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    appletOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (fixture && fixture.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { fixture!.kill('SIGKILL'); }, 10_000);
        fixture!.once('exit', () => { clearTimeout(timeout); resolve(); });
        fixture!.kill('SIGTERM');
      });
    }
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  test('returns from Account and WebID consent to the original independent applet with authenticated Pod access', async ({ page }) => {
    test.setTimeout(120_000);
    const originalPath = '/applet/notes?document=welcome#details';
    let authenticatedPodRead = false;
    let tokenSucceeded = false;
    let tokenExchanges = 0;
    const authorizationStates = new Set<string>();
    const accountDocuments: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.endsWith('/token')) tokenExchanges += 1;
      if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('state')) {
        authorizationStates.add(url.searchParams.get('state')!);
      }
      if (request.url() === account.podUrl && request.headers().dpop && request.headers().authorization) authenticatedPodRead = true;
      if (request.isNavigationRequest() && new URL(request.url()).pathname.startsWith('/.account/')) accountDocuments.push(request.url());
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('/token') && response.status() === 200) tokenSucceeded = true;
    });
    const trace = await completeOidcLogin(page, { ...account, email: account.email!, password: account.password! }, {
      baseUrl: appletOrigin,
      startUrl: `${appletOrigin}${originalPath}`,
      ready: (current) => current.getByTestId('external-applet-ready').isVisible().catch(() => false),
      timeoutMs: 90_000,
    });
    expect(appletOrigin).not.toBe(new URL(issuerBaseUrl).origin);
    expect(page.url()).toBe(`${appletOrigin}${originalPath}`);
    expect(accountDocuments.length).toBeGreaterThan(0);
    expect(trace.passwordSubmitted).toBe(true);
    expect(trace.authCodeChallengeMethodS256).toBe(true);
    expect(trace.callbackHasCode && trace.callbackHasState).toBe(true);
    expect(trace.tokenAuthorizationCodeGrantSeen && trace.tokenCodeVerifierSeen).toBe(true);
    expect(trace.authorizationRedirectUris.every((uri) => new URL(uri).origin === appletOrigin)).toBe(true);
    expect(tokenSucceeded && authenticatedPodRead).toBe(true);
    expect(authorizationStates.size).toBe(1);
    expect(tokenExchanges).toBe(1);
    await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-webid', account.webId!);
    await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-pod-status', '200');
  });

  test('switches from Alice to Bob through the host with a fresh WebID and Pod binding', async ({ page }) => {
    test.setTimeout(120_000);
    for (const [index, identity] of [account, bob].entries()) {
      if (index === 1) {
        await page.getByRole('button', { name: 'Sign out WebID', exact: true }).click();
        await expect(page.getByTestId('external-applet-anonymous')).toBeVisible();
        await expect(page.getByTestId('external-applet-anonymous')).toHaveAttribute('data-private-read-status', /^(401|403)$/);
        await expect(page.locator('[data-webid], [data-pod-url]')).toHaveCount(0);
        // WebID logout does not own the issuer's CSS Account cookie. Stop at
        // its form/consent, and explicitly switch a retained Account before
        // allowing the helper to approve Bob's authorization.
        await completeOidcLogin(page, identity, {
          baseUrl: appletOrigin,
          requireCallbackEvidence: false,
          ready: async current => await current.locator('input[type="email"]').isVisible().catch(() => false)
            || await current.getByRole('button', { name: '换一个账号', exact: true }).isVisible().catch(() => false),
        });
        const switchAccount = page.getByRole('button', { name: '换一个账号', exact: true });
        if (await switchAccount.isVisible().catch(() => false)) await switchAccount.click();
      }
      const trace = await completeOidcLogin(page, identity, {
        baseUrl: appletOrigin,
        ...(index === 0 ? { startUrl: `${appletOrigin}/applet/switch` } : {}),
        ready: (current) => current.getByTestId('external-applet-ready').isVisible().catch(() => false),
      });
      expect(trace.passwordSubmitted).toBe(true);
      expect(trace.tokenAuthorizationCodeGrantSeen && trace.tokenCodeVerifierSeen).toBe(true);
      await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-webid', identity.webId!);
      await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-pod-url', identity.podUrl!);
      await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-pod-status', '200');
    }
  });

  test('restores using the fixture host policy on refresh and stays anonymous after explicit WebID logout', async ({ page }) => {
    test.setTimeout(120_000);
    await completeOidcLogin(page, account, {
      baseUrl: appletOrigin, startUrl: `${appletOrigin}/applet/refresh`,
      ready: (current) => current.getByTestId('external-applet-ready').isVisible().catch(() => false),
    });
    await page.reload();
    await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-webid', account.webId!, { timeout: 45_000 });
    await expect(page.getByTestId('external-applet-ready')).toHaveAttribute('data-pod-status', '200');
    expect(page.url()).toBe(`${appletOrigin}/applet/refresh`);
    await page.getByRole('button', { name: 'Sign out WebID', exact: true }).click();
    await expect(page.getByTestId('external-applet-anonymous')).toBeVisible();
    await expect(page.getByTestId('external-applet-anonymous')).toHaveAttribute('data-private-read-status', /^(401|403)$/);
    await expect(page.locator('[data-webid], [data-pod-url]')).toHaveCount(0);
    let postLogoutAuthRequests = 0;
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.searchParams.get('response_type') === 'code'
        || (request.method() === 'POST' && url.pathname.endsWith('/token'))) postLogoutAuthRequests += 1;
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in with WebID', exact: true })).toBeEnabled();
    await expect(page.getByTestId('external-applet-ready')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
    expect(postLogoutAuthRequests).toBe(0);
  });

  test('denying consent returns an error without identity or Pod access', async ({ page }) => {
    test.setTimeout(90_000);
    let tokenSucceeded = false;
    let podRequested = false;
    let deniedCallback = false;
    page.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('/token') && response.ok()) tokenSucceeded = true;
    });
    page.on('request', request => {
      if (request.url() === account.podUrl && request.headers().dpop) podRequested = true;
      const url = new URL(request.url());
      if (url.origin === appletOrigin && url.pathname === '/auth/callback' && url.searchParams.get('error') === 'access_denied') deniedCallback = true;
    });
    await completeOidcLogin(page, account, {
      baseUrl: appletOrigin, startUrl: `${appletOrigin}/applet/deny`,
      requireCallbackEvidence: false,
      ready: current => current.getByRole('button', { name: '拒绝', exact: true }).isVisible().catch(() => false),
    });
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(page.getByTestId('external-applet-error')).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).origin).toBe(appletOrigin);
    expect(deniedCallback).toBe(true);
    await expect(page.locator('[data-webid], [data-pod-url]')).toHaveCount(0);
    expect(tokenSucceeded || podRequested).toBe(false);
  });

  test('a tampered callback state is rejected by Inrupt before identity or Pod access', async ({ page }) => {
    test.setTimeout(90_000);
    let tokenSucceeded = false;
    let tokenRequests = 0;
    let podRequested = false;
    page.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('/token') && response.ok()) tokenSucceeded = true;
    });
    page.on('request', request => {
      if (request.url() === account.podUrl && request.headers().dpop) podRequested = true;
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/token')) tokenRequests += 1;
    });
    // Deliberate protocol fault injection, not a mocked successful session.
    await page.addInitScript((origin) => {
      const url = new URL(location.href);
      if (url.origin === origin && url.pathname === '/auth/callback' && url.searchParams.has('code')) {
        url.searchParams.set('state', 'unrecognized-test-state');
        history.replaceState(null, '', url.href);
        (window as typeof window & { callbackStateTampered?: boolean }).callbackStateTampered = true;
      }
    }, appletOrigin);
    await completeOidcLogin(page, account, {
      baseUrl: appletOrigin, startUrl: `${appletOrigin}/applet/state`,
      failure: current => current.getByTestId('external-applet-error').isVisible().catch(() => false),
    });
    expect(await page.evaluate(() => (window as typeof window & { callbackStateTampered?: boolean }).callbackStateTampered)).toBe(true);
    await expect(page.getByTestId('external-applet-error')).toBeVisible();
    await expect(page.locator('[data-webid], [data-pod-url]')).toHaveCount(0);
    expect(tokenSucceeded || podRequested).toBe(false);
    expect(tokenRequests).toBe(0);
  });

});
