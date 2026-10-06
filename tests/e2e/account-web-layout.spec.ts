import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Visual/interaction fixtures only: routed `/.account` APIs and the `xpodDesktop`
// bridge are fixtures. They are not real Gateway, Electron, Account, Pod, or Chat
// acceptance evidence, and a passing run here does not replace the live suite.
//
// The contracts asserted below follow the current source
// (`packages/shared-ui/src/pod-sign-in/*`, `ui/src/auth/*`, `ui/src/pages/*`) and
// `docs/superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md`: a browser
// document is a two-column `page` (service introduction beside a responsive 480px body), the
// desktop bridge is a `window` that fills 440x620 by default and never collapses below the
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
  bindings?: Array<{ webId: string; storageUrl: string }>;
}

interface ObservedCall { method: string; path: string }

/** Records `method path` for every non-navigation Account request so guards can assert what happened. */
async function mockAccount(page: Page, options: LayoutFixtureOptions = {}) {
  const observed: ObservedCall[] = [];
  await page.route('**/provision/status', (route) => route.fulfill({ json: { managed: false } }));
  // `XpodServiceAvailability` reads `/service/status` as a service-status array
  // (`Proxy.handleInternalApi` returns `supervisor.getAllStatus()`), so a running
  // css+api array keeps the account shell out of its reconnect banner without a
  // live Gateway.
  await page.route('**/service/status', (route) => route.fulfill({ json: [
    { name: 'css', status: 'running' },
    { name: 'api', status: 'running' },
  ] }));
  // `XpodDeploymentIdentity` reads `/api/service-info`; the route mirrors
  // `registerServiceInfoRoute` (edition + managed + publicUrl, oidcIssuer only when
  // managed). This fixture is Local and unmanaged, matching the mocked
  // `/provision/status` above.
  await page.route('**/api/service-info', (route) => route.fulfill({ json: {
    edition: 'local',
    managed: false,
    publicUrl: null,
  } }));
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
    if (url.pathname === '/.account/account/pod/') return route.fulfill({ json: { pods: Object.fromEntries((options.bindings ?? []).map((binding, i) => [binding.storageUrl, `/.account/account/pod/${i}/`])), podDeletionControls: Object.fromEntries((options.bindings ?? []).map((binding, i) => [binding.storageUrl, `/.account/account/pod/${i}/`])) } });
    if (url.pathname === '/.account/account/webid/') return route.fulfill({ json: { webIdLinks: {} } });
    if (url.pathname === '/.account/account/bindings/') return route.fulfill({ json: { bindings: options.bindings ?? [] } });
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
 * beside a responsive 480px body (introduction shown at >=768px, hidden in a single column
 * below); `window` = the desktop bridge host that fills 440x620 by default and keeps the
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
    expect(geometry.body.width).toBeLessThanOrEqual(480);
    if (expectation.intro === 'shown') {
      await expect(page.getByTestId('web-account-introduction')).toBeVisible();
      expect(geometry.intro).not.toBeNull();
      // The shared body caps at exactly 480px, and the introduction sits to its left.
      expect(geometry.body.width).toBe(480);
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
    expect({ minWidth: bounds.minWidth, minHeight: bounds.minHeight }).toEqual({ minWidth: '0px', minHeight: '0px' });
    expect(bounds.width).toBe(viewport.width);
    expect(bounds.height).toBe(viewport.height);
  }

  expect(geometry.right).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css' });
}

/**
 * §4 / §13.11: a native host window never scrolls; only the sign-in body
 * (`[data-pod-sign-in="main"]`, `overflow-y: auto`) may, and the pinned action
 * area stays inside the viewport. Returns the measured boxes for evidence.
 */
async function expectBodyOnlyScrolling(page: Page) {
  const state = await page.evaluate(() => {
    const main = document.querySelector('[data-pod-sign-in="main"]') as HTMLElement | null;
    const actions = document.querySelector('[data-pod-sign-in="actions"]') as HTMLElement | null;
    const actionsBox = actions?.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentScrollHeight: document.documentElement.scrollHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      mainOverflowY: main ? getComputedStyle(main).overflowY : null,
      mainScrollHeight: main?.scrollHeight ?? null,
      mainClientHeight: main?.clientHeight ?? null,
      actions: actionsBox ? { top: actionsBox.top, bottom: actionsBox.bottom } : null,
    };
  });
  expect(state.documentScrollWidth).toBeLessThanOrEqual(state.viewport.width);
  // The host window itself does not scroll; the body region owns any overflow.
  expect(state.documentScrollHeight).toBeLessThanOrEqual(state.viewport.height + 1);
  expect(state.mainOverflowY).toBe('auto');
  expect(state.actions).not.toBeNull();
  expect(state.actions!.bottom).toBeLessThanOrEqual(state.viewport.height + 1);
  return state;
}

