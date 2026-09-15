import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { completeOidcLogin, normalizeAccountPath, type BrowserSolidCredentials } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodPod, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

type Fixture = {
  baseUrl: string;
  controlUrl: string;
  accounts: { bob: BrowserSolidCredentials & { podBindings: Array<{ webId: string; podUrl: string }> } };
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
    const timer = setTimeout(() => reject(new Error(`Consent fixture startup timed out: ${diagnostics}`)), 150_000);
    child!.once('error', error => { clearTimeout(timer); reject(error); });
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Consent fixture exited (${code})`)); });
    lines.on('line', line => {
      if (line.startsWith('XPOD_SETTINGS_FIXTURE_READY ')) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice('XPOD_SETTINGS_FIXTURE_READY '.length)));
      } else if (line.startsWith('XPOD_SETTINGS_FIXTURE_ERROR ')) {
        clearTimeout(timer);
        reject(new Error(`Consent fixture failed: ${diagnostics}`));
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

// Compact Chromium validates the 480x640 content layout. The separate Electron
// IPC acceptance proves native cancellation; these cases do not impersonate it.
for (const viewport of [{ width: 1280, height: 800 }, { width: 480, height: 640 }]) {
  for (const action of ['retry', 'return', 'cancel'] as const) {
    test(`${viewport.width}x${viewport.height}: failed WebID selection can ${action}`, async ({ browser }, testInfo) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const account = fixture.accounts.bob;
      const original = new URL(`/ai-connections?consent-recovery=${action}-${viewport.width}`, fixture.baseUrl).href;
      const first = account.podBindings[0];
      const second = account.podBindings[1];
      expect(first && second).toBeTruthy();
      let failedPosts = 0;
      let pickPosts = 0;
      let pickGets = 0;
      let tokenPosts = 0;
      let cancelPosts = 0;
      let cancelledCallback = false;
      page.on('request', request => {
        const url = new URL(request.url());
        const normalized = normalizeAccountPath(url.pathname);
        if (normalized === '/.account/oidc/pick-webid/') {
          if (request.method() === 'GET') pickGets++;
          if (request.method() === 'POST') pickPosts++;
        }
        if (request.method() === 'POST' && url.pathname.endsWith('/token')) tokenPosts++;
        if (request.method() === 'POST' && /\/oidc\/cancel\/?$/u.test(normalized)) cancelPosts++;
        if (url.pathname === '/auth/callback' && url.searchParams.get('error') === 'access_denied') cancelledCallback = true;
      });
      await page.route('**/*', async route => {
        if (route.request().method() === 'POST'
          && normalizeAccountPath(new URL(route.request().url()).pathname) === '/.account/oidc/pick-webid/'
          && failedPosts === 0) {
          failedPosts++;
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary WebID selection failure' }) });
        } else await route.continue();
      });
      try {
        await completeOidcLogin(page, account, {
          baseUrl: fixture.baseUrl, startUrl: original,
          ready: current => current.getByRole('combobox', { name: /身份与存储空间|identity.*storage/i }).isVisible(),
          requireCallbackEvidence: false,
        });
        const selection = await chooseBinding(page, first.podUrl);
        await page.getByRole('checkbox', { name: '记住这个应用', exact: true }).check();
        await page.getByRole('button', { name: '批准', exact: true }).click();
        await expect(page.getByRole('button', { name: '返回授权', exact: true })).toBeVisible();
        expect(failedPosts).toBe(1);
        expect(tokenPosts).toBe(0);
        for (const label of ['重试', '返回授权', '取消授权']) await assertActionInViewport(page, label);
        await page.screenshot({ path: testInfo.outputPath('selection-failed.png') });
        if (action === 'cancel') {
          await page.getByRole('button', { name: '取消授权', exact: true }).click();
          await expect.poll(() => cancelledCallback).toBe(true);
          expect(cancelPosts).toBe(1);
          await expect(page.getByRole('button', { name: '返回应用', exact: true })).toBeVisible();
          await page.getByRole('button', { name: '返回应用', exact: true }).click();
          await expect(page).toHaveURL(original);
          expect(tokenPosts).toBe(0);
          await expect(page.locator('[data-pod-ready="true"]')).toHaveCount(0);
        } else {
          const beforePosts = pickPosts;
          const beforeGets = pickGets;
          await page.getByRole('button', { name: action === 'retry' ? '重试' : '返回授权', exact: true }).click();
          const selector = page.getByRole('combobox', { name: /身份与存储空间|identity.*storage/i });
          await expect(selector).toBeEnabled();
          expect(pickPosts).toBe(beforePosts);
          if (action === 'retry') expect(pickGets).toBeGreaterThan(beforeGets);
          await expect(selector).toHaveValue(selection);
          await expect(page.getByRole('checkbox', { name: '记住这个应用', exact: true })).toBeChecked();
          const target = action === 'return' ? second : first;
          await chooseBinding(page, target.podUrl);
          await completeOidcLogin(page, { ...account, ...target }, {
            baseUrl: fixture.baseUrl, requireCallbackEvidence: true,
            ready: current => current.locator('[data-pod-ready="true"]').isVisible(),
          });
          await expect(page).toHaveURL(original);
          expect(tokenPosts).toBe(1);
          expect(await readBrowserXpodRuntime(page)).toMatchObject({ webId: target.webId, podUrl: target.podUrl });
          const resource = `consent-${action}-${viewport.width}.txt`;
          expect(await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: resource })).toMatchObject({ status: 201 });
          expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: resource });
        }
        await page.screenshot({ path: testInfo.outputPath('recovered.png') });
        await testInfo.attach('consent-recovery-evidence', { contentType: 'application/json', body: JSON.stringify({ viewport, action, failedPosts, pickPosts, pickGets, tokenPosts, cancelPosts, cancelledCallback }) });
      } finally {
        await context.close();
      }
    });
  }
}

test('Electron failed consent returns through the trusted native cancellation bridge', async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const userData = await mkdtemp(path.resolve('.test-data/consent-electron-profile-'));
  const original = new URL('/ai-connections?consent-native-recovery=1', fixture.baseUrl).href;
  const app = await electron.launch({ args: [path.resolve('desktop/dist/main.js')], env: {
    ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_URL: original, XPOD_DESKTOP_USER_DATA_DIR: userData,
  } });
  let selectionFailures = 0;
  let tokenPosts = 0;
  let cancelPosts = 0;
  try {
    const page = await app.firstWindow();
    const context = app.context();
    context.on('request', request => {
      const pathname = normalizeAccountPath(new URL(request.url()).pathname);
      if (request.method() === 'POST' && pathname.endsWith('/token')) tokenPosts++;
      if (request.method() === 'POST' && /\/oidc\/cancel\/?$/u.test(pathname)) cancelPosts++;
    });
    await context.route('**/*', async route => {
      if (route.request().method() === 'POST' && normalizeAccountPath(new URL(route.request().url()).pathname) === '/.account/oidc/pick-webid/') {
        selectionFailures++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      } else await route.continue();
    });
    await completeOidcLogin(page, fixture.accounts.bob, {
      baseUrl: fixture.baseUrl, requireCallbackEvidence: false,
      ready: current => current.getByRole('combobox', { name: /身份与存储空间|identity.*storage/i }).isVisible(),
    });
    await chooseBinding(page, fixture.accounts.bob.podBindings[0].podUrl);
    await page.getByRole('button', { name: '批准', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回应用', exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('electron-consent-failed.png') });
    await expect(page.getByRole('button', { name: '返回应用', exact: true })).toBeInViewport();
    expect(selectionFailures).toBe(1);
    const before = { path: new URL(page.url()).pathname, text: await page.locator('body').innerText(),
      size: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
    await page.screenshot({ path: testInfo.outputPath('electron-consent-failed.png') });
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    const expected = new URL(original);
    expected.searchParams.set('xpod-login', 'cancelled');
    await expect(page).toHaveURL(expected.href);
    await expect(page.locator('[data-pod-ready="true"]')).toHaveCount(0);
    expect(tokenPosts).toBe(0);
    expect(cancelPosts).toBe(0);
    expect(app.windows()).toHaveLength(1);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 280, height: 400 });
    await page.screenshot({ path: testInfo.outputPath('electron-returned-app.png') });
    await testInfo.attach('electron-native-recovery', { contentType: 'application/json', body: JSON.stringify({
      before, after: { path: new URL(page.url()).pathname, text: await page.locator('body').innerText(),
        size: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) },
      tokenPosts, cancelPosts, selectionFailures,
    }) });
  } finally {
    // Exercise the real Quit path before Playwright closes its routed context.
    // Context teardown can stall before its custom Electron quit hook runs.
    const process = app.process();
    try {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
          const timer = setTimeout(() => {
            process.kill('SIGKILL'); // Only this test's child; timeout remains a failure.
            reject(new Error('Consent Electron did not quit within 20 seconds'));
          }, 20_000);
          process.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        });
        const [exit] = await Promise.all([
          exited,
          app.evaluate(({ app: electronApp }) => { electronApp.emit('xpod:acceptance:quit-app'); }),
        ]);
        expect(exit).toEqual({ code: 0, signal: null });
        await testInfo.attach('electron-process-exit', { contentType: 'application/json', body: JSON.stringify(exit) });
      } else {
        expect({ code: process.exitCode, signal: process.signalCode }).toEqual({ code: 0, signal: null });
      }
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
});

async function chooseBinding(page: Page, podUrl: string): Promise<string> {
  const selector = page.getByRole('combobox', { name: /身份与存储空间|identity.*storage/i });
  const value = await selector.locator('option').evaluateAll((options, pod) => options.map(option => (option as HTMLOptionElement).value).find(value => value.endsWith(`|${pod}`) || value.endsWith(`|${pod.replace(/\/$/u, '')}`)), podUrl);
  if (!value) throw new Error('Expected real multi-Pod consent binding is missing');
  await selector.selectOption(value);
  return value;
}

async function assertActionInViewport(page: Page, label: string): Promise<void> {
  const action = page.getByRole('button', { name: label, exact: true });
  await expect(action).toBeEnabled();
  const box = await action.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}
