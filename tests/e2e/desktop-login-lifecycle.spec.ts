import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronExecutable from 'electron';
import { _electron as electron, expect, type ElectronApplication, type Page, type TestInfo, test } from '@playwright/test';
import { normalizeAccountPath } from '../helpers/browserSolidOidc';
import { completeOfflineProductLogout, verifyOfflinePodRecovery } from '../helpers/browserLoginNetwork';
import { armDelayedProviders, cleanupDelayedProviders, delayedProvidersState, releaseDelayedProviders } from '../helpers/browserDelayedProviders';
import { fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

const READY_PREFIX = 'XPOD_SETTINGS_FIXTURE_READY ';

interface FixtureReady {
  baseUrl: string;
  controlUrl?: string;
  accounts: { alice: { email: string; password: string; webId: string; podUrl: string } };
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

type DesktopDeployment = {
  mode: 'cloud' | 'managed-local' | 'standalone';
  baseUrl: string;
  issuer: string;
  account: { email: string; password: string; username: string };
};
const matrixManifest = process.env.XPOD_E2E_LOGIN_MATRIX_MANIFEST;
const deploymentCases: Array<DesktopDeployment | undefined> = matrixManifest
  ? JSON.parse(readFileSync(matrixManifest, 'utf8')) as DesktopDeployment[]
  : [undefined];

for (const deployment of deploymentCases) {
test(`${deployment ? `${deployment.mode}: ` : ''}closing to tray keeps the same authenticated renderer and full quit falls back safely when needed`, async () => {
  const testInfo = test.info();
  const fixture: FixtureReady = deployment ? {
    baseUrl: deployment.baseUrl,
    accounts: { alice: { ...deployment.account,
      podUrl: new URL(`${deployment.account.username}/`, deployment.baseUrl).href,
      webId: deployment.mode === 'managed-local' ? '' : new URL(`${deployment.account.username}/profile/card#me`, deployment.baseUrl).href,
    } },
  } : await startFixture();
  const issuer = deployment?.issuer ?? fixture.baseUrl;
  const privatePath = `desktop-private-${randomUUID()}.txt`;
  const privateBody = `desktop-lifecycle-${randomUUID()}`;
  const userData = await mkdtemp(path.join(os.tmpdir(), 'xpod-desktop-login-lifecycle-'));
  let app: ElectronApplication | undefined;
  let lifecycleCompleted = false;
  const network: Array<Record<string, unknown>> = [];
  const quitDiagnostics: Array<Record<string, unknown>> = [];
  let privateStderr = '';
  const observeQuit = async (desktop: ElectronApplication) => {
    const child = desktop.process();
    child.stderr?.on('data', (chunk: Buffer) => { privateStderr += chunk.toString(); });
    child.once('exit', (code, signal) => quitDiagnostics.push({ event: 'child-exit', pid: child.pid, code, signal }));
    desktop.on('console', message => {
      if (message.text().startsWith('XPOD_QUIT_EVIDENCE ')) quitDiagnostics.push({ event: message.text(), pid: child.pid });
    });
    await desktop.evaluate(({ app: electronApp }) => {
      electronApp.on('before-quit', () => console.log('XPOD_QUIT_EVIDENCE before-quit'));
      electronApp.on('will-quit', () => console.log('XPOD_QUIT_EVIDENCE will-quit'));
      electronApp.on('quit', () => console.log('XPOD_QUIT_EVIDENCE quit'));
    });
  };
  const observeDesktopNetwork = (desktop: ElectronApplication) => {
    const context = desktop.context();
    const requestPath = (raw: string) => {
      try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '<invalid>'; }
    };
    context.on('request', request => network.push({ phase: 'request', path: requestPath(request.url()), method: request.method(), type: request.resourceType() }));
    context.on('response', response => network.push({ phase: 'response', path: requestPath(response.url()), status: response.status(), length: response.headers()['content-length'] }));
    context.on('requestfinished', request => network.push({ phase: 'finished', path: requestPath(request.url()) }));
    context.on('requestfailed', request => network.push({ phase: 'failed', path: requestPath(request.url()), error: request.failure()?.errorText }));
  };
  try {
    app = await electron.launch({
      args: [path.resolve('desktop/dist/main.js')],
      env: {
        ...process.env,
        XPOD_DESKTOP_ACCEPTANCE: '1',
        XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', fixture.baseUrl).href,
        XPOD_DESKTOP_USER_DATA_DIR: userData,
      },
      timeout: 30_000,
    });

    await app.context().tracing.start({ screenshots: true, snapshots: true });
    observeDesktopNetwork(app);
    await observeQuit(app);
    let passwordSubmissions = 0;
    const passwordAuthorityPosts: string[] = [];
    const consentRememberSubmissions: boolean[] = [];
    const webIdRememberSubmissions: boolean[] = [];
    const trackedPages = new WeakSet<Page>();
    const trackPasswordSubmissions = (page: Page) => {
      if (trackedPages.has(page)) return;
      trackedPages.add(page);
      page.on('request', (request) => {
        const pathname = normalizeAccountPath(new URL(request.url()).pathname);
        if (request.method() === 'POST' && pathname === '/.account/login/password/') {
          passwordSubmissions += 1;
          passwordAuthorityPosts.push(new URL(request.url()).origin);
        }
        if (request.method() === 'POST' && pathname === '/.account/oidc/consent/') {
          consentRememberSubmissions.push(request.postDataJSON().remember === true);
        }
        if (request.method() === 'POST' && pathname === '/.account/oidc/pick-webid/') {
          try {
            webIdRememberSubmissions.push(request.postDataJSON().remember === true);
          } catch {
            webIdRememberSubmissions.push(false);
          }
        }
      });
    };

    const firstWindow = await app.firstWindow();
    trackPasswordSubmissions(firstWindow);
    await assertDesktopAccountDocument(firstWindow, app, testInfo);
    await expect(firstWindow.getByTestId('xpod-deployment-identity')).toBeVisible();
    await expect(firstWindow.getByRole('tooltip')).toHaveCount(0);
    await firstWindow.screenshot({ path: testInfo.outputPath('deployment-first-login-compact.png') });
    await firstWindow.getByRole('button', { name: '部署详情', exact: true }).click();
    const deploymentDetails = firstWindow.getByRole('tooltip');
    await expect(deploymentDetails).toContainText(`当前访问：${new URL(firstWindow.url()).origin}`);
    // Capture the completed presentation, not an intermediate fade-in frame.
    await expect.poll(() => deploymentDetails.evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    const detailBounds = await deploymentDetails.boundingBox();
    const viewportWidth = await firstWindow.evaluate(() => window.innerWidth);
    expect(detailBounds).not.toBeNull();
    expect(detailBounds!.x).toBeGreaterThanOrEqual(0);
    expect(detailBounds!.x + detailBounds!.width).toBeLessThanOrEqual(viewportWidth);
    await firstWindow.screenshot({ path: testInfo.outputPath('deployment-first-login-details.png') });
    await firstWindow.keyboard.press('Escape');
    await expect(firstWindow.getByRole('tooltip')).toHaveCount(0);

    const signedIn = await completeLogin(app, firstWindow, fixture.accounts.alice, trackPasswordSubmissions, true, true);
    if (deployment?.mode === 'managed-local') await resolveManagedAccountBinding(signedIn, fixture.accounts.alice, issuer);
    await assertProtectedAiConfig(signedIn, fixture.accounts.alice);
    await assertDesktopIdentity(signedIn, fixture.accounts.alice, issuer);
    expect(await fetchBrowserXpodPod(signedIn, privatePath, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: privateBody,
    })).toMatchObject({ status: 201 });
    await assertPrivateRead(signedIn, fixture.accounts.alice.podUrl, privatePath, privateBody);
    const sessionAfterFirstLogin = await solidSessionDiagnostics(signedIn, issuer);
    expect(sessionAfterFirstLogin.currentSessionPresent).toBe(true);
    expect(sessionAfterFirstLogin.hasLegacyHostSession).toBe(false);
    expect(passwordSubmissions).toBe(1);
    expect(webIdRememberSubmissions).toContain(true);
    expect(consentRememberSubmissions).toContain(true);
    const firstLoginConsentCount = consentRememberSubmissions.length;
    await expect.poll(() => hasRememberedXpodLogin(signedIn), { timeout: 15_000 }).toBe(true);

    const trayEvidence = await app.evaluate(({ app: electronApp }) => new Promise<unknown>((resolve) => {
      const acceptanceApp = electronApp as {
        once(event: string, listener: (evidence: unknown) => void): void;
        emit(event: string): void;
      };
      const timeout = setTimeout(() => resolve({ timeout: true }), 5_000);
      acceptanceApp.once('xpod:acceptance:tray-evidence', (evidence: unknown) => {
        clearTimeout(timeout);
        resolve(evidence);
      });
      acceptanceApp.emit('xpod:acceptance:read-tray');
    }));
    expect(trayEvidence).toEqual(expect.objectContaining({
      exists: true,
      imageEmpty: false,
      imageScaleFactors: expect.arrayContaining([1, 2]),
      tooltip: 'Xpod · 运行中',
      bounds: expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }),
    }));
    expect((trayEvidence as { bounds: { width: number; height: number } }).bounds.width).toBeGreaterThan(0);
    expect((trayEvidence as { bounds: { width: number; height: number } }).bounds.height).toBeGreaterThan(0);

    const firstRendererPid = await currentRendererPid(app);
    const documentMarker = await signedIn.evaluate(() => {
      const marker = crypto.randomUUID();
      (window as typeof window & { acceptanceDocumentMarker?: string }).acceptanceDocumentMarker = marker;
      return marker;
    });
    await signedIn.evaluate(() => {
      const desktopBridge = (window as typeof window & {
        xpodDesktop?: { closeWindowForAcceptance?(): void };
      }).xpodDesktop;
      desktopBridge?.closeWindowForAcceptance?.();
    });
    await expect.poll(() => isElectronWindowVisible(app!), { timeout: 10_000 }).toBe(false);
    expect(app.windows().filter((page) => !page.isClosed())).toContain(signedIn);

    const servicesAfterClose = await fetch(new URL('/service/status', fixture.baseUrl)).then((response) => response.json()) as Array<{ name: string; status: string }>;
    expect(servicesAfterClose).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'gateway', status: 'running' }),
      expect.objectContaining({ name: 'css', status: 'running' }),
      expect.objectContaining({ name: 'api', status: 'running' }),
    ]));

    const secondInstanceExit = await launchSecondDesktopInstance({
      ...process.env,
      XPOD_DESKTOP_ACCEPTANCE: '1',
      XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', fixture.baseUrl).href,
      XPOD_DESKTOP_USER_DATA_DIR: userData,
    });
    expect(secondInstanceExit).toBe(0);
    await expect.poll(() => isElectronWindowVisible(app!), { timeout: 10_000 }).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const reopened = signedIn;
    trackPasswordSubmissions(reopened);
    await assertProtectedAiConfig(reopened, fixture.accounts.alice);
    await assertPrivateRead(reopened, fixture.accounts.alice.podUrl, privatePath, privateBody);
    const sessionAfterRendererReopen = await solidSessionDiagnostics(reopened, issuer);
    expect(sessionAfterRendererReopen.currentSessionPresent).toBe(true);
    expect(sessionAfterRendererReopen.currentSessionId).toBe(sessionAfterFirstLogin.currentSessionId);
    expect(sessionAfterRendererReopen.hasLegacyHostSession).toBe(false);
    expect(passwordSubmissions).toBe(1);
    await expect(reopened.locator('input[type="password"]')).toHaveCount(0);
    expect(consentRememberSubmissions).toHaveLength(firstLoginConsentCount);
    await expect(reopened.getByTestId('auth-surface-page')).toHaveCount(0);
    await expect(reopened.getByText(/登录请求|登录验证|Unable to complete Xpod sign-in/i)).toHaveCount(0);
    expect(await currentRendererPid(app)).toBe(firstRendererPid);
    expect(await reopened.evaluate(() => (
      window as typeof window & { acceptanceDocumentMarker?: string }
    ).acceptanceDocumentMarker)).toBe(documentMarker);

    await expect.poll(() => hasRememberedXpodLogin(reopened), { timeout: 15_000 }).toBe(true);

    const sessionBeforeFullQuit = await solidSessionDiagnostics(reopened, issuer);
    expect(sessionBeforeFullQuit).toEqual(expect.objectContaining({
      currentSessionPresent: true,
      currentSessionId: sessionAfterFirstLogin.currentSessionId,
    }));

    const beforeQuitTrace = testInfo.outputPath('electron-before-quit-private.zip');
    await app.context().tracing.stop({ path: beforeQuitTrace });
    await chmod(beforeQuitTrace, 0o600);
    quitDiagnostics.push({ event: 'first-quit-requested', pid: app.process().pid });
    const quittingProcess = app.process();
    const exited = waitForElectronExit(app);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('xpod:acceptance:quit-app');
    });
    // Release Playwright's Node inspector so Electron can finish its normal exit.
    await app.close();
    await exited;
    expect(quittingProcess.exitCode).toBe(0);
    expect(quittingProcess.signalCode).toBeNull();
    app = undefined;

    app = await electron.launch({
      args: [path.resolve('desktop/dist/main.js')],
      env: {
        ...process.env,
        XPOD_DESKTOP_ACCEPTANCE: '1',
        XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', fixture.baseUrl).href,
        XPOD_DESKTOP_USER_DATA_DIR: userData,
      },
      timeout: 30_000,
    });

    await app.context().tracing.start({ screenshots: true, snapshots: true });
    observeDesktopNetwork(app);
    await observeQuit(app);
    const afterFullQuit = await app.firstWindow();
    trackPasswordSubmissions(afterFullQuit);
    await expect.poll(async () => {
      if (await isAiConfigReady(afterFullQuit)) return 'authenticated';
      if (await afterFullQuit.getByRole('button', { name: '进入 Xpod', exact: true }).isVisible({ timeout: 200 }).catch(() => false)) {
        return 'remembered';
      }
      return 'restoring';
    }, { timeout: 60_000 }).toMatch(/^(?:authenticated|remembered)$/u).catch(async (error: unknown) => {
      const snapshot = await authDebugSnapshot(afterFullQuit);
      const text = await visibleText(afterFullQuit);
      await afterFullQuit.screenshot({ path: '.test-data/login-redesign/desktop-cold-start-failure.png', timeout: 3_000 }).catch(() => undefined);
      throw new Error(`Desktop cold start stalled at ${safePath(afterFullQuit.url())}: ${JSON.stringify(snapshot)}; ${text}`, { cause: error });
    });
    const sessionAfterFullQuit = await solidSessionDiagnostics(afterFullQuit, issuer);
    expect(sessionAfterFullQuit.hasRememberedLogin).toBe(true);
    expect(passwordSubmissions).toBe(1);
    await expect(afterFullQuit.locator('input[type="password"]')).toHaveCount(0);
    await expect(afterFullQuit.getByText(/登录请求|登录验证|Unable to complete Xpod sign-in/i)).toHaveCount(0);
    const automaticRecovery = await isAiConfigReady(afterFullQuit);
    if (automaticRecovery) {
      expect(sessionAfterFullQuit.currentSessionPresent).toBe(true);
      expect(sessionAfterFullQuit.hasLegacyHostSession).toBe(false);
      await assertProtectedAiConfig(afterFullQuit, fixture.accounts.alice);
      expect(sessionAfterFullQuit.hasAccountCookie).toBe(true);
    } else {
      await expect(afterFullQuit.getByRole('region', { name: '默认模型', exact: true })).toHaveCount(0);
      const rememberedEntry = afterFullQuit.getByRole('button', { name: '进入 Xpod', exact: true });
      await expect(rememberedEntry).toBeVisible();
      await rememberedEntry.click();
      const restored = await completeLogin(app, afterFullQuit, fixture.accounts.alice, trackPasswordSubmissions, false);
      await assertProtectedAiConfig(restored, fixture.accounts.alice);
      // No expiry or revocation was injected: the persisted Account session
      // must resume authorization without another password submission.
      expect(passwordSubmissions).toBe(1);
    }
    const restoredPage = currentElectronPage(app, afterFullQuit, trackPasswordSubmissions);
    await assertDesktopIdentity(restoredPage, fixture.accounts.alice, issuer);
    await assertPrivateRead(restoredPage, fixture.accounts.alice.podUrl, privatePath, privateBody);
    expect(consentRememberSubmissions).toHaveLength(firstLoginConsentCount);
    await testInfo.attach('desktop-deployment-evidence', {
      contentType: 'application/json', body: JSON.stringify({ mode: deployment?.mode ?? 'standalone',
        origin: new URL(fixture.baseUrl).origin, issuer, webId: fixture.accounts.alice.webId,
        podUrl: fixture.accounts.alice.podUrl, privateWriteRead: true, traySameDocument: true,
        coldStartPrivateRead: true, accountControlsVerified: true,
        coldStartRecovery: automaticRecovery ? 'automatic' : 'remembered-entry', passwordSubmissions, passwordAuthorityPosts,
        accountCookieMetadata: { firstLogin: sessionAfterFirstLogin.accountCookies, coldStart: sessionAfterFullQuit.accountCookies },
        consentPosts: { initial: firstLoginConsentCount, trayResume: 0, coldStartResume: 0 } }),
    });
    lifecycleCompleted = true;
  } finally {
    if (app) {
      const tracePath = testInfo.outputPath('electron-context-private.zip');
      await app.context().tracing.stop(!lifecycleCompleted ? { path: tracePath } : {}).catch(() => undefined);
      await chmod(tracePath, 0o600).catch(() => undefined);
    }
    await testInfo.attach('desktop-navigation-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({ network, windows: app?.windows().map(page => ({ path: safePath(page.url()), closed: page.isClosed() })) ?? [] }),
    });
    // Persist the first failure before cleanup attempts can change process state.
    await writeFile(testInfo.outputPath('electron-quit-private.json'), JSON.stringify({ quitDiagnostics, privateStderr }), { mode: 0o600 });
    if (app) await quitAcceptanceApp(app).catch(error => quitDiagnostics.push({ event: 'cleanup-quit-error', message: String(error) }));
    await writeFile(testInfo.outputPath('electron-quit-private.json'), JSON.stringify({ quitDiagnostics, privateStderr }), { mode: 0o600 });
    if (fixture.controlUrl) await stopFixture(fixture.controlUrl);
    await rm(userData, { recursive: true, force: true });
  }
});

