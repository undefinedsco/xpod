import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Visual/interaction fixtures only: routed `/.account` APIs and the `xpodDesktop`
// bridge are fixtures. They are not real Gateway, Electron, Account, Pod, or Chat
// acceptance evidence, and a passing run here does not replace the live suite.
//
// The contracts asserted below follow the current source
// (`packages/shared-ui/src/pod-sign-in/*`, `ui/src/auth/*`, `ui/src/pages/*`) and
// `docs/superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md`: a browser
// document is a two-column `page` (service introduction beside a 360px body), the
// desktop bridge is a `window` that fills 360x540 and never collapses below the
// 320x480 minimum. The retired `compact` layout / 280x400 bounds / implicit Pod
// registration are gone and must not reappear.
test.use({ baseURL: process.env.XPOD_ACCOUNT_LAYOUT_BASE_URL ?? 'http://127.0.0.1:5173' });

const LONG_WEBID = 'https://0123456789abcdef0123456789abcdef.nodes.example/acceptance-0123456789/profile/card#me';
const LONG_STORAGE = 'https://0123456789abcdef0123456789abcdef.nodes.example/acceptance-0123456789/';

interface LayoutFixtureOptions {
  /** Controls expose `account.logout`, so the fixture is a signed-in Account. */
  authenticated?: boolean;
  /** Serve the OIDC client so `/.account/oidc/consent/` renders the consent screen. */
  consent?: boolean;
  /** Return an over-long node identity from the WebID picker. */
  longBinding?: boolean;
  /** Status for `POST /.account/login/password/` (401 = wrong password). */
  loginStatus?: number;
}

interface ObservedCall { method: string; path: string }

/** Records `method path` for every non-navigation Account request so guards can assert what happened. */
async function mockAccount(page: Page, options: LayoutFixtureOptions = {}) {
  const observed: ObservedCall[] = [];
  await page.route('**/provision/status', (route) => route.fulfill({ json: { managed: false } }));
  await page.route('**/.account/**', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) return route.continue();
    const url = new URL(request.url());
    const method = request.method();
    observed.push({ method, path: url.pathname });

    const password = {
      create: '/.account/login/password/create/',
      login: '/.account/login/password/',
      forgot: '/.account/login/password/forgot/',
      reset: '/.account/login/password/reset/',
    };
    const controls = {
      password,
      ...(options.authenticated ? {
        account: {
          id: 'acc-layout-fixture',
          username: 'alice',
          create: '/.account/account/',
          logout: '/.account/logout/',
          pod: '/.account/account/pod/',
          webid: '/.account/account/webid/',
          bindings: '/.account/account/bindings/',
        },
      } : {}),
    };

    if (url.pathname === '/.account/') return route.fulfill({ json: { controls } });
    if (url.pathname === '/.account/logout/') return route.fulfill({ json: { location: '/.account/login/password/' } });
    // Account-only creation: this endpoint creates the Account, never a Pod or storage.
    if (url.pathname === '/.account/account/' && method === 'POST') {
      options.authenticated = true;
      return route.fulfill({ json: { authorization: 'fixture-account-token' } });
    }
    if (url.pathname === password.create && method === 'POST') return route.fulfill({ json: {} });
    if (url.pathname === password.login && method === 'POST') {
      const status = options.loginStatus ?? 401;
      return route.fulfill({ status, json: status < 400 ? { authorization: 'fixture-login-token' } : {} });
    }
    if (url.pathname === password.forgot && method === 'POST') return route.fulfill({ json: {} });
    if (url.pathname === password.reset && method === 'POST') return route.fulfill({ json: {} });
    if (url.pathname === '/.account/oidc/consent/') {
      if (!options.consent) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ json: { client: { client_id: 'layout-fixture', client_name: 'Example App', client_uri: 'https://app.example/' } } });
    }
    if (url.pathname === '/.account/oidc/pick-webid/') {
      return route.fulfill({ json: { entries: [{
        webId: options.longBinding ? LONG_WEBID : 'https://id.example/alice/profile/card#me',
        storageUrl: options.longBinding ? LONG_STORAGE : 'https://nodes.example/alice/',
      }] } });
    }
    if (url.pathname === '/.account/account/pod/') return route.fulfill({ json: { pods: {} } });
    if (url.pathname === '/.account/account/webid/') return route.fulfill({ json: { webIdLinks: {} } });
    if (url.pathname === '/.account/account/bindings/') return route.fulfill({ json: { entries: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  return observed;
}

/** Minimal `xpodDesktop` bridge: enough to make the app choose the account window surface. */
async function useDesktopBridge(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      xpodDesktop: {
        setIdentity: () => undefined,
        setWindowMode: (mode: string) => { document.documentElement.dataset.requestedWindowMode = mode; },
      },
    });
  });
}

