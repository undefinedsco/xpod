import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type BrowserContext, type Page, test } from '@playwright/test';
import {
  completeOidcLogin,
  normalizeAccountPath,
  type BrowserOidcTrace,
  type BrowserSolidCredentials,
} from '../helpers/browserSolidOidc';
import {
  fetchBrowserXpodPod,
  refetchBrowserXpodAccount as refetchBrowserAccountControls,
} from '../helpers/browserXpodRuntime';
import { completeOfflineProductLogout, verifyOfflinePodRecovery } from '../helpers/browserLoginNetwork';

const readyPrefix = 'XPOD_SETTINGS_FIXTURE_READY ';
const failurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';
const routeNavigationTimeoutMs = 30_000;

type SharedLoginFixture = {
  type: 'ready';
  baseUrl: string;
  controlUrl: string;
  accounts: {
    alice: BrowserSolidCredentials;
    bob: BrowserSolidCredentials & {
      podUrls: string[];
      podBindings: Array<{ podUrl: string; webId: string }>;
    };
    newAccount: BrowserSolidCredentials;
  };
};

class SharedLoginHarness {
  private static pendingChild: ReturnType<typeof spawn> | undefined;

  static async stopPendingStart(): Promise<void> {
    const child = this.pendingChild;
    this.pendingChild = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }

  private constructor(
    private readonly child: ReturnType<typeof spawn>,
    readonly ready: SharedLoginFixture,
  ) {}

  static async start(): Promise<SharedLoginHarness> {
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pendingChild = child;
    // The long-running fixture and its child services emit diagnostics for
    // every browser scenario. Always drain stderr: leaving a piped stream
    // unread eventually fills the OS pipe and blocks the fixture event loop,
    // which presents as an unrelated static-asset request hanging late in the
    // serial suite.
    let startupDiagnostics = '';
    const captureStartupDiagnostics = (chunk: Buffer) => {
      startupDiagnostics = (startupDiagnostics + chunk.toString()).slice(-32_768);
    };
    child.stderr.on('data', captureStartupDiagnostics);
    let ready: SharedLoginFixture;
    try {
      ready = await new Promise<SharedLoginFixture>((resolve, reject) => {
        let output = '';
        let settled = false;
        const cleanup = () => {
          child.stdout.off('data', onData);
          child.off('error', onError);
          child.off('exit', onExit);
          // The ready record is the only stdout protocol message the harness
          // consumes. Drain later fixture diagnostics without retaining or
          // repeatedly reparsing the already-consumed ready JSON.
          child.stdout.resume();
        };
        const succeed = (value: SharedLoginFixture) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanup();
          resolve(value);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          cleanup();
          reject(error);
        };
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          for (const line of output.split('\n')) {
            if (line.startsWith(failurePrefix)) {
              let message = 'Unknown startup failure';
              try {
                const failure = JSON.parse(line.slice(failurePrefix.length)) as { message?: string };
                message = failure.message ?? message;
              } catch { /* Preserve the protocol failure without logging stdout. */ }
              fail(new Error(`Shared-login fixture reported startup failure: ${message}`));
              return;
            }
            if (!line.startsWith(readyPrefix)) continue;
            try {
              succeed(JSON.parse(line.slice(readyPrefix.length)) as SharedLoginFixture);
            } catch {
              fail(new Error('Shared-login fixture returned invalid ready JSON'));
            }
            return;
          }
          output = output.slice(output.lastIndexOf('\n') + 1);
        };
        const onError = () => fail(new Error('Shared-login fixture process failed to start'));
        const onExit = (code: number | null) => {
          if (code !== null && code !== 0) {
            fail(new Error('Shared-login fixture exited before ready'));
          }
        };
        const timeout = setTimeout(() => fail(new Error('Shared-login fixture startup timed out')), 120_000);
        child.stdout.on('data', onData);
        child.once('error', onError);
        child.once('exit', onExit);
      });
    } catch (error) {
      const diagnosticsDirectory = path.resolve('.test-data/inrupt-boundary');
      mkdirSync(diagnosticsDirectory, { recursive: true });
      writeFileSync(path.join(diagnosticsDirectory, `fixture-startup-${child.pid}.log`), startupDiagnostics, { mode: 0o600 });
      await this.stopPendingStart();
      throw error;
    }
    this.pendingChild = undefined;
    child.stderr.off('data', captureStartupDiagnostics);
    child.stderr.resume();
    return new SharedLoginHarness(child, ready);
  }

  async stop(): Promise<void> {
    try {
      await fetch(new URL('/control/shutdown', this.ready.controlUrl).toString(), {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The fixture may already have stopped after a failed test.
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      this.child.once('exit', finish);
      const termTimer = setTimeout(() => {
        this.child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (this.child.exitCode === null) this.child.kill('SIGKILL');
          finish();
        }, 5_000);
      }, 10_000);
    });
  }
}

async function assertFixtureUsesCurrentProducts(fixture: SharedLoginFixture): Promise<void> {
  const entries = [
    { path: '/status/overview', asset: /src="([^"]*\/dashboard\/assets\/dashboard-[^"]+\.js)"/u },
    { path: '/ai-connections', asset: /src="([^"]*\/settings\/assets\/settings-[^"]+\.js)"/u },
    { path: '/auth/callback', asset: /src="([^"]*\/auth\/callback\/assets\/auth-callback-[^"]+\.js)"/u },
  ] as const;

  for (const entry of entries) {
    const html = await fetch(new URL(entry.path, fixture.baseUrl), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    }).then((response) => response.text());
    const assetPath = html.match(entry.asset)?.[1];
    if (!assetPath) throw new Error(`Fixture entry ${entry.path} does not reference its product bundle`);
    const bundle = await fetch(new URL(assetPath, fixture.baseUrl), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    }).then((response) => response.text());
    expect(bundle, `${entry.path} must use the current shared account card`).toContain('data-selected-pod-url');
    expect(bundle, `${entry.path} must use the current shared account card`).toContain('Xpod ID');
  }
}