for (const scenario of ['offline logout', 'delayed providers'] as const) {
  test(`${deployment ? `${deployment.mode}: ` : ''}${scenario} preserves the desktop session boundary`, async () => {
    const testInfo = test.info();
    const fixture: FixtureReady = deployment ? {
      baseUrl: deployment.baseUrl,
      accounts: { alice: { ...deployment.account,
        podUrl: new URL(`${deployment.account.username}/`, deployment.baseUrl).href,
        webId: deployment.mode === 'managed-local' ? '' : new URL(`${deployment.account.username}/profile/card#me`, deployment.baseUrl).href,
      } },
    } : await startFixture();
    const userData = await mkdtemp(path.resolve('.test-data/desktop-session-boundary-'));
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let primaryFailure: unknown;
    const network: Array<Record<string, unknown>> = [];
    try {
      app = await electron.launch({ args: [path.resolve('desktop/dist/main.js')], env: {
        ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1',
        XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', fixture.baseUrl).href,
        XPOD_DESKTOP_USER_DATA_DIR: userData,
      } });
      app.context().on('request', request => network.push({ event: 'request', path: safePath(request.url()), type: request.resourceType() }));
      app.context().on('response', response => network.push({ event: 'response', path: safePath(response.url()), status: response.status() }));
      app.context().on('requestfinished', request => network.push({ event: 'finished', path: safePath(request.url()) }));
      app.context().on('requestfailed', request => network.push({ event: 'failed', path: safePath(request.url()), error: request.failure()?.errorText }));
      page = await app.firstWindow();
      page = await completeLogin(app, page, fixture.accounts.alice);
      expect(await page.evaluate(() => Boolean(window.xpodDesktop))).toBe(true);
      if (deployment?.mode === 'managed-local') await resolveManagedAccountBinding(page, fixture.accounts.alice, deployment.issuer);
      await assertDesktopIdentity(page, fixture.accounts.alice, deployment?.issuer ?? fixture.baseUrl);
      const accountControl = (await readBrowserXpodAccount(page)).controls.account!.webId!;
      if (scenario === 'offline logout') {
        const resource = `offline-desktop-${randomUUID()}.txt`;
        const body = `offline-private-${randomUUID()}`;
        expect(await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).toMatchObject({ status: 201 });
        const offlineNetwork = await verifyOfflinePodRecovery(page, app.context(), resource, body);
        await completeOfflineProductLogout(page, app.context());
        await expect.poll(async () => (await readBrowserXpodAccount(page!)).isAnonymous).toBe(true);
        const revokedStatus = await page.evaluate(async url => (await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })).status, accountControl);
        expect([401, 403]).toContain(revokedStatus);
        expect([401, 403]).toContain((await fetch(new URL(resource, fixture.accounts.alice.podUrl))).status);
        await testInfo.attach('desktop-offline-logout', { contentType: 'application/json', body: JSON.stringify({
          mode: deployment?.mode ?? 'standalone', actualDesktopBridge: true, offlineReadRecovered: true, offlineLogoutRetried: true, revokedStatus, ...offlineNetwork,
        }) });
      } else {
        await page.goto(new URL('/ai-connections', fixture.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-pod-ready="true"]')).toBeVisible({ timeout: 30_000 });
        const calls: Array<{ origin: string; phase: string }> = [];
        let phase = 'positive';
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.pathname === '/api/ai/connections/authorization-methods') calls.push({ origin: url.origin, phase });
        });
        await armDelayedProviders(page);
        phase = 'positive-release';
        await releaseDelayedProviders(page);
        expect(await delayedProvidersState(page)).toMatchObject({ statusAtRelease: 'authenticated', settled: true, rejected: false });
        expect(calls.filter(call => call.phase === 'positive-release').length).toBeGreaterThan(0);
        expect(calls.filter(call => call.phase === 'positive-release').every(call => call.origin === new URL(fixture.baseUrl).origin)).toBe(true);
        await cleanupDelayedProviders(page);
        phase = 'delayed';
        await armDelayedProviders(page);
        await page.getByTestId('xpod-user-card-trigger').click();
        await page.getByRole('button', { name: '退出', exact: true }).click();
        await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
        await expect.poll(async () => (await readBrowserXpodAccount(page!)).isAnonymous).toBe(true);
        expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
        expect(await delayedProvidersState(page)).toMatchObject({ resultReady: true, released: false, settled: false });
        phase = 'after-logout';
        await releaseDelayedProviders(page);
        const operation = await delayedProvidersState(page);
        expect(operation).toMatchObject({ statusAtRelease: 'anonymous', settled: true, rejected: true });
        expect(calls.filter(call => call.phase === 'after-logout')).toEqual([]);
        await testInfo.attach('desktop-delayed-provider-logout', { contentType: 'application/json', body: JSON.stringify({
          mode: deployment?.mode ?? 'standalone', actualDesktopBridge: true, calls, operation,
        }) });
      }
    } catch (error) {
      primaryFailure = error;
      await testInfo.attach('desktop-session-primary-failure', { contentType: 'application/json', body: JSON.stringify({
        message: error instanceof Error ? error.message : String(error), path: page ? safePath(page.url()) : undefined, network,
      }) });
      if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('desktop-session-failed.png'), timeout: 3_000 }).catch(() => undefined);
      throw error;
    } finally {
      try {
        if (page && scenario === 'delayed providers' && !page.isClosed()) await cleanupDelayedProviders(page);
      } finally {
        try { if (app) await quitAcceptanceApp(app); }
        catch (error) {
          await testInfo.attach('desktop-session-cleanup-failure', { contentType: 'text/plain', body: String(error) });
          // Reap only this test's owned child. A forced kill remains a failure.
          app?.process().kill('SIGKILL');
          if (!primaryFailure) throw error;
        } finally {
          if (fixture.controlUrl) await stopFixture(fixture.controlUrl);
          await rm(userData, { recursive: true, force: true });
        }
      }
    }
  });
}

