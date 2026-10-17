import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { _electron as electron, expect, test, type ElectronApplication, type Page, type Browser } from '@playwright/test';
import { normalizeAccountPath, chooseConsentBinding, type BrowserSolidCredentials } from '../helpers/browserSolidOidc';
import { externalRefreshFromEnvironment, externalRefreshPrivateRoot, verifyExternalRefreshStorage } from '../helpers/browserExternalRefreshFixture';
import { recordOwnedHost, closeOwnedHost, cleanupOwnedHostGroup, hostGroupPassed, type OwnedHostGroup } from '../helpers/ownedElectronHost';
import { startBrowserExternalRp } from '../helpers/browserExternalRp';
import { completeOidcLogin } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodPod, readBrowserXpodRuntime } from '../helpers/browserXpodRuntime';

const external = externalRefreshFromEnvironment();

type Ready = { baseUrl: string; account: BrowserSolidCredentials & { webId: string; podUrl: string }; accessTokenTtl: number; refreshTokenTtl: number };
type TokenEvidence = { grant: string; status: number; receivedAt: number; expiresIn?: number; error?: string; refreshIssued: boolean };

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function start(mode: 'renew' | 'expire'): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = spawn('bun', [path.resolve('tests/helpers/browserRefreshFixtureServer.ts'), mode], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr!.on('data', (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-12_000); });
  try {
    const ready = await new Promise<Ready>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timeout = setTimeout(() => reject(new Error(`Refresh fixture startup timed out: ${diagnostics}`)), 120_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Refresh fixture exited ${code}: ${diagnostics}`)); });
      lines.on('line', (line) => {
        if (line.startsWith('XPOD_REFRESH_READY ')) {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice('XPOD_REFRESH_READY '.length)));
        }
      }); // Keep draining both child pipes for the fixture's entire lifetime.
    });
    return { child, ready };
  } catch (error) { await stop(child); throw error; }
}
async function ready(page: Page): Promise<boolean> {
  if (new URL(page.url()).pathname !== '/ai-connections') return false;
  return page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible().catch(() => false);
}

/** Exercise the actual desktop host; Web only exposes the lightweight Account UI. */
async function completeDesktopLogin(app: ElectronApplication, account: BrowserSolidCredentials): Promise<Page> {
  const deadline = Date.now() + 90_000;
  let submitted = false;
  let reentered = false;
  const approved = new Set<string>();
  while (Date.now() < deadline) {
    const page = app.windows().filter(candidate => !candidate.isClosed()).at(-1);
    if (!page) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    if (await ready(page)) return page;
    const reenter = page.getByRole('button', { name: '重新登录', exact: true });
    if (!reentered && await reenter.isVisible()) {
      reentered = true;
      await reenter.click();
      continue;
    }
    const email = page.locator('input[type="email"], input[name="email"], input#email').first();
    const password = page.locator('input[type="password"]').first();
    if (!submitted && await email.isVisible() && await password.isVisible()) {
      await email.fill(account.email);
      await password.fill(account.password);
      if (external) {
        const remember = page.getByRole('checkbox', { name: '记住账号', exact: true });
        if (await remember.isVisible()) await remember.check();
      }
      await password.press('Enter');
      submitted = true;
    }
    const pathname = new URL(page.url()).pathname;
    const allow = page.getByRole('button', { name: '允许', exact: true });
    if (!approved.has(pathname) && normalizeAccountPath(pathname) === '/.account/oidc/consent/' && await allow.isVisible()) {
      if (external) {
        const chooser = page.locator('#oidc-consent-webid');
        if (await chooser.isVisible()) {
          if (!await chooser.isEnabled()) { await page.waitForTimeout(100); continue; }
          const options = await chooser.locator('option').evaluateAll(elements => elements.map(element => ({
            value: (element as HTMLOptionElement).value, disabled: (element as HTMLOptionElement).disabled,
          })));
          const selected = chooseConsentBinding(options, await chooser.inputValue(), account);
          if (!selected) throw new Error('External deployment Consent binding unavailable');
          await chooser.selectOption(selected);
          await expect(chooser).toHaveValue(selected);
        }
        const remember = page.getByRole('checkbox', { name: '以后不再询问', exact: true });
        if (!await remember.isVisible()) await page.locator('summary').filter({ hasText: '请求详情' }).click();
        await remember.check();
      }
      approved.add(pathname);
      await allow.click();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Desktop login did not restore the protected AI Connections route');
}

async function verifyExternalBrowser(browser: Browser, stateRoot: string) {
  if (!external) throw new Error('External browser input missing');
  const rp = await startBrowserExternalRp(external.input.issuer);
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  let passwordPosts = 0;
  let authorizationCodes = 0;
  let identityMatches = true;
  const track = () => context!.on('request', request => {
    if (request.method() === 'POST' && normalizeAccountPath(new URL(request.url()).pathname) === '/.account/login/password/') passwordPosts++;
  });
  const login = async (rememberAccount: boolean) => {
    const transaction = rp.authorization();
    const page = await context!.newPage();
    await completeOidcLogin(page, external.ready.account, {
      baseUrl: new URL(rp.callbackUrl).origin, startUrl: transaction.url, rememberAccount,
      ready: current => current.getByRole('heading', { name: 'Application callback', exact: true }).isVisible(),
      requireCallbackEvidence: false, timeoutMs: 90_000,
    });
    const session = await transaction.exchange(new URL(page.url()));
    authorizationCodes++;
    identityMatches &&= session.webId === external.input.binding.webId && new URL(session.issuer).href === new URL(external.input.issuer).href;
    expect(identityMatches).toBe(true);
    expect(session.tokenStatus).toBe(200);
  };
  try {
    context = await browser.newContext();
    track();
    await login(true);
    expect(passwordPosts).toBe(1);
    // Persist only Account cookies: provider-session reuse cannot satisfy this check.
    const storage = await context.storageState();
    storage.cookies = storage.cookies.filter(cookie => cookie.name === 'css-account');
    expect(storage.cookies.length).toBeGreaterThan(0);
    storage.origins = [];
    const state = path.join(stateRoot, 'account-cookies.private.json');
    await writeFile(state, JSON.stringify(storage), { mode: 0o600, flag: 'wx' });
    await context.close();
    context = await browser.newContext({ storageState: state });
    track();
    await login(false);
    expect(passwordPosts).toBe(1);
    return { authorizationCodes, passwordPosts, cookieRestored: true, identityMatches };
  } finally {
    try { await context?.close(); } finally { await rp.close(); }
  }
}

const profiles = external ? [external.input.profile.kind] : ['renew', 'expire', 'idle'] as const;
for (const mode of profiles) {
  test(`real desktop SDK ${mode === 'renew' ? 'automatically renews before private Pod read' : mode === 'idle' ? 'renews the first expired request with suspended proactive refresh timers' : 'recovers through full login after refresh expiry'}`, async ({ browser }, testInfo) => {
    test.setTimeout(external ? 260_000 : 240_000);
    const fixture: { child?: ChildProcess; ready: Ready } = external ? { ready: external.ready } : await start(mode === 'idle' ? 'renew' : mode);
    const dataRoot = external ? path.join(externalRefreshPrivateRoot(external.input), 'private-state') : path.resolve('.test-data/desktop-session-refresh');
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const userData = await mkdtemp(path.join(dataRoot, `${mode}-`));
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let primaryFailure: unknown;
    let browserEvidence: Awaited<ReturnType<typeof verifyExternalBrowser>> | undefined;
    let persistedHostRestored = false;
    let hostClosed = false;
    const hostGroups: OwnedHostGroup[] = [];
    const observerPath = (phase: 'initial' | 'restart') => path.join(externalRefreshPrivateRoot(external!.input), `${phase}-observer.safe.json`);
    const readObserver = (phase: 'initial' | 'restart') => {
      const value = JSON.parse(readFileSync(observerPath(phase), 'utf8'));
      expect(value.ready).toBe(true); expect(value.hostImported).toBe(true);
      expect(value.failed).toBe(false); expect(value.opaquePosts).toBe(0);
      return value as { hostPid: number; authorizationCodes: number; passwordPosts: number; refreshTokens: number };
    };
    let initialObserver: ReturnType<typeof readObserver> | undefined;
    let restartObserver: ReturnType<typeof readObserver> | undefined;
    const tokens: TokenEvidence[] = [];
    const pending = new Set<Promise<void>>();
    const requests: Array<{ at: number; path: string; method: string; authorizationScheme: string }> = [];
    const resource = `browser-refresh-private-${mode}.txt`;
    const payload = 'Private Pod data survives real SDK renewal and reauthentication.';
    const evidence = { initialPrivateRead: false, anonymousDenied: false, pastInitialAccessExpiry: false, recoveredByLogin: false, finalPrivateRead: false, idleRequestCount: undefined as number | undefined, suspendedRefreshTimers: undefined as number | undefined, passwordPosts: undefined as number | undefined, firstExpiredRequest: undefined as { at: number; path: string; method: string; authorizationScheme: string } | undefined };
    try {
      const anonymousFetch = external ? await verifyExternalRefreshStorage(external.input) : fetch;
      if (external) browserEvidence = await verifyExternalBrowser(browser, userData);
      app = await electron.launch({
        args: external ? [path.resolve('tests/helpers/desktopSessionObserver.cjs'), path.resolve('desktop/dist/main.js')] : [path.resolve('desktop/dist/main.js')],
        env: { ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1',
          XPOD_DESKTOP_URL: new URL('/ai-connections', fixture.ready.baseUrl).href,
          XPOD_DESKTOP_USER_DATA_DIR: userData,
          ...(external ? { XPOD_SESSION_OBSERVER_OUTPUT: observerPath('initial'), XPOD_SESSION_OBSERVER_ISSUER: external.input.issuer } : {}) },
        timeout: 30_000,
      });
      if (external) hostGroups.push(recordOwnedHost(app));
      app.context().on('request', (request) => {
        requests.push({ at: Date.now(), path: normalizeAccountPath(new URL(request.url()).pathname), method: request.method(), authorizationScheme: request.headers().authorization?.split(/\s+/u, 1)[0] ?? 'none' });
      });
      if (mode === 'idle') {
        await app.context().addInitScript(() => {
          const schedule = window.setTimeout;
          const held: string[] = [];
          Object.defineProperty(window, '__xpodSuspendedRefreshTimers', { value: held });
          // Suspend only Inrupt's proactive refresh callback, including the minified
          // bundle shape. Date.now and every other timer/transport remain real.
          window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
            const source = typeof handler === 'function' ? Function.prototype.toString.call(handler) : '';
            if (source.includes('temporarily_unavailable') && source.includes('server_error')) {
              held.push(typeof handler === 'function' ? handler.name : '<unknown>');
              return schedule(() => undefined, 2_147_483_647);
            }
            return schedule(handler, delay, ...args);
          }) as typeof window.setTimeout;
        });
      }
      app.context().on('response', (response) => {
        const request = response.request();
        const grant = new URLSearchParams(request.postData() ?? '').get('grant_type');
        if (request.method() !== 'POST' || !['authorization_code', 'refresh_token'].includes(grant ?? '')) return;
        const task = response.json().then((body) => {
          tokens.push({ grant: grant!, status: response.status(), receivedAt: Date.now(),
            expiresIn: body.expires_in, error: body.error === undefined ? undefined : body.error === 'invalid_grant' ? 'invalid_grant' : 'other', refreshIssued: typeof body.refresh_token === 'string' });
        }).catch(() => undefined);
        pending.add(task); void task.finally(() => pending.delete(task));
      });
      page = await completeDesktopLogin(app, fixture.ready.account);
      await expect.poll(() => tokens.filter((entry) => entry.grant === 'authorization_code').length).toBe(1);
      if (external) {
        const runtime = await readBrowserXpodRuntime(page);
        expect(runtime.webId).toBe(external.input.binding.webId);
        expect(runtime.podUrl).toBe(external.input.binding.podUrl);
        expect(runtime.issuer).toBe(external.input.issuer);
      }
      const initial = tokens.find((entry) => entry.grant === 'authorization_code')!;
      expect(initial.expiresIn).toBe(fixture.ready.accessTokenTtl);
      expect(initial.refreshIssued).toBe(true);
      expect((await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: payload })).status).toBe(201);
      const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#>. <#owner> a acl:Authorization; acl:accessTo <${resource}>; acl:agent <${fixture.ready.account.webId}>; acl:mode acl:Read, acl:Write, acl:Control.`;
      expect([200, 201, 205]).toContain((await fetchBrowserXpodPod(page, `${resource}.acl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: acl })).status);
      expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: payload });
      evidence.initialPrivateRead = true;
      const anonymous = await anonymousFetch(new URL(resource, fixture.ready.account.podUrl));
      expect([401, 403]).toContain(anonymous.status);
      await anonymous.arrayBuffer();
      evidence.anonymousDenied = true;

      const initialPasswordPosts = requests.filter(entry => entry.method === 'POST' && entry.path === '/.account/login/password/').length;
      expect(initialPasswordPosts).toBe(1);
      if (mode === 'idle') {
        evidence.suspendedRefreshTimers = await page.evaluate(() => (window as unknown as { __xpodSuspendedRefreshTimers?: string[] }).__xpodSuspendedRefreshTimers?.length ?? 0);
        expect(evidence.suspendedRefreshTimers).toBeGreaterThan(0);
        // Real shell/notification traffic remains enabled and is recorded. An
        // authenticated background request may be the first expired request.
        await expect.poll(() => Date.now() - (requests.at(-1)?.at ?? 0), { timeout: 10_000 }).toBeGreaterThan(1000);
        const idleStartedAt = Date.now();
        expect(tokens.filter(entry => entry.grant === 'refresh_token')).toHaveLength(0);
        const remainingLifetime = initial.receivedAt + initial.expiresIn! * 1000 + 1500 - Date.now();
        if (remainingLifetime > 0) await new Promise(resolve => setTimeout(resolve, remainingLifetime));
        evidence.idleRequestCount = requests.filter(entry => entry.at >= idleStartedAt).length;

        expect(Date.now()).toBeGreaterThan(initial.receivedAt + initial.expiresIn! * 1000);
        evidence.pastInitialAccessExpiry = true;
      } else if (mode === 'renew') {
        await expect.poll(() => tokens.some((entry) => entry.grant === 'refresh_token' && entry.status === 200), { timeout: 45_000 }).toBe(true);
        // Wall-clock wait beyond the original access token's complete lifetime.
        await expect.poll(() => Date.now() > initial.receivedAt + initial.expiresIn! * 1000 + 1000, { timeout: 45_000 }).toBe(true);
        evidence.pastInitialAccessExpiry = true;
        expect((await readBrowserXpodRuntime(page)).status).toBe('authenticated');
        expect(tokens.filter((entry) => entry.grant === 'authorization_code')).toHaveLength(1);
      } else {
        await expect.poll(() => tokens.some((entry) => entry.grant === 'refresh_token' && entry.status >= 400 && entry.error === 'invalid_grant'), { timeout: 45_000 }).toBe(true);
        expect(Date.now() - initial.receivedAt).toBeGreaterThan(fixture.ready.refreshTokenTtl * 1000);
        await expect(page.getByText('登录已过期，需要重新确认', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '重新登录', exact: true })).toBeVisible();
        page = await completeDesktopLogin(app, fixture.ready.account);
        evidence.recoveredByLogin = true;
        await expect.poll(() => tokens.filter((entry) => entry.grant === 'authorization_code').length).toBe(2);
      }
      expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: payload });
      evidence.finalPrivateRead = true;
      await Promise.allSettled([...pending]);
      evidence.passwordPosts = requests.filter(entry => entry.method === 'POST' && entry.path === '/.account/login/password/').length;
      expect(evidence.passwordPosts).toBe(initialPasswordPosts);
      evidence.firstExpiredRequest = requests.find(entry => entry.at > initial.receivedAt + initial.expiresIn! * 1000 && ['DPoP', 'Bearer'].includes(entry.authorizationScheme));
      if (mode === 'idle') {
        expect(evidence.firstExpiredRequest).toBeDefined();
        expect(tokens.find(entry => entry.grant === 'refresh_token' && entry.status === 200)!.receivedAt).toBeGreaterThanOrEqual(evidence.firstExpiredRequest!.at);
        expect(tokens.filter(entry => entry.grant === 'refresh_token' && entry.status === 200)).toHaveLength(1);
        expect(tokens.filter(entry => entry.grant === 'authorization_code')).toHaveLength(1);
        expect((await readBrowserXpodRuntime(page)).status).toBe('authenticated');
      }
      if (external) {
        const codesBeforeRestart = tokens.filter(entry => entry.grant === 'authorization_code').length;
        const passwordBeforeRestart = requests.filter(entry => entry.method === 'POST' && entry.path === '/.account/login/password/').length;
        await closeOwnedHost(app, hostGroups[0]);
        initialObserver = readObserver('initial');
        expect(initialObserver.hostPid).toBe(hostGroups[0].pid);
        expect(initialObserver.authorizationCodes).toBe(codesBeforeRestart);
        expect(initialObserver.passwordPosts).toBe(passwordBeforeRestart);
        app = undefined;
        app = await electron.launch({ args: [path.resolve('tests/helpers/desktopSessionObserver.cjs'), path.resolve('desktop/dist/main.js')],
          env: { ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_URL: new URL('/ai-connections', fixture.ready.baseUrl).href,
            XPOD_DESKTOP_USER_DATA_DIR: userData, XPOD_SESSION_OBSERVER_OUTPUT: observerPath('restart'),
            XPOD_SESSION_OBSERVER_ISSUER: external.input.issuer }, timeout: 30_000 });
        hostGroups.push(recordOwnedHost(app));
        page = await app.firstWindow();
        await expect.poll(async () => (await readBrowserXpodRuntime(page!)).status, { timeout: 45_000 }).toBe('authenticated');
        const restored = await readBrowserXpodRuntime(page);
        expect(restored.webId).toBe(external.input.binding.webId);
        expect(restored.podUrl).toBe(external.input.binding.podUrl);
        expect(restored.issuer).toBe(external.input.issuer);
        expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body: payload });
        restartObserver = readObserver('restart');
        expect(restartObserver.authorizationCodes).toBe(0);
        expect(restartObserver.passwordPosts).toBe(0);
        expect(tokens.filter(entry => entry.grant === 'authorization_code')).toHaveLength(codesBeforeRestart);
        expect(requests.filter(entry => entry.method === 'POST' && entry.path === '/.account/login/password/')).toHaveLength(passwordBeforeRestart);
        persistedHostRestored = true;
      }
    } catch (error) {
      primaryFailure = error;
      if (external) throw new Error('External session verification failed; private page diagnostics suppressed');
      const windows = app?.windows().filter(candidate => !candidate.isClosed()) ?? [];
      await testInfo.attach('desktop-failure', { contentType: 'application/json', body: JSON.stringify({
        error: String(error), windows: await Promise.all(windows.map(async candidate => ({
          path: new URL(candidate.url()).pathname,
          body: await candidate.locator('body').innerText({ timeout: 1000 }).catch(() => '<unavailable>'),
        }))),
      }) });
      for (let i = 0; i < windows.length; i += 1) {
        await windows[i].screenshot({ path: testInfo.outputPath(`desktop-failure-${i}.png`), timeout: 3000 }).catch(() => undefined);
      }
      throw error;
    } finally {
      try {
        await Promise.allSettled([...pending]);
        const evidencePath = testInfo.outputPath('token-lifecycle-evidence.json');
        await writeFile(evidencePath, JSON.stringify({ mode, accessTtl: fixture.ready.accessTokenTtl, refreshTtl: fixture.ready.refreshTokenTtl, tokens, evidence, requests }, null, 2));
        if (!external) await testInfo.attach('token-lifecycle-evidence', { path: evidencePath, contentType: 'application/json' });
      } finally {
        try {
          if (app) {
            if (external) {
              await closeOwnedHost(app, hostGroups[hostGroups.length - 1]);
              restartObserver = readObserver('restart');
              expect(restartObserver.hostPid).toBe(hostGroups[1].pid);
              expect(restartObserver.authorizationCodes).toBe(0);
              expect(restartObserver.passwordPosts).toBe(0);
              hostClosed = hostGroups.length === 2 && hostGroups.every(hostGroupPassed);
            } else {
              const child = app.process();
              await app.close();
              expect(child.exitCode).toBe(0);
              expect(child.signalCode).toBeNull();
              hostClosed = true;
            }
          }
        } catch (error) {
          if (!external) await testInfo.attach('desktop-cleanup-failure', { contentType: 'text/plain', body: String(error) });
          if (!primaryFailure) throw error;
        } finally {
          for (const group of hostGroups) await cleanupOwnedHostGroup(group);
          hostClosed &&= hostGroups.length === 0 || hostGroups.every(hostGroupPassed);
          if (fixture.child) await stop(fixture.child);
          await rm(userData, { recursive: true, force: true });
          if (external && !primaryFailure && hostClosed && browserEvidence) {
            await writeFile(path.join(external.input.outputDirectory, 'observations.safe.json'), JSON.stringify({
              status: 'passed', browser: browserEvidence,
              tokenEvents: tokens, hostGroups,
              startupObservers: { initial: initialObserver, restart: restartObserver },
              policySemantics: 'deployment-only shortened TTL; default 1h/14d expiry not observed',
              runtime: { bun: process.versions.bun, node: process.versions.node },
              sdk: { authorizationCodes: tokens.filter(entry => entry.grant === 'authorization_code').length,
                refreshSuccesses: tokens.filter(entry => entry.grant === 'refresh_token' && entry.status === 200).length,
                refreshRejections: tokens.filter(entry => entry.grant === 'refresh_token' && entry.status >= 400 && entry.error === 'invalid_grant').length,
                persistedHostRestored, identityMatches: true, privateReadWrite: evidence.initialPrivateRead && evidence.finalPrivateRead,
                anonymousDenied: evidence.anonymousDenied, accessExpiryObserved: evidence.pastInitialAccessExpiry,
                refreshExpiryObserved: mode === 'expire' && evidence.recoveredByLogin, recoveredByLogin: evidence.recoveredByLogin },
              cleanup: { hostAbsent: hostClosed, rpClosed: true, privateStateRemoved: !existsSync(userData) },
            }, null, 2), { mode: 0o600, flag: 'wx' });
          }
        }
      }
    }
  });
}