let fixture: SharedLoginHarness;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('Xpod shared login acceptance', () => {
  test.beforeAll(async () => {
    // The runtime startup contract is 120s, also for this setup hook.
    test.setTimeout(120_000);
    fixture = await SharedLoginHarness.start();
    await assertFixtureUsesCurrentProducts(fixture.ready);
  });

  test.afterAll(async () => {
    await fixture?.stop();
    // A timed-out hook can leave start() pending before fixture is assigned.
    await SharedLoginHarness.stopPendingStart();
  });

  test('@auth-boundary Status accepts a native Account session without an Inrupt session', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await establishNativeAccountSession(page, context, fixture.ready.accounts.alice);
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      const solidSession = await page.evaluate(() => ({
        currentSession: window.localStorage.getItem('solidClientAuthn:currentSession'),
        legacyAccountToken: window.sessionStorage.getItem('xpod.cssAccountToken'),
      }));
      expect(solidSession.currentSession).toBeNull();
      expect(solidSession.legacyAccountToken).toBeNull();
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('Status login establishes Account only, then AI Connections establishes WebID and Pod', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const accountTrace = await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
      expect(accountTrace.passwordSubmitted).toBe(true);
      expect(accountTrace.authorizationRequestSeen).toBe(false);
      expect(await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
      await expect(page.getByTestId('xpod-user-card-trigger')).toBeVisible();
      await expect(page.getByRole('button', { name: /continue with the current xpod identity|authorize/i })).toHaveCount(0);

      const trace = await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      assertRealOidcTrace(trace, { requirePassword: false });
      expect(trace.passwordSubmitted).toBe(false);
      try {
        await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await pageDiagnostics(page)}`);
      }
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
      await expect(page.locator('[data-testid="account-credentials-scroll"] input[type="password"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('@auth-boundary authenticated rail clicks cross product bundles without losing either session', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      await openRoute(page, '/status/overview');
      await expect.poll(() => isStatusAuthenticated(page)).toBe(true);
      await installAuthSurfaceMutationTrace(page);
      const destinations = [
        { label: 'AI Connections', path: '/ai-connections', ready: isPodSettingsReady },
        { label: 'Network', path: '/network', ready: isNetworkReady },
        { label: 'AI Config', path: '/ai-config/model-assignments', ready: isAiConfigReady },
        { label: 'Status', path: '/status/overview', ready: isStatusAuthenticated },
      ] as const;

      for (const destination of destinations) {
        const navigation = page.waitForURL((url) => url.pathname === destination.path, { timeout: 30_000 });
        await page.getByRole('link', { name: destination.label, exact: true }).click();
        await navigation;
        try {
          await expect.poll(() => destination.ready(page), {
            timeout: 30_000,
            message: `${destination.label} did not restore the authenticated product after a rail click`,
          }).toBe(true);
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await pageDiagnostics(page)}`);
        }
        const authTrace = await readAuthSurfaceMutationTrace(page);
        expect(authTrace.authPageSeen, `${destination.label} rail click flashed the login page`).toBe(false);
        expect(authTrace.dialogSeen, `${destination.label} rail click mounted a dialog`).toBe(false);
        expect(authTrace.modalSeen, `${destination.label} rail click mounted a modal surface`).toBe(false);
        await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
        await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
        await expect(page.getByText(/Could not connect to Xpod|Account unavailable|Not logged in/i).first()).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });

  test('the user card switches from Alice to Bob through explicit reauthentication', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      await page.getByTestId('xpod-user-card-trigger').click();
      const selectionRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.searchParams.get('response_type') === 'code'
          && url.searchParams.get('prompt') === 'login';
      });
      await page.getByRole('button', { name: 'Switch account', exact: true }).click();
      await selectionRequest;
      const trace = await completeOidcLogin(page, fixture.ready.accounts.bob, {
        baseUrl: fixture.ready.baseUrl,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
      });
      expect(trace.passwordSubmitted).toBe(true);
      const binding = await page.evaluate(() => JSON.parse(
        localStorage.getItem('xpod.auth.selected-storage.v1') ?? 'null',
      )?.binding);
      expect(binding).toEqual({
        webId: fixture.ready.accounts.bob.webId,
        storageUrl: fixture.ready.accounts.bob.podUrl,
      });
      expect(binding.webId).not.toBe(fixture.ready.accounts.alice.webId);
    } finally {
      await context.close();
    }
  });

  test('@auth-boundary AI Connections keeps its Inrupt session when Account controls fail', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let accountControlFailures = 0;
    try {
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      const sessionIdBeforeFailure = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      expect(sessionIdBeforeFailure).toBeTruthy();
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/.account/') {
          accountControlFailures += 1;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Account control plane unavailable' }),
          });
          return;
        }
        await route.continue();
      });

      await openRoute(page, '/ai-connections');
      try {
        await expect.poll(() => isPodWorkspaceContentReady(page), { timeout: 30_000 }).toBe(true);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await pageDiagnostics(page)}`);
      }
      expect(accountControlFailures).toBeGreaterThan(0);
      const sessionIdAfterFailure = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      expect(sessionIdAfterFailure).toBe(sessionIdBeforeFailure);
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
      await page.getByTestId('xpod-user-card-trigger').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByText('退出未完成', { exact: true })).toBeVisible();
      await page.unroute('**/*');
      await page.getByRole('button', { name: '重试退出', exact: true }).click();
      await expectAnonymousLoginCard(page);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('@auth-boundary WebID-only Status retains navigation and returns to AI Connections with the same session', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      assertRealOidcTrace(await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady));
      const sessionId = await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'));
      expect(sessionId).toBeTruthy();
      await context.clearCookies({ name: 'css-account' });
      // Refresh the existing Account Provider through its public context API.
      // This performs real discovery/controls requests without restarting SDK.
      await refetchBrowserAccountControls(page);
      const protectedRequests: string[] = [];
      page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith('/api/admin/') || pathname === '/service/status') protectedRequests.push(pathname);
      });
      await page.getByRole('link', { name: 'Status', exact: true }).click();
      await expect.poll(() => safePath(page.url())).toBe('/status/overview');
      await expect(page.getByTestId('web-account-page')).toBeVisible();
      await expect(page.getByRole('link', { name: 'AI Connections', exact: true })).toBeVisible();
      const controls = await page.evaluate(async () => {
        const response = await fetch('/.account/', { headers: { Accept: 'application/json' }, credentials: 'include' });
        return response.json() as Promise<{ controls?: { account?: Record<string, unknown> } }>;
      });
      expect(controls.controls?.account?.logout).toBeUndefined();
      expect(protectedRequests).toEqual([]);
      await page.getByRole('link', { name: 'AI Connections', exact: true }).click();
      await expect.poll(() => isPodWorkspaceContentReady(page), { timeout: 30_000 }).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBe(sessionId);
      await page.getByTestId('xpod-user-card-trigger').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expectAnonymousLoginCard(page);
    } finally {
      await context.close();
    }
  });

  test('@auth-boundary WebID failure does not clear the Account-backed Status session', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let blockedTokenRequests = 0;
    try {
      await establishNativeAccountSession(page, context, fixture.ready.accounts.alice);
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST'
          && (url.pathname.endsWith('/token') || url.pathname.includes('/oidc/token'))) {
          blockedTokenRequests += 1;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Injected Solid token failure' }),
          });
          return;
        }
        await route.continue();
      });

      await openRoute(page, '/ai-connections');
      const failedTrace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        failure: () => blockedTokenRequests > 0,
        requireCallbackEvidence: false,
        timeoutMs: 30_000,
      });
      expect(failedTrace.authorizationRequestSeen).toBe(true);
      await expect.poll(() => blockedTokenRequests, {
        timeout: 30_000,
        message: 'AI Connections did not exercise the injected WebID failure',
      }).toBeGreaterThan(0);
      // Wait for the failed callback to settle, either at its error or the
      // fresh consent opened by automatic recovery. The request counter alone
      // fires before the browser has received the injected token error.
      await expect.poll(async () => await isConsentReady(page)
        || await page.getByRole('alert').isVisible().catch(() => false), { timeout: 30_000 }).toBe(true);
      await page.unroute('**/*');

      await openRoute(page, '/status/overview');
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('WebID-first AI Config login leaves the Account session available to Status', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/ai-config/model-assignments', isAiConfigReady);
      assertRealOidcTrace(trace);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Model Assignments', exact: true })).toBeVisible();
      await expect(page.locator('[data-testid="model-assignment-row"]')).toHaveCount(6);
      await expect(page.getByText('Failed to read AI Config', { exact: true })).toHaveCount(0);
      await expect(page.getByText('System default', { exact: true })).toHaveCount(6);
      await expect(page).toHaveTitle('Xpod Settings');

      await page.getByRole('link', { name: /Document Processing/u }).click();
      await expect(page).toHaveURL(/\/ai-config\/document-processing$/u);
      const tableRecognition = page.getByRole('checkbox', { name: /Table recognition/u });
      await tableRecognition.check();
      const saved = page.waitForResponse((response) => (
        new URL(response.url()).pathname === '/api/ai/config'
        && response.request().method() === 'PATCH'
      ));
      await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
      expect((await saved).status()).toBe(200);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('checkbox', { name: /Table recognition/u })).toBeChecked({ timeout: 30_000 });

      await openRoute(page, '/status/overview');
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('an existing Account restores Status after reload without reopening the modal', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await page.getByTestId('xpod-user-card-trigger').click();
      const card = avatarCard(page);
      await expect(card).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(card).toContainText(/Account|alice/i);
    } finally {
      await context.close();
    }
  });

  test('Status overview presents runtime summary before one vertical three-service list', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);

      const serviceList = page.getByTestId('runtime-services-list');
      await expect(serviceList).toBeVisible({ timeout: 30_000 });
      const rows = page.getByTestId('runtime-service-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveAttribute('data-service-name', 'Gateway');
      await expect(rows.nth(1)).toHaveAttribute('data-service-name', 'Solid Server');
      await expect(rows.nth(2)).toHaveAttribute('data-service-name', 'API Server');
      await expect(serviceList).not.toContainText('Tunnel');

      const rowBoxes = await rows.evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) };
      }));
      expect(rowBoxes).toHaveLength(3);
      expect(rowBoxes[0]!.y).toBeLessThan(rowBoxes[1]!.y);
      expect(rowBoxes[1]!.y).toBeLessThan(rowBoxes[2]!.y);
      expect(new Set(rowBoxes.map((box) => box.x)).size).toBe(1);
      expect(new Set(rowBoxes.map((box) => box.width)).size).toBe(1);

      const summaryTop = await page.getByText('Xpod runtime', { exact: true }).evaluate((element) => element.getBoundingClientRect().top);
      const servicesTop = await serviceList.evaluate((element) => element.getBoundingClientRect().top);
      expect(summaryTop).toBeLessThan(servicesTop);
    } finally {
      await context.close();
    }
  });

  test('Avatar opens a consumer profile card beside the rail on desktop', async ({ browser }, testInfo) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await page.setViewportSize({ width: 960, height: 720 });
      await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);

      const trigger = page.getByTestId('xpod-user-card-trigger');
      await trigger.click();
      const card = avatarCard(page);
      await expect(card).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(card.getByRole('heading', { name: /alice/i })).toBeVisible();
      await expect(card).toContainText('Xpod ID');
      await expect(card).toContainText(/Pod connected|Account connected/);
      await expect(card.getByRole('link', { name: 'Pod settings' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Switch account' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expect(card).not.toContainText('WebID');

      const triggerBox = await requiredBox(trigger, 'avatar trigger');
      const cardBox = await requiredBox(card, 'avatar card');
      expect(cardBox.x).toBeGreaterThanOrEqual(triggerBox.x + triggerBox.width);
      expect(cardBox.y).toBeLessThanOrEqual(24);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(960);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(720);
      const screenshotPath = testInfo.outputPath('consumer-avatar-card-desktop.png');
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach('consumer-avatar-card-desktop', { path: screenshotPath, contentType: 'image/png' });
    } finally {
      await context.close();
    }
  });

  test('Avatar opens a consumer profile card above the bottom nav on narrow windows', async ({ browser }, testInfo) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await page.setViewportSize({ width: 520, height: 720 });
      await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);

      const trigger = page.getByTestId('xpod-user-card-trigger');
      await trigger.click();
      const card = avatarCard(page);
      await expect(card).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const triggerBox = await requiredBox(trigger, 'avatar trigger');
      const cardBox = await requiredBox(card, 'avatar card');
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(520);
      expect(cardBox.y).toBeGreaterThanOrEqual(0);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(triggerBox.y);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(720 - 56);
      const screenshotPath = testInfo.outputPath('consumer-avatar-card-narrow.png');
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach('consumer-avatar-card-narrow', { path: screenshotPath, contentType: 'image/png' });
    } finally {
      await context.close();
    }
  });

  test('anonymous startup mounts one sign-in card and no workspace shell', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);
      await expect(page.getByRole('button', { name: 'Close sign in', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Status', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Network', exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('applies one system color scheme to the full anonymous login surface', async ({ browser }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      try {
        await openRoute(page, '/status/overview');
        const loginRegion = page.getByTestId('web-account-panel');
        await expect(loginRegion).toBeVisible({ timeout: 30_000 });

        const colors = await loginRegion.evaluate((card) => {
          const root = document.documentElement;
          const body = document.body;
          const rootStyle = getComputedStyle(root);
          return {
            rootTheme: root.dataset.theme,
            colorScheme: root.style.colorScheme,
            bodyBackground: getComputedStyle(body).backgroundColor,
            cardBackground: getComputedStyle(card).backgroundColor,
            backgroundToken: rootStyle.getPropertyValue('--background').trim(),
            cardToken: rootStyle.getPropertyValue('--card').trim(),
          };
        });

        expect(colors.rootTheme).toBe(colorScheme);
        expect(colors.colorScheme).toBe(colorScheme);
        expect(colors.bodyBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(colors.cardBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(colors.backgroundToken).not.toBe('');
        expect(colors.cardToken).not.toBe('');
        if (colorScheme === 'dark') {
          expect(colors.bodyBackground).not.toBe('rgb(255, 255, 255)');
          expect(colors.cardBackground).not.toBe('rgb(255, 255, 255)');
        }
      } finally {
        await context.close();
      }
    }
  });

  test('multiple Pods preserve the exact selected accessible Pod after Account ownership removal', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const bob = fixture.ready.accounts.bob;
      const podUrls = bob.podUrls;
      expect(podUrls.length).toBeGreaterThanOrEqual(2);
      const pending = await login(page, bob, '/ai-connections', isConsentReady, false);
      assertOidcStartTrace(pending);
      const selectedBinding = bob.podBindings[1] ?? bob.podBindings[0]!;
      await chooseStorageBinding(page, selectedBinding.podUrl);
      const completed = await completeOidcLogin(page, bob, {
        baseUrl: fixture.ready.baseUrl,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 90_000,
      });
      assertRealOidcTrace({
        ...completed,
        authorizationRequestSeen: pending.authorizationRequestSeen,
        authCodeChallengeSeen: pending.authCodeChallengeSeen,
        authCodeChallengeMethodS256: pending.authCodeChallengeMethodS256,
        passwordSubmitted: pending.passwordSubmitted,
        authorizationRedirectUris: [
          ...pending.authorizationRedirectUris,
          ...completed.authorizationRedirectUris,
        ],
      });
      // The consent recovery entry hydrates the Pod-backed Settings runtime;
      // allow its large RDF browser chunk to finish on a cold build cache.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId('xpod-user-card-trigger')).toBeVisible();
      await page.getByTestId('xpod-user-card-trigger').click();
      await expect(avatarCard(page)).toHaveAttribute('data-selected-pod-url', selectedBinding.podUrl);

      const deleteResponse = await fetch(new URL('/control/delete-pod', fixture.ready.controlUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podUrl: selectedBinding.podUrl }),
      });
      if (deleteResponse.status !== 204) {
        throw new Error(`delete control failed ${deleteResponse.status} ${await deleteResponse.text()} url=${fixture.ready.controlUrl}`);
      }
      // Removing an Account ownership record does not revoke this WebID's
      // Solid ACL. The existing session must keep its exact accessible Pod;
      // Account directory state is not a second authorization authority.
      const sessionBeforeReload = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      expect(await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'))).toBe(sessionBeforeReload);
      await page.getByTestId('xpod-user-card-trigger').click();
      await expect(avatarCard(page)).toHaveAttribute('data-selected-pod-url', selectedBinding.podUrl);
      await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('exact-pair storage metadata conflicts expose deterministic retry recovery instead of silent selection', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await openRoute(page, '/ai-connections');
      let injectedCount = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && normalizeAccountPath(url.pathname) === '/.account/oidc/pick-webid/') {
          const response = await route.fetch();
          const payload = await response.json().catch(() => ({})) as { entries?: unknown };
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          const first = entries.find((entry): entry is Record<string, unknown> => (
            Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
              && typeof (entry as { webId?: unknown }).webId === 'string'
              && typeof (entry as { storageUrl?: unknown }).storageUrl === 'string')
          ));
          if (first) {
            payload.entries = [
              { ...first, label: 'Alice storage A' },
              { ...first, label: 'Alice storage B' },
              ...entries.slice(1),
            ];
            injectedCount += 1;
            await route.fulfill({ response, json: payload });
            return;
          }
        }
        await route.continue();
      });
      const completedLogin = completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 90_000,
      });
      await expect.poll(() => injectedCount, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText(/conflict|duplicated with incompatible metadata/i).first())
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /try again|重试/i }).first()).toBeVisible();
      await page.unroute('**/*');
      await page.getByRole('button', { name: /try again|重试/i }).first().click();
      const completed = await completedLogin;
      assertRealOidcTrace(completed);
      await expect(page.getByRole('button', { name: /authorize|continue/i })).toHaveCount(0);
      await expect(page.getByText(/duplicated with incompatible metadata/i)).toHaveCount(0);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('a real WebID token expiry clears the SDK restore marker and offers an explicit retry', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let tokenExpiresIn: number | undefined;
    let refreshTokenSeen = false;
    let refreshAttempts = 0;
    const observeTokenResponse = (response: import('@playwright/test').Response) => {
      const url = new URL(response.url());
      if (!url.pathname.endsWith('/token') && !url.pathname.includes('/oidc/token')) return;
      if (response.request().method() !== 'POST') return;
      const grantType = new URLSearchParams(response.request().postData() ?? '').get('grant_type');
      if (grantType !== 'authorization_code') return;
      void response.json().then((payload: unknown) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const expiresIn = (payload as { expires_in?: unknown }).expires_in;
        if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
          tokenExpiresIn = expiresIn;
        }
        refreshTokenSeen = typeof (payload as { refresh_token?: unknown }).refresh_token === 'string';
      }).catch(() => undefined);
    };
    page.on('response', observeTokenResponse);
    try {
      await page.clock.install();
      const trace = await login(page, fixture.ready.accounts.alice, '/ai-config/model-assignments', isAiConfigReady);
      assertRealOidcTrace(trace);
      await expect.poll(() => tokenExpiresIn, { timeout: 10_000 }).toBeGreaterThan(0);
      const sessionIdBeforeExpiry = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      expect(sessionIdBeforeExpiry).toBeTruthy();

      // A real Inrupt AuthCodeRedirectHandler schedules SESSION_EXPIRED from
      // expires_in (or emits it after a refresh failure). Deny only future
      // refresh-token grants; the initial authorization-code exchange above
      // remains untouched.
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const grantType = new URLSearchParams(request.postData() ?? '').get('grant_type');
        if (request.method() === 'POST'
          && (url.pathname.endsWith('/token') || url.pathname.includes('/oidc/token'))
          && grantType === 'refresh_token') {
          refreshAttempts += 1;
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'invalid_grant', error_description: 'expired browser token' }),
          });
          return;
        }
        await route.continue();
      });

      const advanceMs = Math.max(3_700_000, ((tokenExpiresIn ?? 3_600) + 30) * 1_000);
      await page.clock.fastForward(advanceMs);
      await expect(page.getByTestId('auth-surface-page').getByText(/^(?:Session expired|登录状态已失效|会话已过期)$/i))
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /try again|使用 webid 登录|重试|重新登录/i }).first()).toBeVisible();
      expect(refreshTokenSeen).toBe(true);
      expect(refreshAttempts).toBeGreaterThan(0);
      const sessionIdAtExpiry = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      expect(sessionIdAtExpiry).toBeNull();

      // fastForward pauses the emulated clock after firing the expiry timer;
      // resume it before exercising the retry navigation.
      await page.clock.resume();
      await page.getByRole('button', { name: /try again|使用 webid 登录|重试|重新登录/i }).first().click();
      await expect.poll(
        () => page.evaluate(() => window.sessionStorage.getItem('xpod.auth.transaction.v1.active')),
        { timeout: 10_000 },
      ).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      await expect(page.getByText(/另一个页面正在完成登录/u)).toHaveCount(0);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('fresh registration from AI Connections resumes consent and returns to AI Connections', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const account = { email: `registration-${suffix}@example.com`, password: `Register-${suffix}-Pass123!` };
    const navigations: string[] = [];
    const consentResponses: Array<{ status: number; hasClient: boolean }> = [];
    const pending: Promise<void>[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(safePath(frame.url()));
    });
    page.on('response', (response) => {
      if (normalizeAccountPath(new URL(response.url()).pathname) === '/.account/oidc/consent/' && response.request().method() === 'GET') {
        pending.push(response.json().then((body: { client?: unknown }) => {
          consentResponses.push({ status: response.status(), hasClient: Boolean(body.client) });
        }).catch(() => undefined));
      }
    });
    try {
      const initial = await completeOidcLogin(page, account, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        requireCallbackEvidence: false,
        ready: async (current) => safePath(current.url()).startsWith('/.account/')
          && await current.getByRole('button', { name: '创建账号', exact: true }).isVisible(),
      });
      expect(initial.authorizationRequestSeen).toBe(true);
      expect(initial.passwordSubmitted).toBe(false);
      await page.getByRole('button', { name: '创建账号', exact: true }).click();
      await page.locator('input[name="username"]').fill(`register-${suffix}`);
      await page.locator('input[name="email"]').fill(account.email);
      await page.locator('input[name="password"]').fill(account.password);
      await page.locator('input[name="confirmation"]').fill(account.password);
      await page.getByRole('button', { name: '创建账号', exact: true }).click();
      await expect.poll(async () => {
        if (await isConsentReady(page)) return 'consent';
        const current = safePath(page.url());
        if (current.startsWith('/status/') || current.startsWith('/dashboard')) return `unexpected:${current}`;
        return current;
      }, { timeout: 45_000, message: 'Registration must resume the pending consent before entering a product' }).toBe('consent');
      const completed = await completeOidcLogin(page, account, {
        baseUrl: fixture.ready.baseUrl,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
      });
      expect(completed.callbackHasCode).toBe(true);
      expect(completed.callbackHasState).toBe(true);
      expect(completed.tokenAuthorizationCodeGrantSeen).toBe(true);
      await expect(page).toHaveURL(new URL('/ai-connections', fixture.ready.baseUrl).href);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveAttribute('data-pod-ready', 'true');
      expect(navigations.filter((entry) => entry.startsWith('/status/') || entry.startsWith('/dashboard'))).toEqual([]);
      await Promise.all(pending);
      expect(consentResponses.some((entry) => entry.status === 200 && entry.hasClient)).toBe(true);
    } finally {
      await Promise.all(pending);
      await test.info().attach('registration-navigation', {
        body: JSON.stringify({ navigations, consentResponses }), contentType: 'application/json',
      });
      await context.close();
    }
  });

  test('a new Account automatically creates its first storage and waits for its binding before consent', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    const observations: Array<{ order: number; kind: 'created' | 'empty-bindings' | 'ready-bindings' | 'consent' }> = [];
    const pending: Promise<void>[] = [];
    let order = 0;
    const observeRequest = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST' && normalizeAccountPath(new URL(request.url()).pathname) === '/.account/oidc/consent/') {
        observations.push({ order: order++, kind: 'consent' });
      }
    };
    const observeResponse = (response: import('@playwright/test').Response) => {
      const pathname = normalizeAccountPath(new URL(response.url()).pathname);
      if (response.request().method() === 'POST' && pathname.startsWith('/.account/') && /\/pod\/?$/u.test(pathname) && response.ok()) {
        observations.push({ order: order++, kind: 'created' });
      }
      if (response.request().method() === 'GET' && pathname === '/.account/oidc/pick-webid/' && response.ok()) {
        const responseOrder = order++;
        pending.push(response.json().then((payload: { entries?: unknown[] }) => {
          if (!Array.isArray(payload.entries)) throw new Error('Missing authoritative storage binding entries');
          observations.push({ order: responseOrder, kind: payload.entries.length ? 'ready-bindings' : 'empty-bindings' });
        }));
      }
    };
    page.on('request', observeRequest);
    page.on('response', observeResponse);
    try {
      const trace = await login(page, fixture.ready.accounts.newAccount, '/ai-connections', isPodSettingsReady);
      assertRealOidcTrace(trace);
      await Promise.all(pending);
      const created = observations.filter(({ kind }) => kind === 'created');
      expect(created).toHaveLength(1);
      expect(observations.some((entry) => entry.kind === 'empty-bindings' && entry.order < created[0].order)).toBe(true);
      const bound = observations.find((entry) => entry.kind === 'ready-bindings' && entry.order > created[0].order);
      expect(bound).toBeDefined();
      const approved = observations.find(({ kind }) => kind === 'consent');
      expect(approved).toBeDefined();
      expect(bound!.order).toBeLessThan(approved!.order);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveAttribute('data-pod-ready', 'true');
    } finally {
      page.off('request', observeRequest);
      page.off('response', observeResponse);
      await context.close();
    }
  });

  test('gates protected product routes behind the same single login card while local service pages stay available', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);

      await openRoute(page, '/network');
      await expect(page.getByTestId('auth-surface-modal')).toHaveCount(0);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
      await expect(page.locator('[data-workspace-layout]')).toBeVisible({ timeout: 30_000 });

      await openRoute(page, '/ai-connections');
      await expectAnonymousLoginCard(page);
      await expect(page.getByRole('button', { name: /continue|authorize/i })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('uses the fixed same-origin callback and returns to the original safe route', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/ai-config/model-assignments?surface=providers', isAiConfigReady);
      assertRealOidcTrace(trace);
      expect(new URL(page.url()).origin).toBe(new URL(fixture.ready.baseUrl).origin);
      expect(new URL(page.url()).pathname).toBe('/ai-config/model-assignments');
      expect(new URL(page.url()).search).toBe('?surface=providers');
      // Host transaction matching is carried by SDK OIDC state and the
      // tab-local consumed record, never by a variable redirect URI.
      expect(trace.authorizationRedirectUris.some((value) => {
        const redirect = new URL(value);
        return redirect.origin === new URL(fixture.ready.baseUrl).origin
          && redirect.pathname === '/auth/callback'
          && redirect.search === ''
          && redirect.hash === '';
      })).toBe(true);
    } finally {
      await context.close();
    }
  });

  for (const order of [[0, 1], [1, 0]]) {
    test(`two same-origin tabs complete interleaved logins in order ${order.map((index) => index === 0 ? 'A' : 'B').join(' then ')}`, async ({ browser }) => {
      const { context, page } = await scenarioPage(browser);
      const secondPage = await context.newPage();
      try {
        await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
        const pages = [page, secondPage];
        const starts = [];
        for (const current of pages) {
          starts.push(await login(current, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false));
          expect(new URL(current.url()).pathname).toMatch(/^\/\.account\/interaction\/[^/]+\/oidc\/consent\/$/u);
        }
        expect(new URL(page.url()).pathname).not.toBe(new URL(secondPage.url()).pathname);
        for (const index of order) {
          const completion = await completeOidcLogin(pages[index], fixture.ready.accounts.alice, {
            baseUrl: fixture.ready.baseUrl,
            ready: isPodSettingsReady,
            requireCallbackEvidence: true,
            timeoutMs: 30_000,
          });
          assertRealOidcTrace({ ...completion,
            authorizationRequestSeen: starts[index].authorizationRequestSeen,
            authCodeChallengeSeen: starts[index].authCodeChallengeSeen,
            authCodeChallengeMethodS256: starts[index].authCodeChallengeMethodS256,
          }, { requirePassword: false });
          await expect(pages[index].getByText(/另一个页面正在完成登录/u)).toHaveCount(0);
        }
        for (const current of pages) await expect.poll(() => isPodSettingsReady(current)).toBe(true);
      } finally {
        await context.close();
      }
    });
  }

  for (const cookieCase of ['missing', 'other interaction', 'tampered signature'] as const) {
    test(`scoped interaction rejects ${cookieCase} cookie without consuming either login`, async ({ browser }) => {
      const { context, page } = await scenarioPage(browser);
      const secondPage = await context.newPage();
      const outsider = await browser.newContext();
      try {
        await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
        await login(page, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false);
        await login(secondPage, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false);
        const target = new URL(page.url());
        const other = new URL(secondPage.url());
        expect(target.pathname).toMatch(/^\/\.account\/interaction\/[^/]+\//u);
        expect(target.pathname).not.toBe(other.pathname);
        if (cookieCase !== 'missing') {
          const otherCookies = (await context.cookies(cookieCase === 'other interaction' ? other.href : target.href))
            .filter((cookie) => cookie.name.startsWith('_interaction'));
          expect(otherCookies.length).toBeGreaterThan(0);
          if (cookieCase === 'tampered signature') {
            const signature = otherCookies.find((cookie) => cookie.name === '_interaction.sig');
            expect(signature).toBeDefined();
            signature!.value = 'invalid-signature';
          }
          // Deliberately send B's real signed cookie to A. No forged cookie,
          // account credential, or synthetic authorization response is used.
          await outsider.addCookies(otherCookies.map((cookie) => ({ ...cookie, path: '/' })));
        }
        const response = await outsider.request.get(target.href, {
          headers: { Accept: 'application/json' }, maxRedirects: 0,
        });
        expect(response.status()).toBe(400);
        expect(await response.text()).toContain('Invalid OIDC interaction');
        for (const current of [page, secondPage]) {
          const trace = await completeOidcLogin(current, fixture.ready.accounts.alice, {
            baseUrl: fixture.ready.baseUrl, ready: isPodSettingsReady,
            requireCallbackEvidence: true, timeoutMs: 30_000,
          });
          expect(trace.callbackHasState).toBe(true);
          expect(trace.callbackHasCode).toBe(true);
          expect(trace.tokenAuthorizationCodeGrantSeen).toBe(true);
          expect(trace.tokenCodeVerifierSeen).toBe(true);
        }
      } finally {
        await outsider.close();
        await context.close();
      }
    });
  }

  test('cancelling interaction A leaves pending interaction B usable', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    const secondPage = await context.newPage();
    try {
      await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false);
      const start = await login(secondPage, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false);
      await page.getByRole('button', { name: /^(?:deny|拒绝)$/i }).click();
      await expect(page.getByRole('button', { name: /重新登录|返回并重试/i }).first()).toBeVisible();
      const trace = await completeOidcLogin(secondPage, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl, ready: isPodSettingsReady,
        requireCallbackEvidence: true, timeoutMs: 30_000,
      });
      assertRealOidcTrace({ ...trace,
        authorizationRequestSeen: start.authorizationRequestSeen,
        authCodeChallengeSeen: start.authCodeChallengeSeen,
        authCodeChallengeMethodS256: start.authCodeChallengeMethodS256,
      }, { requirePassword: false });
    } finally {
      await context.close();
    }
  });

  test('consent denial and unsafe return paths expose deterministic recovery', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const accountTrace = await login(page, fixture.ready.accounts.alice, '/status/overview', isStatusAuthenticated, false);
      expect(accountTrace.passwordSubmitted).toBe(true);
      // Starting from an existing Account presents explicit consent instead
      // of racing the one-binding auto-approval immediately after passwords.
      const denied = await login(page, fixture.ready.accounts.alice, '/ai-connections', isConsentReady, false);
      assertOidcStartTrace({ ...denied, passwordSubmitted: accountTrace.passwordSubmitted });
      expect(denied.passwordSubmitted).toBe(false);
      // The full-page consent surface exposes Deny as its real cancellation
      // action; it does not pretend that the callback page has a dismiss
      // control before a failure is rendered.
      await expect(page.getByRole('button', { name: /^(?:deny|拒绝)$/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^(?:dismiss|关闭)$/i })).toHaveCount(0);
      await page.getByRole('button', { name: /^(?:deny|拒绝)$/i }).click();
      await expect.poll(() => safePath(page.url()), { timeout: 30_000 })
        .toMatch(/^(?:\/ai-connections|\/status\/overview|\/auth\/callback)$/u);
      const recover = page.getByRole('button', { name: /重新登录|返回并重试/i }).first();
      await expect(recover).toBeVisible();
      // Use the offered recovery action before starting another transaction.
      await recover.click();
      await expect.poll(() => safePath(page.url()), { timeout: 30_000 }).toBe('/ai-connections');
      const restarted = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        ready: isConsentReady,
        requireCallbackEvidence: false,
        timeoutMs: 30_000,
      });
      await page.addInitScript(() => {
        const callback = new URL(window.location.href);
        if (callback.pathname === '/auth/callback' && callback.searchParams.has('code')) {
            const activeKey = 'xpod.auth.transaction.v1.active';
            const transactionId = window.sessionStorage.getItem(activeKey);
            if (!transactionId) throw new Error('Missing active transaction for unsafe-return acceptance');
            const recordKey = `xpod.auth.transaction.v1.record.${transactionId}`;
            const raw = window.sessionStorage.getItem(recordKey);
            if (!raw) throw new Error('Missing transaction record for unsafe-return acceptance');
            const record = JSON.parse(raw) as { transaction?: { returnTo?: string } };
            if (!record.transaction) throw new Error('Malformed transaction record for unsafe-return acceptance');
            record.transaction.returnTo = 'https://evil.example/steal';
            window.sessionStorage.setItem(recordKey, JSON.stringify(record));
            window.sessionStorage.setItem('xpod.test.unsafe-return-injected', '1');
        }
      });
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        failure: async (currentPage) => currentPage
          .getByRole('alert')
          .isVisible({ timeout: 100 })
          .catch(() => false),
        timeoutMs: 30_000,
      });
      expect(await page.evaluate(() => window.sessionStorage.getItem('xpod.test.unsafe-return-injected'))).toBe('1');
      assertOidcStartTrace({ ...restarted, passwordSubmitted: accountTrace.passwordSubmitted });
      expect(trace.redirectCodeSeen).toBe(true);
      expect(trace.callbackPathSeen).toBe(true);
      expect(trace.callbackHasCode).toBe(true);
      expect(trace.callbackHasState).toBe(true);
      // The mutated host return path is rejected before handing the real
      // one-time authorization code to the SDK.
      expect(trace.tokenAuthorizationCodeGrantSeen).toBe(false);
      expect(trace.tokenCodeVerifierSeen).toBe(false);
      expect(new URL(page.url()).origin).toBe(new URL(fixture.ready.baseUrl).origin);
      // Invalid host records are rejected while loading the transaction,
      // before the later return-route validator can expose a specific error.
      expect(safePath(page.url())).toBe('/auth/callback');
      await expect(page.getByRole('alert')).toContainText(/这次登录请求已经失效|Xpod 已阻止异常的(?:登录来源|返回地址)/u);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /重新登录/i }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('an unsupported authorization request exposes provider recovery without claiming a state mismatch', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const authorizationStates = new Set<string>();
      const errorCallbacks: URL[] = [];
      let injectedAuthorizations = 0;
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('state')) {
          authorizationStates.add(url.searchParams.get('state')!);
        }
        if (url.origin === new URL(fixture.ready.baseUrl).origin
          && url.pathname === '/auth/callback' && url.searchParams.has('error')) {
          errorCallbacks.push(url);
        }
      });
      // Inject an unsupported request option; the real identity provider must
      // reject it, and the host must present that error without accepting an identity.
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('client_id')) {
          url.searchParams.set('prompt', 'unsupported-acceptance-prompt');
          injectedAuthorizations += 1;
          await route.continue({ url: url.href });
        } else {
          await route.continue();
        }
      });
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        failure: (currentPage) => currentPage.getByRole('alert')
          .filter({ hasText: '身份服务未能完成此次授权' }).isVisible().catch(() => false),
        timeoutMs: 30_000,
      });
      // Inrupt may clean the callback URL; inspect the actual incoming request.
      expect(injectedAuthorizations).toBe(1);
      expect(errorCallbacks).toHaveLength(1);
      expect(errorCallbacks[0].searchParams.get('error')).toBe('invalid_request');
      expect(errorCallbacks[0].searchParams.get('error_description')).toContain('unsupported prompt value requested');
      expect(authorizationStates.has(errorCallbacks[0].searchParams.get('state')!)).toBe(true);
      expect(trace.callbackHasState).toBe(true);
      expect(trace.callbackHasCode).toBe(false);
      expect(trace.tokenAuthorizationCodeGrantSeen).toBe(false);
      await expect(page.getByText('登录页面与当前会话不再匹配，请重新登录。')).toHaveCount(0);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
      await page.unroute('**/*');
      await page.getByRole('button', { name: '重新登录', exact: true }).click();
      await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl, ready: isPodSettingsReady, requireCallbackEvidence: true,
      });
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveAttribute('data-pod-ready', 'true');
    } finally {
      await context.close();
    }
  });

  test('lost host transaction fails closed after a real provider response without redeeming its code', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await page.addInitScript(() => {
        const callback = new URL(window.location.href);
        if (callback.pathname !== '/auth/callback' || !callback.searchParams.has('code')) return;
        const activeKey = 'xpod.auth.transaction.v1.active';
        const transactionId = window.sessionStorage.getItem(activeKey);
        if (!transactionId) throw new Error('Missing host transaction before loss injection');
        window.sessionStorage.removeItem(`xpod.auth.transaction.v1.record.${transactionId}`);
        window.sessionStorage.removeItem(activeKey);
        window.sessionStorage.setItem('xpod.test.host-transaction-removed', '1');
      });
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        failure: (currentPage) => currentPage.getByRole('alert')
          .filter({ hasText: /这次登录请求已经失效|登录信息不完整/u })
          .isVisible({ timeout: 100 }).catch(() => false),
        requireCallbackEvidence: false,
        timeoutMs: 45_000,
      });
      assertOidcStartTrace(trace);
      expect(trace.callbackPathSeen).toBe(true);
      expect(trace.callbackHasCode).toBe(true);
      expect(trace.callbackHasState).toBe(true);
      expect(trace.tokenAuthorizationCodeGrantSeen).toBe(false);
      expect(await page.evaluate(() => window.sessionStorage.getItem('xpod.test.host-transaction-removed'))).toBe('1');
      await expect(page.getByRole('button', { name: /重新登录/i }).first()).toBeVisible();
      expect(safePath(page.url())).toBe('/auth/callback');
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('reopening a completed callback returns to the product route without redeeming the code again', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let callbackHref: string | undefined;
    let authorizationCodeTokenRequests = 0;
    const captureCallback = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url());
      if (url.pathname === '/auth/callback' && url.searchParams.has('code')) callbackHref ??= url.href;
      if (callbackHref && request.method() === 'POST'
        && (url.pathname.endsWith('/token') || url.pathname.includes('/oidc/token'))
        && new URLSearchParams(request.postData() ?? '').get('grant_type') === 'authorization_code'
        && new URLSearchParams(request.postData() ?? '').get('code') === new URL(callbackHref).searchParams.get('code')) {
        authorizationCodeTokenRequests += 1;
      }
    };
    page.on('request', captureCallback);
    try {
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 90_000,
      });
      assertRealOidcTrace(trace);
      expect(callbackHref).toBeTruthy();
      await expect.poll(() => authorizationCodeTokenRequests, { timeout: 10_000 }).toBeGreaterThan(0);
      const tokenRequestsBeforeReplay = authorizationCodeTokenRequests;
      await page.evaluate(() => window.localStorage.removeItem('solidClientAuthn:currentUrl'));
      const replay = new URL(callbackHref!);
      await page.goto(replay.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect.poll(() => safePath(page.url()), { timeout: 10_000 }).toBe('/ai-connections');
      await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      expect(authorizationCodeTokenRequests).toBe(tokenRequestsBeforeReplay);
      await expect(page.getByText(/登录页面与当前会话不再匹配/u)).toHaveCount(0);
      await expect(page.getByText(/Unable to complete Xpod sign-in/i)).toHaveCount(0);

      const tampered = new URL(callbackHref!);
      tampered.searchParams.set('state', 'invalid-state-from-browser-test');
      const sessionBeforeTampering = await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'));
      await page.getByTestId('xpod-user-card-trigger').click();
      const identityBeforeTampering = await avatarCard(page).innerText();
      const podBeforeTampering = await avatarCard(page).getAttribute('data-selected-pod-url');
      // A valid pre-existing session may restore its own same-origin route
      // using the SDK marker without accepting the supplied authorization.
      await page.goto(tampered.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect.poll(async () => await isPodSettingsReady(page)
        || await page.getByRole('alert').isVisible().catch(() => false), { timeout: 30_000 }).toBe(true);
      expect(authorizationCodeTokenRequests).toBe(tokenRequestsBeforeReplay);
      if (await isPodSettingsReady(page)) {
        expect(safePath(page.url())).toBe('/ai-connections');
        expect(await page.evaluate(() => window.localStorage.getItem('solidClientAuthn:currentSession'))).toBe(sessionBeforeTampering);
        await page.getByTestId('xpod-user-card-trigger').click();
        await expect(avatarCard(page)).toHaveText(identityBeforeTampering);
        await expect(avatarCard(page)).toHaveAttribute('data-selected-pod-url', podBeforeTampering!);
      } else {
        expect(safePath(page.url())).toBe('/auth/callback');
        await expect(page.getByRole('button', { name: /重新登录/i })).toBeVisible();
      }
      expect(await page.evaluate(() => Object.keys(window.sessionStorage)
        .filter((key) => key.startsWith('xpod.auth.callback.completed.v1.'))
        .some((key) => window.sessionStorage.getItem(key)?.includes('invalid-state-from-browser-test')))).toBe(false);
      // Without that independent restore marker, an unknown state must fail
      // closed instead of matching the previous completed callback.
      await page.evaluate(() => window.localStorage.removeItem('solidClientAuthn:currentUrl'));
      await page.goto(tampered.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
      expect(safePath(page.url())).toBe('/auth/callback');
      expect(authorizationCodeTokenRequests).toBe(tokenRequestsBeforeReplay);
      await expect(page.getByRole('button', { name: /重新登录/i })).toBeVisible();
    } finally {
      page.off('request', captureCallback);
      await context.close();
    }
  });

  test('one logout clears both domains and retries only the failed Account step', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let accountLogoutRequests = 0;
    try {
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname.includes('logout')) {
          accountLogoutRequests += 1;
          if (accountLogoutRequests <= 2) {
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
            return;
          }
        }
        await route.continue();
      });
      await page.getByTestId('xpod-user-card-trigger').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expect(page.getByText('退出未完成', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('alert')).toBeVisible();
      expect(accountLogoutRequests).toBe(1);
      await page.getByRole('button', { name: '重试退出', exact: true }).click();
      await expect.poll(() => accountLogoutRequests).toBe(2);
      await expect(page.getByText('退出未完成', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '重试退出', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '重试退出', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expectAnonymousLoginCard(page);
      expect(accountLogoutRequests).toBe(3);
      await expect(avatarCard(page)).toHaveCount(0);
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('one logout retries only WebID when Solid session cleanup fails', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let accountLogoutRequests = 0;
    const countAccountLogout = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.includes('logout')) accountLogoutRequests += 1;
    };
    page.on('request', countAccountLogout);
    try {
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      await page.evaluate(() => {
        const nativeRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function removeItem(key: string) {
          if (key === 'solidClientAuthn:currentSession') {
            Storage.prototype.removeItem = nativeRemoveItem;
            throw new Error('Injected Solid session cleanup failure');
          }
          return nativeRemoveItem.call(this, key);
        };
      });

      await page.getByTestId('xpod-user-card-trigger').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expect(page.getByText('退出未完成', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('alert')).toBeVisible();
      expect(accountLogoutRequests).toBe(0);

      await page.getByRole('button', { name: '重试退出', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expectAnonymousLoginCard(page);
      await expect(avatarCard(page)).toHaveCount(0);
      expect(accountLogoutRequests).toBe(1);
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);
    } finally {
      page.off('request', countAccountLogout);
      await context.close();
    }
  });

  test('@offline Account login reports network loss and retries without creating a WebID session', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);
      await page.locator('input[type="email"]').fill(fixture.ready.accounts.alice.email);
      await page.locator('input[type="password"]').fill(fixture.ready.accounts.alice.password);
      const submit = page.getByTestId('web-account-page').getByRole('button', { name: '登录', exact: true });
      await context.setOffline(true);
      await submit.click();
      await expect(page.getByText('登录失败，请重试。', { exact: true })).toBeVisible();
      await expect(submit).toBeEnabled();
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
      await context.setOffline(false);
      await submit.click();
      await expect.poll(() => isStatusAuthenticated(page), { timeout: 30_000 }).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('solidClientAuthn:currentSession'))).toBeNull();
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });

  test('@offline an authenticated applet keeps its identity across failed Pod access and network recovery', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      assertRealOidcTrace(await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady));
      const resourcePath = `offline-recovery-${Date.now()}.txt`;
      const body = 'private Pod content across network loss';
      const write = await fetchBrowserXpodPod(page, resourcePath, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body,
      });
      expect([200, 201, 204, 205]).toContain(write.status);
      await verifyOfflinePodRecovery(page, context, resourcePath, body);
      expect([200, 204, 205]).toContain((await fetchBrowserXpodPod(page, resourcePath, { method: 'DELETE' })).status);
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });

  test('@offline product logout retains a failed Account cleanup step until the network returns', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      assertRealOidcTrace(await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady));
      await completeOfflineProductLogout(page, context);
      await expectAnonymousLoginCard(page);
      await openRoute(page, '/status/overview');
      await expectAnonymousLoginCard(page);
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  });

  test('@offline a disconnected callback fails closed and retries with a fresh authorization code', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let blockedExchanges = 0;
    let blockedCode: string | null = null;
    const successfulCodes: string[] = [];
    try {
      await page.route('**/*', async (route) => {
        const request = route.request();
        const form = new URLSearchParams(request.postData() ?? '');
        if (request.method() === 'POST' && form.get('grant_type') === 'authorization_code') {
          blockedExchanges += 1;
          blockedCode = form.get('code');
          await context.setOffline(true);
          await route.abort('internetdisconnected');
          return;
        }
        await route.continue();
      });
      const failed = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/ai-connections', fixture.ready.baseUrl).href,
        failure: (currentPage) => currentPage.getByRole('alert').isVisible().catch(() => false),
        timeoutMs: 30_000,
      });
      expect(blockedExchanges).toBe(1);
      expect(blockedCode).toBeTruthy();
      expect(failed.callbackHasCode).toBe(true);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
      await expect(page.locator('[data-pod-ready="true"]')).toHaveCount(0);
      await page.unroute('**/*');
      await context.setOffline(false);
      page.on('response', (response) => {
        const request = response.request();
        const form = new URLSearchParams(request.postData() ?? '');
        if (response.ok() && form.get('grant_type') === 'authorization_code') {
          successfulCodes.push(form.get('code')!);
        }
      });
      await page.getByRole('button', { name: '重新登录', exact: true }).click();
      await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl, ready: isPodSettingsReady, requireCallbackEvidence: true,
      });
      expect(successfulCodes).toHaveLength(1);
      expect(successfulCodes[0]).not.toBe(blockedCode);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveAttribute('data-pod-ready', 'true');
    } finally {
      await context.setOffline(false);
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('renders one Xpod identity control with no provider chooser or second login/logout path', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      // Bob's multi-Pod recovery scenario above intentionally deletes one of
      // his bindings; use the stable single-Pod account for this invariant.
      await login(page, fixture.ready.accounts.alice, '/ai-connections', isPodSettingsReady);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /cloud|local|custom issuer|external webid|external pod/i })).toHaveCount(0);
      await page.getByTestId('xpod-user-card-trigger').click();
      const card = avatarCard(page);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
      await expect(card.getByRole('button', { name: 'Switch account', exact: true })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

async function isStatusAuthenticated(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  return url.pathname.startsWith('/status')
    && await page.locator('[data-testid="xpod-user-card-trigger"][aria-label^="Open account menu for "]').isVisible({ timeout: 250 }).catch(() => false);
}

async function isPodSettingsReady(page: Page): Promise<boolean> {
  if (!await isPodWorkspaceContentReady(page)) return false;
  return await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]')
    .isVisible({ timeout: 250 }).catch(() => false);
}

async function isPodWorkspaceContentReady(page: Page): Promise<boolean> {
  const pathname = new URL(page.url()).pathname;
  if (!pathname.startsWith('/settings') && !pathname.startsWith('/ai-connections') && !pathname.startsWith('/ai-config')) return false;
  const workspace = page.locator('[data-workspace-layout]').first();
  if (!await workspace.isVisible({ timeout: 250 }).catch(() => false)) return false;
  return await page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first()
    .count() > 0;
}

async function isNetworkReady(page: Page): Promise<boolean> {
  return new URL(page.url()).pathname.startsWith('/network')
    && await page.locator('[data-testid="xpod-user-card-trigger"][aria-label^="Open account menu for "]').isVisible({ timeout: 250 }).catch(() => false)
    && await page.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 }).catch(() => false);
}

async function isAiConfigReady(page: Page): Promise<boolean> {
  const pathname = new URL(page.url()).pathname;
  if (!pathname.startsWith('/ai-config')) return false;
  if (!await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible({ timeout: 250 }).catch(() => false)) return false;
  if (!await page.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 }).catch(() => false)) return false;
  return await page.getByRole('heading', { name: /AI Config ·/u }).first()
    .isVisible({ timeout: 250 }).catch(() => false);
}

async function expectAnonymousLoginCard(page: Page): Promise<void> {
  const accountRoute = new URL(page.url()).pathname.startsWith('/status');
  await expect(page.getByTestId(accountRoute ? 'web-account-page' : 'auth-surface-page')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId(accountRoute ? 'web-account-page' : 'auth-surface-page')).toBeVisible({ timeout: 30_000 });
  if (accountRoute) {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('web-account-panel')).toHaveCount(1);
    await expect(page.locator('input[type="email"]')).toHaveCount(1);
    await expect(page.locator('input[type="password"]')).toHaveCount(1);
  } else {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(?:登录|sign in|使用 .+ 登录)$/i })).toHaveCount(1);
  }
  await expect(page.locator('[data-workspace-layout]')).toHaveCount(0);
  await expect(page.locator('[data-list-navigation]')).toHaveCount(0);
}

async function pageDiagnostics(page: Page): Promise<string> {
  const body = await page.locator('body').innerText({ timeout: 1_000 })
    .then((value) => value.replace(/\s+/gu, ' ').trim().slice(0, 500))
    .catch(() => '<unavailable>');
  return `url=${safePath(page.url())}; body=${body}`;
}

async function isConsentReady(page: Page): Promise<boolean> {
  const path = safePath(page.url());
  if (path !== '/.account/oidc/consent/') return false;
  return await page.getByRole('button', { name: /^(?:deny|拒绝)$/i }).isVisible({ timeout: 250 }).catch(() => false);
}

async function scenarioPage(browser: { newContext(): Promise<BrowserContext> }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const diagnosticPath = process.env.XPOD_LOGIN_CDP_DIAGNOSTICS;
  if (diagnosticPath) {
    const requests = new Set<string>();
    const record = (event: string, data: Record<string, unknown>) => {
      appendFileSync(diagnosticPath, `${JSON.stringify({ time: Date.now(), event, ...data })}\n`);
    };
    cdp.on('Network.requestWillBeSent', (event) => {
      const pathname = new URL(event.request.url).pathname;
      if (!pathname.includes('/assets/') || !pathname.endsWith('.js')) return;
      requests.add(event.requestId);
      record('request', { requestId: event.requestId, pathname, timestamp: event.timestamp });
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
      if (requests.has(event.requestId)) record('requestExtraInfo', { requestId: event.requestId });
    });
    cdp.on('Network.responseReceivedExtraInfo', (event) => {
      if (requests.has(event.requestId)) record('responseExtraInfo', { requestId: event.requestId, status: event.statusCode });
    });
    cdp.on('Network.responseReceived', (event) => {
      if (!requests.has(event.requestId)) return;
      const { status, connectionId, connectionReused, remoteIPAddress, remotePort, timing, fromDiskCache, fromServiceWorker } = event.response;
      record('response', { requestId: event.requestId, status, connectionId, connectionReused, remoteIPAddress, remotePort, timing, fromDiskCache, fromServiceWorker });
    });
    cdp.on('Network.loadingFinished', (event) => {
      if (requests.has(event.requestId)) record('finished', { requestId: event.requestId, timestamp: event.timestamp });
    });
    cdp.on('Network.loadingFailed', (event) => {
      if (requests.has(event.requestId)) record('failed', { requestId: event.requestId, errorText: event.errorText, canceled: event.canceled });
    });
  }
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  return { context, page };
}

async function establishNativeAccountSession(
  page: Page,
  context: BrowserContext,
  account: BrowserSolidCredentials,
): Promise<void> {
  await openRoute(page, '/status/overview');
  const accountToken = await page.evaluate(async ({ email, password }) => {
    const response = await fetch('/.account/login/password/', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password, remember: true }),
    });
    if (!response.ok) throw new Error(`Account login failed: HTTP ${response.status}`);
    const body = await response.json() as { authorization?: string };
    if (!body.authorization) throw new Error('Account login returned no authorization token');
    return body.authorization;
  }, account);
  await context.addCookies([{
    name: 'css-account',
    value: accountToken,
    url: fixture.ready.baseUrl,
    sameSite: 'Lax',
  }]);
  await openRoute(page, '/status/overview');
}

async function openRoute(page: Page, path: string): Promise<void> {
  const destination = new URL(path, fixture.ready.baseUrl).href;
  try {
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: routeNavigationTimeoutMs });
  } catch (error) {
    if (!(error instanceof Error) || !/ERR_ABORTED|another navigation/iu.test(error.message)) throw error;
  }
  await expect.poll(() => safePath(page.url()), {
    timeout: routeNavigationTimeoutMs,
    message: `route did not settle: ${destination}`,
  }).toBe(new URL(path, fixture.ready.baseUrl).pathname);
}

async function installAuthSurfaceMutationTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const windowWithTrace = window as typeof window & {
      __xpodAuthSurfaceMutationTrace?: {
        authPageSeen: boolean;
        modalSeen: boolean;
        dialogSeen: boolean;
        pendingSeen: boolean;
        disconnect: () => void;
      };
    };
    windowWithTrace.__xpodAuthSurfaceMutationTrace?.disconnect();
    const trace = {
      authPageSeen: false,
      modalSeen: false,
      dialogSeen: false,
      pendingSeen: false,
      disconnect: () => observer.disconnect(),
    };
    const scan = () => {
      trace.authPageSeen ||= Boolean(document.querySelector('[data-testid="auth-surface-page"]'));
      trace.modalSeen ||= Boolean(document.querySelector('[data-testid="auth-surface-modal"]'));
      trace.dialogSeen ||= Boolean(document.querySelector('[role="dialog"]'));
      trace.pendingSeen ||= Boolean(document.querySelector('[data-testid="xpod-auth-pending-scene"]'));
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    scan();
    windowWithTrace.__xpodAuthSurfaceMutationTrace = trace;
  });
  await page.evaluate(() => {
    const windowWithTrace = window as typeof window & {
      __xpodAuthSurfaceMutationTrace?: {
        authPageSeen: boolean;
        modalSeen: boolean;
        dialogSeen: boolean;
        pendingSeen: boolean;
        disconnect: () => void;
      };
    };
    if (windowWithTrace.__xpodAuthSurfaceMutationTrace) return;
    const trace = {
      authPageSeen: false,
      modalSeen: false,
      dialogSeen: false,
      pendingSeen: false,
      disconnect: () => observer.disconnect(),
    };
    const scan = () => {
      trace.authPageSeen ||= Boolean(document.querySelector('[data-testid="auth-surface-page"]'));
      trace.modalSeen ||= Boolean(document.querySelector('[data-testid="auth-surface-modal"]'));
      trace.dialogSeen ||= Boolean(document.querySelector('[role="dialog"]'));
      trace.pendingSeen ||= Boolean(document.querySelector('[data-testid="xpod-auth-pending-scene"]'));
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    scan();
    windowWithTrace.__xpodAuthSurfaceMutationTrace = trace;
  });
}

async function readAuthSurfaceMutationTrace(page: Page): Promise<{
  authPageSeen: boolean;
  modalSeen: boolean;
  dialogSeen: boolean;
  pendingSeen: boolean;
}> {
  return page.evaluate(() => {
    const trace = (window as typeof window & {
      __xpodAuthSurfaceMutationTrace?: {
        authPageSeen: boolean;
        modalSeen: boolean;
        dialogSeen: boolean;
        pendingSeen: boolean;
        disconnect: () => void;
      };
    }).__xpodAuthSurfaceMutationTrace;
    if (!trace) {
      return { authPageSeen: false, modalSeen: false, dialogSeen: false, pendingSeen: false };
    }
    const snapshot = {
      authPageSeen: trace.authPageSeen,
      modalSeen: trace.modalSeen,
      dialogSeen: trace.dialogSeen,
      pendingSeen: trace.pendingSeen,
    };
    trace.authPageSeen = false;
    trace.modalSeen = false;
    trace.dialogSeen = false;
    trace.pendingSeen = false;
    return snapshot;
  });
}

async function chooseStorageBinding(page: Page, podUrl: string): Promise<void> {
  const storageSelect = page.getByRole('combobox', { name: /身份与存储空间|identity.*storage|storage/i });
  await expect(storageSelect).toBeVisible({ timeout: 5_000 });
  const options = await storageSelect.locator('option').evaluateAll((entries) => entries
    .filter((option): option is HTMLOptionElement => option instanceof HTMLOptionElement)
    .map((option) => option.value));
  const value = await storageSelect.locator('option').evaluateAll((entries, requestedPodUrl) => {
    const normalized = String(requestedPodUrl).replace(/\/$/u, '');
    const options = entries.filter((option): option is HTMLOptionElement => option instanceof HTMLOptionElement);
    return options.find((option) => option.value.endsWith(`|${normalized}`)
      || option.value.endsWith(`|${normalized}/`))?.value;
  }, podUrl);
  if (!value) throw new Error(`Consent page did not expose binding for ${podUrl}; options=${options.join(',')}`);
  await storageSelect.selectOption(value);
}

function avatarCard(page: Page) {
  return page.locator('[data-avatar-card="true"]');
}

async function requiredBox(locator: ReturnType<Page['locator']>, label: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} did not expose a bounding box`);
  return box;
}

