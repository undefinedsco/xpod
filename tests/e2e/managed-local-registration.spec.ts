import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { normalizeAccountPath } from '../helpers/browserSolidOidc';

const liveUrl = process.env.XPOD_E2E_LIVE_URL;

test('managed Local fresh registration returns through consent to its original AI Connections', async ({ browser }, testInfo) => {
  test.skip(!liveUrl, 'Set XPOD_E2E_LIVE_URL to an already-running managed Local Gateway or dev UI');
  test.setTimeout(240_000);
  const origin = new URL(liveUrl!).origin;
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const account = {
    email: `registration-${suffix}@example.com`,
    password: `Register-${suffix}-Pass123!`,
    username: `reg-${suffix}`,
  };
  // This is an explicit live acceptance: retain only private credentials so a
  // failed attempt can be resumed without creating another real account.
  const dataRoot = path.resolve('.test-data');
  await mkdir(dataRoot, { recursive: true });
  const privateRoot = await mkdtemp(path.join(dataRoot, 'managed-local-registration-'));
  await writeFile(path.join(privateRoot, 'account.json'), JSON.stringify(account), { mode: 0o600 });
  const context = await browser.newContext();
  const page = await context.newPage();
  const navigations: string[] = [];
  let authorizationStarted = false;
  let authorizationHasProvisionCode = false;
  let callbackHasCode = false;
  let callbackHasState = false;
  let registrationCompleted = false;
  let laterPasswordPosts = 0;
  const responses: Array<{ origin: string; path: string; method: string; status: number }> = [];
  const saveTrace = () => writeFileSync(path.join(privateRoot, 'navigation.json'), JSON.stringify({ navigations, responses, authorizationStarted, authorizationHasProvisionCode, registrationCompleted, laterPasswordPosts }), { mode: 0o600 });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.searchParams.get('response_type') === 'code' && url.searchParams.has('code_challenge')) {
      authorizationStarted = true;
      authorizationHasProvisionCode ||= url.searchParams.has('provisionCode');
      saveTrace();
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    navigations.push(`${url.origin}${url.pathname}`);
    if (url.pathname === '/auth/callback') {
      callbackHasCode ||= url.searchParams.has('code');
      callbackHasState ||= url.searchParams.has('state');
    }
    saveTrace();
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!/\/(?:\.account|\.oidc|auth\/callback|provision)\//u.test(url.pathname) && !url.pathname.endsWith('/profile/card')) return;
    if (registrationCompleted && normalizeAccountPath(url.pathname) === '/.account/login/password/' && response.request().method() === 'POST') laterPasswordPosts++;
    responses.push({ origin: url.origin, path: url.pathname, method: response.request().method(), status: response.status() });
    saveTrace();
  });
  try {
    await page.goto(`${origin}/ai-connections`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const status = await context.request.get(`${origin}/provision/status`, { timeout: 60_000 });
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ managed: true, registered: true });
    const provisionStatus = await status.json();
    const issuerOrigin = new URL(provisionStatus.oidcIssuer).origin;
    await page.waitForURL((url) => url.origin === issuerOrigin && url.pathname.startsWith('/.account/'), { timeout: 60_000, waitUntil: 'domcontentloaded' });
    expect(authorizationStarted).toBe(true);
    expect(authorizationHasProvisionCode).toBe(true);
    // Confirm that the IdP recognizes the original authorization interaction
    // before creating any real account. This is not an independent Account login.
    const interactionCookies = await context.cookies(page.url());
    expect(interactionCookies.some((cookie) => cookie.name === '_interaction' && cookie.value.length > 0)).toBe(true);
    const registrationButton = page.getByRole('button', { name: '创建账号', exact: true });
    await expect(registrationButton).toBeVisible();
    await registrationButton.click();
    await page.locator('input[name="username"]').fill(account.username);
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
    await page.locator('input[name="confirmation"]').fill(account.password);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    // Registration may still be associating credentials and provisioning the
    // Pod. The generic login helper must not refill that disabled form.
    await Promise.race([
      page.waitForURL((url) => !url.pathname.includes('/register/'), { timeout: 120_000, waitUntil: 'domcontentloaded' }),
      page.getByRole('alert').first().waitFor({ state: 'visible', timeout: 120_000 }).then(async () => {
        throw new Error(`Registration stopped: ${await page.getByRole('alert').first().innerText()}`);
      }),
    ]);
    registrationCompleted = true;
    await expect.poll(async () => {
      const current = normalizeAccountPath(new URL(page.url()).pathname);
      if (current === '/.account/oidc/consent/' && await page.getByRole('button', { name: /^(?:deny|拒绝)$/i }).isVisible()) return 'consent';
      if (await page.locator('input[name="password"]').isVisible()) return 'unexpected-password-login';
      return current;
    }, { timeout: 60_000, message: 'Registration must go directly to consent without asking for credentials again' }).toBe('consent');
    let approvedInteraction: string | undefined;
    // Picking the initial WebID resumes OIDC at a new native consent
    // interaction. Approve each visible grant explicitly without resubmitting
    // credentials or clicking the same interaction twice.
    for (let step = 0; step < 3; step++) {
      let next: 'waiting' | 'consent' | 'application' | 'password' = 'waiting';
      await expect.poll(async () => {
        const url = new URL(page.url());
        if (url.origin === origin && url.pathname === '/ai-connections') next = 'application';
        else if (await page.locator('input[name="password"]').isVisible()) next = 'password';
        else if (url.origin === issuerOrigin
          && normalizeAccountPath(url.pathname) === '/.account/oidc/consent/'
          && page.url() !== approvedInteraction
          && await page.getByRole('button', { name: /^(?:allow|approve|authorize|批准|允许|授权|同意)$/i }).isVisible()) next = 'consent';
        else next = 'waiting';
        return next;
      }, { timeout: 60_000, message: 'Continue native consent without another password login' }).toMatch(/^(?:consent|application)$/u);
      if (new URL(page.url()).origin === origin) break;
      const storageSelect = page.locator('select').first();
      if (await storageSelect.isVisible()) {
        const value = await storageSelect.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find(Boolean));
        if (value) await storageSelect.selectOption(value);
      }
      approvedInteraction = page.url();
      await page.getByRole('button', { name: /^(?:allow|approve|authorize|批准|允许|授权|同意)$/i }).click();
    }
    await expect(page.locator('[data-workspace-layout]').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="workspace-main-pane"] section[role="region"]').first()).toBeVisible({ timeout: 60_000 });
    expect(callbackHasCode).toBe(true);
    expect(callbackHasState).toBe(true);
    expect(laterPasswordPosts).toBe(0);
    expect(responses.some((entry) => /\/token$/u.test(entry.path) && entry.method === 'POST' && entry.status === 200)).toBe(true);
    expect(responses.some((entry) => normalizeAccountPath(entry.path) === '/.account/oidc/consent/' && entry.method === 'POST' && entry.status < 400)).toBe(true);
    expect(navigations.filter((value) => /^\/(?:status|dashboard)(?:\/|$)/u.test(new URL(value).pathname))).toEqual([]);
    await expect(page).toHaveURL(`${origin}/ai-connections`);
    const expectedPod = `${origin}/${account.username}/`;
    const selected = await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('xpod.auth.selected-storage.v1') ?? 'null');
      return stored ? { storageUrl: stored.binding?.storageUrl, webId: stored.binding?.webId } : null;
    });
    expect(selected).toEqual({ storageUrl: expectedPod, webId: `${expectedPod}profile/card#me` });
    expect(responses.some((entry) => entry.origin === origin && entry.path === `/${account.username}/profile/card` && entry.method === 'GET' && entry.status === 200)).toBe(true);
    await testInfo.attach('selected-pod', { body: JSON.stringify(selected), contentType: 'application/json' });
  } finally {
    await writeFile(path.join(privateRoot, 'last-page.json'), JSON.stringify({ path: new URL(page.url()).pathname, visibleText: await page.locator('body').innerText({ timeout: 1000 }).catch(() => '<unavailable>') }), { mode: 0o600 });
    await testInfo.attach('managed-registration-navigation', {
      body: JSON.stringify({ navigations, responses, finalPath: new URL(page.url()).pathname, visibleText: await page.locator('body').innerText({ timeout: 1000 }).catch(() => '<unavailable>') }), contentType: 'application/json',
    });
    const storage = await context.storageState().catch(() => undefined);
    if (storage) await writeFile(path.join(privateRoot, 'browser-state.json'), JSON.stringify(storage), { mode: 0o600 });
    await context.close();
  }
});