test(`${deployment ? `${deployment.mode}: ` : ''}compact native wrong-password keeps alert/register/forgot/login inside the 280x400 window`, async () => {
  const testInfo = test.info();
  const fixture: FixtureReady = deployment ? {
    baseUrl: deployment.baseUrl,
    accounts: { alice: { ...deployment.account,
      podUrl: new URL(`${deployment.account.username}/`, deployment.baseUrl).href,
      webId: deployment.mode === 'managed-local' ? '' : new URL(`${deployment.account.username}/profile/card#me`, deployment.baseUrl).href,
    } },
  } : await startFixture();
  const userData = await mkdtemp(path.resolve('.test-data/desktop-compact-wrong-login-'));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [path.resolve('desktop/dist/main.js')],
      env: {
        ...process.env,
        XPOD_DESKTOP_ACCEPTANCE: '1',
        XPOD_DESKTOP_URL: new URL('/ai-config/model-assignments', fixture.baseUrl).href,
        XPOD_DESKTOP_USER_DATA_DIR: userData,
      },
      timeout: 30_000,
    });
    const page = await app.firstWindow();
    await expect(page.getByLabel('邮箱')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('密码')).toBeVisible({ timeout: 30_000 });

    const nativeWindow = await app.browserWindow(page);
    const nativeGeometry = await nativeWindow.evaluate(window => ({
      bounds: window.getBounds(), contentBounds: window.getContentBounds(), minimumSize: window.getMinimumSize(),
    }));
    await nativeWindow.dispose();
    expect({ width: nativeGeometry.bounds.width, height: nativeGeometry.bounds.height }).toEqual({ width: 280, height: 400 });
    expect(nativeGeometry.minimumSize).toEqual([280, 400]);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(viewport).toEqual({ width: nativeGeometry.contentBounds.width, height: nativeGeometry.contentBounds.height });

    const role = (name: string) => page.getByRole('button', { name, exact: true });
    const fits = async (locator: ReturnType<typeof role>, what: string) => {
      const box = await locator.boundingBox();
      expect(box, `${what} is missing`).not.toBeNull();
      expect(box!.y, `${what} top ${box!.y}`).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height, `${what} bottom ${box!.y + box!.height} exceeds content height ${viewport.height}`)
        .toBeLessThanOrEqual(viewport.height);
    };
    const inputFits = async (label: string) => {
      const box = await page.getByLabel(label).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height, `${label} bottom ${box!.y + box!.height} exceeds ${viewport.height}`).toBeLessThanOrEqual(viewport.height);
    };
    const assertNoInternalScroll = async () => {
      const scroll = await page.evaluate(() => {
        const form = document.querySelector<HTMLElement>('[data-pod-sign-in-state="idp-sign-in"]');
        return {
          formScrolls: form ? form.scrollHeight > form.clientHeight + 1 : null,
          documentOverflows: document.documentElement.scrollHeight > window.innerHeight,
        };
      });
      expect(scroll).toEqual({ formScrolls: false, documentOverflows: false });
    };

    // Normal state: every control fits the content viewport with no internal scroll.
    await inputFits('邮箱');
    await inputFits('密码');
    await fits(role('忘记密码？'), 'forgot');
    await fits(role('登录'), 'submit');
    await fits(role('注册账号'), 'register');
    await assertNoInternalScroll();

    // Wrong password: the inline alert must appear and must not push the recovery
    // actions out of the window (Register previously ended at y=384 > content 372).
    await page.getByLabel('邮箱').fill(fixture.accounts.alice.email);
    await page.getByLabel('密码').fill(`${fixture.accounts.alice.password}-wrong`);
    await role('登录').click();
    await expect(page.getByRole('alert')).toHaveText('邮箱或密码不正确。');
    await fits(role('忘记密码？'), 'forgot (error)');
    await fits(role('登录'), 'submit (error)');
    await fits(role('注册账号'), 'register (error)');
    const alertBox = await page.getByRole('alert').boundingBox();
    expect(alertBox).not.toBeNull();
    expect(alertBox!.y + alertBox!.height, `alert bottom ${alertBox!.y + alertBox!.height} exceeds ${viewport.height}`).toBeLessThanOrEqual(viewport.height);
    await assertNoInternalScroll();
    await testInfo.attach('compact-native-wrong-password', { contentType: 'application/json',
      body: JSON.stringify({ mode: deployment?.mode ?? 'standalone', nativeGeometry, viewport }) });
  } finally {
    if (app) {
      await quitAcceptanceApp(app).catch(async (error) => {
        await testInfo.attach('compact-native-wrong-password-cleanup-failure', { contentType: 'text/plain', body: String(error) });
        app?.process().kill('SIGKILL');
        throw error;
      });
    }
    if (fixture.controlUrl) await stopFixture(fixture.controlUrl);
    await rm(userData, { recursive: true, force: true });
  }
});

}

