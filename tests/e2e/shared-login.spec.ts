import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, type BrowserContext, type Page, test } from '@playwright/test';
import {
  completeOidcLogin,
  type BrowserOidcTrace,
  type BrowserSolidCredentials,
} from '../helpers/browserSolidOidc';

const readyPrefix = 'XPOD_SETTINGS_FIXTURE_READY ';
const failurePrefix = 'XPOD_SETTINGS_FIXTURE_ERROR ';

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
  private constructor(
    private readonly child: ReturnType<typeof spawn>,
    readonly ready: SharedLoginFixture,
  ) {}

  static async start(): Promise<SharedLoginHarness> {
    const child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The long-running fixture and its child services emit diagnostics for
    // every browser scenario. Always drain stderr: leaving a piped stream
    // unread eventually fills the OS pipe and blocks the fixture event loop,
    // which presents as an unrelated static-asset request hanging late in the
    // serial suite.
    child.stderr.resume();
    const ready = await new Promise<SharedLoginFixture>((resolve, reject) => {
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
            fail(new Error('Shared-login fixture reported startup failure'));
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

let fixture: SharedLoginHarness;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.describe('Xpod shared login acceptance', () => {
  test.beforeAll(async () => {
    fixture = await SharedLoginHarness.start();
  });

  test.afterAll(async () => {
    await fixture?.stop();
  });

  test('dashboard-first login opens Pod-backed Settings without a second password prompt', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/dashboard/overview', isDashboardAuthenticated);
      assertRealOidcTrace(trace);
      await expect(page.getByTestId('xpod-user-card-trigger')).toBeVisible();
      // Dashboard auth can settle before the selected Pod finishes opening;
      // wait for the same exact-pair readiness marker used by Settings before
      // switching products.
      await expect(page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]'))
        .toBeVisible({ timeout: 30_000 });

      await openProduct(page, 'settings');
      try {
        await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${await pageDiagnostics(page)}`);
      }
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('Settings-first login leaves the Account session available to Dashboard', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
      assertRealOidcTrace(trace);
      await openProduct(page, 'dashboard');
      await expect.poll(() => isDashboardAuthenticated(page), { timeout: 30_000 }).toBe(true);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('an existing Account with one Pod restores that exact binding after reload', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
      assertRealOidcTrace(trace);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => isPodSettingsReady(page), { timeout: 30_000 }).toBe(true);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await page.getByTestId('xpod-user-card-trigger').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toContainText('No Pod selected');
      await expect(dialog).toContainText('Pod');
    } finally {
      await context.close();
    }
  });

  test('multiple Pods restore a valid remembered binding or show an explicit chooser, never an implicit first response', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const bob = fixture.ready.accounts.bob;
      const podUrls = bob.podUrls;
      expect(podUrls.length).toBeGreaterThanOrEqual(2);
      const pending = await login(page, bob, '/settings/models', isConsentReady, false);
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
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(selectedBinding.podUrl);

      const deleteResponse = await fetch(new URL('/control/delete-pod', fixture.ready.controlUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podUrl: selectedBinding.podUrl }),
      });
      if (deleteResponse.status !== 204) {
        throw new Error(`delete control failed ${deleteResponse.status} ${await deleteResponse.text()} url=${fixture.ready.controlUrl}`);
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
      // The stale binding must fail closed through the shared recovery
      // boundary, rather than surfacing the Pod's raw HTTP 403 or silently
      // opening another remembered Pod.
      await expect(page.getByRole('button', { name: /try again/i }).first())
        .toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Could not connect to Xpod|storage.*failed|binding.*no longer available/i).first())
        .toBeVisible({ timeout: 30_000 });
    } finally {
      await context.close();
    }
  });

  test('exact-pair storage metadata conflicts expose deterministic retry recovery instead of silent selection', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const pending = await login(page, fixture.ready.accounts.alice, '/settings/models', isConsentReady, false);
      assertOidcStartTrace(pending);
      let injectedCount = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/.account/oidc/pick-webid/') {
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
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect.poll(() => injectedCount, { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText(/conflict|duplicated with incompatible metadata/i).first())
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /try again/i }).first()).toBeVisible();
      await page.unroute('**/*');
      await page.getByRole('button', { name: /try again/i }).first().click();
      await expect(page.getByRole('button', { name: 'Authorize', exact: true }))
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/duplicated with incompatible metadata/i)).toHaveCount(0);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('a real WebID token expiry exposes the expired recovery boundary without creating a second Session', async ({ browser }) => {
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
      const trace = await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
      assertRealOidcTrace(trace);
      await expect.poll(() => tokenExpiresIn, { timeout: 10_000 }).toBeGreaterThan(0);
      const sessionIdBeforeExpiry = await page.evaluate(() => window.sessionStorage.getItem('xpod.solid.sessionId'));
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
      await expect(page.getByRole('alert').filter({ hasText: /^Session expired$/i }))
        .toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /try again/i }).first()).toBeVisible();
      expect(refreshTokenSeen).toBe(true);
      expect(refreshAttempts).toBeGreaterThan(0);
      const sessionIdAtExpiry = await page.evaluate(() => window.sessionStorage.getItem('xpod.solid.sessionId'));
      expect(sessionIdAtExpiry).toBe(sessionIdBeforeExpiry);

      // fastForward pauses the emulated clock after firing the expiry timer;
      // resume it before exercising the retry navigation.
      await page.clock.resume();
      await page.getByRole('button', { name: /try again/i }).first().click();
      await expect.poll(
        () => page.evaluate(() => window.sessionStorage.getItem('xpod.auth.transaction.v1.active')),
        { timeout: 10_000 },
      ).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      const sessionIdAfterRetry = await page.evaluate(() => window.sessionStorage.getItem('xpod.solid.sessionId'));
      expect(sessionIdAfterRetry).toBe(sessionIdBeforeExpiry);
    } finally {
      await page.unroute('**/*').catch(() => undefined);
      await context.close();
    }
  });

  test('a new Account creates its first storage and waits for the binding before consent', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const bootstrapTrace = await login(
        page,
        fixture.ready.accounts.newAccount,
        '/settings/models',
        isStorageBootstrapVisible,
        false,
      );
      assertOidcStartTrace(bootstrapTrace);
      await expect(page.getByText(/prepare storage|create.*storage|no eligible storage/i).first()).toBeVisible();
      const podName = page.getByLabel(/Pod name/i).first();
      if (await podName.isVisible({ timeout: 500 }).catch(() => false)) {
        await podName.fill(`browser-${Date.now().toString(36)}`);
      }
      await page.getByRole('button', { name: /create storage|create/i }).last().click();
      const completedTrace = await completeOidcLogin(page, fixture.ready.accounts.newAccount, {
        baseUrl: fixture.ready.baseUrl,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 90_000,
      });
      assertRealOidcTrace({
        ...completedTrace,
        authorizationRequestSeen: bootstrapTrace.authorizationRequestSeen,
        authCodeChallengeSeen: bootstrapTrace.authCodeChallengeSeen,
        authCodeChallengeMethodS256: bootstrapTrace.authCodeChallengeMethodS256,
        passwordSubmitted: bootstrapTrace.passwordSubmitted,
        authorizationRedirectUris: [
          ...bootstrapTrace.authorizationRedirectUris,
          ...completedTrace.authorizationRedirectUris,
        ],
      });
      expect(completedTrace.passwordSubmitted).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('enforces Dashboard, anonymous local Settings, and Pod-backed Settings authorization', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      await openRoute(page, '/dashboard/overview');
      await expect(page.getByRole('button', { name: /continue$/i }).first()).toBeVisible();

      await openRoute(page, '/settings/network');
      await expect.poll(() => isWorkspaceReady(page), { timeout: 30_000 }).toBe(true);
      await expect(page.getByRole('button', { name: /continue$/i })).toHaveCount(0);

      await openRoute(page, '/settings/models');
      await expect(page.getByRole('button', { name: /continue$/i }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('uses the fixed same-origin callback and returns to the original safe route', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const trace = await login(page, fixture.ready.accounts.alice, '/settings/models?surface=providers', isPodSettingsReady);
      assertRealOidcTrace(trace);
      expect(new URL(page.url()).origin).toBe(new URL(fixture.ready.baseUrl).origin);
      expect(new URL(page.url()).pathname).toBe('/settings/models');
      expect(new URL(page.url()).search).toBe('?surface=providers');
      expect(trace.authorizationRedirectUris.some((value) => {
        const redirect = new URL(value);
        return redirect.origin === new URL(fixture.ready.baseUrl).origin
          && redirect.pathname === '/auth/callback'
          && redirect.searchParams.get('transaction') === trace.callbackTransaction;
      })).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('consent denial and unsafe return paths expose deterministic recovery', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      const denied = await login(page, fixture.ready.accounts.alice, '/settings/models', isConsentReady, false);
      assertOidcStartTrace(denied);
      // The full-page consent surface exposes Deny as its real cancellation
      // action; it does not pretend that the callback page has a dismiss
      // control before a failure is rendered.
      await expect(page.getByRole('button', { name: /^deny$/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^dismiss$/i })).toHaveCount(0);
      await page.getByRole('button', { name: /^deny$/i }).click();
      await expect.poll(() => safePath(page.url()), { timeout: 30_000 })
        .toMatch(/^(?:\/settings\/models|\/dashboard\/overview|\/auth\/callback)$/u);
      await expect(page.getByRole('link', { name: /start sign-in again/i }).first()).toBeVisible();

      await openRoute(page, '/settings/models');
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
          .getByText(/This sign-in (?:return path is not allowed|link is invalid)\./u)
          .isVisible({ timeout: 100 })
          .catch(() => false),
        timeoutMs: 30_000,
      });
      expect(await page.evaluate(() => window.sessionStorage.getItem('xpod.test.unsafe-return-injected'))).toBe('1');
      assertRealOidcTrace({
        ...trace,
        authorizationRequestSeen: restarted.authorizationRequestSeen,
        authCodeChallengeSeen: restarted.authCodeChallengeSeen,
        authCodeChallengeMethodS256: restarted.authCodeChallengeMethodS256,
        passwordSubmitted: denied.passwordSubmitted || restarted.passwordSubmitted,
        authorizationRedirectUris: [
          ...restarted.authorizationRedirectUris,
          ...trace.authorizationRedirectUris,
        ],
      });
      expect(new URL(page.url()).origin).toBe(new URL(fixture.ready.baseUrl).origin);
      await expect(page.getByText(/This sign-in (?:return path is not allowed|link is invalid)\./u)).toBeVisible();
      await expect(page.getByRole('link', { name: /start sign-in again/i }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('lost host transaction exposes deterministic callback recovery after a real provider response', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let callbackHref: string | undefined;
    const captureCallback = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url());
      if (url.pathname === '/auth/callback' && url.searchParams.has('code')) callbackHref ??= url.href;
    };
    page.on('request', captureCallback);
    try {
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/settings/models', fixture.ready.baseUrl).href,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 30_000,
      });
      assertRealOidcTrace(trace);
      expect(callbackHref).toBeTruthy();
      const replay = new URL(callbackHref!);
      replay.searchParams.set('transaction', '00000000-0000-4000-8000-000000000000');
      replay.searchParams.delete('code');
      replay.searchParams.delete('state');
      replay.searchParams.delete('iss');
      await page.goto(replay.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect.poll(() => safePath(page.url()), { timeout: 10_000 }).toBe('/auth/callback');
      await expect(page.getByText(/did not return an authenticated WebID|missing.*transaction|already been used|invalid/i).first()).toBeVisible();
      await expect(page.getByRole('link', { name: /start sign-in again/i }).first()).toBeVisible();
    } finally {
      page.off('request', captureCallback);
      await context.close();
    }
  });

  test('invalid OIDC state exposes an explicit identity-provider recovery action', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let callbackHref: string | undefined;
    const captureCallback = (request: import('@playwright/test').Request) => {
      const url = new URL(request.url());
      if (url.pathname === '/auth/callback' && url.searchParams.has('code')) callbackHref ??= url.href;
    };
    page.on('request', captureCallback);
    try {
      const trace = await completeOidcLogin(page, fixture.ready.accounts.alice, {
        baseUrl: fixture.ready.baseUrl,
        startUrl: new URL('/settings/models', fixture.ready.baseUrl).href,
        ready: isPodSettingsReady,
        requireCallbackEvidence: true,
        timeoutMs: 30_000,
      });
      assertRealOidcTrace(trace);
      expect(callbackHref).toBeTruthy();
      const replay = new URL(callbackHref!);
      replay.searchParams.set('state', 'invalid-state-from-browser-test');
      await page.goto(replay.href, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await expect.poll(() => safePath(page.url()), { timeout: 10_000 }).toBe('/auth/callback');
      await expect(page.getByText(/identity provider could not verify this sign-in/i)).toBeVisible();
      await expect(page.getByRole('link', { name: /start sign-in again/i }).first()).toBeVisible();
    } finally {
      page.off('request', captureCallback);
      await context.close();
    }
  });

  test('one logout clears both domains and retries only the failed Account step', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    let failAccountLogout = true;
    try {
      await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (failAccountLogout && request.method() === 'POST' && url.pathname.includes('logout')) {
          failAccountLogout = false;
          await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          return;
        }
        await route.continue();
      });
      await page.getByTestId('xpod-user-card-trigger').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expect(page.getByText('Sign out incomplete', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.unroute('**/*');
      await page.getByRole('button', { name: 'Try again', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expect(page.getByRole('button', { name: /sign in to xpod/i })).toBeVisible({ timeout: 30_000 });
      await openRoute(page, '/dashboard/overview');
      await expect(page.getByRole('button', { name: /continue$/i }).first()).toBeVisible();
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
      await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
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
      await expect(page.getByText('Sign out incomplete', { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(accountLogoutRequests).toBe(1);

      await page.getByRole('button', { name: 'Try again', exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
      });
      await expect(page.getByRole('button', { name: /sign in to xpod/i })).toBeVisible({ timeout: 30_000 });
      expect(accountLogoutRequests).toBe(1);
      await openRoute(page, '/dashboard/overview');
      await expect(page.getByRole('button', { name: /continue$/i }).first()).toBeVisible();
    } finally {
      page.off('request', countAccountLogout);
      await context.close();
    }
  });

  test('renders one Xpod identity control with no provider chooser or second login/logout path', async ({ browser }) => {
    const { context, page } = await scenarioPage(browser);
    try {
      // Bob's multi-Pod recovery scenario above intentionally deletes one of
      // his bindings; use the stable single-Pod account for this invariant.
      await login(page, fixture.ready.accounts.alice, '/settings/models', isPodSettingsReady);
      await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /cloud|local|custom issuer|external webid|external pod/i })).toHaveCount(0);
      await page.getByTestId('xpod-user-card-trigger').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
      await expect(dialog.getByRole('button', { name: 'Use a different account', exact: true })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

async function isDashboardAuthenticated(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  return url.pathname.startsWith('/dashboard')
    && await page.locator('[data-testid="xpod-user-card-trigger"][aria-label^="Open account menu for "]').isVisible({ timeout: 250 }).catch(() => false);
}

async function isPodSettingsReady(page: Page): Promise<boolean> {
  if (!new URL(page.url()).pathname.startsWith('/settings')) return false;
  if (!await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible({ timeout: 250 }).catch(() => false)) return false;
  const workspace = page.locator('[data-workspace-layout]').first();
  if (!await workspace.isVisible({ timeout: 250 }).catch(() => false)) return false;
  return await page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first()
    .count() > 0;
}

async function isWorkspaceReady(page: Page): Promise<boolean> {
  if (!new URL(page.url()).pathname.startsWith('/settings')) return false;
  return await page.locator('[data-workspace-layout]').first().isVisible({ timeout: 250 }).catch(() => false);
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
  return await page.getByRole('button', { name: /^deny$/i }).isVisible({ timeout: 250 }).catch(() => false);
}

async function isStorageBootstrapVisible(page: Page): Promise<boolean> {
  const path = safePath(page.url());
  if (path !== '/.account/oidc/consent/') return false;
  return await page.getByText(/prepare storage|create.*storage|no eligible storage/i).first()
    .isVisible({ timeout: 250 }).catch(() => false);
}

async function scenarioPage(browser: { newContext(): Promise<BrowserContext> }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

async function openRoute(page: Page, path: string): Promise<void> {
  const destination = new URL(path, fixture.ready.baseUrl).href;
  try {
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof Error) || !/ERR_ABORTED|another navigation/iu.test(error.message)) throw error;
  }
  await expect.poll(() => safePath(page.url()), {
    timeout: 10_000,
    message: `route did not settle: ${destination}; ${pageDiagnostics(page)}`,
  }).toBe(new URL(path, fixture.ready.baseUrl).pathname);
}

async function chooseStorageBinding(page: Page, podUrl: string): Promise<void> {
  const storageSelect = page.locator('#oidc-consent-storage');
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
    timeoutMs: 60_000,
  });
  // The callback app records completion immediately before replacing the
  // document. Give that replacement one event-loop turn to settle before a
  // caller starts a second product navigation (notably dashboard → Settings).
  await page.waitForTimeout(250);
  return trace;
}

async function openProduct(page: Page, product: 'dashboard' | 'settings'): Promise<void> {
  const trigger = page.getByTestId('xpod-user-card-trigger');
  await trigger.click({ timeout: 2_000 });
  const label = product === 'dashboard' ? 'Open Dashboard' : 'Open Settings';
  const link = page.getByRole('link', { name: label, exact: true });
  // Follow the host-provided same-origin route. This keeps navigation
  // deterministic while the login helper remains the only OIDC observer.
  const href = await link.getAttribute('href', { timeout: 2_000 }).catch(() =>
    product === 'dashboard' ? '/dashboard/overview' : '/settings/models');
  if (!href) throw new Error(`Missing ${label} route`);
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
    await close.click({ timeout: 2_000 });
  }
  const destination = new URL(href, fixture.ready.baseUrl).href;
  let response: Awaited<ReturnType<Page['goto']>>;
  try {
    response = await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof Error) || !/ERR_ABORTED|another navigation/iu.test(error.message)) throw error;
    // Callback cleanup can replace the document at the same moment the host
    // switch is requested. The URL poll below observes the settled route.
    response = null;
  }
  const expectedPath = product === 'dashboard' ? '/dashboard/overview' : '/settings/models';
  await expect.poll(() => safePath(page.url()), {
    timeout: 30_000,
    message: `switch route did not settle: href=${href}; response=${response?.status() ?? 'none'} ${response?.url() ?? destination}`,
  }).toBe(expectedPath);
}

function safePath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
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

function assertRealOidcTrace(trace: BrowserOidcTrace): void {
  assertOidcStartTrace(trace);
  expect(trace.redirectCodeSeen).toBe(true);
  expect(trace.tokenAuthorizationCodeGrantSeen).toBe(true);
  expect(trace.tokenCodeVerifierSeen).toBe(true);
  expect(trace.callbackPathSeen).toBe(true);
  expect(trace.callbackHasCode).toBe(true);
  expect(trace.callbackHasState).toBe(true);
  expect(trace.callbackTransaction).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
}
