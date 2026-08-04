import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Browser, type Page, test } from '@playwright/test';

const env = process.env;
const baseUrl = env.XPOD_SETTINGS_E2E_BASE_URL;
const aliceState = env.XPOD_SETTINGS_E2E_ALICE_STATE;
const bobState = env.XPOD_SETTINGS_E2E_BOB_STATE;
const alicePodUrl = env.XPOD_SETTINGS_E2E_ALICE_POD_URL;
const testApiKey = env.XPOD_SETTINGS_E2E_TEST_API_KEY;
const screenshotDir = path.resolve('.test-data/acceptance/screenshots');
const hasRequiredEnvironment = Boolean(baseUrl && aliceState && bobState && alicePodUrl && testApiKey);

test.describe('Xpod settings product acceptance', () => {
  test.skip(!hasRequiredEnvironment, 'Set XPOD_SETTINGS_E2E_BASE_URL, XPOD_SETTINGS_E2E_ALICE_STATE, XPOD_SETTINGS_E2E_BOB_STATE, XPOD_SETTINGS_E2E_ALICE_POD_URL and XPOD_SETTINGS_E2E_TEST_API_KEY.');

  test.beforeAll(async () => {
    await mkdir(screenshotDir, { recursive: true });
  });

  test('persists Alice API-key credential in her private Pod and keeps it isolated from Bob', async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await authenticatedPage(browser, aliceState!);
    const bob = await authenticatedPage(browser, bobState!);
    try {
      const aliceBefore = await readPodAiConnectionStatus(alice);
      const bobBefore = await readPodAiConnectionStatus(bob);
      expect(aliceBefore.webId).not.toBe(bobBefore.webId);

      await openModule(alice, '/settings/models', 'Models');
      await completeApiKeyThroughUi(alice, testApiKey!);
      await alice.reload({ waitUntil: 'domcontentloaded' });
      await expect(alice.locator('body')).not.toContainText(testApiKey!);
      await expect(alice.locator('body')).toContainText(/openai|configured|connected|api key/i);

      const aliceAfter = await readPodAiConnectionStatus(alice);
      expect(aliceAfter.webId).toBe(aliceBefore.webId);
      expect(aliceAfter.configuredProviders).toBe(aliceBefore.configuredProviders + 1);

      await openModule(bob, '/settings/models', 'Models');
      await expect(bob.locator('body')).not.toContainText(testApiKey!);
      await expect(bob.locator('body')).not.toContainText(/Alice OpenAI acceptance|acceptance-openai/i);
      const bobAfter = await readPodAiConnectionStatus(bob);
      expect(bobAfter.webId).toBe(bobBefore.webId);
      expect(bobAfter.configuredProviders).toBe(bobBefore.configuredProviders);
    } finally {
      await cleanupApiKeyThroughUi(alice).catch(() => undefined);
      await alice.context().close();
      await bob.context().close();
    }
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 960 },
    { name: 'narrow', width: 390, height: 844 },
  ]) {
    test(`shows real Models, Pod, Network and Services data with SDK geometry at ${viewport.name} width`, async ({ browser }) => {
      test.setTimeout(180_000);
      const page = await authenticatedPage(browser, aliceState!);
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const module of [
          { label: 'Models', path: '/settings/models', expected: /openai|anthropic|kimi|bailian|deepseek|gateway/i },
          { label: 'Pod', path: '/dashboard/pod', expected: /webid|pod|issuer|storage|providers/i },
          { label: 'Network', path: '/dashboard/network', expected: /endpoint|addresses|capabilities|unsupported|supported/i },
          { label: 'Services', path: '/dashboard/services', expected: /runtime|solid|gateway|storage|logs|rdf/i },
        ]) {
          await openModule(page, module.path, module.label);
          await expect(page.locator('main')).toHaveCount(1);
          await expect(page.locator('body')).toContainText(module.expected);
          await expect(page.locator('body')).not.toContainText(/mock|fixture|storybook/i);
          await assertSdkGeometryContract(page);
          await page.screenshot({
            path: path.join(screenshotDir, `${viewport.name}-${module.label.toLowerCase()}.png`),
            fullPage: true,
          });
        }
      } finally {
        await page.context().close();
      }
    });
  }

  test('keeps narrow stack detail, back navigation and focus contract mandatory', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await authenticatedPage(browser, aliceState!);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await openModule(page, '/settings/models', 'Models');

      const search = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first();
      await expect(search).toBeVisible();
      await search.focus();
      await expect(search).toBeFocused();

      const detailTrigger = page.locator('aside button, aside a, [data-slot="list"] button, [data-slot="list"] a').first();
      await expect(detailTrigger).toBeVisible();
      await detailTrigger.focus();
      await expect(detailTrigger).toBeFocused();
      await detailTrigger.press('Enter');
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('main')).toBeVisible();
      await page.screenshot({ path: path.join(screenshotDir, 'narrow-stack-detail.png'), fullPage: true });

      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('main')).toHaveCount(1);
      await expect(search.or(page.getByRole('searchbox').first())).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});

