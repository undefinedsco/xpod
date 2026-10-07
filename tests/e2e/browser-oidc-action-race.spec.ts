import { expect, test } from '@playwright/test';
import { clickNonPasswordOidcAction } from '../helpers/browserSolidOidc';

test('a disappearing OIDC control returns to callback detection without waiting for a stale locator', async ({ page }) => {
  test.setTimeout(5_000);
  await page.setContent('<button>授权</button>');
  const candidate = page.getByRole('button', { name: '授权', exact: true });
  await expect(candidate).toBeVisible();
  // The navigation may commit between discovery and same-node activation.
  await page.setContent('<h1>Application callback</h1>');
  expect(await clickNonPasswordOidcAction(candidate)).toBe(false);
  await expect(page.getByRole('heading', { name: 'Application callback', exact: true })).toBeVisible();
});

for (const control of ['<button>允许</button>', '<a href="#approve">授权</a>', '<input type="submit" value="同意">']) {
  test(`manual Consent cannot be auto-approved after the ready probe: ${control}`, async ({ page }) => {
    await page.setContent('<main>正在加载…</main>');
    expect(await page.locator('[data-pod-sign-in-state="consent"]').count()).toBe(0);
    // The actual Consent mounts after the Node-side ready probe and before activation.
    await page.setContent(`<main data-pod-sign-in-state="consent"><h1>应用授权</h1><form>${control}</form></main>`);
    await page.evaluate(() => {
      document.addEventListener('click', event => { event.preventDefault(); document.body.dataset.clicked = 'true'; });
    });
    const candidate = page.locator('button, a, input[type="submit"]').first();
    expect(await clickNonPasswordOidcAction(candidate, { manualConsent: true })).toBe(false);
    expect(await page.locator('body').getAttribute('data-clicked')).toBeNull();
    await expect(page.getByRole('heading', { name: '应用授权' })).toBeVisible();
  });
}