async function login(
  page: Page,
  account: BrowserSolidCredentials,
  startPath: string,
  ready: (page: Page) => boolean | Promise<boolean>,
  requireCallbackEvidence = true,
): Promise<BrowserOidcTrace> {
  const startUrl = new URL(startPath, fixture.ready.baseUrl).href;
  const trace = await completeOidcLogin(page, account, {
    baseUrl: fixture.ready.baseUrl,
    startUrl,
    ready,
    requireCallbackEvidence,
    // A traced cold callback can load the full Pod-backed Settings module
    // graph (including the browser RDF engine) before the readiness marker is
    // mounted. Keep the deadline inside the 120s scenario budget without
    // treating a still-loading module response as an authentication failure.
    timeoutMs: 90_000,
  });
  // The callback app records completion immediately before replacing the
  // document. Give that replacement one event-loop turn to settle before a
  // caller starts a second product navigation (notably Status → AI Connections).
  await page.waitForTimeout(250);
  return trace;
}

function safePath(rawUrl: string): string {
  try {
    return normalizeAccountPath(new URL(rawUrl).pathname);
  } catch {
    return '<unknown>';
  }
}

function assertOidcStartTrace(trace: BrowserOidcTrace): void {
  expect(trace.authorizationRequestSeen).toBe(true);
  expect(trace.authCodeChallengeSeen).toBe(true);
  expect(trace.authCodeChallengeMethodS256).toBe(true);
  expect(trace.passwordSubmitted).toBe(true);
}

function assertRealOidcTrace(
  trace: BrowserOidcTrace,
  options: { requirePassword?: boolean } = {},
): void {
  if (options.requirePassword !== false) assertOidcStartTrace(trace);
  else {
    expect(trace.authorizationRequestSeen).toBe(true);
    expect(trace.authCodeChallengeSeen).toBe(true);
    expect(trace.authCodeChallengeMethodS256).toBe(true);
  }
  expect(trace.redirectCodeSeen).toBe(true);
  expect(trace.tokenAuthorizationCodeGrantSeen).toBe(true);
  expect(trace.tokenCodeVerifierSeen).toBe(true);
  expect(trace.callbackPathSeen).toBe(true);
  expect(trace.callbackHasCode).toBe(true);
  expect(trace.callbackHasState).toBe(true);
  expect(trace.callbackTransaction).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
}
