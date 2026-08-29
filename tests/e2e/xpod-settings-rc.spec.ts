import { expect, type Browser, type BrowserContext, type Page, test } from '@playwright/test';
import { fetchProfileStorageUrls } from '../../ui/src/utils/provision-scope';

const baseUrl = requiredEnv('XPOD_SETTINGS_E2E_BASE_URL');
const aliceStatePath = requiredEnv('XPOD_SETTINGS_E2E_ALICE_STATE');
const bobStatePath = requiredEnv('XPOD_SETTINGS_E2E_BOB_STATE');

test.describe.configure({ mode: 'serial' });

test.describe('deployed Xpod settings acceptance', () => {
  test('restores two authenticated sessions with distinct managed Pod bindings', async ({ browser }) => {
    test.setTimeout(90_000);
    const alice = await openAuthenticatedAiConnections(browser, aliceStatePath);
    const bob = await openAuthenticatedAiConnections(browser, bobStatePath);
    try {
      const [ aliceIdentity, bobIdentity ] = await Promise.all([
        authoritativeSelectedStorage(alice.page),
        authoritativeSelectedStorage(bob.page),
      ]);

      expect(aliceIdentity.webId).not.toBe(bobIdentity.webId);
      expect(aliceIdentity.storageUrl).not.toBe(bobIdentity.storageUrl);
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