interface LayoutExpectation {
  host: 'document' | 'window';
  /** `page` frame only: whether the left service-introduction column shows at this width. */
  intro?: 'shown' | 'hidden';
}

/**
 * The shared frame contract: `page` = two columns with the service introduction
 * beside a 360px body (introduction shown at >=768px, hidden in a single column
 * below); `window` = the desktop bridge host that fills 360x540 and keeps the
 * 320x480 minimum. No horizontal overflow anywhere, and the retired `compact`
 * layout must not come back.
 */
async function checkLayout(page: Page, info: TestInfo, name: string, expectation: LayoutExpectation) {
  const panel = page.getByTestId('web-account-panel');
  const expectedLayout = expectation.host === 'window' ? 'window' : 'page';
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-web-account-layout', expectedLayout);
  await expect(panel).toHaveAttribute('data-web-account-host', expectation.host);
  await expect(page.locator('[data-web-account-layout="compact"]')).toHaveCount(0);

  const viewport = page.viewportSize()!;
  const geometry = await panel.evaluate((element) => {
    const body = element.parentElement!.getBoundingClientRect();
    const intro = element.ownerDocument.querySelector('[data-pod-sign-in="intro"]');
    const shown = intro !== null && getComputedStyle(intro).display !== 'none';
    const introBox = shown ? intro!.getBoundingClientRect() : null;
    const panelBox = element.getBoundingClientRect();
    return {
      body: { x: body.x, width: body.width },
      intro: introBox ? { x: introBox.x, width: introBox.width } : null,
      right: panelBox.x + panelBox.width,
    };
  });

  if (expectation.host === 'document') {
    await expect(page.locator('[data-pod-sign-in-frame="page"]')).toHaveCount(1);
    expect(geometry.body.width).toBeLessThanOrEqual(360);
    if (expectation.intro === 'shown') {
      await expect(page.getByTestId('web-account-introduction')).toBeVisible();
      expect(geometry.intro).not.toBeNull();
      // The shared body caps at exactly 360px, and the introduction sits to its left.
      expect(geometry.body.width).toBe(360);
      expect(geometry.intro!.x + geometry.intro!.width).toBeLessThanOrEqual(geometry.body.x);
    } else {
      await expect(page.locator('[data-pod-sign-in="intro"]')).toBeHidden();
      expect(geometry.intro).toBeNull();
    }
  } else {
    const frame = page.locator('[data-pod-sign-in-frame="window"]');
    await expect(frame).toHaveCount(1);
    await expect(page.locator('html')).toHaveAttribute('data-requested-window-mode', 'account');
    const bounds = await frame.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { minWidth: style.minWidth, minHeight: style.minHeight, width: box.width, height: box.height };
    });
    expect({ minWidth: bounds.minWidth, minHeight: bounds.minHeight }).toEqual({ minWidth: '320px', minHeight: '480px' });
    expect(bounds.width).toBeGreaterThanOrEqual(320);
    expect(bounds.height).toBeGreaterThanOrEqual(480);
    expect(bounds.width).toBe(viewport.width);
    expect(bounds.height).toBe(viewport.height);
  }

  expect(geometry.right).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css' });
}

test('Wide page shows the service introduction beside the 360px body and recovers from a login error', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const observed = await mockAccount(page, { loginStatus: 401 });
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.getByRole('heading', { name: '登录 Xpod', exact: true })).toBeVisible();
  await checkLayout(page, info, 'wide-login', { host: 'document', intro: 'shown' });
  await expect(page.getByTestId('web-account-introduction')).toContainText('Xpod 账号服务');

  await page.getByLabel('邮箱').fill('layout@example.test');
  await page.getByLabel('密码', { exact: true }).fill('not-a-real-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  await checkLayout(page, info, 'wide-login-error', { host: 'document', intro: 'shown' });

  // Editing clears the failure, and submitting again retries the same form.
  await page.getByLabel('密码', { exact: true }).fill('still-wrong');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  expect(observed.filter((call) => call.method === 'POST' && call.path === '/.account/login/password/')).toHaveLength(2);

  // Password recovery keeps the page frame; the reset form keeps its confirmation field.
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();
  await page.getByLabel('邮箱').fill('layout@example.test');
  await page.getByRole('button', { name: '发送重置链接' }).click();
  await expect(page.getByText('请查收邮件')).toBeVisible();
  await checkLayout(page, info, 'wide-recovery', { host: 'document', intro: 'shown' });

  await page.goto('/.account/login/password/reset/?rid=visual-fixture');
  await page.getByLabel('新密码', { exact: true }).fill('a-new-password');
  await page.getByLabel('确认密码', { exact: true }).fill('different-password');
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不一致');
  await page.getByLabel('确认密码', { exact: true }).fill('a-new-password');
  await page.getByRole('button', { name: '重设密码', exact: true }).click();
  await expect(page.getByText('密码已重设。')).toBeVisible();
  await checkLayout(page, info, 'wide-reset', { host: 'document', intro: 'shown' });
});

