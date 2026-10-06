import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startBrowserExternalRp } from '../helpers/browserExternalRp';
import { expect, test, type Page, type Request } from '@playwright/test';
import { completeOidcLogin, normalizeAccountPath } from '../helpers/browserSolidOidc';

type Deployment = {
  mode: 'cloud' | 'managed-local' | 'standalone';
  runnerBunVersion?: string;
  baseUrl: string;
  issuer: string;
  account: { email: string; password: string; username: string };
};
const manifestPath = process.env.XPOD_E2E_LOGIN_MATRIX_MANIFEST;
const deployments = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Deployment[] : [];

// The relying party is intentionally a tiny external test application. It does
// not mount Xpod's desktop shell or inject a desktop bridge into Chromium.
// Accounts, Consent, creation, issuer and protected resources are real Xpod.
if (!manifestPath) test('deployment matrix requires its isolated runner', () => {
  test.skip(true, 'Run bun --no-env-file tests/helpers/runLoginDeploymentMatrix.ts');
});

for (const deployment of deployments) {
  test.describe(`${deployment.mode} lightweight Web and external application`, () => {
    test.describe.configure({ mode: 'serial', timeout: 240_000 });
    let rp: Awaited<ReturnType<typeof startBrowserExternalRp>>;
    let provisionCode: string | undefined;
    const origin = new URL(deployment.baseUrl).origin;
    const expectedPod = `${origin}/${deployment.account.username}/`;
    let expectedWebId: string | undefined = deployment.mode === 'managed-local' ? undefined : `${expectedPod}profile/card#me`;
    // Retain request identity and completion evidence if document/module loading
    // stalls. Never capture query strings, request bodies, cookies or tokens.
    let network: Array<Record<string, unknown>> = [];
    test.beforeEach(async ({ page }) => {
      network = [];
      const requests = new WeakMap<Request, number>();
      let requestId = 0;
      const record = (phase: string, request: Request, status?: number) => {
        if (network.length >= 600) return;
        if (!requests.has(request)) requests.set(request, ++requestId);
        const url = new URL(request.url());
        network.push({ phase, id: requests.get(request), origin: url.origin, path: url.pathname,
          type: request.resourceType(), method: request.method(), ...(status === undefined ? {} : { status }) });
      };
      page.on('request', request => record('request', request));
      page.on('response', response => record('response', response.request(), response.status()));
      page.on('requestfinished', request => record('finished', request));
      page.on('requestfailed', request => record('failed', request));
    });
    test.afterEach(async () => {
      const testInfo = test.info();
      await testInfo.attach('browser-navigation-evidence', { contentType: 'application/json', body: JSON.stringify(network) });
    });

    test.beforeAll(async () => {
      rp = await startBrowserExternalRp(deployment.issuer);
      const metadataResponse = await fetch(`${origin}/api/service-info`);
      expect(metadataResponse.status).toBe(200);
      const metadata = await metadataResponse.json() as Record<string, unknown>;
      expect(metadata).toMatchObject({
        edition: deployment.mode === 'cloud' ? 'cloud' : 'local',
        managed: deployment.mode === 'managed-local',
      });
      expect(Object.keys(metadata).every(key => ['edition', 'managed', 'publicUrl', 'oidcIssuer'].includes(key))).toBe(true);
      if (deployment.mode === 'managed-local') {
        expect(origin).not.toBe(new URL(deployment.issuer).origin);
        const provision = await fetch(`${origin}/provision/status`);
        const state = await provision.json() as { managed: boolean; registered: boolean; oidcIssuer: string; provisionCode: string };
        expect(state).toMatchObject({ managed: true, registered: true, oidcIssuer: deployment.issuer });
        expect(state.provisionCode).toBeTruthy();
        provisionCode = state.provisionCode;
      }
    });

    test.afterAll(async () => {
      await rp?.close();
    });

    for (const register of [true, false]) {
      test(register ? 'registration and quick creation return to the original Consent and grant private Pod access'
        : 'an existing account can authorize an external application to access its private Pod', async ({ page }, testInfo) => {
        const passwordAuthorityPosts: string[] = [];
        page.context().on('request', request => {
          const url = new URL(request.url());
          if (request.method() === 'POST' && normalizeAccountPath(url.pathname) === '/.account/login/password/') passwordAuthorityPosts.push(url.origin);
        });
        const authorization = rp.authorization(provisionCode);
        if (register) {
          await registerFromProduct(page, deployment, authorization.url);
          const bindingWebId = await readCreatedAccountBinding(page, deployment, expectedPod);
          if (expectedWebId) expect(bindingWebId).toBe(expectedWebId);
          expectedWebId = bindingWebId;
        }
        expect(expectedWebId).toBeTruthy();
        await completeOidcLogin(page, { ...deployment.account, podUrl: expectedPod, webId: expectedWebId }, {
          baseUrl: new URL(rp.callbackUrl).origin,
          ...(register ? {} : { startUrl: authorization.url }),
          ready: current => current.getByRole('heading', { name: 'Application callback', exact: true }).isVisible(),
          requireCallbackEvidence: false,
          timeoutMs: 120_000,
        });
        const callback = new URL(page.url());
        const session = await authorization.exchange(callback);
        expect(session.webId).toBe(expectedWebId);
        expect(new URL(session.issuer).origin).toBe(new URL(deployment.issuer).origin);
        const { authenticatedFetch } = session;
        const resource = new URL(`matrix-private-${randomUUID()}.txt`, expectedPod).href;
        const body = `private-matrix-${randomUUID()}`;
        const write = await authenticatedFetch(resource, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body });
        expect(write.status).toBe(201);
        const read = await authenticatedFetch(resource);
        expect(read.status).toBe(200);
        expect(await read.text()).toBe(body);
        expect([401, 403]).toContain((await fetch(resource)).status);
        await testInfo.attach('external-application-evidence', { contentType: 'application/json', body: JSON.stringify({
          mode: deployment.mode, runnerBunVersion: deployment.runnerBunVersion, origin, issuer: deployment.issuer,
          callbackOrigin: callback.origin, selectedWebId: session.webId, podUrl: expectedPod,
          registeredFromProduct: register, passwordAuthorityPosts, nativeCallbackCodeAndState: true, tokenStatus: session.tokenStatus,
          privateWriteRead: true, anonymousDenied: true, managedProvisionScope: Boolean(provisionCode),
        }) });
      });
    }

    for (const accountCookieOnly of [false, true]) {
      test(`session reuse with ${accountCookieOnly ? 'only the Account cookie' : 'the existing provider session'} preserves identity, Consent and browser isolation`, async ({ page, context, browser }, testInfo) => {
        const passwordPosts: string[] = [];
        const consentPosts: string[] = [];
        const pickWebIdPosts: string[] = [];
        context.on('request', request => {
          const url = new URL(request.url());
          if (request.method() !== 'POST') return;
          const pathname = normalizeAccountPath(url.pathname);
          if (pathname === '/.account/login/password/') passwordPosts.push(url.origin);
          if (pathname === '/.account/oidc/consent/') consentPosts.push(url.origin);
          if (pathname === '/.account/oidc/pick-webid/') pickWebIdPosts.push(url.origin);
        });
        const credentials = { ...deployment.account, podUrl: expectedPod, webId: expectedWebId };
        const loginOptions = {
          baseUrl: new URL(rp.callbackUrl).origin,
          ready: (current: Page) => current.getByRole('heading', { name: 'Application callback', exact: true }).isVisible(),
          requireCallbackEvidence: false,
          timeoutMs: 90_000,
        };
        const passwordVisible = (current: Page) => current.locator('input[type="password"]').first().isVisible();
        const consentVisible = (current: Page) => current.getByRole('button', { name: '允许', exact: true }).isVisible();
        const exchange = async (authorization: ReturnType<typeof rp.authorization>) => {
          const callback = new URL(page.url());
          expect(`${callback.origin}${callback.pathname}`).toBe(rp.callbackUrl);
          expect(callback.searchParams.get('state')).toBe(authorization.state);
          expect(callback.searchParams.get('error')).toBeNull();
          expect(callback.searchParams.get('code')).toBeTruthy();
          const session = await authorization.exchange(callback);
          expect(session.webId).toBe(expectedWebId);
          expect(new URL(session.issuer).href).toBe(new URL(deployment.issuer).href);
          expect(session.tokenStatus).toBe(200);
          return session;
        };

        const first = rp.authorization(provisionCode);
        const initialTrace = await completeOidcLogin(page, credentials, {
          ...loginOptions, startUrl: first.url, ready: consentVisible, manualConsent: true, rememberAccount: true,
        });
        expect(initialTrace.passwordSubmitted).toBe(true);
        expect(passwordPosts).toEqual([new URL(deployment.issuer).origin]);
        await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
        const rememberChoice = page.getByRole('checkbox', { name: '以后不再询问', exact: true });
        if (!await rememberChoice.isVisible()) {
          await page.locator('summary').filter({ hasText: '请求详情' }).click();
        }
        await rememberChoice.check();
        await expect(rememberChoice).toBeChecked();
        expect(consentPosts).toHaveLength(0);
        const initialCompletion = await completeOidcLogin(page, credentials, { ...loginOptions, failure: passwordVisible });
        expect(initialCompletion.passwordSubmitted).toBe(false);
        const initialSession = await exchange(first);
        expect(consentPosts).toHaveLength(1);
        const initialPickWebIdPosts = pickWebIdPosts.length;
        expect(initialPickWebIdPosts).toBe(1);
        const resource = new URL(`matrix-session-reuse-${randomUUID()}.txt`, expectedPod).href;
        const body = `private-session-reuse-${randomUUID()}`;
        expect((await initialSession.authenticatedFetch(resource, {
          method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body,
        })).status).toBe(201);
        expect([401, 403]).toContain((await fetch(resource)).status);

        if (accountCookieOnly) {
          const accountCookies = (await context.cookies(deployment.issuer)).filter(cookie => cookie.name === 'css-account');
          expect(accountCookies).toHaveLength(1);
          const providerCookies = (await context.cookies(deployment.issuer)).filter(cookie => /^_session(?:\.|$)/u.test(cookie.name));
          expect(providerCookies.length).toBeGreaterThan(0);
          for (const cookie of providerCookies) {
            await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
          }
          // Clear storage on both real origins (separate on Managed Local),
          // retaining the original cookie instead of manufacturing a session.
          for (const storageOrigin of new Set([origin, new URL(deployment.issuer).origin, new URL(rp.callbackUrl).origin])) {
            await page.goto(new URL('/dashboard', storageOrigin).href, { waitUntil: 'domcontentloaded' });
            expect(new URL(page.url()).origin).toBe(storageOrigin);
            await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
          }
          expect((await context.cookies(deployment.issuer)).filter(cookie => cookie.name === 'css-account')).toEqual(accountCookies);
          expect((await context.cookies(deployment.issuer)).filter(cookie => /^_session(?:\.|$)/u.test(cookie.name))).toHaveLength(0);
        }

        const resumed = rp.authorization(provisionCode);
        expect(resumed.state).not.toBe(first.state);
        const resumedTrace = await completeOidcLogin(page, credentials, {
          ...loginOptions, startUrl: resumed.url, failure: passwordVisible, ready: consentVisible, manualConsent: true,
        });
        expect(resumedTrace.passwordSubmitted).toBe(false);
        expect(passwordPosts).toHaveLength(1);
        // The RP is a dynamically registered native client, not Xpod Desktop.
        // oidc-provider requires native-client re-consent; only the real desktop
        // client has Xpod's remembered-grant exemption. Make this extra approval
        // explicit so the login helper cannot conceal a second consent screen.
        expect(normalizeAccountPath(new URL(page.url()).pathname)).toBe('/.account/oidc/consent/');
        await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
        expect(consentPosts).toHaveLength(1);
        expect(resumed.tokenRequests).toBe(0);
        const resumedCompletion = await completeOidcLogin(page, credentials, { ...loginOptions, failure: passwordVisible });
        expect(resumedCompletion.passwordSubmitted).toBe(false);
        const resumedSession = await exchange(resumed);
        expect(consentPosts).toHaveLength(2);
        const resumedPickWebIdPosts = pickWebIdPosts.length - initialPickWebIdPosts;
        expect(resumedPickWebIdPosts).toBe(accountCookieOnly ? 1 : 0);
        const read = await resumedSession.authenticatedFetch(resource);
        expect(read.status).toBe(200);
        expect(await read.text()).toBe(body);

        const explicit = rp.authorization(provisionCode);
        const explicitUrl = new URL(explicit.url);
        explicitUrl.searchParams.set('prompt', 'consent');
        const consentTrace = await completeOidcLogin(page, credentials, {
          ...loginOptions, startUrl: explicitUrl.href, failure: passwordVisible,
          ready: consentVisible, manualConsent: true,
        });
        expect(consentTrace.passwordSubmitted).toBe(false);
        expect(normalizeAccountPath(new URL(page.url()).pathname)).toBe('/.account/oidc/consent/');
        await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
        expect(explicit.tokenRequests).toBe(0);
        expect(consentPosts).toHaveLength(2);
        const consentCompletion = await completeOidcLogin(page, credentials, { ...loginOptions, failure: passwordVisible });
        expect(consentCompletion.passwordSubmitted).toBe(false);
        const explicitSession = await exchange(explicit);
        const explicitRead = await explicitSession.authenticatedFetch(resource);
        expect(explicitRead.status).toBe(200);
        expect(await explicitRead.text()).toBe(body);
        expect(passwordPosts).toHaveLength(1);
        expect(consentPosts).toHaveLength(3);
        expect(pickWebIdPosts).toHaveLength(initialPickWebIdPosts + resumedPickWebIdPosts);
        expect(consentPosts.every(postOrigin => postOrigin === new URL(deployment.issuer).origin)).toBe(true);
        expect(pickWebIdPosts.every(postOrigin => postOrigin === new URL(deployment.issuer).origin)).toBe(true);

        const cleanContext = await browser.newContext();
        try {
          expect(await cleanContext.cookies()).toHaveLength(0);
          const cleanPage = await cleanContext.newPage();
          const fresh = rp.authorization(provisionCode);
          await cleanPage.goto(fresh.url, { waitUntil: 'domcontentloaded' });
          await expect(cleanPage.getByLabel('邮箱', { exact: true })).toBeVisible({ timeout: 60_000 });
          await expect(cleanPage.getByLabel('密码', { exact: true })).toBeVisible();
          expect(new URL(cleanPage.url()).origin).toBe(new URL(deployment.issuer).origin);
          expect(fresh.tokenRequests).toBe(0);
          expect([401, 403]).toContain((await cleanContext.request.get(resource)).status());
        } finally {
          await cleanContext.close();
        }
        await testInfo.attach('session-reuse-evidence', { contentType: 'application/json', body: JSON.stringify({
          mode: deployment.mode, accountCookieOnly, issuer: deployment.issuer, selectedWebId: expectedWebId,
          passwordPosts: { initial: 1, resumed: 0, explicitConsent: 0 },
          consentPosts: { initial: 1, resumed: 1, explicitConsent: 1 },
          pickWebIdPosts: { initial: initialPickWebIdPosts, resumed: resumedPickWebIdPosts,
            explicitConsent: pickWebIdPosts.length - initialPickWebIdPosts - resumedPickWebIdPosts },
          nativeExternalClientRequiresReconsent: true,
          newCallbackStateValidated: true, privatePodReadAfterResume: true,
          explicitConsentDisplayed: true, privatePodReadAfterExplicitConsent: true,
          cleanContextRequiresPassword: true, cleanContextPrivatePodDenied: true,
        }) });
      });
    }

    for (const route of ['/dashboard', '/status/overview', '/network', '/settings/pod', '/ai-connections', '/ai-config/model-assignments']) {
      test(`browser ${route} provides the lightweight desktop entry`, async ({ page }) => {
        await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: '在桌面 Xpod 中管理', exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('xpod-user-card-trigger')).toHaveCount(0);
        await expect(page.getByRole('link', { name: '账号页面', exact: true })).toHaveAttribute('href', new URL('/.account/account/', deployment.issuer).href);
        expect(await page.evaluate(() => Boolean(window.xpodDesktop))).toBe(false);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: '在桌面 Xpod 中管理', exact: true })).toBeVisible();
      });
    }
  });
}

