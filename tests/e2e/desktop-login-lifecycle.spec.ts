import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronExecutable from 'electron';
import { _electron as electron, expect, type ElectronApplication, type Page, test } from '@playwright/test';
import { normalizeAccountPath } from '../helpers/browserSolidOidc';
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
      webId: new URL(`${deployment.account.username}/profile/card#me`, deployment.baseUrl).href,
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
    const webIdRememberSubmissions: boolean[] = [];
    const trackedPages = new WeakSet<Page>();
    const trackPasswordSubmissions = (page: Page) => {
      if (trackedPages.has(page)) return;
      trackedPages.add(page);
      page.on('request', (request) => {
        const pathname = normalizeAccountPath(new URL(request.url()).pathname);
        if (request.method() === 'POST' && pathname === '/.account/login/password/') {
          passwordSubmissions += 1;
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
    await assertDesktopAccountDocument(firstWindow);

    const signedIn = await completeLogin(app, firstWindow, fixture.accounts.alice, trackPasswordSubmissions);
    await assertProtectedAiConfig(signedIn, fixture.accounts.alice);
    await assertDesktopIdentity(signedIn, fixture.accounts.alice, issuer);
    expect(await fetchBrowserXpodPod(signedIn, privatePath, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: privateBody,
    })).toMatchObject({ status: 201 });
    await assertPrivateRead(signedIn, fixture.accounts.alice.podUrl, privatePath, privateBody);
    const sessionAfterFirstLogin = await solidSessionDiagnostics(signedIn);
    expect(sessionAfterFirstLogin.currentSessionPresent).toBe(true);
    expect(sessionAfterFirstLogin.hasLegacyHostSession).toBe(false);
    expect(passwordSubmissions).toBe(1);
    expect(webIdRememberSubmissions).toContain(true);
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
      tooltip: expect.stringMatching(/^Xpod · 3\/3 services running$/),
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
    const sessionAfterRendererReopen = await solidSessionDiagnostics(reopened);
    expect(sessionAfterRendererReopen.currentSessionPresent).toBe(true);
    expect(sessionAfterRendererReopen.currentSessionId).toBe(sessionAfterFirstLogin.currentSessionId);
    expect(sessionAfterRendererReopen.hasLegacyHostSession).toBe(false);
    expect(passwordSubmissions).toBe(1);
    await expect(reopened.locator('input[type="password"]')).toHaveCount(0);
    await expect(reopened.getByTestId('auth-surface-page')).toHaveCount(0);
    await expect(reopened.getByText(/登录请求|登录验证|Unable to complete Xpod sign-in/i)).toHaveCount(0);
    expect(await currentRendererPid(app)).toBe(firstRendererPid);
    expect(await reopened.evaluate(() => (
      window as typeof window & { acceptanceDocumentMarker?: string }
    ).acceptanceDocumentMarker)).toBe(documentMarker);

    await expect.poll(() => hasRememberedXpodLogin(reopened), { timeout: 15_000 }).toBe(true);

    const sessionBeforeFullQuit = await solidSessionDiagnostics(reopened);
    expect(sessionBeforeFullQuit).toEqual(expect.objectContaining({
      currentSessionPresent: true,
      currentSessionId: sessionAfterFirstLogin.currentSessionId,
    }));

    const beforeQuitTrace = testInfo.outputPath('electron-before-quit-private.zip');
    await app.context().tracing.stop({ path: beforeQuitTrace });
    await chmod(beforeQuitTrace, 0o600);
    quitDiagnostics.push({ event: 'first-quit-requested', pid: app.process().pid });
    const exited = waitForElectronExit(app);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('xpod:acceptance:quit-app');
    });
    await exited;
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
      if (await afterFullQuit.getByRole('button', { name: /^(?:重新登录\s+\S+|使用\s+.+\s+登录)$/u }).isVisible({ timeout: 200 }).catch(() => false)) {
        return 'remembered';
      }
      return 'restoring';
    }, { timeout: 60_000 }).toMatch(/^(?:authenticated|remembered)$/u).catch(async (error: unknown) => {
      const snapshot = await authDebugSnapshot(afterFullQuit);
      const text = await visibleText(afterFullQuit);
      await afterFullQuit.screenshot({ path: '.test-data/login-redesign/desktop-cold-start-failure.png', timeout: 3_000 }).catch(() => undefined);
      throw new Error(`Desktop cold start stalled at ${safePath(afterFullQuit.url())}: ${JSON.stringify(snapshot)}; ${text}`, { cause: error });
    });
    const sessionAfterFullQuit = await solidSessionDiagnostics(afterFullQuit);
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
      await expect(afterFullQuit.locator('[data-testid="model-assignment-row"]')).toHaveCount(0);
      const rememberedEntry = afterFullQuit.getByRole('button', { name: /^(?:重新登录\s+\S+|使用\s+.+\s+登录)$/u });
      await expect(rememberedEntry).toBeVisible();
      await rememberedEntry.click();
      const restored = await completeLogin(app, afterFullQuit, fixture.accounts.alice, trackPasswordSubmissions);
      await assertProtectedAiConfig(restored, fixture.accounts.alice);
      // No expiry or revocation was injected: the persisted Account session
      // must resume authorization without another password submission.
      expect(passwordSubmissions).toBe(1);
    }
    const restoredPage = currentElectronPage(app, afterFullQuit, trackPasswordSubmissions);
    await assertDesktopIdentity(restoredPage, fixture.accounts.alice, issuer);
    await assertPrivateRead(restoredPage, fixture.accounts.alice.podUrl, privatePath, privateBody);
    await testInfo.attach('desktop-deployment-evidence', {
      contentType: 'application/json', body: JSON.stringify({ mode: deployment?.mode ?? 'standalone',
        origin: new URL(fixture.baseUrl).origin, issuer, webId: fixture.accounts.alice.webId,
        podUrl: fixture.accounts.alice.podUrl, privateWriteRead: true, traySameDocument: true,
        coldStartPrivateRead: true, accountControlsVerified: true,
        coldStartRecovery: automaticRecovery ? 'automatic' : 'remembered-entry', passwordSubmissions }),
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
  const ownsWebId = await page.evaluate(async ({ control, webId }) => {
    const response = await fetch(control, { credentials: 'include', headers: { Accept: 'application/json' } });
    return response.ok && Object.prototype.hasOwnProperty.call((await response.json()).webIdLinks ?? {}, webId);
  }, { control: state.controls.account!.webId!, webId: account.webId });
  expect(ownsWebId).toBe(true);
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
    const webIdButton = page.getByRole('button', { name: '批准', exact: true });
    const interactionPath = new URL(page.url()).pathname;
    if (!approvedInteractions.has(interactionPath)
      && normalizeAccountPath(interactionPath) === '/.account/oidc/consent/'
      && await webIdButton.isVisible({ timeout: 200 }).catch(() => false)) {
      webIdSeen = true;
      // Picking the WebID can resume into a separate consent interaction.
      // Approve each interaction once; never repeatedly submit a stuck form.
      approvedInteractions.add(interactionPath);
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
      await password.press('Enter');
      submitted = true;
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }
  page = currentElectronPage(app, page, onPage);
  throw new Error(`Desktop login timed out at ${safePath(page.url())}: ${JSON.stringify({ submitted, webIdSeen, approvedInteractionCount: approvedInteractions.size, buttons: await buttonSnapshot(page) })}; ${await visibleText(page)}`);
}

async function assertDesktopAccountDocument(page: Page): Promise<void> {
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 30_000 });
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

  // Account pages now intentionally retain their compact document card in
  // the dedicated Account window. Vertical scrolling is allowed; controls must
  // remain usable without horizontal overflow.
  expect(geometry.layout).toBe('compact');
  expect(geometry.viewport).toEqual({ width: 480, height: 640 });
  expect(geometry.dialog.x).toBeGreaterThanOrEqual(0);
  expect(geometry.dialog.width).toBeGreaterThan(0);
  expect(geometry.dialog.x + geometry.dialog.width).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.documentOverflowsHorizontally).toBe(false);
  await expect(page.locator('input[type="email"]')).toBeEditable();
  await expect(page.locator('input[type="password"]')).toBeEditable();
  const submit = page.getByRole('button', { name: '登录', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  await expect(submit).toBeEnabled();

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
  await expect(page.getByRole('heading', { name: 'Model Assignments', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="model-assignment-row"]')).toHaveCount(6);
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

async function isAiConfigReady(page: Page): Promise<boolean> {
  return new URL(page.url()).pathname.startsWith('/ai-config')
    && await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible({ timeout: 200 }).catch(() => false)
    && await page.locator('[data-testid="model-assignment-row"]').count() === 6
    && await page.getByText('Failed to read AI Config', { exact: true }).count() === 0;
}

async function hasRememberedXpodLogin(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(window.localStorage.getItem('xpod.remembered-login.v1')));
}

interface SolidSessionDiagnostics {
  currentSessionPresent: boolean;
  currentSessionId?: string;
  hasLegacyHostSession: boolean;
  hasAccountCookie: boolean;
  hasSelectedStorage: boolean;
  hasRememberedLogin: boolean;
}

async function solidSessionDiagnostics(page: Page): Promise<SolidSessionDiagnostics> {
  return page.evaluate(() => {
    const hostSessionId = window.localStorage.getItem('xpod.solid.sessionId') ?? undefined;
    const currentSessionId = window.localStorage.getItem('solidClientAuthn:currentSession') ?? undefined;
    return {
      currentSessionPresent: Boolean(currentSessionId),
      currentSessionId,
      hasLegacyHostSession: Boolean(hostSessionId),
      hasAccountCookie: document.cookie.includes('css-account='),
      hasSelectedStorage: Boolean(window.localStorage.getItem('xpod.auth.selected-storage.v1')),
      hasRememberedLogin: Boolean(window.localStorage.getItem('xpod.remembered-login.v1')),
    };
  });
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
      hasAccountCookie: document.cookie.includes('css-account='),
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
  await exited;
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