/**
 * Rendered typography of the consent view, read from computed styles.
 *
 * The consent heading carries the historical `text-[17px]` utility class, but
 * the rendered contract is the shared sign-in title size (`22px`, weight 600)
 * from `.pod-sign-in h1`. Class names are not size evidence: this reads what the
 * browser actually lays out, so a host change cannot silently restyle it.
 */
async function measureConsentTypography(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector('[data-pod-sign-in-state="consent"] h1') as HTMLElement | null;
    if (!element) return null;
    const style = getComputedStyle(element);
    return { fontSize: style.fontSize, fontWeight: style.fontWeight };
  });
}

test('Wide page shows the service introduction beside the 480px body and recovers from a login error', async ({ page }, info) => {
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
  expect(bodyWidth).toBeLessThanOrEqual(480);

  // Recovery stays reachable in the single column.
  await page.getByRole('button', { name: '忘记密码？' }).click();
  await expect(page.getByRole('heading', { name: '找回密码', exact: true })).toBeVisible();
  await checkLayout(page, info, 'narrow-recovery', { host: 'document', intro: 'hidden' });
});

test('Desktop bridge account window fills 440x620 and honours the 320x480 minimum', async ({ page }, info) => {
  await useDesktopBridge(page);
  await page.setViewportSize({ width: 440, height: 620 });
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await checkLayout(page, info, 'window-440x620', { host: 'window' });

  await page.setViewportSize({ width: 320, height: 480 });
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await checkLayout(page, info, 'window-minimum-320x480', { host: 'window' });

  // Form choices must remain clickable above the pinned action area.
  const remember = page.getByRole('checkbox', { name: '记住账号' });
  await remember.click({ trial: true });
  const rememberBounds = (await remember.boundingBox())!;
  const actionsBounds = (await page.locator('[data-pod-sign-in="actions"]').boundingBox())!;
  expect(rememberBounds.y + rememberBounds.height).toBeLessThanOrEqual(actionsBounds.y);

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
  expect(before.heading).toBe(22);   // shared sign-in title
  expect(before.intro).toBe(12);     // rem `text-xs`
  expect(before.overflow).toBe(0);

  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  await expect.poll(async () => (await measureEnlargedText(page)).intro).toBe(24);

  const after = await measureEnlargedText(page);
  expect(after.rootFont).toBe(32);                      // root font really doubled
  expect(after.intro! / before.intro!).toBeCloseTo(2, 5);   // rem text doubles
  expect(after.heading).toBe(22);                       // fixed px stays put
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

test('Desktop consent fills the native 440x620 window and the 320x480 minimum', async ({ page }, info) => {
  await useDesktopBridge(page);
  await page.setViewportSize({ width: 440, height: 620 });
  await mockAccount(page, { authenticated: true, consent: true, longBinding: true });
  await page.goto('/.account/oidc/consent/');
  await expect(page.getByRole('heading', { name: '授权 Example App', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled();

  // The native authentication surface fills the host-selected window; it is not
  // the two-column browser document page.
  await checkLayout(page, info, 'consent-window-440x620-long-identity', { host: 'window' });
  await expect(page.locator('html')).toHaveAttribute('data-requested-window-mode', 'account');
  let scrolling = await expectBodyOnlyScrolling(page);
  expect(scrolling.viewport).toEqual({ width: 440, height: 620 });
  // Host selection changes geometry only: the consent heading still renders at
  // the shared sign-in title size the browser page uses (measured, not class-based).
  expect(await measureConsentTypography(page)).toEqual({ fontSize: '22px', fontWeight: '600' });

  // Primary and return actions remain reachable with the long identity.
  await page.getByRole('button', { name: '允许', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '允许', exact: true }).click({ trial: true });
  await page.getByRole('button', { name: '换一个账号', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '换一个账号', exact: true }).click({ trial: true });

  // The remember choice is still offered, folded into the request details.
  await page.locator('summary', { hasText: '请求详情' }).click();
  await expect(page.getByLabel('以后不再询问')).toBeVisible();
  await page.getByLabel('以后不再询问').uncheck();

  // The shared minimum still fits the long identity in the same native window.
  await page.setViewportSize({ width: 320, height: 480 });
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeEnabled();
  await checkLayout(page, info, 'consent-window-320x480-long-identity', { host: 'window' });
  scrolling = await expectBodyOnlyScrolling(page);
  expect(scrolling.viewport).toEqual({ width: 320, height: 480 });
  // The minimum window keeps the same typography; it does not compact the copy.
  expect(await measureConsentTypography(page)).toEqual({ fontSize: '22px', fontWeight: '600' });
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


test('Desktop sign-in remains operable at 200% root text in default and minimum windows', async ({ page }, info) => {
  await useDesktopBridge(page);
  await mockAccount(page);
  await page.goto('/.account/login/password/');
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  for (const [width, height] of [[440, 620], [320, 480]]) {
    await page.setViewportSize({ width, height });
    expect((await measureEnlargedText(page)).rootFont).toBe(32);
    for (const name of ['登录', '注册账号', '忘记密码？']) {
      const action = page.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await action.click({ trial: true });
    }
    await checkLayout(page, info, `sign-in-window-${width}-text-200`, { host: 'window' });
  }
});

test('Desktop long-identity consent remains operable at 200% root text', async ({ page }, info) => {
  await useDesktopBridge(page);
  await mockAccount(page, { authenticated: true, consent: true, longBinding: true });
  await page.goto('/.account/oidc/consent/');
  await expect(page.getByRole('heading', { name: '授权 Example App', exact: true })).toBeVisible();
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  for (const [width, height] of [[440, 620], [320, 480]]) {
    await page.setViewportSize({ width, height });
    for (const name of ['允许', '换一个账号']) {
      const action = page.getByRole('button', { name, exact: true });
      await action.scrollIntoViewIfNeeded();
      await action.click({ trial: true });
    }
    await checkLayout(page, info, `consent-window-${width}-text-200`, { host: 'window' });
    await expect(page.locator('html')).toHaveAttribute('data-requested-window-mode', 'account');
  }
});


for (const theme of ['light', 'dark'] as const) {
  test(`Acceptance feedback: ${theme} Input focus strengthens its single existing border`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAccount(page);
    await page.addInitScript((theme) => localStorage.setItem('xpod.theme', theme), theme);
    await page.goto('/.account/login/password/');
    const email = page.getByLabel('邮箱');
    await email.fill('acceptance@example.com');
    await email.focus();
    await expect(email).toBeFocused();
    const readFocusStyle = () => email.evaluate((element) => {
      const s = getComputedStyle(element);
      const probe = document.createElement('span');
      probe.style.borderColor = 'hsl(var(--ring))';
      element.parentElement!.appendChild(probe);
      const ringColor = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return { outlineStyle: s.outlineStyle, borderColor: s.borderTopColor, borderStyle: s.borderTopStyle, borderWidth: s.borderTopWidth, ringColor, boxShadow: s.boxShadow, keyboardFocus: element.matches(':focus-visible') };
    });
    // Wait for the existing border-color transition to reach the focus token.
    await expect.poll(async () => { const s = await readFocusStyle(); return s.borderWidth === '2px' && s.borderColor === s.ringColor; }).toBe(true);
    const style = await readFocusStyle();
    await page.screenshot({ path: info.outputPath(`${theme}-single-input-border.png`) });
    expect(style.keyboardFocus).toBe(true);
    expect(style.outlineStyle).toBe('none');
    expect(style.borderStyle).toBe('solid');
    expect(style.borderColor).toBe(style.ringColor);
    expect(style.boxShadow === 'none' || (style.boxShadow.match(/-?[\d.]+px/g) ?? []).every((length) => Number.parseFloat(length) === 0)).toBe(true);
  });
}

test('Acceptance feedback: entry documents use Xpod branding instead of starter icons', async ({ page }) => {
  await mockAccount(page);
  for (const path of ['/.account/login/password/', '/dashboard/', '/settings/pod']) {
    await page.goto(path);
    await expect(page).toHaveTitle(/Xpod/);
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute('href', /xpod.*\.svg/);
    const response = await page.request.get((await icon.getAttribute('href'))!);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('#563E84');
  }
});

test('Acceptance feedback: Account has a desktop management entry and labelled collapsible addresses', async ({ page }, info) => {
  const origin = new URL(process.env.XPOD_ACCOUNT_LAYOUT_BASE_URL ?? 'http://127.0.0.1:5173').origin;
  await mockAccount(page, { authenticated: true, bindings: [
    { webId: `${origin}/alice/profile/card#me`, storageUrl: `${origin}/alice/` },
    { webId: LONG_WEBID, storageUrl: LONG_STORAGE },
  ] });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/.account/account/');
  const desktop = page.getByRole('region', { name: '桌面 Xpod' });
  await expect(desktop.getByRole('button', { name: '桌面管理入口' })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 Xpod 工作台' })).toHaveCount(0);
  const section = page.locator('[data-pod-sign-in="webid-section"]');
  await expect(section.getByRole('button', { name: /工作台|管理 Pod/ })).toHaveCount(0);
  await expect(section.getByText('账号服务托管', { exact: true })).toBeVisible();
  await expect(section.getByText('独立部署', { exact: true })).toBeVisible();
  const addresses = section.locator('details');
  await expect(addresses).toHaveCount(2);
  expect(await addresses.first().getAttribute('open')).toBeNull();
  await addresses.nth(1).getByText('查看地址', { exact: true }).click();
  await expect(addresses.nth(1).getByText('WebID（身份地址）', { exact: true })).toBeVisible();
  await expect(addresses.nth(1).getByText('Pod（存储地址）', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: /删除 Pod/ }).first()).toHaveClass(/border/);
  await page.screenshot({ path: info.outputPath('account-workspace-addresses.png') });
});

test('Acceptance feedback: email selection survives mouse gestures and keeps browser validation', async ({ page }) => {
  await mockAccount(page);
  for (const path of ['/.account/login/password/', '/.account/login/password/create/', '/.account/login/password/forgot/']) {
    await page.goto(path);
    const email = page.getByLabel('邮箱', { exact: true });
    await expect(email).toHaveAttribute('type', 'text');
    await expect(email).toHaveAttribute('inputmode', 'email');
    for (const value of ['', '   ', '63005737@qq.com', 'a+tag@example.test', 'a@localhost', 'missing-at', 'a@@example.test', 'a@bad domain.test']) {
      await email.fill(value);
      expect(await email.evaluate((element: HTMLInputElement) => {
        const native = document.createElement('input');
        native.type = 'email';
        native.required = element.required;
        native.value = element.value;
        return element.checkValidity() === native.checkValidity();
      })).toBe(true);
    }
    await email.fill('63005737@qq.com');
    const box = (await email.boundingBox())!;
    await page.mouse.move(box.x + 13, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 16, box.y + box.height / 2, { steps: 20 });
    await page.mouse.up();
    expect(await email.evaluate((element: HTMLInputElement) => new Promise<string>((resolve) => {
      setTimeout(() => resolve(element.value.slice(element.selectionStart!, element.selectionEnd!)), 500);
    }))).toBe('63005737@qq.com');
    await page.keyboard.type('replacement@example.test');
    await expect(email).toHaveValue('replacement@example.test');
    await page.mouse.dblclick(box.x + 30, box.y + box.height / 2);
    expect(await email.evaluate((element: HTMLInputElement) => new Promise<string>((resolve) => {
      setTimeout(() => resolve(element.value.slice(element.selectionStart!, element.selectionEnd!)), 500);
    }))).toBe('replacement');
  }
});


for (const theme of ['light', 'dark'] as const) {
  test(`Account deletion confirmation: ${theme}, narrow keyboard cancellation and retry`, async ({ page }, info) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.emulateMedia({ colorScheme: theme });
    let nativeDialogs = 0;
    page.on('dialog', async (dialog) => { nativeDialogs++; await dialog.dismiss(); });
    const observed = await mockAccount(page, { authenticated: true, bindings: [{ webId: LONG_WEBID, storageUrl: LONG_STORAGE }] });
    let deletes = 0;
    await page.route('**/.account/account/pod/0/', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      deletes++;
      await route.fulfill(deletes === 1
        ? { status: 503, json: { message: 'POD_DELETE_NODE_UNAVAILABLE' } }
        : { status: 204, body: '' });
    });
    await page.goto('/.account/account/');
    await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    const trigger = page.getByRole('button', { name: /删除 Pod/ });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '删除 Pod', exact: true });
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(deletes).toBe(0);
    expect(observed.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    await trigger.click();
    await dialog.getByRole('button', { name: '删除 Pod', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('请确认设备在线');
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${theme}-pod-delete-retry.png`) });
    await dialog.getByRole('button', { name: '删除 Pod', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletes).toBe(2);
    expect(nativeDialogs).toBe(0);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Legacy Pod authorization: ${theme} narrow device task and independent deletion`, async ({ page }, info) => {
    const origin = new URL(process.env.XPOD_ACCOUNT_LAYOUT_BASE_URL ?? 'http://127.0.0.1:5173').origin;
    let enabled = false;
    let authorizationRequests = 0;
    let deletionRequests = 0;
    let nativeDialogs = 0;
    page.on('dialog', async (dialog) => { nativeDialogs++; await dialog.dismiss(); });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((dark) => localStorage.setItem('xpod-theme', dark ? 'dark' : 'light'), theme === 'dark');
    await mockAccount(page, { authenticated: true, bindings: [{ webId: `${origin}/alice/profile/card#me`, storageUrl: `${origin}/alice/` }] });
    await page.route('**/api/admin/**', (route) => route.fulfill({ json: { env: {}, configs: [], configFiles: [] } }));
    await page.route('**/service/status', (route) => route.fulfill({ json: { status: 'running', services: [] } }));
    await page.route('**/.account/account/pod/', (route) => route.fulfill({ json: {
      pods: { [`${origin}/alice/`]: '/.account/account/pod/0/' },
      [enabled ? 'podDeletionControls' : 'podDeletionAuthorizationControls']: { [`${origin}/alice/`]: '/.account/account/pod/0/' },
    } }));
    await page.route('**/.account/account/pod/0/', async (route) => {
      if (route.request().method() === 'DELETE') { deletionRequests++; return route.fulfill({ status: 204, body: '' }); }
      expect(route.request().postDataJSON()).toEqual({ action: 'requestDeletionAuthorization' });
      return route.fulfill({ json: { deletionAuthorization: {
        challenge: 'opaque.challenge', podName: 'alice', expiresAt: Date.now() + 60000,
        localManagementUrl: `${origin}/settings/pod?deletionAuthorization=opaque.challenge&podName=alice`,
      } } });
    });
    await page.route('**/provision/pods', async (route) => {
      const body = route.request().postDataJSON();
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers().authorization).toBeUndefined();
      if (body.action === 'inspectDeletionAuthorization') return route.fulfill({ json: { deletionAuthorization: {
        challenge: 'opaque.challenge', podName: 'alice', expiresAt: Date.now() + 60000,
        cloudAccountId: 'verified-account', cloudPodId: 'cloud-pod', nodeId: 'local-node',
        storageUrl: `${origin}/alice/`, currentLocalPodId: 'current-generation', ownerWebIds: [`${origin}/alice/profile/card#me`],
        returnUrl: `${origin}/.account/account/`,
      } } });
      expect(body).toEqual({ action: 'authorizeDeletion', challenge: 'opaque.challenge', podName: 'alice', expectedLocalPodId: 'current-generation' });
      authorizationRequests++;
      if (authorizationRequests === 1) return route.fulfill({ status: 502, json: { code: 'POD_DELETE_NODE_UNAVAILABLE' } });
      enabled = true;
      return route.fulfill({ json: { success: true, returnUrl: `${origin}/.account/account/` } });
    });
    await page.goto('/.account/account/');
    await page.getByRole('button', { name: '启用删除 alice' }).click();
    await expect(page).toHaveURL(/\/settings\/pod\?deletionAuthorization=/);
    const task = page.getByRole('region', { name: '启用 Pod 删除' });
    await expect(task.getByText('verified-account', { exact: true })).toBeVisible();
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await task.getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
    const dialog = page.getByRole('dialog', { name: '启用 Pod 删除' });
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(authorizationRequests).toBe(0);
    await task.getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
    await dialog.getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
    await expect(dialog.getByRole('alert')).toContainText('暂时无法连接账号服务');
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await page.screenshot({ path: info.outputPath(`${theme}-authorize-pod-retry.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
    await expect(task.getByRole('status')).toContainText('数据尚未删除');
    expect(deletionRequests).toBe(0);
    await task.getByRole('link', { name: '返回账号页面' }).click();
    await page.getByRole('button', { name: '删除 Pod alice' }).click();
    expect(deletionRequests).toBe(0);
    await page.getByRole('dialog', { name: '删除 Pod', exact: true }).getByRole('button', { name: '取消' }).click();
    expect(deletionRequests).toBe(0);
    expect(nativeDialogs).toBe(0);
  });
}

test('Local authorization task refuses a remote visitor without operator access', async ({ page }) => {
  await mockAccount(page);
  await page.route('**/api/admin/**', (route) => route.fulfill({ status: 403, json: {} }));
  await page.route('**/service/status', (route) => route.fulfill({ json: { status: 'running', services: [] } }));
  await page.route('**/provision/pods', (route) => route.fulfill({ status: 403, json: { code: 'POD_DELETE_OPERATOR_REQUIRED' } }));
  await page.goto('/settings/pod?deletionAuthorization=opaque.challenge&podName=alice');
  const task = page.getByRole('region', { name: '启用 Pod 删除' });
  await expect(task.getByRole('alert')).toContainText('当前访问没有设备管理权限');
  await expect(task.getByRole('button', { name: '允许这个账号删除此 Pod' })).toHaveCount(0);
  await expect(task.getByLabel('本机 Xpod 管理地址')).toBeVisible();
  await expect(task.locator('input[type=password]')).toHaveCount(0);
});

test('Local authorization refuses a Pod rebuilt after inspection', async ({ page }) => {
  const origin = new URL(process.env.XPOD_ACCOUNT_LAYOUT_BASE_URL ?? 'http://127.0.0.1:5173').origin;
  await mockAccount(page);
  await page.route('**/api/admin/**', (route) => route.fulfill({ json: { env: {}, configs: [], configFiles: [] } }));
  await page.route('**/service/status', (route) => route.fulfill({ json: { status: 'running', services: [] } }));
  let authorizations = 0;
  await page.route('**/provision/pods', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'inspectDeletionAuthorization') return route.fulfill({ json: { deletionAuthorization: {
      challenge: 'opaque.challenge', podName: 'alice', expiresAt: Date.now() + 60000,
      cloudAccountId: 'verified-account', cloudPodId: 'cloud-pod', nodeId: 'node', storageUrl: `${origin}/alice/`,
      currentLocalPodId: 'original-generation', ownerWebIds: [], returnUrl: `${origin}/.account/account/`,
    } } });
    expect(body.expectedLocalPodId).toBe('original-generation');
    authorizations++;
    return route.fulfill({ status: 409, json: { code: 'POD_DELETE_GENERATION_CHANGED' } });
  });
  await page.goto('/settings/pod?deletionAuthorization=opaque.challenge&podName=alice');
  await page.getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '允许这个账号删除此 Pod' }).click();
  await expect(page.getByRole('alert')).toContainText('这个地址的 Pod 已发生变化');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '允许这个账号删除此 Pod' })).toHaveCount(0);
  expect(authorizations).toBe(1);
});


test('Device operator 401 recovers only by explicit loopback navigation with the original challenge', async ({ page }) => {
  await mockAccount(page);
  await page.route('**/api/admin/**', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/service/status', (route) => route.fulfill({ json: { status: 'running', services: [] } }));
  const requests: string[] = [];
  await page.route('**/provision/pods', async (route) => {
    requests.push(route.request().postDataJSON().action);
    return route.fulfill({ status: 401, json: {} });
  });
  await page.goto('/settings/pod?deletionAuthorization=opaque.original&podName=alice&returnTo=https://evil.test/');
  await expect(page.getByText(/当前访问没有设备管理权限/)).toBeVisible();
  const field = page.getByLabel('本机 Xpod 管理地址');
  for (const invalid of ['https://evil.test/', 'http://user:secret@localhost:41873/', 'http://localhost:41873/?x=1', 'http://localhost:41873/#x']) {
    await field.fill(invalid);
    await page.getByRole('button', { name: '在本机继续' }).click();
    await expect(page.getByText('请输入本机 localhost、127.0.0.1 或 [::1] 的 HTTP(S) 地址，不得包含账号密码、查询参数或片段。', { exact: true })).toBeVisible();
  }
  const localRequests: Array<{ url: string; navigation: boolean; method: string }> = [];
  await page.route('http://localhost:41873/**', async (route) => {
    localRequests.push({ url: route.request().url(), navigation: route.request().isNavigationRequest(), method: route.request().method() });
    return route.fulfill({ contentType: 'text/html', body: '<title>Local management fixture</title><p>Device management</p>' });
  });
  await field.fill('http://localhost:41873/xpod/');
  await page.getByRole('button', { name: '在本机继续' }).click();
  await expect(page).toHaveURL('http://localhost:41873/xpod/settings/pod?deletionAuthorization=opaque.original&podName=alice');
  expect(localRequests).toEqual([{ url: 'http://localhost:41873/xpod/settings/pod?deletionAuthorization=opaque.original&podName=alice', navigation: true, method: 'GET' }]);
  expect(requests).toEqual(['inspectDeletionAuthorization']);
});
