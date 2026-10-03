import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDpopHeader, generateDpopKeyPair } from '@inrupt/solid-client-authn-core';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { clickNonPasswordOidcAction, completeOidcLogin, normalizeAccountPath } from '../helpers/browserSolidOidc';
import { fetchBrowserXpodGateway, fetchBrowserXpodPod, readBrowserXpodAccount, readBrowserXpodRuntime, refetchBrowserXpodAccount } from '../helpers/browserXpodRuntime';

export interface DesktopRememberDeployment {
  baseUrl: string;
  issuer: string;
  accounts: Array<{ role?: 'alice' | 'bob'; remember: boolean; email: string; password: string; username: string; webId: string; podUrl: string }>;
}

const manifestPath = process.env.XPOD_E2E_DESKTOP_REMEMBER_MANIFEST;
const deployment = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) as DesktopRememberDeployment : undefined;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

for (const remember of [false, true]) {
  test(`managed cross-site Account remember=${remember} preserves its actual cookie and storage contract across desktop restart`, async ({}, testInfo) => {
    test.skip(!deployment, 'Run runDesktopAccountRememberAcceptance.ts');
    if (remember) test.setTimeout(360_000);
    const fixture = deployment!;
    const account = fixture.accounts.find(entry => !entry.role && entry.remember === remember)!;
    expect(new URL(fixture.baseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(fixture.issuer).hostname).toBe('localhost');
    expect(new URL(account.webId).origin).toBe(new URL(fixture.issuer).origin);
    expect(new URL(account.podUrl).origin).toBe(new URL(fixture.baseUrl).origin);
    await mkdir(path.resolve('.test-data'), { recursive: true });
    const userData = await mkdtemp(path.resolve('.test-data/desktop-account-remember-'));
    await chmod(userData, 0o700);
    const evidence: Record<string, unknown> = { accountRemember: remember, consentRemember: true, crossSite: true,
      injectedAccountCookie: false, injectedRememberChoice: false, coldStartTested: false };
    const requests: Array<{ phase: string; path: string; method: string; origin: string; remember?: boolean; prompt?: string; status?: number; grantType?: string }> = [];
    const authorizations: Array<{ phase: string; state: string; clientHash: string }> = [];
    const accountWire: Array<Record<string, unknown>> = [];
    const wireTasks: Promise<void>[] = [];
    let originalCloudCookie: string | undefined;
    let phase = 'initial';
    let app: ElectronApplication | undefined;
    const observe = (desktop: ElectronApplication) => {
      desktop.context().on('request', request => {
        const url = new URL(request.url());
        const pathname = normalizeAccountPath(url.pathname);
        if (request.method() === 'POST' && ['/.account/login/password/', '/.account/oidc/consent/', '/.account/oidc/pick-webid/'].includes(pathname)) {
          const body = request.postDataJSON() as { remember?: unknown };
          requests.push({ phase, path: pathname, method: 'POST', origin: url.origin,
            ...(typeof body.remember === 'boolean' ? { remember: body.remember } : {}) });
        }
        if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('code_challenge')) {
          authorizations.push({ phase, state: url.searchParams.get('state') ?? '',
            clientHash: createHash('sha256').update(url.searchParams.get('client_id') ?? '').digest('hex') });
          requests.push({ phase, path: pathname, method: request.method(), origin: url.origin,
            prompt: url.searchParams.get('prompt') ?? 'default' });
        }
      });
      desktop.context().on('response', response => {
        const url = new URL(response.url());
        if (phase === 'cookie-only' && url.origin === new URL(fixture.issuer).origin && url.pathname.startsWith('/.account/')) {
          const observedPhase = phase;
          wireTasks.push(response.request().allHeaders().then(headers => {
            const cookieValue = (headers.cookie ?? '').split(';').map(part => part.trim())
              .find(part => part.startsWith('css-account='))?.slice('css-account='.length);
            accountWire.push({ phase: observedPhase, path: safeAccountPath(url.pathname),
              method: response.request().method(), status: response.status(),
              originalAccountCookie: originalCloudCookie !== undefined && cookieValue === originalCloudCookie,
              authorizationPresent: Boolean(headers.authorization), dpopPresent: Boolean(headers.dpop),
              accountHeaderFromOriginalCookie: originalCloudCookie !== undefined
                && headers.authorization === `CSS-Account-Token ${decodeURIComponent(originalCloudCookie)}` });
          }));
        }
        if (url.pathname.endsWith('/token') && response.request().method() === 'POST') {
          requests.push({ phase, path: normalizeAccountPath(url.pathname), method: 'POST', origin: url.origin, status: response.status(),
            grantType: new URLSearchParams(response.request().postData() ?? '').get('grant_type') ?? undefined });
        }
      });
    };
    const launch = async (route = '/ai-connections') => {
      const desktop = await electron.launch({ args: [path.resolve('desktop/dist/main.js')], timeout: 30_000, env: {
        ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_USER_DATA_DIR: userData,
        XPOD_DESKTOP_URL: new URL(route, fixture.baseUrl).href,
      } });
      observe(desktop);
      return desktop;
    };
    try {
      app = await launch();
      const initialPid = app.process().pid;
      const page = await app.firstWindow();
      await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible({ timeout: 60_000 });
      expect(new URL(page.url()).origin).toBe(new URL(fixture.issuer).origin);
      await page.getByLabel('邮箱', { exact: true }).fill(account.email);
      await page.getByLabel('密码', { exact: true }).fill(account.password);
      const choice = page.getByRole('checkbox', { name: '记住账号', exact: true });
      await choice.setChecked(remember);
      await expect(choice).toBeChecked({ checked: remember });
      await page.getByLabel('密码', { exact: true }).press('Enter');
      // Pause at the real Cloud interaction before approving WebID/Consent, so
      // sessionStorage is inspected in the original WebContents, not another tab.
      await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible({ timeout: 60_000 });
      expect(new URL(page.url()).origin).toBe(new URL(fixture.issuer).origin);
      const cloudStorage = await storageMetadata(page, account.email, fixture.issuer);
      evidence.cloudAfterPassword = cloudStorage;
      expect(cloudStorage.rememberChoice).toBe(remember);
      expect(cloudStorage.persistentEmail).toBe(remember);
      expect(cloudStorage.sessionEmail).toBe(!remember);
      const cloudCookie = await accountCookieMetadata(app, fixture.issuer);
      evidence.cloudCookieAfterPassword = cloudCookie;
      expect(cloudCookie.count).toBe(1);
      expect(cloudCookie.persistent).toBe(remember);
      expect(cloudCookie.session).toBe(!remember);
      expect(cloudCookie.sameSite).toBe('Lax');
      expect(passwordRequests(requests)).toEqual([{ phase: 'initial', path: '/.account/login/password/', method: 'POST', origin: new URL(fixture.issuer).origin, remember }]);
      const initialApprovals: Array<{ path: string; remember: boolean; status: number }> = [];
      evidence.initialApprovals = initialApprovals;
      await captureWindows(app, testInfo.outputPath('initial-cloud'));
      const flow = await completeOidcLogin(page, account, { baseUrl: fixture.baseUrl, timeoutMs: 100_000,
        manualConsent: true, requireCallbackEvidence: true,
        failure: async current => {
          if (await current.locator('input[type="password"]').first().isVisible()) {
            throw new Error('Initial authorization returned to a second password form');
          }
          return false;
        },
        ready: async current => {
          if (await localReady(current, fixture.baseUrl)) return true;
          if (!await current.locator('[data-pod-sign-in-state="consent"]').isVisible()) return false;
          const approval = current.getByRole('button', { name: '允许', exact: true });
          if (!await approval.isEnabled()) return false;
          // Pick-WebID and Consent are separate documents with independent
          // checkbox state. Make each actual choice before approving that page.
          const rememberGrant = current.getByRole('checkbox', { name: '以后不再询问', exact: true });
          if (!await rememberGrant.isVisible()) await current.locator('summary').filter({ hasText: '请求详情' }).click();
          await rememberGrant.check();
          await expect(rememberGrant).toBeChecked();
          await captureWindows(app!, testInfo.outputPath(`initial-approval-${initialApprovals.length + 1}`));
          // Both POST implementations navigate to a new document. Observe the
          // response and that navigation before exposing the next approval to
          // the driver, so the old DOM cannot submit a second click.
          const [response] = await Promise.all([
            current.waitForResponse(candidate => {
              const url = new URL(candidate.url());
              return candidate.request().method() === 'POST' && url.origin === new URL(fixture.issuer).origin
                && ['/.account/oidc/pick-webid/', '/.account/oidc/consent/'].includes(normalizeAccountPath(url.pathname));
            }, { timeout: 30_000 }),
            current.waitForEvent('framenavigated', { predicate: frame => frame === current.mainFrame(), timeout: 30_000 }),
            clickNonPasswordOidcAction(approval).then(clicked => { expect(clicked).toBe(true); }),
          ]);
          const posted = response.request().postDataJSON() as { remember?: unknown };
          initialApprovals.push({ path: normalizeAccountPath(new URL(response.url()).pathname),
            remember: posted.remember === true, status: response.status() });
          expect(response.status()).toBe(200);
          expect(posted.remember).toBe(true);
          await current.waitForLoadState('domcontentloaded');
          return false;
        } });
      for (const approvalPath of ['/.account/oidc/pick-webid/', '/.account/oidc/consent/']) {
        expect(initialApprovals.some(approval => approval.path === approvalPath)).toBe(true);
      }
      expect(flow.passwordSubmitted).toBe(false);
      expect(flow.callbackHasCode && flow.callbackHasState).toBe(true);
      const ready = await readBrowserXpodRuntime(page);
      expect(ready).toMatchObject({ status: 'authenticated', webId: account.webId, podUrl: account.podUrl, issuer: fixture.issuer });
      const localStorage = await storageMetadata(page, account.email, fixture.issuer);
      evidence.localAfterReady = localStorage;
      // Account hints are separate from a remembered WebID/Consent grant.
      if (!remember) expect(localStorage.persistentEmail).toBe(false);
      const consent = requests.filter(request => request.path === '/.account/oidc/consent/' && request.method === 'POST');
      expect(consent.length).toBeGreaterThan(0);
      expect(consent.every(request => request.remember === true)).toBe(true);
      expect(passwordRequests(requests)).toHaveLength(1);
      const resource = `remember-contract-${randomUUID()}.txt`;
      const body = `private-${randomUUID()}`;
      expect(await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).toMatchObject({ status: 201 });
      expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body });
      evidence.initialPrivateWriteRead = true;
      await captureWindows(app, testInfo.outputPath('initial-ready'));
      await quitDesktop(app);
      app = undefined;

      phase = 'cold';
      app = await launch();
      evidence.coldStartTested = true;
      evidence.newElectronProcess = app.process().pid !== initialPid;
      expect(evidence.newElectronProcess).toBe(true);
      const coldPage = await app.firstWindow();
      const cookieAfterRestart = await accountCookieMetadata(app, fixture.issuer);
      evidence.cloudCookieAfterRestart = cookieAfterRestart;
      if (remember) {
        expect(cookieAfterRestart.count).toBe(1);
        expect(cookieAfterRestart.persistent).toBe(true);
      }
      const resumed = await completeOidcLogin(coldPage, account, { baseUrl: fixture.baseUrl, timeoutMs: 100_000,
        ready: current => localReady(current, fixture.baseUrl), requireCallbackEvidence: false,
        failure: current => current.locator('input[type="password"]').first().isVisible() });
      expect(resumed.passwordSubmitted).toBe(false);
      const requiresPassword = await coldPage.locator('input[type="password"]').first().isVisible();
      evidence.coldStartOutcome = requiresPassword ? 'password-required' : 'authenticated';
      // Unchecked Account cookies are session cookies. OIDC provider/refresh
      // authorization remains independent; do not infer it must be revoked.
      if (remember) expect(requiresPassword).toBe(false);
      if (!requiresPassword) {
        expect(await readBrowserXpodRuntime(coldPage)).toMatchObject({ status: 'authenticated', webId: account.webId, podUrl: account.podUrl, issuer: fixture.issuer });
        expect(await fetchBrowserXpodPod(coldPage, resource)).toEqual({ status: 200, body });
        evidence.coldStartPrivateRead = true;
        evidence.localAfterRestart = await storageMetadata(coldPage, account.email, fixture.issuer);
      }
      expect(passwordRequests(requests)).toHaveLength(1);
      await captureWindows(app, testInfo.outputPath('cold'));
      if (remember) {
        await quitDesktop(app);
        app = undefined;
        phase = 'cookie-only-cleanup';
        // A new process destroys InMemoryStorage. JSON-only documents never
        // construct the product SDK, so cleanup cannot race a silent restore.
        app = await launch('/api/service-info');
        const cleanPage = await app.firstWindow();
        await cleanPage.waitForURL(new URL('/api/service-info', fixture.baseUrl).href);
        const accountCookies = (await app.context().cookies(fixture.issuer)).filter(cookie => cookie.name === 'css-account');
        expect(accountCookies.length).toBe(1);
        originalCloudCookie = accountCookies[0].value;
        const providerCookies = (await app.context().cookies(fixture.issuer)).filter(cookie => /^_session(?:\.|$)/u.test(cookie.name));
        expect(providerCookies.length).toBeGreaterThan(0);
        for (const cookie of providerCookies) {
          await app.context().clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
        }
        const remaining = await app.context().cookies(fixture.issuer);
        const cookieUnchanged = JSON.stringify(remaining.filter(cookie => cookie.name === 'css-account')) === JSON.stringify(accountCookies);
        expect(cookieUnchanged).toBe(true);
        expect(remaining.filter(cookie => /^_session(?:\.|$)/u.test(cookie.name)).length).toBe(0);
        const localCleanup = await removeSdkSessionState(cleanPage, { webId: account.webId, storageUrl: account.podUrl, routeId: 'xpod-current-origin' });
        expect(localCleanup.removed).toBeGreaterThan(0);
        expect(localCleanup.remaining).toBe(0);
        expect(localCleanup.otherStorageUnchanged).toBe(true);
        expect(localCleanup.rememberedHintPresent).toBe(true);
        expect(localCleanup.rememberedHintBytesUnchanged).toBe(true);
        expect(localCleanup.rememberedCloudWebIdMatches).toBe(true);
        expect(localCleanup.rememberedLocalStorageMatches).toBe(true);
        expect(localCleanup.rememberedRouteMatches).toBe(true);

        const cloudPageEvent = app.context().waitForEvent('page');
        await app.evaluate(({ BrowserWindow }, url) => {
          const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
          void window.loadURL(url);
        }, new URL('/api/service-info', fixture.issuer).href);
        const cloudPage = await cloudPageEvent;
        await cloudPage.waitForURL(new URL('/api/service-info', fixture.issuer).href);
        const cloudCleanup = await removeSdkSessionState(cloudPage);
        expect(cloudCleanup.remaining).toBe(0);
        expect(cloudCleanup.otherStorageUnchanged).toBe(true);
        phase = 'cookie-only';
        // This same-origin request uses the real browser cookie jar only.
        // Product Account UI may later derive a header from that same cookie;
        // those requests are recorded separately rather than called cookie-only.
        const accountProbe = await cloudPage.evaluate(async () => {
          const response = await fetch('/.account/', { credentials: 'include', headers: { Accept: 'application/json' } });
          const index = await response.json() as { controls?: { account?: unknown } };
          return { status: response.status, accountControls: Boolean(index.controls?.account) };
        });
        expect(accountProbe).toEqual({ status: 200, accountControls: true });
        await Promise.all(wireTasks);
        expect(accountWire.some(entry => entry.path === '/.account/' && entry.method === 'GET' && entry.status === 200
          && entry.originalAccountCookie === true && entry.authorizationPresent === false && entry.dpopPresent === false)).toBe(true);
        expect((await app.context().cookies(fixture.issuer)).filter(cookie => /^_session(?:\.|$)/u.test(cookie.name)).length).toBe(0);
        await captureWindows(app, testInfo.outputPath('cookie-only-probe'));
        await cloudPage.close();
        evidence.accountCookieOnlyIsolation = { cookieUnchanged, removedProviderCookies: providerCookies.length,
          providerCookiesRemaining: 0, localCleanup, cloudCleanup, accountProbe, newElectronProcess: app.process().pid !== initialPid };

        const reauthorized = await reauthorizeWithoutPassword(cleanPage, account, fixture.baseUrl);
        expect(reauthorized.passwordSubmitted).toBe(false);
        expect(reauthorized.authorizationRequestSeen && reauthorized.callbackHasCode && reauthorized.callbackHasState).toBe(true);
        expect(reauthorized.tokenAuthorizationCodeGrantSeen && reauthorized.tokenCodeVerifierSeen).toBe(true);
        const priorAuthorizations = authorizations.filter(entry => entry.phase !== 'cookie-only');
        expect(priorAuthorizations.length).toBeGreaterThan(0);
        const freshAuthorizations = authorizations.filter(entry => entry.phase === 'cookie-only');
        expect(freshAuthorizations.length).toBeGreaterThan(0);
        expect(freshAuthorizations.every(entry => Boolean(entry.state)
          && !authorizations.some(previous => previous.phase !== 'cookie-only' && previous.state === entry.state))).toBe(true);
        expect(requests.some(request => request.phase === 'cookie-only' && request.grantType === 'authorization_code' && request.status === 200)).toBe(true);
        expect(requests.some(request => request.phase === 'cookie-only' && request.grantType === 'refresh_token')).toBe(false);
        expect(passwordRequests(requests)).toHaveLength(1);
        expect(await readBrowserXpodRuntime(cleanPage)).toMatchObject({ status: 'authenticated', webId: account.webId, podUrl: account.podUrl, issuer: fixture.issuer });
        expect(await fetchBrowserXpodPod(cleanPage, resource)).toEqual({ status: 200, body });
        const initialClientHashes = [...new Set(authorizations.filter(entry => entry.phase === 'initial').map(entry => entry.clientHash))];
        const freshClientHashes = [...new Set(freshAuthorizations.map(entry => entry.clientHash))];
        expect(initialClientHashes.length).toBeGreaterThan(0);
        evidence.accountCookieOnlyReauthorization = { authenticated: true, actualAuthorizationCode200: true,
          newState: true, privateReadExact: true, initialClientHashes, freshClientHashes,
          sameClient: freshClientHashes.every(hash => initialClientHashes.includes(hash)),
          explicitApprovalPaths: reauthorized.explicitApprovalPaths, rememberedDomObserved: reauthorized.rememberedHintSeen,
          consentPosts: requests.filter(request => request.phase === 'cookie-only' && request.path === '/.account/oidc/consent/').length,
          pickWebIdPosts: requests.filter(request => request.phase === 'cookie-only' && request.path === '/.account/oidc/pick-webid/').length };
        await captureWindows(app, testInfo.outputPath('cookie-only-ready'));
      }

    } finally {
      evidence.passwordPosts = { initial: passwordRequests(requests).filter(request => request.phase === 'initial').length,
        cold: passwordRequests(requests).filter(request => request.phase === 'cold').length,
        cookieOnly: passwordRequests(requests).filter(request => request.phase === 'cookie-only').length };
      evidence.consentPosts = { initial: requests.filter(request => request.phase === 'initial' && request.path === '/.account/oidc/consent/').length,
        cold: requests.filter(request => request.phase === 'cold' && request.path === '/.account/oidc/consent/').length,
        cookieOnly: requests.filter(request => request.phase === 'cookie-only' && request.path === '/.account/oidc/consent/').length };
      await Promise.allSettled(wireTasks);
      evidence.passwordPostsTotal = passwordRequests(requests).length;
      const evidencePath = testInfo.outputPath('account-remember-safe-evidence.json');
      await writeFile(evidencePath, JSON.stringify({ ...evidence, requests, accountWire }), { mode: 0o600 });
      try { if (app) { await captureWindows(app, testInfo.outputPath('final')); await quitDesktop(app); } }
      finally { await rm(userData, { recursive: true, force: true }); }
    }
  });
}

