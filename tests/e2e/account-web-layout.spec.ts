import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Visual/interaction fixtures only. Real Account/Pod/Chat evidence belongs to RC.
test.use({ baseURL: 'http://127.0.0.1:5173' });

async function mockAccount(page: Page, options: { authenticated?: boolean; consent?: boolean; failedBindings?: boolean } = {}) {
  const observed: string[] = [];
  await page.route('**/provision/status', (route) => route.fulfill({ json: { managed: false } }));
  await page.route('**/.account/**', async (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    const url = new URL(route.request().url());
    const method = route.request().method();
    observed.push(`${method} ${url.pathname}`);
    const controls = {
      password: { login: '/.account/login/password/', forgot: '/.account/login/password/forgot/', reset: '/.account/login/password/reset/' },
      ...(options.authenticated ? { account: {
        logout: '/.account/logout/', username: 'alice', pod: '/.account/account/pod/', bindings: '/.account/account/bindings/',
      } } : {}),
    };
    if (url.pathname === '/.account/') return route.fulfill({ json: { controls } });
    if (url.pathname === '/.account/oidc/consent/') {
      if (!options.consent) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ json: { client: { client_id: 'layout-test', client_name: 'Example App' } } });
    }
    if (url.pathname === '/.account/oidc/pick-webid/') {
      return route.fulfill({ json: { entries: [{ webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://nodes.example/alice/' }] } });
    }
    if (url.pathname === '/.account/account/bindings/') return route.fulfill({ status: options.failedBindings ? 500 : 200, json: { entries: [] } });
    if (url.pathname === '/.account/login/password/' && method === 'POST') return route.fulfill({ status: 401, json: {} });
    if (url.pathname.includes('/forgot/') || url.pathname.includes('/reset/')) return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: {} });
  });
  return observed;
}

async function checkLayout(page: Page, info: TestInfo, name: string) {
  const panel = page.getByTestId('web-account-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('auth-surface-page')).toHaveCount(0);
  const box = await panel.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(448);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  const viewport = page.viewportSize()!;
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  if (viewport.width >= 1024) {
    const introduction = page.getByTestId('web-account-introduction');
    await expect(introduction).toBeVisible();
    const left = await introduction.boundingBox();
    expect(left!.x + left!.width).toBeLessThan(box!.x);
  } else {
    await expect(page.getByTestId('web-account-introduction')).toBeHidden();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css' });
}

for (const width of [1440, 768, 390]) {
  test(`Web account layout and recovery at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAccount(page);
    await page.goto('/.account/login/password/');
    await expect(page.getByLabel('邮箱')).toBeVisible();
    await checkLayout(page, info, 'login');
    await page.getByLabel('邮箱').fill('layout@example.test');
    await page.getByLabel('密码', { exact: true }).fill('not-a-real-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
    await checkLayout(page, info, 'login-error');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await expect(page).toHaveURL(/\/\.account\/login\/password\/register\//);
    await expect(page.getByLabel('Pod 名称')).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill('first-password');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel('确认密码', { exact: true }).fill('different-password');
    await page.getByLabel('确认密码', { exact: true }).blur();
    await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
    await checkLayout(page, info, 'register-mismatch');
    await page.getByRole('button', { name: '返回登录' }).click();
    await expect(page).toHaveURL(/\/\.account\/login\/password\/$/);
    await page.reload();
    await expect(page.getByLabel('确认密码')).toHaveCount(0);
    await page.getByRole('button', { name: '忘记密码？' }).click();
    await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();
    await page.getByLabel('邮箱').fill('layout@example.test');
    await page.getByRole('button', { name: '发送重置链接' }).click();
    await expect(page.getByText('请查收邮件')).toBeVisible();
    await checkLayout(page, info, 'recovery-success');
    await page.goto('/.account/login/password/reset/?rid=visual-fixture');
    await page.getByLabel('新密码', { exact: true }).fill('a-new-password');
    await page.getByLabel('确认密码', { exact: true }).fill('a-new-password');
    await page.getByRole('button', { name: '重设密码', exact: true }).click();
    await expect(page.getByText('密码已重设。')).toBeVisible();
    await checkLayout(page, info, 'reset-success');
  });

  test(`Web consent and failed storage stay bounded at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const calls = await mockAccount(page, { authenticated: true, failedBindings: true });
    await page.goto('/.account/create-pod/');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await checkLayout(page, info, 'storage-error');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    expect(calls.filter((call) => call === 'POST /.account/account/pod/')).toHaveLength(0);
    await page.unroute('**/.account/**');
    await mockAccount(page, { authenticated: true, consent: true });
    await page.goto('/.account/oidc/consent/');
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeEnabled();
    await checkLayout(page, info, 'consent');
    await page.getByLabel('记住这个应用').uncheck();
    await expect(page.getByLabel('记住这个应用')).not.toBeChecked();
  });
}

test('Loading/error/retry and desktop-hosted Account documents use the Web panel', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccount(page);
  let releaseControls!: () => void;
  const held = new Promise<void>((resolve) => { releaseControls = resolve; });
  await page.route('**/.account/', async (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    await held;
    return route.fulfill({ status: 400, json: {} });
  });
  await page.goto('/.account/login/password/');
  await expect(page.getByRole('status')).toBeVisible();
  await checkLayout(page, info, 'loading');
  releaseControls();
  await expect(page.getByRole('alert')).toContainText('无法读取账号服务信息');
  await page.getByText('技术详情', { exact: true }).click();
  await expect(page.getByText('Failed to load account controls (Status: 400)', { exact: true })).toBeVisible();
  await checkLayout(page, info, 'account-error');
  await page.unroute('**/.account/');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await page.addInitScript(() => { Object.assign(window, { xpodDesktop: { setIdentity: () => undefined, setWindowMode: () => undefined } }); });
  await page.setViewportSize({ width: 480, height: 700 });
  await page.reload();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.locator('[data-auth-surface-frame="window"]')).toHaveCount(0);
  await expect(page.getByTestId('web-account-page')).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-bridge-window.png'), scale: 'css' });
});

