import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const baseUrl = process.env.XPOD_SETTINGS_E2E_BASE_URL;
const screenshotDir = path.resolve('.test-data/acceptance/screenshots');

test.describe('Xpod settings product acceptance', () => {
  test.skip(!baseUrl, 'Set XPOD_SETTINGS_E2E_BASE_URL to a real Xpod settings host; product JSON fetch interception is not allowed.');

  test.beforeAll(async () => {
    await mkdir(screenshotDir, { recursive: true });
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 960 },
    { name: 'narrow', width: 390, height: 844 },
  ]) {
    test(`exercises all settings modules with real host data at ${viewport.name} width`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const module of [
        { label: 'Models', path: '/dashboard/models' },
        { label: 'Pod', path: '/dashboard/pod' },
        { label: 'Network', path: '/dashboard/network' },
        { label: 'Services', path: '/dashboard/services' },
      ]) {
        await page.goto(new URL(module.path, baseUrl).toString(), { waitUntil: 'networkidle' });
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('link', { name: module.label }).or(page.getByText(module.label).first())).toBeVisible();
        await expect(page.locator('body')).not.toContainText('Mock');
        await page.screenshot({
          path: path.join(screenshotDir, `${viewport.name}-${module.label.toLowerCase()}.png`),
          fullPage: true,
        });
      }
    });
  }

  test('keeps header search, stack back navigation and focus contract coherent on a narrow viewport', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(new URL('/dashboard/models', baseUrl).toString(), { waitUntil: 'networkidle' });

    const search = page.getByRole('searchbox').or(page.getByPlaceholder(/search/i)).first();
    await expect(search).toBeVisible();
    await search.focus();
    await expect(search).toBeFocused();

    const firstNavigable = page.getByRole('link').filter({ hasNotText: /^Models$/ }).first();
    if (await firstNavigable.count()) {
      await firstNavigable.focus();
      await page.keyboard.press('Enter');
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: path.join(screenshotDir, 'narrow-stack-detail.png'), fullPage: true });
      await page.goBack({ waitUntil: 'networkidle' });
      await expect(page.locator('main')).toHaveCount(1);
    }
  });
});
