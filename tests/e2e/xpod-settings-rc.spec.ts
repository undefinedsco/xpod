import { expect, type Browser, type BrowserContext, type Page, test } from '@playwright/test';

const baseUrl = requiredEnv('XPOD_SETTINGS_E2E_BASE_URL');
const aliceStatePath = requiredEnv('XPOD_SETTINGS_E2E_ALICE_STATE');
const bobStatePath = requiredEnv('XPOD_SETTINGS_E2E_BOB_STATE');
const managedPodHostSuffix = deriveManagedPodHostSuffix(baseUrl);

test.describe.configure({ mode: 'serial' });

test.describe('deployed Xpod settings acceptance', () => {
  test('restores two authenticated sessions with distinct managed Pod bindings', async ({ browser }) => {
    const alice = await openAuthenticatedAiConnections(browser, aliceStatePath);
    const bob = await openAuthenticatedAiConnections(browser, bobStatePath);
    try {
      const alicePodUrl = await selectedPodUrl(alice.page);
      const bobPodUrl = await selectedPodUrl(bob.page);

      expect(alicePodUrl).not.toBe(bobPodUrl);
      expect(new URL(alicePodUrl).hostname.endsWith(managedPodHostSuffix)).toBe(true);
      expect(new URL(bobPodUrl).hostname.endsWith(managedPodHostSuffix)).toBe(true);
    } finally {
      await alice.context.close();
      await bob.context.close();
    }
  });

  test('loads the deployed product modules at desktop width', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      storageState: aliceStatePath,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      for (const module of deployedModules) {
        await openAuthenticatedModule(page, module.path, module.readySelector);
        await page.screenshot({
          path: testInfo.outputPath(`desktop-${module.name}.png`),
          fullPage: true,
        });
      }
    } finally {
      await context.close();
    }
  });

  test('keeps the deployed product modules usable at narrow width', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      storageState: aliceStatePath,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    try {
      for (const module of deployedModules) {
        await openAuthenticatedModule(page, module.path, module.readySelector);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`narrow-${module.name}.png`),
          fullPage: true,
        });
      }
    } finally {
      await context.close();
    }
  });
});

const deployedModules = [
  { name: 'ai-connections', path: '/ai-connections', readySelector: '[data-testid="ai-connections-panel"]' },
  { name: 'pod', path: '/settings/pod', readySelector: 'main' },
  { name: 'network', path: '/network', readySelector: 'main' },
  { name: 'status', path: '/status/overview', readySelector: 'main' },
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

async function openAuthenticatedModule(page: Page, route: string, readySelector: string): Promise<void> {
  const response = await page.goto(new URL(route, baseUrl).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  expect(response?.status() ?? 599).toBeLessThan(400);
  await expect(page.locator(readySelector).first()).toBeVisible({ timeout: 45_000 });
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

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required for deployed RC browser acceptance`);
  return value;
}

function deriveManagedPodHostSuffix(idpBaseUrl: string): string {
  const hostname = new URL(idpBaseUrl).hostname;
  const labels = hostname.split('.');
  if (!/^id(?:-|$)/u.test(labels[0] ?? '')) {
    throw new Error(`Cannot derive the managed Pod host suffix from IdP ${hostname}`);
  }
  labels[0] = labels[0]!.replace(/^id/u, 'pods');
  return `.${labels.join('.')}`;
}