test('Narrow page collapses the introduction into a single column with no horizontal overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await checkLayout(page, info, 'narrow-login', { host: 'document', intro: 'hidden' });

  const bodyWidth = await page.getByTestId('web-account-panel')
    .evaluate((element) => element.parentElement!.getBoundingClientRect().width);
  expect(bodyWidth).toBeGreaterThan(0);
  expect(bodyWidth).toBeLessThanOrEqual(360);

  // Recovery stays reachable in the single column.
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();
  await checkLayout(page, info, 'narrow-recovery', { host: 'document', intro: 'hidden' });
});

test('Desktop bridge account window fills 360x540 and honours the 320x480 minimum', async ({ page }, info) => {
  await useDesktopBridge(page);
  await page.setViewportSize({ width: 360, height: 540 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await checkLayout(page, info, 'window-360x540', { host: 'window' });

  await page.setViewportSize({ width: 320, height: 480 });
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await checkLayout(page, info, 'window-minimum-320x480', { host: 'window' });

  // Primary and return actions stay reachable at the shared minimum.
  await page.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '登录', exact: true }).click({ trial: true });
  await page.getByRole('button', { name: '注册账号', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '注册账号', exact: true }).click({ trial: true });
});

test('Account surface keeps the light and dark action roles', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();

  const readRoles = () => page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const submit = document.querySelector('[data-pod-sign-in-state] button[type="submit"]') as HTMLElement | null;
    return {
      theme: document.documentElement.dataset.theme ?? null,
      primary: root.getPropertyValue('--primary').trim(),
      background: root.getPropertyValue('--background').trim(),
      submitBackground: submit ? getComputedStyle(submit).backgroundColor : null,
    };
  });

  const light = await readRoles();
  expect(light.theme).toBe('light');
  expect(light.primary).toBe('260.6 36.1% 38%');      // InkViolet action #563E84
  expect(light.background).toBe('42 38.5% 94.9%');    // canvas #F7F4ED
  expect(light.submitBackground).toBe('rgb(86, 62, 132)');
  await checkLayout(page, info, 'theme-light', { host: 'document', intro: 'shown' });

  await page.addInitScript(() => { try { localStorage.setItem('xpod.theme', 'dark'); } catch { /* storage unavailable */ } });
  await page.reload();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  const dark = await readRoles();
  expect(dark.theme).toBe('dark');
  expect(dark.primary).toBe('270 16.7% 71.8%');      // lightened dark action #B7ABC3
  expect(dark.background).toBe('30 13.8% 11.4%');    // dark canvas #211D19
  expect(dark.submitBackground).toBe('rgb(183, 171, 195)');
  await checkLayout(page, info, 'theme-dark', { host: 'document', intro: 'shown' });
});

/**
 * Measures the 200%-text contract: `html` root font-size, the rem introduction
 * paragraph, the fixed-px `h1`, the rem-height primary action, and the document's
 * horizontal overflow. `html { font-size: 200% }` is real root-relative text
 * enlargement, not a `deviceScaleFactor: 2` screenshot trick.
 */
async function measureEnlargedText(page: Page) {
  return page.evaluate(() => {
    const px = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
    };
    const submit = document.querySelector('[data-pod-sign-in-state] button[type="submit"]') as HTMLElement | null;
    return {
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      heading: px('[data-pod-sign-in-state] h1'),
      intro: px('[data-testid="web-account-introduction"] p'),
      submitHeight: submit ? submit.getBoundingClientRect().height : null,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

test('Enlarged root text doubles rem typography while fixed-px headings stay put', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();

  const before = await measureEnlargedText(page);
  expect(before.rootFont).toBe(16);
  expect(before.heading).toBe(17);   // fixed `text-[17px]`
  expect(before.intro).toBe(12);     // rem `text-xs`
  expect(before.overflow).toBe(0);

  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await expect.poll(async () => (await measureEnlargedText(page)).intro).toBe(24);

  const after = await measureEnlargedText(page);
  expect(after.rootFont).toBe(32);                      // root font really doubled
  expect(after.intro! / before.intro!).toBeCloseTo(2, 5);   // rem text doubles
  expect(after.heading).toBe(17);                       // fixed px stays put
  expect(after.submitHeight!).toBeCloseTo(before.submitHeight! * 2, 0); // rem control grows
  expect(after.overflow).toBe(0);                       // wide two-column still fits
  await checkLayout(page, info, 'wide-text-200', { host: 'document', intro: 'shown' });
});

// Regression guard for the 390px + 200% root-text layout (design spec 10.2: 390px single
// column, 200% text, no horizontal scroll). The page frame's inner wrapper
// (`div.flex items-center justify-center px-4 py-8`) previously auto-sized as a grid item
// with `min-width: auto`, so its automatic minimum (360px body + 2x32px rem padding)
// inflated the implicit single-column grid track to 424px and overflowed the viewport by
// 34px; the frame now sets `min-width: 0`. Keep this assertion at that bar.
test('Narrow 200% text keeps no horizontal scroll and leaves primary and return reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await expect.poll(async () => (await measureEnlargedText(page)).intro).toBe(24);

  // Vertical scrolling is allowed; the primary and return actions must stay reachable.
  await page.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '登录', exact: true }).click({ trial: true });
  await page.getByRole('button', { name: '忘记密码？' }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '忘记密码？' }).click({ trial: true });

  // Evidence before the failing assertion: the overflowing layout and its measured width.
  await page.screenshot({ path: info.outputPath('narrow-text-200-overflow.png'), scale: 'css' });
  const measured = await measureEnlargedText(page);
  console.log(`[narrow-200] overflow=${measured.overflow}px`);
  expect(measured.overflow).toBe(0);
});