async function fetchMountedSdkAccountJson<T>(page: Page, input: {
  authority: string; expectedWebId: string; expectedIssuer: string; resource: string;
}): Promise<T> {
  return page.evaluate(async ({ authority, expectedWebId, expectedIssuer, resource }) => {
    type Host = {
      session?: { getSnapshot(): { status: string; webId?: string; issuer?: string } };
      fetch?: typeof fetch;
      state?: { status: string };
      issuer?: string;
    };
    type Fiber = { child?: Fiber; sibling?: Fiber; stateNode?: { current?: Fiber }; memoizedProps?: { value?: Host } };
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find(entry => entry.startsWith('__reactContainer$'));
    const current = root && key ? (root as unknown as Record<string, Fiber>)[key].stateNode?.current : undefined;
    if (!current) throw new Error('Missing committed React provider tree');
    const queue: Array<Fiber | undefined> = [current];
    let host: Host | undefined;
    while (queue.length) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const value = fiber.memoizedProps?.value;
      if (value?.session?.getSnapshot && value.fetch && value.state) { host = value; break; }
      queue.push(fiber.child, fiber.sibling);
    }
    if (!host?.session || !host.fetch) throw new Error('Missing mounted standard SDK host');
    const snapshot = host.session.getSnapshot();
    if (snapshot.status !== 'authenticated' || snapshot.webId !== expectedWebId
      || !host.issuer || new URL(host.issuer).origin !== new URL(expectedIssuer).origin) {
      throw new Error('Account binding acceptance identity changed');
    }
    const authorityOrigin = new URL(authority).origin;
    if (authorityOrigin !== new URL(expectedIssuer).origin) throw new Error('Account authority changed');
    const url = new URL(resource, authority);
    if (url.origin !== authorityOrigin || url.username || url.password || url.search || url.hash) throw new Error('Account control authority changed');
    const response = await host.fetch(url.href, { headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) throw new Error(`Account acceptance request failed (${response.status})`);
    return response.json();
  }, input) as Promise<T>;
}