test('managed same-site Account Bob stays independent of SDK Alice during real request credential issuance', async ({}, testInfo) => {
  test.skip(!deployment, 'Run runDesktopAccountRememberAcceptance.ts');
  test.setTimeout(360_000);
  const fixture = deployment!;
  const alice = fixture.accounts.find(account => account.role === 'alice')!;
  const bob = fixture.accounts.find(account => account.role === 'bob')!;
  expect(alice.webId).not.toBe(bob.webId);
  const localUrl = new URL(fixture.baseUrl);
  localUrl.hostname = 'localhost';
  expect(localUrl.origin).not.toBe(new URL(fixture.issuer).origin);
  const userData = await mkdtemp(path.resolve('.test-data/desktop-account-two-identities-'));
  await chmod(userData, 0o700);
  const evidence: Record<string, unknown> = { independentAccountAndSdkIdentities: true,
    injectedAccountCookie: false, injectedSdkToken: false, overriddenFetchCredentials: false };
  const wire: Array<Record<string, unknown>> = [];
  const tasks: Promise<void>[] = [];
  const passwordCounts = { alice: 0, bob: 0, unexpected: 0 };
  const credentialPosts: Array<{ phase: string; requestedWebIdIsAlice: boolean }> = [];
  let phase = 'alice-login';
  let bobCookie: string | undefined;
  const bobRenewals: Array<{ expires: number; serverDate: number; observedAt: number }> = [];
  let aliceCollection: string | undefined;
  let minted: { id: string; secret: string } | undefined;
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [path.resolve('desktop/dist/main.js')], timeout: 30_000, env: {
      ...process.env, XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_USER_DATA_DIR: userData,
      XPOD_DESKTOP_URL: new URL('/ai-connections', localUrl).href,
    } });
    app.context().on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.origin === new URL(fixture.issuer).origin
        && /\/client-credentials\/?$/u.test(url.pathname)) {
        const body = request.postDataJSON() as { webId?: string };
        credentialPosts.push({ phase, requestedWebIdIsAlice: body.webId === alice.webId });
      }
      if (request.method() !== 'POST' || normalizeAccountPath(new URL(request.url()).pathname) !== '/.account/login/password/') return;
      const body = request.postDataJSON() as { email?: string };
      if (body.email === alice.email) passwordCounts.alice++;
      else if (body.email === bob.email) passwordCounts.bob++;
      else passwordCounts.unexpected++;
    });
    app.context().on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== new URL(fixture.issuer).origin || !url.pathname.startsWith('/.account/')) return;
      const observedPhase = phase;
      tasks.push((async () => {
        const request = response.request();
        const headers = await request.allHeaders();
        let accessWebIdIsAlice = false;
        let proofAthMatches = false;
        if (headers.authorization?.startsWith('DPoP ') && headers.dpop) {
          const token = headers.authorization.slice(5);
          const access = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { webid?: string; iss?: string };
          const proof = JSON.parse(Buffer.from(headers.dpop.split('.')[1]!, 'base64url').toString()) as { ath?: string };
          accessWebIdIsAlice = access.webid === alice.webId && access.iss === fixture.issuer;
          proofAthMatches = proof.ath === createHash('sha256').update(token).digest('base64url');
        }
        const entry: Record<string, unknown> = { phase: observedPhase, path: safeAccountPath(url.pathname),
          method: request.method(), status: response.status(), cookie: Boolean(headers.cookie),
          bobCookiePresent: bobCookie !== undefined && (headers.cookie ?? '').split(';').map(value => value.trim())
            .includes(`css-account=${bobCookie}`), dpop: Boolean(headers.dpop),
          cssAccountToken: headers.authorization?.startsWith('CSS-Account-Token ') ?? false,
          accessWebIdIsAlice, proofAthMatches };
        // Keep raw Set-Cookie values in memory only. CSS renews remembered
        // Account cookies on successful Bob interactions; SDK Alice must not.
        const observedAt = Date.now() / 1000;
        const responseHeaders = await response.headersArray();
        const accountCookies = responseHeaders.filter(header => header.name.toLowerCase() === 'set-cookie'
          && /^css-account=/u.test(header.value));
        entry.accountSetCookie = accountCookies.length > 0;
        if (bobCookie !== undefined && accountCookies.length > 0) {
          const requestIsBob = entry.bobCookiePresent === true && !headers.dpop;
          entry.accountSetCookieActorIsBob = requestIsBob;
          entry.accountSetCookieSameBobValue = accountCookies.every(header =>
            header.value.split(';', 1)[0] === `css-account=${bobCookie}`);
          for (const header of accountCookies) {
            const expires = /(?:^|;)\s*Expires=([^;]+)/iu.exec(header.value)?.[1];
            const maxAge = /(?:^|;)\s*Max-Age=/iu.test(header.value);
            entry.accountSetCookieExpiresPresent = Boolean(expires);
            entry.accountSetCookieMaxAgePresent = maxAge;
            const serverDate = responseHeaders.find(value => value.name.toLowerCase() === 'date')?.value;
            if (requestIsBob && entry.accountSetCookieSameBobValue === true && expires && serverDate
              && !maxAge && response.ok()) {
              bobRenewals.push({ expires: Date.parse(expires) / 1000,
                serverDate: Date.parse(serverDate) / 1000, observedAt });
            }
          }
        }
        if (observedPhase === 'alice-demand' && response.status() === 200 && url.pathname === '/.account/' && accessWebIdIsAlice) {
          const body = await response.json() as { controls?: { account?: { clientCredentials?: string } } };
          const collection = body.controls?.account?.clientCredentials;
          if (collection) aliceCollection = new URL(collection, fixture.issuer).href;
          entry.clientCredentialsControl = Boolean(collection);
        }
        if (observedPhase === 'alice-demand' && request.method() === 'POST' && /\/client-credentials\/?$/u.test(url.pathname)) {
          const body = request.postDataJSON() as { webId?: string };
          entry.requestedWebIdIsAlice = body.webId === alice.webId;
          if (response.status() === 200) {
            const value = await response.json() as { id?: string; secret?: string; resource?: string };
            entry.resourceMatchesAliceCollection = Boolean(aliceCollection && value.resource
              && new URL(value.resource, fixture.issuer).href.startsWith(aliceCollection));
            if (value.id && value.secret) minted = { id: value.id, secret: value.secret };
          }
        }
        wire.push(entry);
      })());
    });
    const page = await app.firstWindow();
    const login = await completeOidcLogin(page, alice, { baseUrl: localUrl.href, timeoutMs: 100_000,
      requireCallbackEvidence: true, ready: current => localReady(current, localUrl.href) });
    expect(login.callbackHasCode && login.tokenAuthorizationCodeGrantSeen).toBe(true);
    expect(await readBrowserXpodRuntime(page)).toMatchObject({ status: 'authenticated', webId: alice.webId,
      issuer: fixture.issuer, podUrl: alice.podUrl });
    const resource = `two-identities-${randomUUID()}.txt`;
    const body = `private-alice-${randomUUID()}`;
    expect(await fetchBrowserXpodPod(page, resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })).toMatchObject({ status: 201 });
    expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body });
    const anonymous = await fetch(new URL(resource, alice.podUrl), { redirect: 'error' });
    expect([401, 403]).toContain(anonymous.status);
    evidence.alicePrivateWriteReadAndAnonymousDenied = true;

    phase = 'bob-login';
    const createdPage = app.context().waitForEvent('page');
    await app.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      void window.loadURL(url);
    }, new URL('/.account/account/', fixture.issuer).href);
    const cloudPage = await createdPage;
    const signOut = cloudPage.getByRole('button', { name: '退出登录', exact: true });
    await expect(signOut).toBeVisible({ timeout: 60_000 });
    const logoutResponse = cloudPage.waitForResponse(response => response.request().method() === 'POST'
      && /\/logout\/?$/u.test(new URL(response.url()).pathname));
    await signOut.click();
    expect((await logoutResponse).status()).toBe(200);
    evidence.aliceAccountLogoutViaRealUi = true;
    expect(await readBrowserXpodRuntime(page)).toMatchObject({ status: 'authenticated', webId: alice.webId,
      issuer: fixture.issuer, podUrl: alice.podUrl });
    expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body });
    evidence.aliceSdkAndPrivateReadSurviveCloudAccountLogout = true;
    await expect(cloudPage.getByLabel('邮箱', { exact: true })).toBeVisible({ timeout: 60_000 });
    await cloudPage.getByLabel('邮箱', { exact: true }).fill(bob.email);
    await cloudPage.getByLabel('密码', { exact: true }).fill(bob.password);
    await cloudPage.getByRole('checkbox', { name: '记住账号', exact: true }).check();
    const bobLoginResponse = cloudPage.waitForResponse(response => response.request().method() === 'POST'
      && normalizeAccountPath(new URL(response.url()).pathname) === '/.account/login/password/');
    await cloudPage.getByLabel('密码', { exact: true }).press('Enter');
    expect((await bobLoginResponse).status()).toBe(200);
    await cloudPage.goto(new URL('/.account/account/', fixture.issuer).href);
    await expect(cloudPage.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    const bobIndex = await cookieAccountIndex(cloudPage);
    expect(bobIndex.status).toBe(200);
    evidence.bobIndexControlMetadata = { explicitIdPresent: Boolean(bobIndex.id),
      webIdManagementControlPresent: Boolean(bobIndex.webIdControl), clientCredentialsControlPresent: Boolean(bobIndex.collection) };
    expect(bobIndex.webIdControl && bobIndex.collection).toBeTruthy();
    expect(await readBrowserXpodAccount(cloudPage)).toMatchObject({ status: 'authenticated',
      controls: { account: { webId: bobIndex.webIdControl } } });
    const bobIdentityRow = cloudPage.locator(`[data-webid-id="${bob.webId}"]`);
    await expect(bobIdentityRow).toBeVisible();
    await expect(bobIdentityRow.locator('a').first()).toHaveAttribute('href', bob.webId);
    const cookiesBefore = (await app.context().cookies(fixture.issuer)).filter(cookie => cookie.name === 'css-account');
    expect(cookiesBefore).toHaveLength(1);
    expect(cookiesBefore[0]!.expires).toBeGreaterThan(Date.now() / 1000);
    bobCookie = cookiesBefore[0]!.value;
    phase = 'bob-default';
    expect(await cookieAccountIndex(cloudPage)).toEqual(bobIndex);
    await Promise.all(tasks);
    expect(wire.some(entry => entry.phase === 'bob-default' && entry.path === '/.account/'
      && entry.status === 200 && entry.bobCookiePresent === true && entry.dpop === false)).toBe(true);
    evidence.defaultCloudAccountIsBob = true;

    // Keep the live standard SDK session. Its secure token/key storage is in
    // memory; reloading would destroy Alice and begin a different OIDC login.
    // Refresh only the product's default Account controls using Bob's cookie.
    phase = 'account-refresh';
    await refetchBrowserXpodAccount(page);
    await expect.poll(() => readBrowserXpodRuntime(page)).toMatchObject({ status: 'authenticated',
      webId: alice.webId, issuer: fixture.issuer, podUrl: alice.podUrl });
    await expect.poll(() => readBrowserXpodAccount(page)).toMatchObject({ status: 'authenticated',
      controls: { account: { webId: bobIndex.webIdControl } } });
    evidence.defaultLocalAccountIsBobWhileSdkIsAlice = true;
    expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body });
    await Promise.all(tasks);
    expect(credentialPosts).toHaveLength(0);
    evidence.credentialPostsBeforeFirstDemand = 0;
    evidence.aliceLiveSdkAndPrivateReadAfterBobAccountRefresh = true;
    phase = 'alice-demand';
    const providers = await fetchBrowserXpodGateway(page, alice.webId, localUrl.origin, '/api/ai/providers');
    expect(providers.status).toBe(200);
    expect(Array.isArray((JSON.parse(providers.body) as { data?: unknown }).data)).toBe(true);
    await Promise.all(tasks);
    const sdkAccount = wire.filter(entry => entry.phase === 'alice-demand' && entry.accessWebIdIsAlice === true);
    expect(sdkAccount.some(entry => entry.path === '/.account/' && entry.status === 200 && entry.clientCredentialsControl === true)).toBe(true);
    expect(wire.filter(entry => entry.phase === 'alice-demand' && entry.dpop === true)
      .every(entry => entry.accessWebIdIsAlice === true)).toBe(true);
    expect(sdkAccount.every(entry => entry.cookie === false && entry.cssAccountToken === false
      && entry.dpop === true && entry.proofAthMatches === true)).toBe(true);
    expect(sdkAccount.some(entry => entry.method === 'POST' && entry.status === 200
      && entry.requestedWebIdIsAlice === true && entry.resourceMatchesAliceCollection === true)).toBe(true);
    expect(aliceCollection).not.toBe(bobIndex.collection);
    expect(credentialPosts.length).toBeGreaterThan(0);
    expect(credentialPosts.every(entry => entry.phase === 'alice-demand' && entry.requestedWebIdIsAlice)).toBe(true);
    expect(minted).toBeDefined();
    // Exchange the freshly product-issued credential against the real issuer;
    // this response is never copied into the SDK or used to replace its fetch.
    const discovery = await (await fetch(new URL('/.well-known/openid-configuration', fixture.issuer))).json() as { token_endpoint: string };
    expect(new URL(discovery.token_endpoint).origin).toBe(new URL(fixture.issuer).origin);
    const key = await generateDpopKeyPair();
    const tokenResponse = await fetch(discovery.token_endpoint, { method: 'POST', headers: {
      Authorization: `Basic ${Buffer.from(`${minted!.id}:${minted!.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded', DPoP: await createDpopHeader(discovery.token_endpoint, 'POST', key) },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }) });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string; token_type: string };
    expect(token.token_type.toLowerCase()).toBe('dpop');
    const claims = JSON.parse(Buffer.from(token.access_token.split('.')[1]!, 'base64url').toString()) as { webid?: string; iss?: string };
    expect(claims).toMatchObject({ webid: alice.webId, iss: fixture.issuer });
    minted = undefined;
    expect(await fetchBrowserXpodPod(page, resource)).toEqual({ status: 200, body });
    expect(await cookieAccountIndex(cloudPage)).toEqual(bobIndex);
    expect(await readBrowserXpodAccount(cloudPage)).toMatchObject({ controls: { account: { webId: bobIndex.webIdControl } } });
    expect(await readBrowserXpodAccount(page)).toMatchObject({ controls: { account: { webId: bobIndex.webIdControl } }, status: 'authenticated' });
    expect([401, 403]).toContain((await fetch(new URL(resource, alice.podUrl), { redirect: 'error' })).status);
    expect(passwordCounts).toEqual({ alice: 1, bob: 1, unexpected: 0 });
    await Promise.all(tasks);
    const cookiesAfter = (await app.context().cookies(fixture.issuer)).filter(cookie => cookie.name === 'css-account');
    expect(cookiesAfter).toHaveLength(1);
    const { expires: expiresBefore, ...identityBefore } = cookiesBefore[0]!;
    const { expires: expiresAfter, ...identityAfter } = cookiesAfter[0]!;
    expect(identityAfter).toEqual(identityBefore);
    expect(expiresAfter).toBeGreaterThanOrEqual(expiresBefore);
    const sdkResponses = wire.filter(entry => entry.phase === 'alice-demand' && entry.accessWebIdIsAlice === true);
    expect(sdkResponses.every(entry => entry.accountSetCookie === false)).toBe(true);
    const bobSetCookieResponses = wire.filter(entry => ['account-refresh', 'alice-demand'].includes(String(entry.phase))
      && entry.accountSetCookie === true);
    expect(bobSetCookieResponses.every(entry => entry.accountSetCookieActorIsBob === true
      && entry.accountSetCookieSameBobValue === true && entry.accountSetCookieExpiresPresent === true
      && entry.accountSetCookieMaxAgePresent === false && Number(entry.status) >= 200 && Number(entry.status) < 300)).toBe(true);
    if (expiresAfter !== expiresBefore) {
      expect(bobRenewals.length).toBeGreaterThan(0);
      // Chromium corrects Expires for server clock skew using the response Date.
      // Bound that correction by the actual response receipt, without ignoring
      // a Cookie lifecycle change or treating an unrelated response as renewal.
      expect(bobRenewals.some(renewal => Math.abs(expiresAfter
        - (renewal.observedAt + renewal.expires - renewal.serverDate)) <= 2)).toBe(true);
    }
    Object.assign(evidence, { sdkAliceCookieFreeAccountControlsAndCredential: true, aliceTokenStatus: 200,
      aliceTokenExactIdentityAndIssuer: true, providersApiStatus: providers.status, alicePrivateReadExact: true,
      bobCookieBytesAndIdentityUnchanged: true, bobCookieExpiryDeltaSeconds: expiresAfter - expiresBefore,
      bobCookieExpiryChangeHasRealBobRenewal: expiresAfter === expiresBefore || bobRenewals.length > 0,
      sdkAliceResponsesSetNoAccountCookie: true, defaultCloudAccountRemainsBob: true });
  } finally {
    await Promise.allSettled(tasks);
    const output = testInfo.outputPath('two-identities-safe-evidence.json');
    await writeFile(output, JSON.stringify({ ...evidence, passwordCounts, credentialPosts, wire }), { mode: 0o600 });
    try { if (app) { await captureWindows(app, testInfo.outputPath('two-identities-final')); await quitDesktop(app); } }
    finally { await rm(userData, { recursive: true, force: true }); }
  }
});

async function cookieAccountIndex(page: Page): Promise<{ status: number; id?: string; webIdControl?: string; collection?: string }> {
  return page.evaluate(async () => {
    const response = await fetch('/.account/', { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
    const value = await response.json() as { controls?: { account?: { id?: string; webId?: string; clientCredentials?: string } } };
    const account = value.controls?.account;
    return { status: response.status, id: account?.id,
      webIdControl: account?.webId ? new URL(account.webId, window.location.href).href : undefined,
      collection: account?.clientCredentials ? new URL(account.clientCredentials, window.location.href).href : undefined };
  });
}

function passwordRequests<T extends { path: string; method: string }>(requests: T[]) {
  return requests.filter(request => request.method === 'POST' && request.path === '/.account/login/password/');
}

async function localReady(page: Page, baseUrl: string): Promise<boolean> {
  return new URL(page.url()).origin === new URL(baseUrl).origin
    && await page.locator('[data-testid="xpod-user-card-trigger"][data-pod-ready="true"]').isVisible();
}

async function storageMetadata(page: Page, expectedEmail: string, issuer: string) {
  return page.evaluate(({ expectedEmail, issuer }) => {
    const pendingKey = 'xpod.pending-account-email.v1';
    const rememberedKey = 'xpod.remembered-login.v1';
    const choices = JSON.parse(localStorage.getItem('xpod.account-remember-choice.v1') ?? '{}') as Record<string, unknown>;
    const remembered = JSON.parse(localStorage.getItem(rememberedKey) ?? 'null') as { account?: { email?: string } } | null;
    return { origin: location.origin, rememberChoice: choices[new URL(issuer).origin] ?? null,
      persistentEmail: localStorage.getItem(pendingKey) === expectedEmail || remembered?.account?.email === expectedEmail,
      sessionEmail: sessionStorage.getItem(pendingKey) === expectedEmail, rememberedWebIdPresent: remembered !== null };
  }, { expectedEmail, issuer });
}

async function accountCookieMetadata(app: ElectronApplication, issuer: string) {
  const cookies = (await app.context().cookies(issuer)).filter(cookie => cookie.name === 'css-account');
  const cookie = cookies[0];
  return { count: cookies.length, persistent: Boolean(cookie && cookie.expires > Date.now() / 1000),
    session: Boolean(cookie && cookie.expires <= 0), sameSite: cookie?.sameSite,
    secure: cookie?.secure, httpOnly: cookie?.httpOnly };
}

async function captureWindows(app: ElectronApplication, prefix: string): Promise<void> {
  for (const [index, page] of app.windows().filter(window => !window.isClosed()).entries()) {
    const filename = `${prefix}-${index}.png`;
    await page.screenshot({ path: filename, timeout: 3_000, mask: [page.locator('input'), page.getByTestId('xpod-user-card-trigger')] })
      .then(() => chmod(filename, 0o600)).catch(() => undefined);
  }
}

async function quitDesktop(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Electron did not quit')), 20_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await app.evaluate(({ app: desktop }) => { desktop.emit('xpod:acceptance:quit-app'); });
  await app.close();
  await exited;
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
}

/** Remove authentication records only; preserve every other byte of each store. */
async function removeSdkSessionState(page: Page, expectedIdentity?: { webId: string; storageUrl: string; routeId: string }) {
  return page.evaluate(expected => {
    const rememberedBefore = localStorage.getItem('xpod.remembered-login.v1');
    const isSdkKey = (key: string) => key.startsWith('xpod.inrupt.') || key.startsWith('solidClientAuthn:')
      || key.startsWith('solidClientAuthenticationUser:') || key === 'xpod.solid.sessionId';
    let removed = 0;
    let remaining = 0;
    let otherStorageUnchanged = true;
    for (const storage of [localStorage, sessionStorage]) {
      const preserved = Object.keys(storage).filter(key => !isSdkKey(key)).map(key => [key, storage.getItem(key)]);
      for (const key of Object.keys(storage).filter(isSdkKey)) { storage.removeItem(key); removed++; }
      remaining += Object.keys(storage).filter(isSdkKey).length;
      otherStorageUnchanged &&= preserved.every(([key, value]) => storage.getItem(key!) === value);
    }
    const rememberedAfter = localStorage.getItem('xpod.remembered-login.v1');
    const remembered = JSON.parse(rememberedAfter ?? 'null') as {
      webId?: string; routeId?: string; storageBinding?: { webId?: string; storageUrl?: string };
    } | null;
    return { removed, remaining, otherStorageUnchanged, rememberedHintPresent: rememberedAfter !== null,
      rememberedHintBytesUnchanged: rememberedBefore !== null && rememberedBefore === rememberedAfter,
      rememberedCloudWebIdMatches: expected ? remembered?.webId === expected.webId && remembered.storageBinding?.webId === expected.webId : null,
      rememberedLocalStorageMatches: expected ? remembered?.storageBinding?.storageUrl === expected.storageUrl : null,
      rememberedRouteMatches: expected ? remembered?.routeId === expected.routeId : null };
  }, expectedIdentity ?? null);
}

/** Drive the existing protocol helper, stopping to explicitly approve Consent. */
async function reauthorizeWithoutPassword(page: Page, account: DesktopRememberDeployment['accounts'][number], baseUrl: string) {
  // A form mounting between the failure probe and the helper's password probe
  // still cannot read credentials, let alone enter them into a second form.
  const identity = { webId: account.webId, podUrl: account.podUrl,
    get email(): string { throw new Error('Account-cookie-only flow attempted credential entry'); },
    get password(): string { throw new Error('Account-cookie-only flow attempted credential entry'); } };
  const traces: Awaited<ReturnType<typeof completeOidcLogin>>[] = [];
  const explicitApprovalPaths: string[] = [];
  let rememberedHintSeen = false;
  const deadline = Date.now() + 100_000;
  for (let attempt = 0; attempt < 4; attempt++) {
    const trace = await completeOidcLogin(page, identity, { baseUrl,
      ...(attempt === 0 ? { startUrl: new URL('/ai-connections', baseUrl).href } : {}),
      timeoutMs: Math.max(1, deadline - Date.now()), manualConsent: true,
      ready: async current => {
        rememberedHintSeen ||= await current.locator('[data-pod-sign-in-state="remembered"]').isVisible();
        return await localReady(current, baseUrl)
          || await current.locator('[data-pod-sign-in-state="consent"]').isVisible()
            && await current.getByRole('button', { name: '允许', exact: true }).isEnabled();
      },
      failure: async current => {
        if (await current.locator('input[type="password"]').first().isVisible()) {
          throw new Error('Account-cookie-only reauthorization requested a second password');
        }
        return false;
      } });
    traces.push(trace);
    expect(trace.passwordSubmitted).toBe(false);
    if (await localReady(page, baseUrl)) {
      return { passwordSubmitted: false, explicitApprovalPaths, rememberedHintSeen,
        authorizationRequestSeen: traces.some(entry => entry.authorizationRequestSeen),
        callbackHasCode: traces.some(entry => entry.callbackHasCode),
        callbackHasState: traces.some(entry => entry.callbackHasState),
        tokenAuthorizationCodeGrantSeen: traces.some(entry => entry.tokenAuthorizationCodeGrantSeen),
        tokenCodeVerifierSeen: traces.some(entry => entry.tokenCodeVerifierSeen) };
    }
    // This is an explicit approval of the real displayed page; it is recorded
    // independently from password, WebID-pick and server Consent POST counts.
    const approval = page.getByRole('button', { name: '允许', exact: true });
    await expect(approval).toBeVisible();
    explicitApprovalPaths.push(normalizeAccountPath(new URL(page.url()).pathname));
    expect(await clickNonPasswordOidcAction(approval)).toBe(true);
  }
  throw new Error('Account-cookie-only reauthorization exceeded explicit approval bound');
}

/** Account identifiers belong in private raw evidence, never safe wire paths. */
function safeAccountPath(pathname: string): string {
  return normalizeAccountPath(pathname).replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/giu, '/<id>');
}