test('App registration uses the Xpod Web form and remains reachable in a short window', async ({ page }, info) => {
  await mockAccount(page);
  await page.addInitScript(() => {
    Object.assign(window, { xpodDesktop: {
      setIdentity: () => undefined,
      setWindowMode: (mode: string) => { document.documentElement.dataset.requestedWindowMode = mode; },
    } });
  });
  await page.setViewportSize({ width: 280, height: 400 });
  await page.goto('/.account/login/password/register/');
  await expect(page.getByTestId('web-account-panel')).toBeVisible();
  await expect(page.locator('[data-auth-surface-frame="window"]')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-requested-window-mode', 'workspace');
  const username = page.getByLabel('Pod 名称');
  const confirmation = page.getByLabel('确认密码');
  await username.click({ trial: true });
  await page.getByLabel('密码', { exact: true }).fill('first-password');
  await confirmation.fill('mismatch');
  await confirmation.blur();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  await page.getByRole('button', { name: '创建账号', exact: true }).click({ trial: true });
  await page.screenshot({ path: info.outputPath('short-window-register-bottom.png'), scale: 'css' });
  await username.scrollIntoViewIfNeeded();
  await username.click({ trial: true });
  await page.screenshot({ path: info.outputPath('short-window-register-fields.png'), scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1080, height: 760 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await checkLayout(page, info, 'register-workspace');
  await page.getByRole('button', { name: '返回登录' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-requested-window-mode', 'workspace');
  await expect(page.locator('[data-auth-surface-frame="window"]')).toHaveCount(0);
  await expect(page.getByTestId('web-account-page')).toBeVisible();
});

test('created storage awaiting readiness has a bounded query-only retry page', async ({ page }, info) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccount(page);
  let creations = 0;
  let logins = 0;
  await page.route('**/api/v1/identity/**', (route) => route.fulfill({ status: 404, json: {} }));
  await page.route('**/.account/**', async (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/.account/') return route.fulfill({ json: { controls: {
      password: { login: '/.account/login/password/' },
      account: { pod: '/.account/account/pod/', webId: '/.account/account/webid/' },
    } } });
    if (url.pathname === '/.account/login/password/' && method === 'POST') {
      logins += 1;
      return route.fulfill({ json: { authorization: 'visual-fixture-token' } });
    }
    if (url.pathname === '/.account/account/pod/') {
      if (method === 'POST') creations += 1;
      return route.fulfill({ json: { pods: {} } });
    }
    if (url.pathname === '/.account/account/webid/') return route.fulfill({ json: { webIdLinks: {} } });
    return route.fallback();
  });
  await page.goto('/.account/login/password/register/');
  await page.getByLabel('Pod 名称').fill('acceptance-layout');
  await page.getByLabel('邮箱').fill('acceptance-layout@example.test');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认密码').fill('fixture-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '正在确认存储空间' })).toBeVisible({ timeout: 25_000 });
  await checkLayout(page, info, 'readiness-pending');
  await page.getByRole('button', { name: '重试确认' }).click();
  await expect(page.getByRole('alert')).toContainText('账号和已创建的空间会保留');
  expect(creations).toBe(1);
  expect(logins).toBe(1);
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  await checkLayout(page, info, 'readiness-retry');
});

test('Account registration remains reachable with enlarged text and keyboard input', async ({ page }, info) => {
  await mockAccount(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/.account/login/password/register/');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  const username = page.getByLabel('Pod 名称');
  await username.click();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('邮箱')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await page.getByLabel('密码', { exact: true }).fill('first-password');
  await page.getByLabel('确认密码').fill('mismatch');
  await page.getByLabel('确认密码').blur();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  await page.getByRole('button', { name: '创建账号', exact: true }).click({ trial: true });
  await page.screenshot({ path: info.outputPath('large-text-register-actions.png'), scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '返回登录' }).click();
  await expect(page).toHaveURL(/\/\.account\/login\/password\/$/);
  await expect(page.getByLabel('确认密码')).toHaveCount(0);
});

test('Local discovery failure stops Account requests until initialization retry succeeds', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = await mockAccount(page);
  let unavailable = true;
  await page.route('**/provision/status', (route) => route.fulfill({
    status: unavailable ? 500 : 200,
    json: unavailable ? {} : { managed: false },
  }));
  await page.goto('/.account/login/password/register/');
  await expect(page.getByRole('heading', { name: '账号服务暂时不可用' })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(0);
  await checkLayout(page, info, 'discovery-failure');
  unavailable = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByLabel('Pod 名称')).toBeVisible();
  await expect(page).toHaveURL(/\/\.account\/login\/password\/register\/$/);
  expect(calls.some((call) => call === 'GET /.account/')).toBe(true);
  expect(calls.some((call) => call.startsWith('POST '))).toBe(false);
  await checkLayout(page, info, 'discovery-recovered');
});