async function resolveManagedAccountBinding(page: Page, account: FixtureReady['accounts']['alice'], issuer: string): Promise<void> {
  await expect.poll(async () => (await readBrowserXpodAccount(page)).status, { timeout: 30_000 }).toBe('authenticated');
  const state = await readBrowserXpodAccount(page);
  expect(new URL(state.authority!).origin).toBe(new URL(issuer).origin);
  const runtime = await readBrowserXpodRuntime(page);
  expect(runtime.status).toBe('authenticated');
  expect(runtime.webId).toBeTruthy();
  expect(new URL(runtime.issuer!).origin).toBe(new URL(issuer).origin);
  expect(new URL(runtime.webId!).origin).toBe(new URL(issuer).origin);
  const input = { authority: state.authority!, expectedWebId: runtime.webId!, expectedIssuer: issuer };
  const index = await fetchMountedSdkAccountJson<{ controls?: { account?: { bindings?: string } } }>(page, { ...input, resource: '/.account/' });
  const control = index.controls?.account?.bindings;
  if (!control) throw new Error('Account did not expose storage bindings');
  const { bindings } = await fetchMountedSdkAccountJson<{ bindings: Array<{ webId: string; storageUrl: string }> }>(page, { ...input, resource: control });
  const exactBindings = bindings.filter(binding => new URL(binding.storageUrl).href === new URL(account.podUrl).href);
  expect(exactBindings).toHaveLength(1);
  const webId = exactBindings[0].webId;
  expect(webId).toBe(runtime.webId);
  expect(new URL(webId).origin).toBe(new URL(issuer).origin);
  expect(new URL(webId).origin).not.toBe(new URL(account.podUrl).origin);
  account.webId = webId;
}