async function registerFromProduct(page: Page, deployment: Deployment, startUrl: string): Promise<void> {
  const issuerOrigin = new URL(deployment.issuer).origin;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => url.origin === issuerOrigin && url.pathname.startsWith('/.account/'), { timeout: 60_000 });
  // The sign-in footer opens registration through its own "注册账号" text action.
  // That entry is a different control from the register form's "创建账号" submit;
  // binding them to one label is exactly what the product stopped doing.
  await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await expect(page.getByTestId('xpod-deployment-identity')).toContainText(deployment.mode === 'standalone' ? '独立部署' : '云端');
  await page.getByRole('button', { name: '部署详情', exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText(`当前访问：${issuerOrigin}`);
  await expect(page.getByRole('tooltip')).toContainText(deployment.mode === 'standalone' ? 'Local · 独立部署' : 'Cloud');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByLabel('邮箱', { exact: true }).fill(deployment.account.email);
  await page.getByLabel('密码', { exact: true }).fill(deployment.account.password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();

  // Registration creates the Account only. With a pending authorization the
  // product hands over to the *original* Consent, which now only guides: it
  // carries no WebID/Pod name form and never creates from the authorization page.
  await page.waitForURL(url => url.origin === issuerOrigin && url.pathname.includes('/oidc/consent/'), { timeout: 120_000, waitUntil: 'domcontentloaded' });
  const consentUrl = new URL(page.url());
  const consentOrigin = consentUrl.origin;
  const consentPath = consentUrl.pathname;
  expect(consentOrigin).toBe(issuerOrigin);
  const interactionScope = /^\/\.account\/interaction\/[^/]+/u.exec(consentPath)?.[0];
  if (!interactionScope) throw new Error(`Consent URL is not scoped to an interaction: ${consentPath}`);
  const quickCreatePath = `${interactionScope}/create-pod/`;
  await expect(page.getByRole('heading', { name: '还没有 WebID', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('first-pod-quick-create')).toHaveCount(0);
  await expect(page.locator('input[name="podName"]')).toHaveCount(0);
  await expect(page.locator('input[name="webIdName"]')).toHaveCount(0);

  // The missing-Pod primary action hands the one-time task to the same-UID
  // lightweight quick-create page; it must keep the Consent's origin and the
  // exact same interaction scope path.
  const enterQuickCreate = async (): Promise<void> => {
    await page.getByRole('button', { name: '创建并继续', exact: true }).click();
    await page.waitForURL(url => url.origin === consentOrigin && url.pathname === quickCreatePath, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).origin).toBe(consentOrigin);
    expect(new URL(page.url()).pathname).toBe(quickCreatePath);
  };
  await enterQuickCreate();

  // The deployment detour stays lightweight in the browser and preserves the
  // original Consent. Heavy management is available only in the desktop host.
  await page.getByTestId('first-pod-quick-create').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '使用自己的部署', exact: true }).click();
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === '/settings/pod', { timeout: 60_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe('/settings/pod');
  await expect(page.getByRole('heading', { name: '在桌面 Xpod 中管理', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '回到授权', exact: true }).click();
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === consentPath, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe(consentPath);

  // Back on the same Consent, re-enter the same-UID quick-create page, then the
  // user names the Pod and explicitly submits before anything is created.
  await enterQuickCreate();
  const quickCreate = page.getByTestId('first-pod-quick-create');
  await quickCreate.waitFor({ timeout: 120_000 });
  await quickCreate.getByLabel('Pod 名称').fill(deployment.account.username);
  await quickCreate.getByRole('button', { name: '创建 Pod 并继续授权', exact: true }).click();

  // Creation returns to the very same Consent: same origin, interaction UID and target.
  await page.waitForURL(url => url.origin === consentOrigin && url.pathname === consentPath, { timeout: 120_000, waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).origin).toBe(consentOrigin);
  expect(new URL(page.url()).pathname).toBe(consentPath);
}

async function readCreatedAccountBinding(page: Page, deployment: Deployment, podUrl: string): Promise<string> {
  const bindings = await page.evaluate(async issuer => {
    const index = await fetch(new URL('/.account/', issuer).href, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!index.ok) throw new Error(`Account controls unavailable (${index.status})`);
    const control = (await index.json()).controls?.account?.bindings;
    if (!control) throw new Error('Account did not expose storage bindings');
    const url = new URL(control, issuer);
    if (url.origin !== new URL(issuer).origin) throw new Error('Account bindings authority changed');
    const response = await fetch(url.href, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Account bindings unavailable (${response.status})`);
    return (await response.json()).bindings as Array<{ webId: string; storageUrl: string }>;
  }, deployment.issuer);
  const exactBindings = bindings.filter(binding => new URL(binding.storageUrl).href === new URL(podUrl).href);
  expect(exactBindings).toHaveLength(1);
  const webId = exactBindings[0].webId;
  expect(new URL(webId).origin).toBe(new URL(deployment.issuer).origin);
  if (deployment.mode === 'managed-local') expect(new URL(webId).origin).not.toBe(new URL(podUrl).origin);
  return webId;
}
