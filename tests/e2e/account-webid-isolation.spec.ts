import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { completeOidcLogin, normalizeAccountPath, type BrowserSolidCredentials } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime, refetchBrowserXpodAccount } from '../helpers/browserXpodRuntime';

type Fixture = {
  baseUrl: string;
  controlUrl: string;
  accounts: { alice: BrowserSolidCredentials; bob: BrowserSolidCredentials & { podBindings: Array<{ webId: string; podUrl: string }> } };
};
let child: ChildProcess | undefined;
let fixture: Fixture;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Reuse the existing real Xpod fixture; this file owns no server/storage implementation.
  child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr!.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-8_000); });
  fixture = await new Promise<Fixture>((resolve, reject) => {
    const lines = createInterface({ input: child!.stdout! });
    const timer = setTimeout(() => reject(new Error(`Account isolation fixture startup timed out: ${diagnostics}`)), 150_000);
    child!.once('error', error => { clearTimeout(timer); reject(error); });
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Account isolation fixture exited (${code})`)); });
    lines.on('line', line => {
      if (line.startsWith('XPOD_SETTINGS_FIXTURE_READY ')) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('XPOD_SETTINGS_FIXTURE_READY '.length)));
      } else if (line.startsWith('XPOD_SETTINGS_FIXTURE_ERROR ')) {
        clearTimeout(timer);
        reject(new Error(`Account isolation fixture failed: ${diagnostics}`));
      }
    });
  });
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => {
    const timer = setTimeout(() => child!.kill('SIGKILL'), 10_000);
    child!.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (fixture) await fetch(new URL('/control/shutdown', fixture.controlUrl), { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  else child.kill('SIGTERM');
  await exited;
});


// This is defensive session isolation after a cross-tab Account change, not a
// supported mixed-user mode. The normal product switch is covered separately.
test('a cross-tab Account change cannot change an existing WebID authority or authorize its identity', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    const applet = await context.newPage();
    let authorizationUrl: string | undefined;
    applet.on('request', request => {
      const url = new URL(request.url());
      if (url.searchParams.has('client_id') && url.searchParams.has('code_challenge')) authorizationUrl = url.href;
    });
    await completeOidcLogin(applet, fixture.accounts.alice, {
      baseUrl: fixture.baseUrl, startUrl: new URL('/ai-connections', fixture.baseUrl).href,
      ready: page => page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible(),
      timeoutMs: 90_000,
    });
    const aliceRuntime = await readBrowserXpodRuntime(applet);
    const aliceAccount = await readBrowserXpodAccount(applet);
    expect(aliceRuntime.webId).toBe(fixture.accounts.alice.webId);
    const resource = 'account-webid-isolation.txt';
    const body = 'private document owned by the original WebID';
    expect((await fetchBrowserXpodPod(applet, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).status).toBeLessThan(300);
    const session = await applet.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'));

    // A separate tab changes only the native CSS Account cookie through its
    // real password endpoint. It never logs out or seeds the Inrupt session.
    const management = await context.newPage();
    await management.goto(new URL('/.account/', fixture.baseUrl).href);
    await management.evaluate(async ({ email, password }) => {
      const response = await fetch('/.account/login/password/', {
        method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember: true }),
      });
      if (!response.ok) throw new Error(`Account login HTTP ${response.status}`);
      const result = await response.json() as { authorization?: string };
      if (!result.authorization) throw new Error('Missing native Account session');
      document.cookie = `css-account=${result.authorization}; Path=/; SameSite=Lax`;
    }, fixture.accounts.bob);
    await management.goto(new URL('/status/overview', fixture.baseUrl).href);
    await expect(management.getByTestId('xpod-user-card-trigger')).toBeVisible();
    await refetchBrowserXpodAccount(management);
    const bobAccount = await readBrowserXpodAccount(management);
    expect(bobAccount.status).toBe('authenticated');
    expect(bobAccount.controls.account?.webId).toBeTruthy();
    expect(bobAccount.controls.account?.webId).not.toBe(aliceAccount.controls.account?.webId);
    await refetchBrowserXpodAccount(applet);
    expect((await readBrowserXpodAccount(applet)).controls.account?.webId).toBe(bobAccount.controls.account?.webId);
    expect(await readBrowserXpodRuntime(applet)).toMatchObject({ webId: aliceRuntime.webId, podUrl: aliceRuntime.podUrl });
    expect(await applet.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBe(session);
    expect(await fetchBrowserXpodPod(applet, resource)).toMatchObject({ status: 200, body });
    expect([401, 403]).toContain((await fetch(new URL(resource, aliceRuntime.podUrl))).status);
    expect((await fetchBrowserXpodPod(applet, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).status).toBeLessThan(300);
    await applet.getByTestId('xpod-user-card-trigger').click();
    await expect(applet.locator('[data-avatar-card="true"]')).toHaveAttribute('data-selected-pod-url', aliceRuntime.podUrl!);
    await applet.getByRole('button', { name: 'Copy Xpod ID' }).click();
    expect(await applet.evaluate(() => navigator.clipboard.readText())).toBe(aliceRuntime.webId);
    const accountOnlyRead = await management.evaluate(async url => (await fetch(url, { credentials: 'include' })).status, new URL(resource, aliceRuntime.podUrl).href);
    expect([401, 403]).toContain(accountOnlyRead);

    // Start a new real issuer interaction under B's current Account cookie,
    // without completing it or replacing A's already valid SDK session.
    expect(Boolean(authorizationUrl)).toBe(true);
    const freshAuthorization = new URL(authorizationUrl!);
    freshAuthorization.searchParams.set('state', 'account-webid-isolation');
    freshAuthorization.searchParams.set('prompt', 'consent');
    const authorization = await context.newPage();
    await authorization.goto(freshAuthorization.href);
    await expect.poll(() => normalizeAccountPath(new URL(authorization.url()).pathname)).toBe('/.account/oidc/consent/');
    const ownership = await authorization.evaluate(async aliceWebId => {
      const picker = new URL(window.location.href);
      picker.pathname = picker.pathname.replace(/consent\/$/u, 'pick-webid/');
      picker.search = '';
      const response = await fetch(picker, { credentials: 'include', headers: { Accept: 'application/json' } });
      const data = await response.json() as { entries?: Array<{ webId: string }> };
      const rejected = await fetch(picker, { method: 'POST', credentials: 'include', redirect: 'manual', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ webId: aliceWebId, remember: true }) });
      return { status: response.status, candidates: data.entries?.map(entry => entry.webId), rejectedStatus: rejected.status };
    }, aliceRuntime.webId);
    expect(ownership.status).toBe(200);
    expect(ownership.candidates?.length).toBeGreaterThan(0);
    expect(ownership.candidates).not.toContain(aliceRuntime.webId);
    expect(ownership.candidates).toEqual(expect.arrayContaining(fixture.accounts.bob.podBindings.map(entry => entry.webId)));
    expect(ownership.rejectedStatus).toBeGreaterThanOrEqual(400);
    expect(ownership.rejectedStatus).toBeLessThan(500);
    expect(await fetchBrowserXpodPod(applet, resource)).toMatchObject({ status: 200, body });
  } finally { await context.close(); }
});
