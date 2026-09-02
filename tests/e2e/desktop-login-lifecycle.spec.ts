import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronExecutable from 'electron';
import { _electron as electron, expect, type ElectronApplication, type Page, test } from '@playwright/test';

const READY_PREFIX = 'XPOD_SETTINGS_FIXTURE_READY ';

interface FixtureReady {
  baseUrl: string;
  controlUrl: string;
  accounts: { alice: { email: string; password: string; webId: string; podUrl: string } };
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('closing to tray keeps the same authenticated renderer and full quit falls back safely when needed', async () => {
  const fixture = await startFixture();
  const userData = await mkdtemp(path.join(os.tmpdir(), 'xpod-desktop-login-lifecycle-'));
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

    let passwordSubmissions = 0;
    const webIdRememberSubmissions: boolean[] = [];
    const trackedPages = new WeakSet<Page>();
    const trackPasswordSubmissions = (page: Page) => {
      if (trackedPages.has(page)) return;
      trackedPages.add(page);
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
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
    await assertFullWindowAccountAuth(firstWindow);

    const signedIn = await completeLogin(app, firstWindow, fixture.accounts.alice, trackPasswordSubmissions);
    await assertProtectedAiConfig(signedIn, fixture.accounts.alice);
    const sessionAfterFirstLogin = await solidSessionDiagnostics(signedIn);
    expect(sessionAfterFirstLogin.currentSessionPresent).toBe(true);
    expect(sessionAfterFirstLogin.currentSessionMatchesHost).toBe(true);
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
    const sessionAfterRendererReopen = await solidSessionDiagnostics(reopened);
    expect(sessionAfterRendererReopen.currentSessionPresent).toBe(true);
    expect(sessionAfterRendererReopen.currentSessionId).toBe(sessionAfterFirstLogin.currentSessionId);
    expect(sessionAfterRendererReopen.currentSessionMatchesHost).toBe(true);
    expect(passwordSubmissions).toBe(1);
    await expect(reopened.locator('input[type="password"]')).toHaveCount(0);
    await expect(reopened.getByTestId('auth-surface-page')).toHaveCount(0);
    await expect(reopened.getByText(/登录请求|登录验证|Unable to complete Xpod sign-in/i)).toHaveCount(0);
    expect(await currentRendererPid(app)).toBe(firstRendererPid);

    await expect.poll(() => hasRememberedXpodLogin(reopened), { timeout: 15_000 }).toBe(true);

    const sessionBeforeFullQuit = await solidSessionDiagnostics(reopened);
    expect(sessionBeforeFullQuit).toEqual(expect.objectContaining({
      currentSessionPresent: true,
      currentSessionId: sessionAfterFirstLogin.currentSessionId,
    }));

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

    const afterFullQuit = await app.firstWindow();
    trackPasswordSubmissions(afterFullQuit);
    await expect.poll(async () => {
      if (await isAiConfigReady(afterFullQuit)) return 'authenticated';
      if (await afterFullQuit.getByRole('button', { name: /^重新登录\s+\S+/u }).isVisible({ timeout: 200 }).catch(() => false)) {
        return 'remembered';
      }
      return 'restoring';
    }, { timeout: 60_000 }).toMatch(/^(?:authenticated|remembered)$/u);
    const sessionAfterFullQuit = await solidSessionDiagnostics(afterFullQuit);
    expect(sessionAfterFullQuit.hasRememberedLogin).toBe(true);
    expect(passwordSubmissions).toBe(1);
    await expect(afterFullQuit.locator('input[type="password"]')).toHaveCount(0);
    await expect(afterFullQuit.getByText(/登录请求|登录验证|Unable to complete Xpod sign-in/i)).toHaveCount(0);
    if (sessionAfterFullQuit.currentSessionPresent) {
      await assertProtectedAiConfig(afterFullQuit, fixture.accounts.alice);
      expect(sessionAfterFullQuit.hasAccountCookie).toBe(true);
    } else {
      await expect(afterFullQuit.getByRole('button', { name: /^重新登录\s+\S+/u })).toBeVisible();
    }
  } finally {
    if (app) await quitAcceptanceApp(app).catch(() => undefined);
    await stopFixture(fixture.controlUrl);
    await rm(userData, { recursive: true, force: true });
  }
});

async function completeLogin(
  app: ElectronApplication,
  initialPage: Page,
  account: FixtureReady['accounts']['alice'],
  onPage?: (page: Page) => void,
): Promise<Page> {
  const deadline = Date.now() + 100_000;
  let page = initialPage;
  let submitted = false;
  let webIdStarted = false;
  let webIdSeen = false;
  while (Date.now() < deadline) {
    page = currentElectronPage(app, page, onPage);
    if (!page.isClosed() && await isAiConfigReady(page)) return page;
    if (page.isClosed()) {
      await delay(250);
      continue;
    }
    const webIdButton = page.getByTestId('auth-surface-modal').getByRole('button', { name: '继续', exact: true }).first();
    if (!webIdStarted && await webIdButton.isVisible({ timeout: 200 }).catch(() => false)) {
      webIdSeen = true;
      await webIdButton.click();
      webIdStarted = true;
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
  throw new Error(`Desktop login timed out at ${safePath(page.url())}: ${JSON.stringify({ submitted, webIdSeen, webIdStarted, buttons: await buttonSnapshot(page) })}; ${await visibleText(page)}`);
}

async function assertFullWindowAccountAuth(page: Page): Promise<void> {
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  let geometry: Awaited<ReturnType<typeof readWorkspaceAuthGeometry>> = null;
  while (!geometry && Date.now() < deadline) {
    geometry = await readWorkspaceAuthGeometry(page);
    if (!geometry) await page.waitForTimeout(100).catch(() => undefined);
  }
  expect(geometry).not.toBeNull();
  if (!geometry) throw new Error('Full-window Xpod Account authentication did not become stable');

  expect(geometry.host).toBe('window');
  expect(geometry.frame).toBe('window');
  expect(geometry.viewport).toEqual({ width: 280, height: 400 });
  expect(geometry.dialog).toEqual({ x: 0, y: 0, width: 280, height: 400 });
  expect(geometry.dialogRadius).toBe('0px');
  expect(geometry.dialogShadow).toBe('none');
  expect(geometry.dialogBorderWidth).toBe('0px');
  expect(geometry.documentOverflows).toBe(false);
  await page.screenshot({ path: '/tmp/xpod-account-auth-window.png' });
  expect(geometry.surfaceBodyMetrics).toEqual(expect.objectContaining({
    overflows: false,
  }));
}

async function readWorkspaceAuthGeometry(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="auth-surface-modal"], [data-testid="auth-surface-page"]');
    const dialog = surface?.querySelector<HTMLElement>('[role="dialog"], [role="region"]');
    const surfaceBody = surface?.querySelector<HTMLElement>('[data-testid="auth-surface-body"]');
    if (!surface || !dialog) return null;
    const dialogRect = dialog.getBoundingClientRect();
    const dialogStyle = window.getComputedStyle(dialog);
    return {
      host: surface.getAttribute('data-auth-surface-host'),
      frame: dialog.getAttribute('data-auth-surface-frame'),
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
  hostSessionId?: string;
  currentSessionMatchesHost: boolean;
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
      hostSessionId,
      currentSessionMatchesHost: Boolean(currentSessionId && hostSessionId && currentSessionId === hostSessionId),
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
  const child = spawn(electronExecutable, [path.resolve('desktop/dist/main.js')], {
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
  child.stderr.resume();
  const ready = await readReady(child);
  fixtureChildren.set(ready.controlUrl, child);
  return ready;
}

const fixtureChildren = new Map<string, ChildProcess>();

async function readReady(child: ChildProcess): Promise<FixtureReady> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('Desktop fixture startup timed out')), 120_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Desktop fixture exited before ready (${code})`));
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