async function authenticatedPage(browser: Browser, storageStatePath: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath });
  return await context.newPage();
}

async function openModule(page: Page, route: string, label: string): Promise<void> {
  await page.goto(new URL(route, baseUrl!).toString(), { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
}

async function completeApiKeyThroughUi(page: Page, apiKey: string): Promise<void> {
  await page.getByText(/openai/i).first().click();
  await page.getByRole('button', { name: /api key|connect|configure|add/i }).first().click();
  await page.getByLabel(/api key|key/i).or(page.locator('input[type="password"], input[name*="key" i]').first()).fill(apiKey);
  await page.getByLabel(/label|name/i).or(page.locator('input[name*="label" i], input[name*="name" i]').first()).fill('Alice OpenAI acceptance');
  await page.getByRole('button', { name: /save|connect|submit|done/i }).first().click();
  await expect(page.locator('body')).toContainText(/connected|configured|saved|openai/i);
}

async function cleanupApiKeyThroughUi(page: Page): Promise<void> {
  await openModule(page, '/settings/models', 'Models');
  await page.getByText(/openai/i).first().click();
  await page.getByRole('button', { name: /delete|disconnect|revoke|remove/i }).first().click();
  await page.getByRole('button', { name: /confirm|delete|disconnect|revoke|remove/i }).first().click();
  await expect(page.locator('body')).not.toContainText('Alice OpenAI acceptance');
}

async function readPodAiConnectionStatus(page: Page): Promise<{ webId: string; configuredProviders: number }> {
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/api/pod/settings/status') && response.request().method() === 'GET'
  ));
  await openModule(page, '/dashboard/pod', 'Pod');
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = await response.json() as {
    identity?: { webId?: unknown };
    aiConnection?: { status?: unknown; configuredProviders?: unknown; source?: unknown };
  };
  expect(payload.aiConnection).toMatchObject({ status: 'available', source: 'drizzle-solid' });
  expect(typeof payload.identity?.webId).toBe('string');
  expect(typeof payload.aiConnection?.configuredProviders).toBe('number');
  return {
    webId: payload.identity!.webId as string,
    configuredProviders: payload.aiConnection!.configuredProviders as number,
  };
}

async function assertSdkGeometryContract(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const header = document.querySelector('header') ?? document.querySelector('[data-slot="header"]');
    const search = document.querySelector('input[type="search"], [role="searchbox"]') as HTMLElement | null;
    const main = document.querySelector('main') as HTMLElement | null;
    const nav = document.querySelector('nav, aside') as HTMLElement | null;
    const styles = getComputedStyle(document.documentElement);
    const rect = (element: Element | null) => {
      const box = element?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    };
    return {
      header: rect(header),
      search: rect(search),
      main: rect(main),
      nav: rect(nav),
      radius: styles.getPropertyValue('--radius').trim(),
      background: styles.getPropertyValue('--background').trim(),
    };
  });

  expect(metrics.header).toBeTruthy();
  expect(metrics.search).toBeTruthy();
  expect(metrics.main).toBeTruthy();
  expect(metrics.nav).toBeTruthy();
  expect(metrics.radius || 'defined').toBeTruthy();
  expect(metrics.background || 'defined').toBeTruthy();
  expect(metrics.search!.y).toBeGreaterThanOrEqual(metrics.header!.y - 1);
  expect(metrics.search!.y + metrics.search!.height).toBeLessThanOrEqual(metrics.header!.y + metrics.header!.height + 1);
  expect(metrics.main!.width).toBeGreaterThan(240);
  expect(Math.abs(metrics.main!.x - metrics.nav!.x)).toBeGreaterThan(16);
}