async function assertDesktopIdentity(page: Page, account: FixtureReady['accounts']['alice'], issuer: string): Promise<void> {
  expect(await readBrowserXpodRuntime(page)).toMatchObject({ status: 'authenticated', webId: account.webId, podUrl: account.podUrl, issuer });
  await expect.poll(async () => {
    const state = await readBrowserXpodAccount(page);
    return state.status;
  }, { timeout: 30_000 }).toBe('authenticated');
  const state = await readBrowserXpodAccount(page);
  expect(new URL(state.authority!).origin).toBe(new URL(issuer).origin);
  expect(state.controls.account?.webId).toBeTruthy();
  const links = await fetchMountedSdkAccountJson<{ webIdLinks?: Record<string, unknown> }>(page, {
    authority: state.authority!, expectedWebId: account.webId, expectedIssuer: issuer, resource: state.controls.account!.webId!,
  });
  expect(Object.prototype.hasOwnProperty.call(links.webIdLinks ?? {}, account.webId)).toBe(true);
}

async function assertPrivateRead(page: Page, podUrl: string, resourcePath: string, body: string): Promise<void> {
  expect(await fetchBrowserXpodPod(page, resourcePath)).toEqual({ status: 200, body });
  const anonymousStatus = await page.evaluate(async url => (await fetch(url, { credentials: 'omit' })).status, new URL(resourcePath, podUrl).href);
  expect([401, 403]).toContain(anonymousStatus);
}

async function completeLogin(
  app: ElectronApplication,
  initialPage: Page,
  account: FixtureReady['accounts']['alice'],
  onPage?: (page: Page) => void,
  allowConsent = true,
  rememberAccount?: boolean,
): Promise<Page> {
  const deadline = Date.now() + 100_000;
  let page = initialPage;
  let submitted = false;
  const approvedInteractions = new Set<string>();
  let webIdSeen = false;
  while (Date.now() < deadline) {
    page = currentElectronPage(app, page, onPage);
    if (!page.isClosed() && await isAiConfigReady(page)) return page;
    if (page.isClosed()) {
      await delay(250);
      continue;
    }
    const webIdButton = page.getByRole('button', { name: '允许', exact: true });
    const interactionPath = new URL(page.url()).pathname;
    if (!approvedInteractions.has(interactionPath)
      && normalizeAccountPath(interactionPath) === '/.account/oidc/consent/'
      && await webIdButton.isVisible({ timeout: 200 }).catch(() => false)) {
      if (!allowConsent) throw new Error('Remembered desktop recovery unexpectedly requested Consent');
      webIdSeen = true;
      // Picking the WebID can resume into a separate consent interaction.
      // Approve each interaction once; never repeatedly submit a stuck form.
      approvedInteractions.add(interactionPath);
      const remember = page.getByRole('checkbox', { name: '以后不再询问', exact: true });
      if (!await remember.isVisible()) await page.locator('summary').filter({ hasText: '请求详情' }).click();
      await remember.check();
      await expect(remember).toBeChecked();
      await webIdButton.click();
      await page.waitForTimeout(250).catch(() => undefined);
      continue;
    }
    const email = page.locator('input[type="email"], input[name="email"], input#email').first();
    const password = page.locator('input[type="password"], input[name="password"], input#password').first();
    if (!submitted
      && await email.isVisible({ timeout: 200 }).catch(() => false)
      && await password.isVisible({ timeout: 200 }).catch(() => false)) {
      await email.fill(account.email);
      await password.fill(account.password);
      if (rememberAccount !== undefined) {
        const remember = page.getByRole('checkbox', { name: '记住账号', exact: true });
        await remember.setChecked(rememberAccount);
        await expect(remember).toBeChecked({ checked: rememberAccount });
      }
      await password.press('Enter');
      submitted = true;
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }
  page = currentElectronPage(app, page, onPage);
  throw new Error(`Desktop login timed out at ${safePath(page.url())}: ${JSON.stringify({ submitted, webIdSeen, approvedInteractionCount: approvedInteractions.size, buttons: await buttonSnapshot(page) })}; ${await visibleText(page)}`);
}

async function assertDesktopAccountDocument(page: Page, app: ElectronApplication, testInfo: TestInfo): Promise<void> {
  await expect(page.getByRole('textbox', { name: '邮箱', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  let geometry: Awaited<ReturnType<typeof readWorkspaceAuthGeometry>> = null;
  while (!geometry && Date.now() < deadline) {
    geometry = await readWorkspaceAuthGeometry(page);
    if (!geometry) await page.waitForTimeout(100).catch(() => undefined);
  }
  await page.screenshot({ path: '.test-data/login-redesign/desktop-account-auth-window.png' });
  expect(geometry).not.toBeNull();
  if (!geometry) throw new Error('Desktop Xpod Account document did not become stable');

  // The dedicated desktop Account window is the native compact sign-in window:
  // it fills the accepted 280x400 host (content ~280x372) with the presentation
  // frame (no card). Controls must stay inside the content viewport with no
  // internal scroll hiding clipping (no scrollIntoView workaround).
  expect(geometry.layout).toBe('window');
  const nativeWindow = await app.browserWindow(page);
  const nativeGeometry = await nativeWindow.evaluate(window => ({
    bounds: window.getBounds(), contentBounds: window.getContentBounds(), minimumSize: window.getMinimumSize(),
  }));
  await nativeWindow.dispose();
  expect({ width: nativeGeometry.bounds.width, height: nativeGeometry.bounds.height }).toEqual({ width: 280, height: 400 });
  expect(nativeGeometry.minimumSize).toEqual([280, 400]);
  expect(geometry.viewport).toEqual({ width: nativeGeometry.contentBounds.width, height: nativeGeometry.contentBounds.height });
  await testInfo.attach('native-account-window-geometry', { contentType: 'application/json',
    body: JSON.stringify({ nativeGeometry, domViewport: geometry.viewport, documentOverflowsHorizontally: geometry.documentOverflowsHorizontally, formScrolls: geometry.formScrolls }) });
  expect(geometry.dialog.x).toBeGreaterThanOrEqual(0);
  expect(geometry.dialog.width).toBeGreaterThan(0);
  expect(geometry.dialog.x + geometry.dialog.width).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.documentOverflowsHorizontally).toBe(false);
  expect(geometry.formScrolls).toBe(false);
  await expect(page.getByRole('textbox', { name: '邮箱', exact: true })).toBeEditable();
  await expect(page.locator('input[type="password"]')).toBeEditable();
  // Actual rect guards: primary/recovery controls must fit the content viewport
  // without a scroll that would hide clipping.
  const contentHeight = geometry.viewport.height;
  const controls = [
    ['email', page.getByRole('textbox', { name: '邮箱', exact: true })],
    ['password', page.locator('input[type="password"]')],
    ['forgot', page.getByRole('button', { name: '忘记密码？', exact: true })],
    ['submit', page.getByRole('button', { name: '登录', exact: true })],
    ['register', page.getByRole('button', { name: '注册账号', exact: true })],
  ] as const;
  for (const [name, locator] of controls) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `${name} is missing`).not.toBeNull();
    expect(box!.y, `${name} top ${box!.y}`).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, `${name} bottom ${box!.y + box!.height} exceeds content height ${contentHeight}`)
      .toBeLessThanOrEqual(contentHeight);
  }
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();

}