test('Account-only registration creates no Pod and hands over to Account management', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const observed = await mockAccount(page, { loginStatus: 401 });
  await page.goto('/.account/login/password/register/');
  await expect(page.getByRole('heading', { name: '注册 Xpod', exact: true })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  // The obsolete username / password-confirmation / back-to-login fields are gone.
  await expect(page.getByLabel('Pod 名称')).toHaveCount(0);
  await expect(page.getByLabel('用户名')).toHaveCount(0);
  await expect(page.getByLabel('确认密码')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回登录' })).toHaveCount(0);
  await checkLayout(page, info, 'register', { host: 'document', intro: 'shown' });

  await page.getByLabel('邮箱').fill('acceptance-layout@example.test');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/\.account\/account\/$/, { timeout: 20_000 });

  // Registration created the Account (and set its password) but never a Pod or storage.
  expect(observed.some((call) => call.method === 'POST' && call.path === '/.account/account/')).toBe(true);
  expect(observed.some((call) => call.method === 'POST' && call.path === '/.account/login/password/create/')).toBe(true);
  expect(observed.filter((call) => call.method === 'POST' && call.path === '/.account/account/pod/')).toHaveLength(0);
});

test('Initialization failure blocks Account requests until retry succeeds', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const observed = await mockAccount(page);
  let unavailable = true;
  await page.route('**/provision/status', (route) => route.fulfill({
    status: unavailable ? 500 : 200,
    json: unavailable ? {} : { managed: false },
  }));

  await page.goto('/.account/login/password/');
  await expect(page.getByRole('heading', { name: '账号服务暂时不可用' })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  expect(observed).toHaveLength(0);
  await checkLayout(page, info, 'init-failure', { host: 'document', intro: 'shown' });

  unavailable = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page).toHaveURL(/\/\.account\/login\/password\/$/);
  expect(observed.some((call) => call.method === 'GET' && call.path === '/.account/')).toBe(true);
  expect(observed.some((call) => call.method === 'POST')).toBe(false);
  await checkLayout(page, info, 'init-recovered', { host: 'document', intro: 'shown' });
});

test('Consent with a long node identity fits the desktop auth window', async ({ page }, info) => {
  await useDesktopBridge(page);
  await page.setViewportSize({ width: 360, height: 540 });
  await mockAccount(page, { authenticated: true, consent: true, longBinding: true });
  await page.goto('/.account/oidc/consent/');
  await expect(page.getByRole('heading', { name: '授权 Example App', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled();
  await checkLayout(page, info, 'consent-window-long-identity', { host: 'window' });

  // Primary and return actions remain reachable in the 360x540 window.
  await page.getByRole('button', { name: '允许', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '允许', exact: true }).click({ trial: true });
  await page.getByRole('button', { name: '换一个账号', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '换一个账号', exact: true }).click({ trial: true });

  // The remember choice is still offered, folded into the request details.
  await page.locator('summary', { hasText: '请求详情' }).click();
  await expect(page.getByLabel('以后不再询问')).toBeVisible();
  await page.getByLabel('以后不再询问').uncheck();

  // The shared minimum still fits the long identity.
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled();
  await checkLayout(page, info, 'consent-window-minimum-long-identity', { host: 'window' });
  await page.getByRole('button', { name: '允许', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '允许', exact: true }).click({ trial: true });
});

test('Keyboard focus walks the sign-in form to the primary action', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');

  await page.getByLabel('邮箱').click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '忘记密码？' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('记住账号')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '注册账号', exact: true })).toBeFocused();

  await checkLayout(page, info, 'wide-keyboard', { host: 'document', intro: 'shown' });
});
