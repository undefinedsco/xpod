import { expect, type Browser, type BrowserContext, type Page, test } from '@playwright/test';
import { fetchProfileStorageUrls } from '../../ui/src/utils/provision-scope';

const baseUrl = requiredEnv('XPOD_SETTINGS_E2E_BASE_URL');
const aliceStatePath = requiredEnv('XPOD_SETTINGS_E2E_ALICE_STATE');
const bobStatePath = requiredEnv('XPOD_SETTINGS_E2E_BOB_STATE');

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('deployed Xpod settings acceptance', () => {
  let alice: Awaited<ReturnType<typeof openAuthenticatedAiConnections>>;
  let bob: Awaited<ReturnType<typeof openAuthenticatedAiConnections>>;

  test.beforeAll(async ({ browser }) => {
    [ alice, bob ] = await Promise.all([
      openAuthenticatedAiConnections(browser, aliceStatePath),
      openAuthenticatedAiConnections(browser, bobStatePath),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      alice?.context.close(),
      bob?.context.close(),
    ]);
  });

  test('restores two authenticated sessions with distinct managed Pod bindings', async () => {
    const [ aliceIdentity, bobIdentity ] = await Promise.all([
      authoritativeSelectedStorage(alice.page),
      authoritativeSelectedStorage(bob.page),
    ]);

    expect(aliceIdentity.webId).not.toBe(bobIdentity.webId);
    expect(aliceIdentity.storageUrl).not.toBe(bobIdentity.storageUrl);
  });

  test('loads the deployed product modules at desktop width', async ({}, testInfo) => {
    await alice.page.setViewportSize({ width: 1440, height: 900 });
    for (const module of deployedModules) {
      await openAuthenticatedModule(alice.page, module.path, module.readySelector);
      await alice.page.screenshot({
        path: testInfo.outputPath(`desktop-${module.name}.png`),
        fullPage: true,
      });
    }
  });

  test('keeps the deployed product modules usable at narrow width', async ({}, testInfo) => {
    await alice.page.setViewportSize({ width: 390, height: 844 });
    for (const module of deployedModules) {
      await openAuthenticatedModule(
        alice.page,
        module.path,
        module.readySelector,
        'attached',
      );
      const listPane = alice.page.locator('[data-testid="workspace-list-pane"]:visible').first();
      if (module.name === 'ai-connections') {
        const aiServices = listPane.getByRole('listbox', { name: 'AI 服务' });
        await expect(aiServices).toBeVisible({ timeout: 45_000 });
        await aiServices.getByRole('option').first().click();
      } else {
        await expect(
          listPane.locator('[data-workspace-list-header="true"]')
            .getByText(module.listHeaderLabel, { exact: true }),
        ).toBeVisible({ timeout: 45_000 });
        const compactSelection = listPane
          .getByRole('link', { name: module.compactSelectionLabel, exact: true }).first();
        await expect(compactSelection).toBeVisible({ timeout: 45_000 });
        await compactSelection.click();
      }
      await expect(alice.page.locator('[data-testid="workspace-main-pane"]:visible').first()).toBeVisible();
      await expect(alice.page.locator(module.readySelector).first()).toBeVisible();
      expect(await alice.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await alice.page.screenshot({
        path: testInfo.outputPath(`narrow-${module.name}.png`),
        fullPage: true,
      });
    }
  });
});

const deployedModules = [
  { name: 'ai-connections', navigationLabel: 'AI Connections', compactSelectionLabel: '', path: '/ai-connections', readySelector: '[data-testid="ai-connections-panel"]' },
  { name: 'pod', navigationLabel: 'Settings', listHeaderLabel: 'Settings', compactSelectionLabel: 'Pod', path: '/settings/pod', readySelector: 'main' },
  { name: 'network', navigationLabel: 'Network', listHeaderLabel: 'Network', compactSelectionLabel: 'Overview', path: '/network', readySelector: 'main' },
  { name: 'status', navigationLabel: 'Status', listHeaderLabel: 'Status', compactSelectionLabel: 'Overview', path: '/status/overview', readySelector: 'main' },
] as const;

async function openAuthenticatedAiConnections(
  browser: Browser,
  storageState: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await openAuthenticatedModule(page, '/ai-connections', '[data-testid="ai-connections-panel"]');
  return { context, page };
}

async function openAuthenticatedModule(
  page: Page,
  route: string,
  readySelector: string,
  readyState: 'attached' | 'visible' = 'visible',
): Promise<void> {
  const targetUrl = new URL(route, baseUrl);
  const currentUrl = new URL(page.url());
  if (currentUrl.origin !== targetUrl.origin || currentUrl.pathname !== targetUrl.pathname) {
    const module = deployedModules.find((candidate) => candidate.path === route);
    const routeLink = module
      ? page.getByRole('link', { name: module.navigationLabel, exact: true }).first()
      : undefined;

    if (routeLink && await routeLink.isVisible()) {
      await Promise.all([
        page.waitForURL((url) => url.origin === targetUrl.origin && url.pathname === targetUrl.pathname, {
          timeout: 60_000,
        }),
        routeLink.click(),
      ]);
    } else {
      const response = await page.goto(targetUrl.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      expect(response?.status() ?? 599).toBeLessThan(400);
    }
  }
  const ready = page.locator(readySelector).first();
  if (readyState === 'attached') {
    await expect(ready).toBeAttached({ timeout: 45_000 });
  } else {
    await expect(ready).toBeVisible({ timeout: 45_000 });
  }
  await expect(page.locator('[data-auth-surface-mode="page"]')).toHaveCount(0);
}

async function selectedPodUrl(page: Page): Promise<string> {
  const trigger = page.getByTestId('xpod-user-card-trigger');
  await expect(trigger).toHaveAttribute('data-pod-ready', 'true', { timeout: 30_000 });
  await trigger.click();
  const card = page.locator('[data-avatar-card="true"][data-selected-pod-url]');
  await expect(card).toBeVisible();
  const podUrl = await card.getAttribute('data-selected-pod-url');
  if (!podUrl) throw new Error('Authenticated account card did not expose its selected Pod URL');
  await page.keyboard.press('Escape');
  return podUrl;
}

async function authoritativeSelectedStorage(page: Page): Promise<{ webId: string; storageUrl: string }> {
  const selectedStorageUrl = normalizeUrl(await selectedPodUrl(page));
  const remembered = await page.evaluate(() => localStorage.getItem('xpod.remembered-login.v1'));
  if (!remembered) throw new Error('Authenticated browser session did not remember its Xpod identity');

  const parsed = JSON.parse(remembered) as {
    webId?: unknown;
    storageBinding?: { webId?: unknown; storageUrl?: unknown };
  };
  if (typeof parsed.webId !== 'string'
    || typeof parsed.storageBinding?.webId !== 'string'
    || typeof parsed.storageBinding.storageUrl !== 'string') {
    throw new Error('Remembered Xpod identity is malformed');
  }

  expect(parsed.storageBinding.webId).toBe(parsed.webId);
  expect(normalizeUrl(parsed.storageBinding.storageUrl)).toBe(selectedStorageUrl);

  const profileStorageUrls = (await fetchProfileStorageUrls(fetch, parsed.webId)).map(normalizeUrl);
  expect(profileStorageUrls, `WebID ${parsed.webId} must advertise selected storage ${selectedStorageUrl}`)
    .toContain(selectedStorageUrl);

  const selectedUrl = new URL(selectedStorageUrl);
  expect(selectedUrl.protocol).toBe('https:');
  expect([ 'localhost', '127.0.0.1', '::1' ]).not.toContain(selectedUrl.hostname);

  return { webId: parsed.webId, storageUrl: selectedStorageUrl };
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required for deployed RC browser acceptance`);
  return value;
}

function normalizeUrl(value: string): string {
  const normalized = new URL(value);
  normalized.hash = '';
  normalized.search = '';
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/';
  return normalized.href;
}