async function readWorkspaceAuthGeometry(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="auth-surface-modal"], [data-testid="auth-surface-page"], [data-testid="web-account-page"]');
    const dialog = surface?.querySelector<HTMLElement>('[role="dialog"], [role="region"]');
    const surfaceBody = surface?.querySelector<HTMLElement>('[data-testid="auth-surface-body"]');
    if (!surface || !dialog) return null;
    const dialogRect = dialog.getBoundingClientRect();
    const dialogStyle = window.getComputedStyle(dialog);
    return {
      host: surface.getAttribute('data-auth-surface-host'),
      frame: dialog.getAttribute('data-auth-surface-frame'),
      layout: dialog.getAttribute('data-web-account-layout'),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: {
        x: dialogRect.x,
        y: dialogRect.y,
        width: dialogRect.width,
        height: dialogRect.height,
      },
      dialogRadius: dialogStyle.borderRadius,
      dialogShadow: dialogStyle.boxShadow,
      dialogBorderWidth: dialogStyle.borderWidth,
      documentOverflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth,
      documentOverflows: document.documentElement.scrollHeight > window.innerHeight
        || document.documentElement.scrollWidth > window.innerWidth,
      formScrolls: (() => {
        const form = document.querySelector<HTMLElement>('[data-pod-sign-in-state="idp-sign-in"]');
        return form ? form.scrollHeight > form.clientHeight + 1 : null;
      })(),
      surfaceBodyMetrics: surfaceBody
        ? {
            clientHeight: surfaceBody.clientHeight,
            scrollHeight: surfaceBody.scrollHeight,
            overflowY: window.getComputedStyle(surfaceBody).overflowY,
            overflows: surfaceBody.scrollHeight > surfaceBody.clientHeight,
          }
        : undefined,
    };
  }).catch(() => null);
}

async function assertProtectedAiConfig(
  page: Page,
  account: FixtureReady['accounts']['alice'],
): Promise<void> {
  try {
    await expect.poll(() => isAiConfigReady(page), { timeout: 60_000 }).toBe(true);
  } catch (error) {
    throw new Error(`AI Config did not restore at ${safePath(page.url())}: ${JSON.stringify({
      snapshot: await authDebugSnapshot(page),
    })}; ${await visibleText(page)}`, { cause: error });
  }
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  const models = page.getByRole('region', { name: '默认模型', exact: true });
  await expect(models).toBeVisible();
  await expect(models.locator('label')).toHaveText(MODEL_PURPOSE_LABELS);
  for (const name of EDITABLE_MODEL_PURPOSES) {
    await expect(models.getByRole('combobox', { name, exact: true })).toBeVisible();
    await expect(models.getByRole('combobox', { name, exact: true })).toBeEnabled();
  }
  await expect(models.getByRole('button', { name: '去更换 ›', exact: true })).toBeEnabled();
  await expect(page.getByText('暂时无法读取 Pod 设置。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Failed to read AI Config', { exact: true })).toHaveCount(0);
  const identity = await page.getByTestId('xpod-user-card-trigger').evaluate((element) => ({
    podReady: element.getAttribute('data-pod-ready'),
    selectedPod: element.getAttribute('data-selected-pod-url'),
  }));
  expect(identity.podReady).toBe('true');
  if (identity.selectedPod !== null) expect(new URL(identity.selectedPod).pathname).toBe(new URL(account.podUrl).pathname);
  const livePodRead = await page.evaluate(async (webId) => {
    const response = await fetch(webId, { headers: { Accept: 'text/turtle' } });
    return { ok: response.ok, status: response.status };
  }, account.webId);
  expect(livePodRead).toEqual({ ok: true, status: 200 });
}

// The canonical Pod models page declares these purposes; only the three model
// choices currently supported by the product are editable, while the remaining
// purposes keep their explicit default/pending presentation.
const MODEL_PURPOSE_LABELS = ['智能', '快速', '视觉辅助', '文档理解', '语义检索', '语音合成', '语音识别', '图像生成', '视频生成', '决策'];
const EDITABLE_MODEL_PURPOSES = ['智能', '视觉辅助', '文档理解'];

async function isAiConfigReady(page: Page): Promise<boolean> {
  return page.evaluate(({ purposes, editable }) => {
    if (location.pathname !== '/pod/models') return false;
    const card = document.querySelector('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]');
    const models = document.querySelector('section[aria-label="默认模型"]');
    const heading = [...document.querySelectorAll('h1')].find(element => element.textContent?.trim() === '模型设置');
    if (!card?.getClientRects().length || !models?.getClientRects().length || !heading?.getClientRects().length) return false;
    const labels = [...models.querySelectorAll('label')].map(element => element.textContent?.trim());
    if (JSON.stringify(labels) !== JSON.stringify(purposes)) return false;
    const choices = [...models.querySelectorAll('select')];
    if (choices.length !== editable.length || !editable.every(name => choices.some(choice => !choice.disabled
      && choice.getClientRects().length > 0 && [...(choice.labels ?? [])].some(label => label.textContent?.trim() === name)))) return false;
    const embedding = [...models.querySelectorAll('button')].find(button => button.textContent?.trim() === '去更换 ›');
    if (!embedding || embedding.disabled || !embedding.getClientRects().length) return false;
    return !document.body.textContent?.includes('暂时无法读取 Pod 设置。')
      && !document.body.textContent?.includes('Failed to read AI Config');
  }, { purposes: MODEL_PURPOSE_LABELS, editable: EDITABLE_MODEL_PURPOSES }).catch((error: unknown) => {
    // OIDC redirects can replace the document while this readiness probe runs.
    if (error instanceof Error && error.message === 'page.evaluate: Execution context was destroyed, most likely because of a navigation') return false;
    throw error;
  });
}

async function hasRememberedXpodLogin(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(window.localStorage.getItem('xpod.remembered-login.v1')));
}

interface SolidSessionDiagnostics {
  currentSessionPresent: boolean;
  currentSessionId?: string;
  hasLegacyHostSession: boolean;
  hasAccountCookie: boolean;
  accountCookies: Array<{ issuer: string; persistent: boolean; expires: number; httpOnly: boolean; secure: boolean; sameSite: string }>;
  hasSelectedStorage: boolean;
  hasRememberedLogin: boolean;
}

async function solidSessionDiagnostics(page: Page, issuer: string): Promise<SolidSessionDiagnostics> {
  const accountCookies = (await page.context().cookies(issuer)).filter(cookie => cookie.name === 'css-account');
  const presentation = await page.evaluate(() => {
    const hostSessionId = window.localStorage.getItem('xpod.solid.sessionId') ?? undefined;
    const currentSessionId = window.localStorage.getItem('solidClientAuthn:currentSession') ?? undefined;
    return {
      currentSessionPresent: Boolean(currentSessionId),
      currentSessionId,
      hasLegacyHostSession: Boolean(hostSessionId),
      hasAccountCookie: false,
      hasSelectedStorage: Boolean(window.localStorage.getItem('xpod.auth.selected-storage.v1')),
      hasRememberedLogin: Boolean(window.localStorage.getItem('xpod.remembered-login.v1')),
    };
  });
  return {
    ...presentation, hasAccountCookie: accountCookies.length > 0,
    accountCookies: accountCookies.map(cookie => ({ issuer: new URL(issuer).origin,
      persistent: cookie.expires > 0, expires: cookie.expires, httpOnly: cookie.httpOnly,
      secure: cookie.secure, sameSite: cookie.sameSite })),
  };
}

async function authDebugSnapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const readFields = (key: string | null, storage: Storage = window.localStorage): string[] => {
      if (!key) return [];
      try {
        const parsed = JSON.parse(storage.getItem(key) ?? '{}') as Record<string, unknown>;
        return Object.keys(parsed).sort();
      } catch {
        return ['<invalid>'];
      }
    };
    const url = new URL(window.location.href);
    const state = url.searchParams.get('state');
    const sessionId = window.localStorage.getItem('xpod.solid.sessionId');
    return {
      pathname: url.pathname,
      searchParameterNames: Array.from(url.searchParams.keys()).sort(),
      oidcError: url.searchParams.get('error') ?? undefined,
      oidcErrorDescription: url.searchParams.get('error_description') ?? undefined,
      hasAccountSessionToken: Boolean(window.sessionStorage.getItem('xpod.cssAccountToken')),
      hasSolidSessionId: Boolean(sessionId),
      currentSessionMatchesHost: window.localStorage.getItem('solidClientAuthn:currentSession') === sessionId,
      currentSessionPresent: Boolean(window.localStorage.getItem('solidClientAuthn:currentSession')),
      hasSolidIssuer: Boolean(window.localStorage.getItem('xpod.solid.lastOidcIssuer')),
      hasSelectedStorage: Boolean(window.localStorage.getItem('xpod.auth.selected-storage.v1')),
      hasRememberedLogin: Boolean(window.localStorage.getItem('xpod.remembered-login.v1')),
      hasInruptCurrentUrl: Boolean(window.localStorage.getItem('solidClientAuthn:currentUrl')),
      oauthStateRecordFields: readFields(state ? `solidClientAuthenticationUser:${state}` : null),
      oauthStateSessionFields: readFields(state ? `solidClientAuthenticationUser:${state}` : null, window.sessionStorage),
      sessionRecordFields: readFields(sessionId ? `solidClientAuthenticationUser:${sessionId}` : null),
      sessionSecureFields: readFields(sessionId ? `solidClientAuthenticationUser:${sessionId}` : null, window.sessionStorage),
      matchingAuthRecordCount: Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
        .filter((key) => key?.startsWith('solidClientAuthenticationUser:')).length,
      userCardCount: document.querySelectorAll('[data-testid="xpod-user-card-trigger"]').length,
      authSurfaceCount: document.querySelectorAll('[data-testid="auth-surface-page"], [data-testid="auth-surface-modal"]').length,
    };
  }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
}

async function isElectronWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some((window) => !window.isDestroyed() && window.isVisible()));
}

async function currentRendererPid(app: ElectronApplication): Promise<number | undefined> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((window) => !window.isDestroyed())
    ?.webContents.getOSProcessId());
}

async function buttonSnapshot(page: Page): Promise<unknown> {
  return page.locator('button').evaluateAll((buttons) => buttons.map((element) => {
    const button = element as HTMLButtonElement;
    return {
      text: button.textContent?.replace(/\s+/gu, ' ').trim(),
      disabled: button.disabled,
      visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
    };
  })).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
}

function currentElectronPage(app: ElectronApplication, fallback: Page, onPage?: (page: Page) => void): Page {
  const open = app.windows().filter((page) => !page.isClosed());
  const current = open.at(-1) ?? fallback;
  onPage?.(current);
  return current;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForElectronExit(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Electron did not quit for acceptance')), 20_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function launchSecondDesktopInstance(env: NodeJS.ProcessEnv): Promise<number | null> {
  const child = spawn(electronExecutable as unknown as string, [path.resolve('desktop/dist/main.js')], {
    cwd: process.cwd(),
    env,
    stdio: 'ignore',
  });
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Second Xpod instance did not yield to the existing desktop host'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function quitAcceptanceApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (!child || child.exitCode !== null) return;
  const exited = waitForElectronExit(app);
  await app.evaluate(({ app: electronApp }) => {
    electronApp.emit('xpod:acceptance:quit-app');
  });
  await app.close();
  await exited;
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
}

async function visibleText(page: Page): Promise<string> {
  return page.locator('body').innerText({ timeout: 1_000 })
    .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 500))
    .catch(() => '<unavailable>');
}

function safePath(raw: string): string {
  try { return new URL(raw).pathname; } catch { return '<invalid>'; }
}

async function startFixture(): Promise<FixtureReady> {
  const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });
  const ready = await readReady(child).catch((error: unknown) => {
    child.kill('SIGTERM');
    throw new Error(`${error instanceof Error ? error.message : String(error)}; fixture stderr: ${stderr}`, { cause: error });
  });
  fixtureChildren.set(ready.controlUrl!, child);
  return ready;
}

const fixtureChildren = new Map<string, ChildProcess>();

async function readReady(child: ChildProcess): Promise<FixtureReady> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('Desktop fixture startup timed out')), 120_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Desktop fixture exited before ready (${code})`));
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.startsWith(READY_PREFIX)) continue;
        clearTimeout(timeout);
        child.stdout!.removeAllListeners('data');
        child.stdout!.resume();
        resolve(JSON.parse(line.slice(READY_PREFIX.length)) as FixtureReady);
        return;
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
  });
}

async function stopFixture(controlUrl: string): Promise<void> {
  const child = fixtureChildren.get(controlUrl);
  fixtureChildren.delete(controlUrl);
  await fetch(new URL('/control/shutdown', controlUrl), { method: 'POST', signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 10_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}
